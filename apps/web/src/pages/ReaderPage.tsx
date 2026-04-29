// Reader page. Owns the chrome (header bar, dock, modals) and
// dispatches to the format-specific reader component for content
// rendering.
//
// State responsibility split:
//   ReaderPage   → which book, which chapter/page, prefs, dock open,
//                  progress sync (NOW BY CFIv2 LOCATOR, NOT JUST
//                  chapterOrd), AI panel, blocking modal, per-style
//                  colour memory.
//   *Reader      → fetch + render content, emit selection events,
//                  emit progress anchor + active chapter, signal
//                  ready/busy state up.
//
// Behaviours we now expose:
//
//   • TOC dock — permanently rendered next to the reader column.
//     Per the user's "目录不允许收起来" feedback, there is no
//     visibility toggle anymore: the dock is always visible (PDF
//     books are the one exception, since they have no chapter list).
//     The dock has its own fixed header bar with a "定位到当前章节"
//     button that scrolls the dock to the active TOC entry.
//
//   • Active TOC chapter is computed from the reader's emitted
//     `activeChapterId`, so the dock highlight tracks the page-flip
//     in real time rather than from `chapters[chapterOrd]`, which
//     could lag during rapid navigation or stay wrong when a chapter
//     load failed.
//
//   • Progress is stored as a CFIv2 locator (paragraph anchor) rather
//     than just the spine ord. Restore on next open returns the user
//     to the EXACT paragraph they were last reading, regardless of
//     whether they changed font size, theme, or page-flip mode in
//     between. The legacy chapter_order column is still written so
//     non-CFIv2 fallbacks (the EPUB iframe path) keep working.
//
//   • Per-style colour memory in prefs.styleColors. The header has
//     no global "active colour" anymore — colour selection happens
//     inside the SelectionToolbar bound to a chosen style. When the
//     user picks a style + colour and applies, we write that colour
//     to prefs.styleColors[<style>] so the next fresh annotation of
//     that style starts with the same colour.
//
//   • Search-jump via ?q=…&chapter=… still flashes the keyword in
//     the destination chapter; we strip the params after consumption
//     so a refresh doesn't re-trigger.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, Link, useSearchParams } from 'react-router-dom';
import { api, ApiException } from '../lib/api';
import { loadPrefs, savePrefs, resolvePageMode, type ReaderPrefs } from '../lib/prefs';
import { fetchToc, findTocItemByHeading, type TocItem } from '../lib/toc';
import type { HighlightColor, HighlightStyle } from '../lib/highlights';
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

interface ProgressAnchor {
  chapterId: string;
  locator: string;
}

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

  const [progressLoaded, setProgressLoaded] = useState(false);
  /** Initial anchor from the server, consumed once by the reader. */
  const [initialAnchor, setInitialAnchor] = useState<ProgressAnchor | null>(null);
  /** Latest anchor reported by the reader. Persisted and used to
   *  drive the active-chapter highlight in the TOC. */
  const [progressAnchor, setProgressAnchor] = useState<ProgressAnchor | null>(null);
  /** Active chapter id reported by the reader. Source of truth for
   *  the TOC's highlighted entry. */
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null);

  // Dock + panels. The TOC dock is always rendered now (per user
  // request "目录不允许收起来"), so there's no `tocVisible` state.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  /** When toggled, the TOC drawer scrolls to the active entry. We
   *  pass this counter down rather than a callback so the drawer
   *  can manage the scroll mechanics itself. */
  const [tocLocateTick, setTocLocateTick] = useState(0);

  /** 0..1 reading-progress estimate emitted by the reader. Drives the
   *  hairline progress bar between the header and the content area. */
  const [progressPct, setProgressPct] = useState(0);
  /** Closest preceding heading text reported by the reader. Used to
   *  pick a TOC entry to mark active when a single chapter file
   *  contains many TOC sections, and to display the user's actual
   *  current section in the header instead of the parser's auto-
   *  generated "第 X 章" placeholder. */
  const [activeHeadingText, setActiveHeadingText] = useState<string | null>(null);

  const [bookReady, setBookReady] = useState(false);
  const [readerBusy, setReaderBusy] = useState(false);
  const [prefsChangeBusyUntil, setPrefsChangeBusyUntil] = useState(0);
  const [, forceRender] = useState(0);
  const [selectedText, setSelectedText] = useState<string | null>(null);

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

  // ── Load book metadata ───────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setBook(null);
    setBookReady(false);
    setProgressLoaded(false);
    setInitialAnchor(null);
    setProgressAnchor(null);
    setActiveChapterId(null);
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

  // ── Load saved progress ─────────────────────────────────────────
  // We now expect the server to return both `chapterOrder` (legacy)
  // and `locator` (CFIv2). The locator + chapter id are forwarded to
  // the reader as initialAnchor; chapterOrder is the spine starting
  // point. PDFs use pageNo directly.
  useEffect(() => {
    if (!book) return;
    let cancelled = false;
    api.get<{
      progress: {
        chapterOrder?: number;
        pageNo?: number;
        locator?: string | null;
        chapterId?: string | null;
      };
    }>(`/api/books/${book.id}/progress`)
      .then(d => {
        if (cancelled) return;
        if (typeof d.progress.chapterOrder === 'number') setChapterOrd(d.progress.chapterOrder);
        if (typeof d.progress.pageNo === 'number') setPdfPage(d.progress.pageNo);
        if (d.progress.locator && d.progress.chapterId) {
          setInitialAnchor({
            locator: d.progress.locator,
            chapterId: d.progress.chapterId,
          });
        }
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

  // ── Load TOC ──────────────────────────────────────────────────
  useEffect(() => {
    if (!book || book.format === 'pdf') return;
    let cancelled = false;
    fetchToc(book.id).then(items => {
      if (!cancelled) setTocItems(items);
    });
    return () => { cancelled = true; };
  }, [book]);

  // ── Save progress (debounced) ──────────────────────────────────
  // We send the CFIv2 locator + chapterId alongside the legacy
  // chapter_order column so older clients still get sensible state.
  // The 600ms debounce covers rapid page flips.
  const lastSavedSig = useRef('');
  useEffect(() => {
    if (!book || !progressLoaded) return;
    const handle = setTimeout(() => {
      const body: Record<string, unknown> = { percent: 0 };
      if (book.format === 'pdf') {
        body.pageNo = pdfPage;
      } else {
        body.chapterOrder = chapterOrd;
        if (progressAnchor) {
          body.locator = progressAnchor.locator;
          body.chapterId = progressAnchor.chapterId;
        }
      }
      const sig = JSON.stringify(body);
      if (sig === lastSavedSig.current) return;
      lastSavedSig.current = sig;
      api.put(`/api/books/${book.id}/progress`, body).catch(() => { /* ignore */ });
    }, 600);
    return () => clearTimeout(handle);
  }, [book, chapterOrd, pdfPage, progressLoaded, progressAnchor]);

  // ── Apply search-jump ──────────────────────────────────────────
  useEffect(() => {
    if (!book || !progressLoaded || !searchJump) return;
    if (chapters.length === 0) return;
    const target = chapters.find(c => c.id === searchJump.chapterId);
    if (target && target.ord !== chapterOrd) {
      setChapterOrd(target.ord);
    }
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
  const TXT_BACKED_FORMATS = ['txt', 'fb2', 'fbz', 'mobi', 'azw', 'azw3', 'epub'];
  const isTxtBacked = !!book && TXT_BACKED_FORMATS.includes(book.format) && chapters.length > 0;
  const isEPUBLegacy = !!isEPUB && chapters.length === 0;
  const cantParse = !!book && !isPDF && !isEPUB && !isCBZ && !TXT_BACKED_FORMATS.includes(book.format);

  const effectiveMode = useMemo(
    () => book ? resolvePageMode(book.format, prefs.pageMode) : prefs.pageMode,
    [book, prefs.pageMode],
  );

  // Resolve the chapter / section title shown in the header. The
  // user fed back that the previous version showed "第 37 章" — that
  // was the parser's auto-generated label for spine entries with no
  // declared title; the user wanted the REAL section the page is in.
  // Resolution order, most-specific first:
  //
  //   1. Match the closest preceding heading from the rendered DOM
  //      against the TOC tree. If we find a TOC entry whose label
  //      matches the heading, use that label. Also returns the
  //      matching entry so the TOC drawer can highlight the right row
  //      even when many entries share the same chapterId.
  //   2. If no TOC label matches but the heading text is non-empty,
  //      use the heading text directly. This handles the case where
  //      the chapter's headings are real but the TOC didn't index
  //      them.
  //   3. Fall back to the chapters table row's title — but only if
  //      it looks like a real human title. We treat anything that
  //      matches an auto-generated pattern (e.g. "第 37 章") as a
  //      placeholder and prefer to show empty over the placeholder.
  //   4. Empty string when nothing meaningful is available.
  const { chapterTitle, activeTocLabel } = useMemo(() => {
    if (!book || isPDF) return { chapterTitle: '', activeTocLabel: null as string | null };
    // Try heading match against TOC.
    if (activeHeadingText) {
      const tocHit = findTocItemByHeading(tocItems, activeHeadingText);
      if (tocHit && tocHit.label) {
        return { chapterTitle: tocHit.label, activeTocLabel: tocHit.label };
      }
      return { chapterTitle: activeHeadingText, activeTocLabel: null };
    }
    const active = activeChapterId
      ? chapters.find(c => c.id === activeChapterId)
      : chapters[chapterOrd];
    const raw = active?.title?.trim() ?? '';
    if (raw && !isAutoChapterTitle(raw, active?.ord ?? -1)) {
      return { chapterTitle: raw, activeTocLabel: null };
    }
    return { chapterTitle: '', activeTocLabel: null };
  }, [book, chapters, chapterOrd, activeChapterId, activeHeadingText, tocItems, isPDF]);

  // ── Handlers passed to readers ─────────────────────────────────
  const handleReaderReady = useCallback(() => setBookReady(true), []);
  const handleReaderBusy = useCallback((b: boolean) => setReaderBusy(b), []);
  const handleSelection = useCallback((text: string | null) => setSelectedText(text), []);
  const handleProgressAnchor = useCallback((a: ProgressAnchor | null) => {
    setProgressAnchor(a);
  }, []);
  const handleActiveChapterChange = useCallback((cid: string) => {
    setActiveChapterId(cid);
  }, []);
  const handleActiveHeadingText = useCallback((h: string | null) => {
    // Dedupe — the reader emits this on every progress tick, and we
    // don't want to invalidate downstream memos when the value didn't
    // actually change.
    setActiveHeadingText(prev => (prev === h ? prev : h));
  }, []);
  const handleProgressPercent = useCallback((p: number) => setProgressPct(p), []);

  // Resolve a TOC pick (which is a chapterId) into a spine ord.
  const handleTocPick = useCallback((chapterId: string) => {
    const ch = chapters.find(c => c.id === chapterId);
    if (ch) setChapterOrd(ch.ord);
  }, [chapters]);

  // Wrap setPrefs so that any change synthesises a brief busy window.
  const handlePrefsChange = useCallback((next: ReaderPrefs) => {
    setPrefs(next);
    setPrefsChangeBusyUntil(performance.now() + 600);
    setTimeout(() => forceRender(t => t + 1), 620);
  }, []);

  // Per-style colour change from the header chip popover.
  const handleStyleColorChange = useCallback((style: HighlightStyle | 'note', color: HighlightColor) => {
    setPrefs(p => ({
      ...p,
      styleColors: { ...p.styleColors, [style]: color },
    }));
  }, []);

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
        bookTitle={book.title}
        chapterTitle={chapterTitle}
        onSettings={() => setSettingsOpen(true)}
        onAI={() => setAiOpen(true)}
        onBack={() => navigate('/library')}
        styleColors={prefs.styleColors}
        onStyleColorChange={handleStyleColorChange}
      />

      {/* Hairline progress bar — sits in the seam between the header
          and the reader column. We render zero width when the bar is
          empty so the leading-edge glow doesn't draw at idle. */}
      <div className="reader-progress" aria-hidden="true">
        <div
          className="reader-progress-fill"
          style={{ width: `${(Math.max(0, Math.min(1, progressPct)) * 100).toFixed(2)}%` }}
        />
      </div>

      <div className="flex-1 min-h-0 flex">
        {!isPDF && (
          <TocDrawer
            items={tocItems.length > 0 ? tocItems : chaptersToTocFallback(chapters)}
            activeChapterId={activeChapterId ?? chapters[chapterOrd]?.id ?? null}
            activeLabel={activeTocLabel}
            onPick={handleTocPick}
            locateTick={tocLocateTick}
            onLocateRequest={() => setTocLocateTick(t => t + 1)}
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
              styleColors={prefs.styleColors}
              onProgressAnchor={handleProgressAnchor}
              onActiveChapterChange={handleActiveChapterChange}
              onActiveHeadingText={handleActiveHeadingText}
              onProgressPercent={handleProgressPercent}
              initialAnchor={initialAnchor}
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
        chapterTitle={chapters.find(c => c.id === activeChapterId)?.title ?? undefined}
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

function chaptersToTocFallback(chapters: Chapter[]): TocItem[] {
  return chapters.map(c => ({
    label: c.title?.trim() || `第 ${c.ord + 1} 章`,
    chapterId: c.id,
    depth: 0,
  }));
}

// Detect whether `title` looks like an auto-generated placeholder put
// there by the ingest parser when the chapter file had no real title.
// We treat the title "第 N 章" (allowing punctuation, full-width spaces)
// AND a bare ord-derived count "Chapter 12" / "12" as placeholders.
// Real titles set by authors almost never collide with these, and
// hiding the placeholder in the header is a much better default than
// surfacing fabricated chapter numbers the user sees as "wrong".
function isAutoChapterTitle(title: string, ord: number): boolean {
  const t = title.replace(/\s+/g, '').trim();
  if (!t) return true;
  // "第N章" / "第N节" / "第N篇" — common in CJK ingest output.
  if (/^第[0-9零一二三四五六七八九十百千]+(章|节|節|篇|回|卷)$/.test(t)) return true;
  // Equal to chapter number alone.
  if (ord >= 0 && t === String(ord + 1)) return true;
  // English shapes: "Chapter 12", "Section 3".
  if (/^(chapter|section|part)\s*\d+$/i.test(title.trim())) return true;
  return false;
}

// Header — back / book+chapter title block / per-style colour
// chips with picker popover / AI / settings.
//
// Layout:
//
//   [←]      ┌─────────────────┐                  [高亮▾][下划▾][波浪▾][删除▾][笔记▾][AI][⚙]
//            │ Book Title      │
//            │ Chapter Title   │
//            └─────────────────┘
//
// Each colour chip in the right-side cluster is a button labelled with
// the style name and a swatch dot in the user's currently-set colour
// for that style. Clicking the chip opens a 6-swatch popover; picking
// a swatch updates the per-style preference (which then applies to
// all future annotations of that style and to the underlying highlight
// when creating a note from a fresh selection).
function ReaderHeader({
  bookTitle, chapterTitle, onSettings, onAI, onBack,
  styleColors, onStyleColorChange,
}: {
  bookTitle: string;
  chapterTitle: string;
  onSettings: () => void; onAI: () => void; onBack: () => void;
  styleColors: ReaderPrefs['styleColors'];
  onStyleColorChange: (s: HighlightStyle | 'note', c: HighlightColor) => void;
}) {
  // Three-zone layout (per the user's "书名放到左侧，章节放中间" feedback):
  //
  //   [← Book Title …………………………] [   Chapter Title   ] [chips][AI][⚙]
  //   └── left, flexes & truncates ─┘ └── absolute-centred ─┘ └── right ──┘
  //
  // The centre zone is absolutely positioned so it stays in the
  // viewport's horizontal middle regardless of how wide the left or
  // right zones are. We constrain its max-width and pointer-events so
  // it doesn't overlap the right-side controls when both titles are
  // long.
  return (
    <header className="reader-header">
      <div className="reader-header-left">
        <button
          onClick={onBack}
          className="reader-header-icon-btn"
          title="返回书架"
          aria-label="返回书架"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="reader-header-book" title={bookTitle}>
          {bookTitle}
        </div>
      </div>

      <div className="reader-header-center" aria-live="polite">
        {chapterTitle && (
          <div className="reader-header-chapter" title={chapterTitle}>
            {chapterTitle}
          </div>
        )}
      </div>

      <div className="reader-header-right">
        {/* Per-style colour cluster. Each chip opens a colour-picker
            popover; the active colour is shown as a swatch dot. */}
        <div className="reader-style-cluster" aria-label="批注样式与颜色">
          <StyleColorChip styleKey="highlight" label="高亮" current={styleColors.highlight} onPick={onStyleColorChange} />
          <StyleColorChip styleKey="underline" label="下划" current={styleColors.underline} onPick={onStyleColorChange} />
          <StyleColorChip styleKey="wavy"      label="波浪" current={styleColors.wavy}      onPick={onStyleColorChange} />
          <StyleColorChip styleKey="strike"    label="删除" current={styleColors.strike}    onPick={onStyleColorChange} />
          <StyleColorChip styleKey="note"      label="笔记" current={styleColors.note}      onPick={onStyleColorChange} />
        </div>

        <button
          onClick={onAI}
          className="reader-header-icon-btn"
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
          className="reader-header-icon-btn"
          title="阅读设置"
          aria-label="阅读设置"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
        </button>
      </div>
    </header>
  );
}

const COLOR_CYCLE: HighlightColor[] = ['yellow', 'red', 'green', 'blue', 'purple', 'orange'];

// Header chip + colour picker popover. Click toggles the popover open;
// picking a colour fires onPick(style, colour) and closes it.
//
// Why a popover (vs the previous "click to cycle"): users want to GO
// from "yellow" to "blue" without rotating through orange, red, and
// green. Popover gives one-tap selection and also acts as a passive
// indicator of "which colour is the default for this style right now".
function StyleColorChip({
  styleKey, label, current, onPick,
}: {
  styleKey: HighlightStyle | 'note';
  label: string;
  current: HighlightColor;
  onPick: (s: HighlightStyle | 'note', c: HighlightColor) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click + Esc.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="reader-style-chip"
        aria-haspopup="true"
        aria-expanded={open}
        title={`${label}：当前 ${colorZh(current)}色（点击选择）`}
      >
        <span
          className="reader-style-chip-dot"
          style={{ background: swatchHex(current) }}
        />
        <span className="reader-style-chip-label">{label}</span>
      </button>
      {open && (
        <div
          className="color-popover"
          style={{ top: '100%', right: 0, marginTop: 6 }}
          role="listbox"
          onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
        >
          {COLOR_CYCLE.map(c => (
            <button
              key={c}
              type="button"
              role="option"
              aria-selected={c === current}
              data-active={c === current ? '1' : undefined}
              className="color-popover-swatch"
              style={{ background: swatchHex(c) }}
              onClick={() => {
                onPick(styleKey, c);
                setOpen(false);
              }}
              title={colorZh(c)}
              aria-label={colorZh(c)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

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
function colorZh(c: HighlightColor): string {
  switch (c) {
    case 'yellow': return '黄';
    case 'red':    return '红';
    case 'green':  return '绿';
    case 'blue':   return '蓝';
    case 'purple': return '紫';
    case 'orange': return '橙';
  }
}
