// Reader page. Owns the chrome (header bar, drawers, modals) and
// dispatches to the format-specific reader component for content
// rendering.
//
// State responsibility split:
//   ReaderPage   → which book, which chapter/page, prefs, drawers
//                  open, progress sync, AI panel, blocking modal.
//   *Reader      → fetch + render content, emit selection events,
//                  signal ready/busy state up.
//
// Critical fix vs previous version — progress restoration:
//   The old code rendered the format reader the moment book metadata
//   loaded, then asynchronously fetched progress and updated chapterOrd.
//   For EpubReader this lost the position because epub.js had already
//   called display() at spine[0] and emitted a 'relocated' event that
//   wrote chapterOrd=0 *before* the GET /progress response arrived.
//   We now gate every reader on `progressLoaded` so the reader only
//   mounts once we know the saved position. (EpubReader still needs
//   to suppress its first 'relocated' callback; that's done inside
//   EpubReader itself.)
//
// Rendering modal:
//   Reading-setting changes that require a re-paginate (font size,
//   line height, page mode, theme on EPUB) take 100-400 ms. We
//   surface a blocking modal during the change so the user knows
//   the click registered. The modal closes either when the reader
//   reports `busy=false` again or after a short safety timeout.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { api, ApiException } from '../lib/api';
import { loadPrefs, savePrefs, resolvePageMode, type ReaderPrefs } from '../lib/prefs';
import SettingsDrawer from '../components/SettingsDrawer';
import TocDrawer from '../components/TocDrawer';
import BlockingModal from '../components/BlockingModal';
import AIChatPanel from '../components/AIChatPanel';
import TxtReader from '../reader/TxtReader';
import EpubReader from '../reader/EpubReader';
import PdfReader from '../reader/PdfReader';
import CbzReader from '../reader/CbzReader';

interface BookDTO {
  id: string;
  title: string;
  authors?: string[];
  format: string;
  status: string;
}

interface Chapter {
  id: string;
  ord: number;
  title?: string | null;
}

export default function ReaderPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [book, setBook] = useState<BookDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<ReaderPrefs>(() => loadPrefs());

  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [chapterOrd, setChapterOrd] = useState(0);
  const [pdfPage, setPdfPage] = useState(1);

  // Progress is loaded asynchronously; the reader only mounts after
  // we have the saved position so a freshly-mounted reader doesn't
  // overwrite it with chapterOrd=0.
  const [progressLoaded, setProgressLoaded] = useState(false);

  // Drawers / panels.
  const [tocOpen, setTocOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

  // Blocking-modal state. The reader signals `busy=true` while it's
  // re-paginating; we surface that as the modal. We also drive it
  // ourselves when opening the book (until the reader signals ready).
  const [bookReady, setBookReady] = useState(false);
  const [readerBusy, setReaderBusy] = useState(false);
  // After a prefs change we synthesize a brief busy window even if the
  // reader doesn't expose one — some changes (theme, line height) are
  // visually instant but we still want feedback for the click.
  const [prefsChangeBusyUntil, setPrefsChangeBusyUntil] = useState(0);
  const [, forceRender] = useState(0);
  // Selection text — kept here so the AI panel can include it as
  // context. Readers push their current selection up via onSelection.
  const [selectedText, setSelectedText] = useState<string | null>(null);

  // ── Persist prefs ───────────────────────────────────────────────
  useEffect(() => { savePrefs(prefs); }, [prefs]);

  // Bind theme to the document root.
  useEffect(() => {
    document.documentElement.setAttribute('data-reader-theme', prefs.theme);
    return () => document.documentElement.removeAttribute('data-reader-theme');
  }, [prefs.theme]);

  // ── Load book metadata once ─────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setBook(null);
    setBookReady(false);
    setProgressLoaded(false);
    setChapters([]);
    setChapterOrd(0);
    setPdfPage(1);
    api.get<{ book: BookDTO }>(`/api/books/${id}`)
      .then(d => { if (!cancelled) setBook(d.book); })
      .catch(e => {
        if (!cancelled) {
          if (e instanceof ApiException && e.status === 404) {
            navigate('/library', { replace: true });
            return;
          }
          setError(e.message);
        }
      });
    return () => { cancelled = true; };
  }, [id, navigate]);

  // ── Load saved progress, THEN allow the reader to mount ─────────
  // Without this gate, EpubReader can race and overwrite progress
  // with chapterOrd=0. We always set progressLoaded=true at the end
  // (even on fetch failure) so a transient error doesn't trap us in
  // the loading modal forever.
  useEffect(() => {
    if (!book) return;
    let cancelled = false;
    api.get<{ progress: { chapterOrder?: number; pageNo?: number } }>(`/api/books/${book.id}/progress`)
      .then(d => {
        if (cancelled) return;
        if (typeof d.progress.chapterOrder === 'number') setChapterOrd(d.progress.chapterOrder);
        if (typeof d.progress.pageNo === 'number') setPdfPage(d.progress.pageNo);
      })
      .catch(() => { /* not critical, fall through to start position */ })
      .finally(() => {
        if (!cancelled) setProgressLoaded(true);
      });
    return () => { cancelled = true; };
  }, [book]);

  // ── Load chapter list ──────────────────────────────────────────
  useEffect(() => {
    if (!book || book.format === 'pdf') return;
    let cancelled = false;
    api.get<{ chapters: Chapter[] }>(`/api/books/${book.id}/chapters/list`)
      .then(d => { if (!cancelled) setChapters(d.chapters); })
      .catch(() => { /* drawer just shows empty */ });
    return () => { cancelled = true; };
  }, [book]);

  // ── Save progress (debounced) ──────────────────────────────────
  // Crucially we DON'T fire this until progress has been loaded —
  // that prevents the "save chapterOrd=0 immediately" race we used
  // to have on EPUB.
  useEffect(() => {
    if (!book || !progressLoaded) return;
    const handle = setTimeout(() => {
      const body: Record<string, unknown> = { percent: 0 };
      if (book.format === 'pdf') body.pageNo = pdfPage;
      else body.chapterOrder = chapterOrd;
      api.put(`/api/books/${book.id}/progress`, body).catch(() => { /* ignore */ });
    }, 600);
    return () => clearTimeout(handle);
  }, [book, chapterOrd, pdfPage, progressLoaded]);

  // ── Format dispatch ─────────────────────────────────────────────
  const isPDF = book?.format === 'pdf';
  const isEPUB = book?.format === 'epub';
  const isCBZ = book?.format === 'cbz';
  const TXT_BACKED_FORMATS = ['txt', 'fb2', 'fbz', 'mobi', 'azw', 'azw3'];
  const isTxtBacked = !!book && TXT_BACKED_FORMATS.includes(book.format);
  const cantParse = !!book && !isPDF && !isEPUB && !isCBZ && !isTxtBacked;

  // Resolved page mode — narrow user's pref to one the format supports.
  const effectiveMode = useMemo(
    () => book ? resolvePageMode(book.format, prefs.pageMode) : prefs.pageMode,
    [book, prefs.pageMode],
  );

  const headerTitle = useMemo(() => {
    if (!book) return '';
    if (isPDF) return book.title;
    const ch = chapters[chapterOrd];
    return ch?.title || book.title;
  }, [book, chapters, chapterOrd, isPDF]);

  // ── Handlers passed to readers ─────────────────────────────────
  const handleReaderReady = useCallback(() => setBookReady(true), []);
  const handleReaderBusy = useCallback((b: boolean) => setReaderBusy(b), []);
  const handleSelection = useCallback((text: string | null) => setSelectedText(text), []);

  // Wrap setPrefs so that any change synthesises a brief busy window.
  // ~600 ms is long enough for a paginated EPUB to re-flow + measure
  // pagination on a slow device, and short enough to feel snappy.
  const handlePrefsChange = useCallback((next: ReaderPrefs) => {
    setPrefs(next);
    setPrefsChangeBusyUntil(performance.now() + 600);
    // Schedule a re-render at the busy-until deadline so the modal
    // reliably closes. We use a state setter that's a no-op except
    // for the re-render side effect.
    setTimeout(() => forceRender(t => t + 1), 620);
  }, []);

  // The blocking modal is open ONLY in two well-defined states:
  //   1. We have a book record but the reader hasn't reported ready
  //      (initial load — opening the book engine).
  //   2. The user just changed reader prefs and we're inside the
  //      synthetic re-render window so the screen doesn't flicker
  //      mid-flow.
  //
  // Crucially we DO NOT key on `readerBusy` here. readerBusy fires on
  // every chapter navigation (network fetch + re-render) and the
  // previous wiring meant any subsequent epub.js relocate-induced
  // re-display would pop the modal back open and never let go,
  // because the EPUB reader entered a feedback loop with itself.
  // After the initial load, the user should never see a blocking
  // modal again until they touch settings.
  void readerBusy;
  const modalOpen =
    (!!book && !cantParse && !bookReady) ||
    performance.now() < prefsChangeBusyUntil;
  const modalLabel = !bookReady ? '正在打开书籍引擎…' : '正在重新渲染…';

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-paper-50">
        <div className="text-center">
          <h2 className="text-xl font-serif text-ink-700 mb-2">无法打开本书</h2>
          <p className="text-sm text-ink-500">{error}</p>
          <Link to="/library" className="inline-block mt-4 text-accent-dark hover:underline text-sm">
            返回书架
          </Link>
        </div>
      </div>
    );
  }
  if (!book) {
    return (
      <>
        <BlockingModal open label="正在打开书籍引擎…" />
        <div className="min-h-screen bg-paper-50" />
      </>
    );
  }

  return (
    <div
      className="h-screen flex flex-col"
      data-reader-theme={prefs.theme}
      style={{ background: 'var(--reader-bg)' }}
    >
      <ReaderHeader
        title={headerTitle}
        bookTitle={book.title}
        onTOC={() => setTocOpen(o => prefs.tocPinned ? o : true)}
        onSettings={() => setSettingsOpen(true)}
        onAI={() => setAiOpen(true)}
        onBack={() => navigate('/library')}
      />

      <div className="flex-1 min-h-0 flex">
        {/* Pinned TOC docks on the left as a flex sibling. When not
            pinned, the TocDrawer renders itself as an overlay. */}
        {prefs.tocPinned && (
          <TocDrawer
            open
            pinned
            chapters={chapters}
            current={chapterOrd}
            onPick={(o) => setChapterOrd(o)}
            onClose={() => onTogglePin(false)}
            onTogglePin={() => onTogglePin(false)}
          />
        )}

        <div className="flex-1 min-w-0 relative">
          {cantParse && (
            <div className="h-full flex items-center justify-center px-6 text-center">
              <div className="max-w-md">
                <h2 className="font-serif text-xl mb-2" style={{ color: 'var(--reader-fg)' }}>
                  这种格式暂不支持阅读
                </h2>
                <p className="text-sm" style={{ color: 'var(--reader-muted)' }}>
                  {book.format.toUpperCase()} 文件已存储在你的书架。文档解析尚未实现，但你随时可以下载原始文件。
                </p>
                <a
                  href={`/api/books/${book.id}/file`}
                  className="inline-block mt-4 px-4 py-2 rounded-lg bg-accent text-white"
                >
                  下载原始文件
                </a>
              </div>
            </div>
          )}

          {/* Each reader is gated on progressLoaded so we never mount
              with a stale chapterOrd=0. */}
          {!cantParse && progressLoaded && isPDF && (
            <PdfReader
              bookId={book.id}
              prefs={prefs}
              page={pdfPage}
              pageMode={effectiveMode}
              onPageChange={p => setPdfPage(Math.max(1, p))}
              onReady={handleReaderReady}
              onBusy={handleReaderBusy}
            />
          )}

          {!cantParse && progressLoaded && isEPUB && (
            <EpubReader
              bookId={book.id}
              prefs={prefs}
              chapterOrd={chapterOrd}
              pageMode={effectiveMode}
              onLocationChange={setChapterOrd}
              onReady={handleReaderReady}
              onBusy={handleReaderBusy}
              onSelection={handleSelection}
            />
          )}

          {!cantParse && progressLoaded && isCBZ && (
            <CbzReader
              bookId={book.id}
              chapterOrd={chapterOrd}
              onChapterChange={n => setChapterOrd(Math.max(0, n))}
              onReady={handleReaderReady}
              onBusy={handleReaderBusy}
            />
          )}

          {!cantParse && progressLoaded && isTxtBacked && (
            <TxtReader
              bookId={book.id}
              prefs={prefs}
              chapterOrd={chapterOrd}
              pageMode={effectiveMode}
              onChapterChange={n => setChapterOrd(Math.max(0, n))}
              onReady={handleReaderReady}
              onBusy={handleReaderBusy}
              onSelection={handleSelection}
            />
          )}
        </div>
      </div>

      <SettingsDrawer
        open={settingsOpen}
        prefs={prefs}
        format={book.format}
        onChange={handlePrefsChange}
        onClose={() => setSettingsOpen(false)}
      />

      {/* Floating TOC drawer (only when not pinned). */}
      {!prefs.tocPinned && (
        <TocDrawer
          open={tocOpen}
          pinned={false}
          chapters={chapters}
          current={chapterOrd}
          onPick={setChapterOrd}
          onClose={() => setTocOpen(false)}
          onTogglePin={() => onTogglePin(true)}
        />
      )}

      <AIChatPanel
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        bookId={book.id}
        bookTitle={book.title}
        chapterTitle={chapters[chapterOrd]?.title ?? undefined}
        selectedText={selectedText}
      />

      <BlockingModal open={modalOpen} label={modalLabel} />
    </div>
  );

  // Helper closures keep the JSX above readable.
  function onTogglePin(pinned: boolean) {
    handlePrefsChange({ ...prefs, tocPinned: pinned });
    if (pinned) setTocOpen(false);
  }
}

function ReaderHeader({
  title, bookTitle, onTOC, onSettings, onAI, onBack,
}: {
  title: string; bookTitle: string;
  onTOC: () => void; onSettings: () => void; onAI: () => void; onBack: () => void;
}) {
  return (
    <header
      className="flex items-center gap-2 px-4 h-12 border-b shrink-0"
      style={{
        borderColor: 'var(--reader-border)',
        color: 'var(--reader-fg)',
        background: 'var(--reader-bg)',
      }}
    >
      <button
        onClick={onBack}
        className="opacity-70 hover:opacity-100 px-2 py-1 text-sm"
        title="返回书架"
        aria-label="返回书架"
      >
        ←
      </button>
      <button
        onClick={onTOC}
        className="opacity-70 hover:opacity-100 p-1.5"
        title="目录"
        aria-label="目录"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
          <line x1="3" y1="6" x2="3.01" y2="6" />
          <line x1="3" y1="12" x2="3.01" y2="12" />
          <line x1="3" y1="18" x2="3.01" y2="18" />
        </svg>
      </button>
      <div className="flex-1 min-w-0 text-center text-sm">
        <div className="truncate font-medium">{title}</div>
        {title !== bookTitle && (
          <div className="text-xs opacity-60 truncate">{bookTitle}</div>
        )}
      </div>
      <button
        onClick={onAI}
        className="opacity-70 hover:opacity-100 p-1.5"
        title="AI 阅读助手"
        aria-label="AI 阅读助手"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
        </svg>
      </button>
      <button
        onClick={onSettings}
        className="opacity-70 hover:opacity-100 p-1.5"
        title="阅读设置"
        aria-label="阅读设置"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
        </svg>
      </button>
    </header>
  );
}
