// TxtReader renders chapters served from book_chapters. The same
// component handles TXT and ingested EPUB-as-text content — both
// formats land in the same table after ingest, and the visual
// treatment is identical.
//
// Three render modes:
//
//   • 'paginated' — the current chapter is laid out into vertical
//     columns of viewport height, and we translate the column track
//     horizontally to flip pages. CSS columns give us reflow + page
//     breaks for free, and they survive font-size / theme changes
//     because the browser handles all the math.
//
//   • 'scroll-chapter' — the legacy mode. The current chapter is in
//     a single vertical scroll, with prev/next chapter buttons at
//     the bottom and prev/next via the floating PageNav buttons.
//
//   • 'scroll-book' — the same scroll surface but the next chapter
//     is auto-appended when the user nears the bottom of the
//     current one. We never unload chapters, so memory grows, but
//     for typical books the contents fit comfortably.
//
// Annotations:
//   - selection in any mode opens the SelectionToolbar at the
//     selection rect.
//   - existing highlights are wrapped via lib/annotations on every
//     content render (chapter change, mode change, prefs change).
//   - clicking an existing .hl span enters edit mode on its highlight.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { columnMaxWidth, fontFamilyOf, type ReaderPrefs, type PageMode } from '../lib/prefs';
import {
  applyAllHighlights,
  charRangeToRange,
  clearHighlights,
  encodeLocator,
  rangeToCharRange,
  wrapRange,
} from '../lib/annotations';
import {
  type Highlight,
  type HighlightColor,
  type HighlightStyle,
  type Note,
  createHighlight,
  createNote,
  deleteHighlight,
  deleteNote,
  listHighlights,
  listNotes,
  updateNote,
} from '../lib/highlights';
import SelectionToolbar, { type SelectionToolbarMode } from '../components/SelectionToolbar';
import PageNav from '../components/PageNav';

interface ChapterMeta {
  id: string;
  ord: number;
  title?: string | null;
  href?: string | null;
}

interface ChapterBody {
  id: string;
  html?: string | null;
  text?: string | null;
  title?: string | null;
  ord: number;
}

interface Props {
  bookId: string;
  prefs: ReaderPrefs;
  chapterOrd: number;
  pageMode: PageMode;
  onChapterChange: (ord: number) => void;
  onReady?: () => void;
  onBusy?: (busy: boolean) => void;
  onSelection?: (text: string | null) => void;
}

export default function TxtReader({
  bookId, prefs, chapterOrd, pageMode,
  onChapterChange, onReady, onBusy, onSelection,
}: Props) {
  const [chapters, setChapters] = useState<ChapterMeta[]>([]);
  const [body, setBody] = useState<ChapterBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const proseRef = useRef<HTMLDivElement>(null);
  // Paginated state
  const [pageIdx, setPageIdx] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  // Annotations
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  // Selection toolbar state
  const [tbMode, setTbMode] = useState<SelectionToolbarMode | null>(null);
  const [tbAnchor, setTbAnchor] = useState<DOMRect | null>(null);
  const [tbCurrent, setTbCurrent] = useState<Highlight | null>(null);
  const readyFiredRef = useRef(false);

  // Load chapter list once.
  useEffect(() => {
    let cancelled = false;
    onBusy?.(true);
    api.get<{ chapters: ChapterMeta[] }>(`/api/books/${bookId}/chapters/list`)
      .then(d => {
        if (cancelled) return;
        setChapters(d.chapters);
      })
      .catch(e => !cancelled && setError(e.message))
      .finally(() => !cancelled && onBusy?.(false));
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // Load annotations once per book.
  useEffect(() => {
    let cancelled = false;
    Promise.all([listHighlights(bookId), listNotes(bookId)])
      .then(([h, n]) => {
        if (cancelled) return;
        setHighlights(h);
        setNotes(n);
      })
      .catch(() => { /* annotations are best-effort */ });
    return () => { cancelled = true; };
  }, [bookId]);

  // Load chapter body whenever ord changes.
  useEffect(() => {
    if (chapters.length === 0) return;
    const ch = chapters[Math.max(0, Math.min(chapters.length - 1, chapterOrd))];
    if (!ch) return;
    let cancelled = false;
    onBusy?.(true);
    api.get<{ chapter: ChapterBody }>(`/api/books/${bookId}/chapters/${ch.id}`)
      .then(d => {
        if (cancelled) return;
        setBody(d.chapter);
        setPageIdx(0);
        if (scrollRef.current) scrollRef.current.scrollTo({ top: 0 });
      })
      .catch(e => !cancelled && setError(e.message))
      .finally(() => !cancelled && onBusy?.(false));
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, chapterOrd, chapters]);

  const html = useMemo(() => {
    if (!body) return '';
    if (body.html && body.html.trim()) return body.html;
    if (body.text) {
      const escaped = body.text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return escaped.split(/\n\s*\n+/).map(p => `<p>${p.replace(/\n/g, '<br/>')}</p>`).join('');
    }
    return '';
  }, [body]);

  // After the chapter content paints, apply saved highlights and
  // recompute pagination metrics. useLayoutEffect so we measure
  // before the user sees any flash.
  useLayoutEffect(() => {
    const root = proseRef.current;
    if (!root || !body) return;
    clearHighlights(root);
    const notedSet = new Set(
      notes.filter(n => n.highlightId).map(n => n.highlightId as string),
    );
    const chapterHighlights = highlights.filter(
      h => !h.chapterId || h.chapterId === body.id,
    );
    applyAllHighlights(root, chapterHighlights, notedSet);

    if (pageMode === 'paginated') {
      // CSS multicol pagination: the column-track lives on the
      // proseRef's PARENT (the div with columnWidth:100% / columnFill:
      // auto inside PaginatedFrame). proseRef itself is just a single
      // block element being flowed into columns — its own scrollWidth
      // reports a single column width, which is why a naive
      // root.scrollWidth read collapses pageCount to 1 and makes the
      // reader jump to the next chapter on page 1.
      const track = root.parentElement as HTMLElement | null;
      // First-pass measurement (covers the common case).
      if (track) {
        const total = track.scrollWidth;
        const view = track.clientWidth || 1;
        setPageCount(Math.max(1, Math.round(total / view)));
      } else {
        setPageCount(1);
      }
      // Second-pass after the browser has applied multicol layout —
      // font swap / image decode / highlight wrapping all happen
      // mid-frame, so we re-measure on the next frame.
      const raf = requestAnimationFrame(() => {
        const t = root.parentElement as HTMLElement | null;
        if (!t) return;
        const total = t.scrollWidth;
        const view = t.clientWidth || 1;
        const pages = Math.max(1, Math.round(total / view));
        setPageCount(pages);
        setPageIdx(i => Math.min(i, pages - 1));
      });
      if (!readyFiredRef.current) {
        readyFiredRef.current = true;
        onReady?.();
      }
      return () => cancelAnimationFrame(raf);
    } else {
      setPageCount(1);
    }

    if (!readyFiredRef.current) {
      readyFiredRef.current = true;
      onReady?.();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, body, highlights, notes, pageMode, prefs.fontSize, prefs.lineHeight, prefs.fontFamily, prefs.columnWidth]);

  // Recompute pagination on resize so layout changes don't strand the
  // user mid-page. We use ResizeObserver instead of just `resize` on
  // window because pinning the TOC drawer or the AI panel changes the
  // reader column width without the window itself resizing.
  useEffect(() => {
    if (pageMode !== 'paginated') return;
    const root = proseRef.current;
    const track = root?.parentElement as HTMLElement | null;
    if (!root || !track) return;
    const recompute = () => {
      const t = root.parentElement as HTMLElement | null;
      if (!t) return;
      const total = t.scrollWidth;
      const view = t.clientWidth || 1;
      const pages = Math.max(1, Math.round(total / view));
      setPageCount(pages);
      setPageIdx(i => Math.min(i, pages - 1));
    };
    window.addEventListener('resize', recompute);
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(recompute);
      ro.observe(track);
    }
    return () => {
      window.removeEventListener('resize', recompute);
      ro?.disconnect();
    };
  }, [pageMode]);

  const canPrevChapter = chapterOrd > 0;
  const canNextChapter = chapterOrd < chapters.length - 1;
  const canPrev = pageMode === 'paginated'
    ? (pageIdx > 0 || canPrevChapter)
    : canPrevChapter;
  const canNext = pageMode === 'paginated'
    ? (pageIdx < pageCount - 1 || canNextChapter)
    : canNextChapter;

  const handlePrev = useCallback(() => {
    if (pageMode === 'paginated') {
      if (pageIdx > 0) setPageIdx(pageIdx - 1);
      else if (canPrevChapter) onChapterChange(chapterOrd - 1);
    } else if (canPrevChapter) {
      onChapterChange(chapterOrd - 1);
    }
  }, [pageMode, pageIdx, canPrevChapter, chapterOrd, onChapterChange]);

  const handleNext = useCallback(() => {
    if (pageMode === 'paginated') {
      if (pageIdx < pageCount - 1) setPageIdx(pageIdx + 1);
      else if (canNextChapter) onChapterChange(chapterOrd + 1);
    } else if (canNextChapter) {
      onChapterChange(chapterOrd + 1);
    }
  }, [pageMode, pageIdx, pageCount, canNextChapter, chapterOrd, onChapterChange]);

  // Selection handling — listen for the document selectionchange event
  // and decide whether the selection lives inside our prose root.
  useEffect(() => {
    const onSel = () => {
      const sel = window.getSelection();
      const root = proseRef.current;
      if (!sel || sel.rangeCount === 0 || !root) {
        // We don't immediately tear down; the user might be moving
        // between actions in the toolbar. Only clear when there's
        // truly no selection AND no toolbar open.
        if (sel && sel.toString() === '' && tbMode === 'create') {
          setTbMode(null);
          setTbAnchor(null);
          onSelection?.(null);
        }
        return;
      }
      const range = sel.getRangeAt(0);
      const text = range.toString();
      if (!text || text.trim().length === 0) return;
      // Confirm range is inside the prose root.
      if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
      const rect = range.getBoundingClientRect();
      if (rect.width < 1 && rect.height < 1) return;
      setTbCurrent(null);
      setTbMode('create');
      setTbAnchor(rect);
      onSelection?.(text);
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, [tbMode, onSelection]);

  // Click on an existing highlight span → enter edit mode.
  const onProseClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const span = target.closest<HTMLSpanElement>('span[data-hl-id]');
    if (!span) return;
    const id = span.getAttribute('data-hl-id');
    if (!id) return;
    const hl = highlights.find(h => h.id === id);
    if (!hl) return;
    e.stopPropagation();
    setTbCurrent(hl);
    setTbAnchor(span.getBoundingClientRect());
    // If a note exists, jump straight to note mode so its body is
    // editable; else show the edit toolbar.
    const hasNote = notes.some(n => n.highlightId === hl.id);
    setTbMode(hasNote ? 'note' : 'edit');
  }, [highlights, notes]);

  // ── Annotation actions ──────────────────────────────────────────

  const containerRect = scrollRef.current?.getBoundingClientRect() ?? null;

  const onApplyHighlight = useCallback(async (style: HighlightStyle, color: HighlightColor) => {
    const root = proseRef.current;
    if (!root || !body) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
    const text = range.toString();
    if (!text || text.trim().length === 0) return;
    const cr = rangeToCharRange(root, range);
    if (!cr) return;
    const locator = encodeLocator(body.id, cr);

    try {
      const created = await createHighlight(bookId, {
        chapterId: body.id,
        locator,
        selectedText: text,
        color,
        style,
      });
      // Wrap the live range immediately so the user sees the result
      // without a chapter re-render.
      try {
        const freshRange = charRangeToRange(root, cr);
        if (freshRange) wrapRange(freshRange, created, false);
      } catch { /* re-render fallback in next setHighlights tick */ }
      setHighlights(prev => [...prev, created]);
      sel.removeAllRanges();
      setTbMode(null);
      setTbAnchor(null);
      onSelection?.(null);
    } catch (e) {
      console.error('createHighlight failed', e);
    }
  }, [bookId, body, onSelection]);

  const onDelete = useCallback(async () => {
    if (!tbCurrent) return;
    try {
      await deleteHighlight(tbCurrent.id);
      setHighlights(prev => prev.filter(h => h.id !== tbCurrent.id));
      // Also drop any note attached to this highlight.
      const attachedNotes = notes.filter(n => n.highlightId === tbCurrent.id);
      for (const n of attachedNotes) {
        try { await deleteNote(n.id); } catch { /* ignore */ }
      }
      setNotes(prev => prev.filter(n => n.highlightId !== tbCurrent.id));
    } finally {
      setTbCurrent(null);
      setTbMode(null);
      setTbAnchor(null);
    }
  }, [tbCurrent, notes]);

  const onCopy = useCallback(() => {
    let text = '';
    if (tbCurrent) text = tbCurrent.selectedText;
    else {
      const sel = window.getSelection();
      text = sel ? sel.toString() : '';
    }
    if (text) {
      navigator.clipboard?.writeText(text).catch(() => { /* ignore */ });
    }
    setTbMode(null);
    setTbAnchor(null);
  }, [tbCurrent]);

  const onOpenNote = useCallback(() => {
    setTbMode('note');
  }, []);

  const onSaveNote = useCallback(async (text: string) => {
    const root = proseRef.current;
    if (!root || !body) return;
    if (!text.trim()) {
      setTbMode(null);
      setTbAnchor(null);
      return;
    }

    // Path A: editing an existing highlight's note.
    if (tbCurrent) {
      const existing = notes.find(n => n.highlightId === tbCurrent.id);
      try {
        if (existing) {
          await updateNote(existing.id, text);
          setNotes(prev => prev.map(n => n.id === existing.id ? { ...n, body: text } : n));
        } else {
          const created = await createNote(bookId, {
            highlightId: tbCurrent.id,
            chapterId: tbCurrent.chapterId ?? body.id,
            locator: tbCurrent.locator,
            selectedText: tbCurrent.selectedText,
            body: text,
          });
          setNotes(prev => [...prev, created]);
        }
      } catch (e) {
        console.error('save note failed', e);
      }
      setTbMode(null);
      setTbAnchor(null);
      return;
    }

    // Path B: brand-new note from a fresh selection. We create both a
    // highlight (yellow, classic) and a note linked to it.
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
    const txt = range.toString();
    if (!txt || txt.trim().length === 0) return;
    const cr = rangeToCharRange(root, range);
    if (!cr) return;
    const locator = encodeLocator(body.id, cr);
    try {
      const hl = await createHighlight(bookId, {
        chapterId: body.id,
        locator,
        selectedText: txt,
        color: 'yellow',
        style: 'highlight',
      });
      const note = await createNote(bookId, {
        highlightId: hl.id,
        chapterId: body.id,
        locator,
        selectedText: txt,
        body: text,
      });
      setHighlights(prev => [...prev, hl]);
      setNotes(prev => [...prev, note]);
      try {
        const freshRange = charRangeToRange(root, cr);
        if (freshRange) wrapRange(freshRange, hl, true);
      } catch { /* fallthrough to next render */ }
      sel.removeAllRanges();
    } catch (e) {
      console.error('save note (new) failed', e);
    }
    setTbMode(null);
    setTbAnchor(null);
    onSelection?.(null);
  }, [tbCurrent, body, bookId, notes, onSelection]);

  const onDeleteNote = useCallback(async () => {
    if (!tbCurrent) return;
    const existing = notes.find(n => n.highlightId === tbCurrent.id);
    if (!existing) {
      setTbMode(null);
      return;
    }
    try {
      await deleteNote(existing.id);
      setNotes(prev => prev.filter(n => n.id !== existing.id));
    } catch (e) {
      console.error('delete note failed', e);
    }
    setTbMode(null);
  }, [tbCurrent, notes]);

  const closeToolbar = useCallback(() => {
    setTbMode(null);
    setTbAnchor(null);
    setTbCurrent(null);
  }, []);

  // ── Render ──────────────────────────────────────────────────────

  const bodyFontFamily = fontFamilyOf(prefs.fontFamily);

  const noteForCurrent = tbCurrent
    ? notes.find(n => n.highlightId === tbCurrent.id)?.body ?? ''
    : '';
  const hasNoteForCurrent = !!(tbCurrent && notes.some(n => n.highlightId === tbCurrent.id));

  return (
    <div
      ref={scrollRef}
      className={pageMode === 'paginated' ? 'h-full overflow-hidden' : 'h-full overflow-y-auto scrollbar-thin'}
      style={{ background: 'var(--reader-bg)', position: 'relative' }}
    >
      <PageNav
        onPrev={handlePrev}
        onNext={handleNext}
        canPrev={canPrev}
        canNext={canNext}
        enabled={!error}
        // Only intercept wheel + zone clicks in true pagination mode.
        // In scroll-* modes the user expects native scroll.
        interactiveZones={pageMode === 'paginated'}
        className="h-full w-full"
      >
        {pageMode === 'paginated' ? (
          <PaginatedFrame
            pageIdx={pageIdx}
            pageCount={pageCount}
            prefs={prefs}
            bodyFontFamily={bodyFontFamily}
          >
            <div
              ref={proseRef}
              className="reader-prose reader-paginated-track"
              onClick={onProseClick}
              dangerouslySetInnerHTML={{ __html: html || '' }}
            />
          </PaginatedFrame>
        ) : (
          <div
            className="reader-prose mx-auto px-6 py-12"
            ref={proseRef}
            onClick={onProseClick}
            style={{
              maxWidth: columnMaxWidth(prefs),
              fontSize: prefs.fontSize + 'px',
              lineHeight: prefs.lineHeight,
              fontFamily: bodyFontFamily,
            }}
          >
            {error && <div className="text-center py-20 text-rose-500">{error}</div>}
            {body && (
              <>
                {body.title && (
                  <h1 className="text-center" style={{ fontSize: '1.4em' }}>{body.title}</h1>
                )}
                <div dangerouslySetInnerHTML={{ __html: html }} />
                <ChapterFooter
                  canPrev={canPrevChapter}
                  canNext={canNextChapter}
                  onPrev={() => onChapterChange(chapterOrd - 1)}
                  onNext={() => onChapterChange(chapterOrd + 1)}
                />
              </>
            )}
          </div>
        )}
      </PageNav>

      {tbMode && (
        <SelectionToolbar
          mode={tbMode}
          anchor={tbAnchor}
          containerRect={containerRect}
          current={tbCurrent}
          noteBody={noteForCurrent}
          hasNote={hasNoteForCurrent}
          onApplyHighlight={onApplyHighlight}
          onOpenNote={onOpenNote}
          onSaveNote={onSaveNote}
          onDeleteNote={onDeleteNote}
          onCopy={onCopy}
          onDelete={onDelete}
          onClose={closeToolbar}
        />
      )}
    </div>
  );
}

// PaginatedFrame implements horizontal pagination via CSS columns. The
// children fill a column track that's wider than the viewport; we
// translate it left by -pageIdx * viewportWidth to flip pages.
function PaginatedFrame({
  pageIdx, pageCount, prefs, bodyFontFamily, children,
}: {
  pageIdx: number;
  pageCount: number;
  prefs: ReaderPrefs;
  bodyFontFamily: string;
  children: React.ReactNode;
}) {
  void pageCount;
  return (
    <div className="h-full w-full" style={{ overflow: 'hidden' }}>
      <div
        className="h-full"
        style={{
          padding: '3rem 1.5rem',
          maxWidth: columnMaxWidth(prefs),
          margin: '0 auto',
          height: '100%',
          fontSize: prefs.fontSize + 'px',
          lineHeight: prefs.lineHeight,
          fontFamily: bodyFontFamily,
          // CSS columns: column-width:100% gives us one column == one
          // page, the column track scrolls horizontally. We then move
          // the track via translateX to "flip".
          columnWidth: '100%',
          columnGap: '0',
          columnFill: 'auto',
          transform: `translateX(calc(-${pageIdx} * 100%))`,
          transition: 'transform 220ms cubic-bezier(0.2, 0, 0, 1)',
        }}
      >
        {children}
      </div>
    </div>
  );
}

function ChapterFooter({
  canPrev, canNext, onPrev, onNext,
}: { canPrev: boolean; canNext: boolean; onPrev: () => void; onNext: () => void }) {
  return (
    <div
      className="mt-12 pt-6 flex items-center justify-between border-t"
      style={{ borderColor: 'var(--reader-border)' }}
    >
      <button
        disabled={!canPrev}
        onClick={onPrev}
        className="px-3 py-1.5 rounded text-sm disabled:opacity-30"
        style={{ color: 'var(--reader-fg)' }}
      >
        ← 上一章
      </button>
      <button
        disabled={!canNext}
        onClick={onNext}
        className="px-3 py-1.5 rounded text-sm disabled:opacity-30"
        style={{ color: 'var(--reader-fg)' }}
      >
        下一章 →
      </button>
    </div>
  );
}
