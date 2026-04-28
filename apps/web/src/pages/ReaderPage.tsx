// Reader page. Owns the chrome (header bar, dock, modals) and
// dispatches to the format-specific reader component for content
// rendering.
//
// State responsibility split:
//   ReaderPage   → which book, which chapter/page, prefs, dock open,
//                  progress sync, AI panel, blocking modal, currently
//                  selected highlight colour.
//   *Reader      → fetch + render content, emit selection events,
//                  signal ready/busy state up.
//
// Recent behaviour changes (per user request):
//   • TOC is now a permanently DOCKED aside on the left. The header
//     button just toggles its VISIBILITY (collapsed dock vs visible
//     dock). There is no longer a floating overlay TOC mode and no
//     pin / unpin chrome — `tocPinned` from prefs is ignored as a
//     legacy field; we treat the dock as on by default.
//   • The AI assistant's "pin" button no longer reshapes the panel
//     into a small bottom-right card. Instead, pinning keeps the
//     panel in its current drawer position (full-height, right edge)
//     and merely removes the backdrop / click-outside-close so the
//     reader stays interactive behind it. The user dismisses it
//     explicitly with the ✕ button.
//   • The header gains a colour-swatch row to the LEFT of the AI
//     icon. The currently-selected colour is forwarded to the active
//     reader and used as the default for new highlights — so the
//     "select a passage and the toolbar pops up with that colour
//     pre-applied" workflow becomes one tap shorter.
//   • A `?q=...&chunk=...&chapter=...` query string drives the
//     search-result jump path: the reader navigates to the chapter,
//     then the TxtReader exposes the chunk + keyword via a single
//     prop the search→reader handoff uses to flash the match for
//     a few seconds. We strip the params after consuming them so
//     a refresh doesn't keep flashing.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, Link, useSearchParams } from 'react-router-dom';
import { api, ApiException } from '../lib/api';
import { loadPrefs, savePrefs, resolvePageMode, type ReaderPrefs } from '../lib/prefs';
import { fetchToc, findTocItemByChapterId, type TocItem } from '../lib/toc';
import { COLORS, type HighlightColor } from '../lib/highlights';
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

// Default colour for new highlights when the user hasn't picked one
// from the header swatch. We use yellow because it's the most legible
// across every reader theme.
const DEFAULT_HIGHLIGHT_COLOR: HighlightColor = 'yellow';

export default function ReaderPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [book, setBook] = useState<BookDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<ReaderPrefs>(() => loadPrefs());

  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [tocItems, setTocItems] = useState<TocItem[]>([]);
  const [chapterOrd, setChapterOrd] = useState(0);
  const [pdfPage, setPdfPage] = useState(1);

  // Progress is loaded asynchronously; the reader only mounts after
  // we have the saved position so a freshly-mounted reader doesn't
  // overwrite it with chapterOrd=0.
  const [progressLoaded, setProgressLoaded] = useState(false);

  // Dock + panels.
  const [tocVisible, setTocVisible] = useState(true);
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

  // Currently-selected highlight colour from the header swatch row.
  // Forwarded to TxtReader; a new highlight from the SelectionToolbar
  // uses this as its default colour.
  const [activeColor, setActiveColor] = useState<HighlightColor>(DEFAULT_HIGHLIGHT_COLOR);

  // Search-jump handoff: when the user arrived from /search, we keep
  // the (chunk, keyword) pair so the reader can flash the match. We
  // consume it once and clear so a refresh doesn't keep flashing.
  const searchJump = useMemo(() => {
    const q = searchParams.get('q')?.trim();
    const chapterId = searchParams.get('chapter')?.trim();
    if (!q || !chapterId) return null;
    return { keyword: q, chapterId };
  }, [searchParams]);

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
    setTocItems([]);
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

  // ── Load hierarchical TOC ──────────────────────────────────────
  // Independent of chapters: the TOC may have heading-only nodes that
  // don't correspond to any spine entry, and conversely a spine entry
  // may not be in the TOC at all. We render TOC items if available,
  // otherwise the drawer's empty-state shows "暂无目录".
  useEffect(() => {
    if (!book || book.format === 'pdf') return;
    let cancelled = false;
    fetchToc(book.id).then(items => {
      if (!cancelled) setTocItems(items);
    });
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

  // ── Apply search-jump on first mount after chapters load ───────
  // We jump to the chapter referenced by `?chapter=...` once the
  // chapter list has resolved (we need ord lookup). The keyword
  // itself is forwarded to TxtReader via the searchJump prop so it
  // can flash matches in-place. After consuming, we strip the
  // params so a page refresh doesn't re-trigger.
  useEffect(() => {
    if (!book || !progressLoaded || !searchJump) return;
    if (chapters.length === 0) return;
    const target = chapters.find(c => c.id === searchJump.chapterId);
    if (target && target.ord !== chapterOrd) {
      setChapterOrd(target.ord);
    }
    // We DON'T strip the params yet — TxtReader needs to read them on
    // its next render. It calls onSearchHandled() once it's flashed
    // the match, which triggers the strip below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, progressLoaded, chapters, searchJump]);

  const handleSearchHandled = useCallback(() => {
    if (!searchJump) return;
    const next = new URLSearchParams(searchParams);
    next.delete('q');
    next.delete('chapter');
    setSearchParams(next, { replace: true });
  }, [searchJump, searchParams, setSearchParams]);

  // ── Format dispatch ─────────────────────────────────────────────
  const isPDF = book?.format === 'pdf';
  const isEPUB = book?.format === 'epub';
  const isCBZ = book?.format === 'cbz';
  // We now route EPUB through the TXT-backed reader as well, because
  // every EPUB goes through the SPA's foliate-based ingest pipeline
  // that produces chapters + chunks just like TXT does. Using
  // TxtReader gives EPUBs the SelectionToolbar (which the legacy
  // epub.js iframe path couldn't host without postMessage gymnastics).
  // Books whose format flag is 'epub' but which were uploaded *before*
  // ingest landed and never got chapters extracted will still hit the
  // EpubReader fallback below via `isEPUBLegacy`.
  const TXT_BACKED_FORMATS = ['txt', 'fb2', 'fbz', 'mobi', 'azw', 'azw3', 'epub'];
  const isTxtBacked = !!book && TXT_BACKED_FORMATS.includes(book.format) && chapters.length > 0;
  const isEPUBLegacy = !!isEPUB && chapters.length === 0;
  const cantParse = !!book && !isPDF && !isEPUB && !isCBZ && !TXT_BACKED_FORMATS.includes(book.format);

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

  const activeChapterId = useMemo(() => {
    const ch = chapters[chapterOrd];
    return ch ? ch.id : null;
  }, [chapters, chapterOrd]);

  // Header subtitle prefers the deepest TOC node matching the current
  // chapter — gives users a sense of where they are in the hierarchy.
  void findTocItemByChapterId; // surface unused-import elimination guard

  // ── Handlers passed to readers ─────────────────────────────────
  const handleReaderReady = useCallback(() => setBookReady(true), []);
  const handleReaderBusy = useCallback((b: boolean) => setReaderBusy(b), []);
  const handleSelection = useCallback((text: string | null) => setSelectedText(text), []);

  // Resolve a TOC pick (which is a chapterId) into a spine ord. If
  // the TOC entry's chapter isn't in our spine list (rare — heading-
  // only entry that we didn't filter out), no-op.
  const handleTocPick = useCallback((chapterId: string) => {
    const ch = chapters.find(c => c.id === chapterId);
    if (ch) setChapterOrd(ch.ord);
  }, [chapters]);

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
        onTOC={() => setTocVisible(v => !v)}
        onSettings={() => setSettingsOpen(true)}
        onAI={() => setAiOpen(true)}
        onBack={() => navigate('/library')}
        activeColor={activeColor}
        onColorChange={setActiveColor}
      />

      <div className="flex-1 min-h-0 flex">
        {/* TOC dock — always rendered when visible. PDFs don't get a
            TOC dock because pdf.js owns its own outline UI. */}
        {tocVisible && !isPDF && (
          <TocDrawer
            items={tocItems.length > 0 ? tocItems : chaptersToTocFallback(chapters)}
            activeChapterId={activeChapterId}
            onPick={handleTocPick}
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

          {!cantParse && progressLoaded && isEPUBLegacy && (
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
              activeColor={activeColor}
              searchKeyword={searchJump?.keyword ?? null}
              searchTargetChapterId={searchJump?.chapterId ?? null}
              onSearchHandled={handleSearchHandled}
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

      <AIChatPanel
        open={aiOpen || !!prefs.aiPinned}
        onClose={() => {
          setAiOpen(false);
          if (prefs.aiPinned) handlePrefsChange({ ...prefs, aiPinned: false });
        }}
        bookId={book.id}
        bookTitle={book.title}
        chapterTitle={chapters[chapterOrd]?.title ?? undefined}
        selectedText={selectedText}
        pinned={!!prefs.aiPinned}
        onTogglePin={() => {
          const next = !prefs.aiPinned;
          handlePrefsChange({ ...prefs, aiPinned: next });
          if (next) setAiOpen(true);
        }}
      />

      <BlockingModal open={modalOpen} label={modalLabel} />
    </div>
  );
}

// When the server returns no hierarchical TOC (rare — old books that
// haven't been re-ingested), we synthesise a flat one from chapters
// so the dock isn't blank.
function chaptersToTocFallback(chapters: Chapter[]): TocItem[] {
  return chapters.map(c => ({
    label: c.title?.trim() || `第 ${c.ord + 1} 章`,
    chapterId: c.id,
    depth: 0,
  }));
}

function ReaderHeader({
  title, bookTitle, onTOC, onSettings, onAI, onBack,
  activeColor, onColorChange,
}: {
  title: string; bookTitle: string;
  onTOC: () => void; onSettings: () => void; onAI: () => void; onBack: () => void;
  activeColor: HighlightColor;
  onColorChange: (c: HighlightColor) => void;
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

      {/* Colour picker for highlights — placed immediately to the LEFT
          of the AI icon as the user requested. The active swatch is
          ringed; clicking another swatch updates the global colour
          that new highlights pick up by default. We use a compact
          inline row so it doesn't crowd the title. */}
      <div className="flex items-center gap-1 mr-1" role="radiogroup" aria-label="高亮颜色">
        {COLORS.map(c => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={c === activeColor}
            onClick={() => onColorChange(c)}
            className="header-color-swatch"
            data-active={c === activeColor ? '1' : '0'}
            style={{ background: swatchHex(c) }}
            title={colorLabel(c)}
            aria-label={colorLabel(c)}
          />
        ))}
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

// Single source of truth for swatch colours — kept in sync with the
// SelectionToolbar so the swatch in the header looks identical to the
// one in the bubble.
function swatchHex(c: HighlightColor): string {
  switch (c) {
    case 'yellow': return '#FFD900';
    case 'red':    return '#FF6363';
    case 'green':  return '#5FC86E';
    case 'blue':   return '#63A5FF';
    case 'purple': return '#BA82EB';
    case 'orange': return '#FF9F50';
  }
}
function colorLabel(c: HighlightColor): string {
  switch (c) {
    case 'yellow': return '黄色';
    case 'red':    return '红色';
    case 'green':  return '绿色';
    case 'blue':   return '蓝色';
    case 'purple': return '紫色';
    case 'orange': return '橙色';
  }
}
