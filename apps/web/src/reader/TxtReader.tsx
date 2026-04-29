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
  clearHighlights,
  encodeLocatorFromRange,
  wrapRange,
} from '../lib/annotations';
import {
  topVisibleAnchor,
  navigateToCFIv2,
  decodeLocatorAny,
  encodeLocatorV2,
  type CFIv2,
} from '../lib/locator';
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
  /** Per-style default colour for new annotations. Sourced from
   *  prefs.styleColors. The SelectionToolbar lets the user override
   *  per-annotation; existing annotations are NEVER auto-recoloured. */
  styleColors: ReaderPrefs['styleColors'];
  /** Called whenever the user lands on a new "current" paragraph
   *  (paginated: page flip / chapter load; scroll: throttled scroll).
   *  ReaderPage uses this to persist a CFIv2 progress anchor and to
   *  highlight the active TOC node. */
  onProgressAnchor?: (anchor: { chapterId: string; locator: string } | null) => void;
  /** Called whenever the topmost visible paragraph's enclosing
   *  TOC chapter changes — used by ReaderPage to drive the active
   *  TOC entry without it lagging behind page flips. */
  onActiveChapterChange?: (chapterId: string) => void;
  /** Called with a 0..1 reading-progress estimate. Combines the
   *  current chapter's ord with the in-chapter page fraction so the
   *  hairline progress bar in the reader chrome moves smoothly even
   *  inside long chapters. */
  onProgressPercent?: (pct: number) => void;
  /** Initial progress locator. When set on first mount, the reader
   *  navigates to the matching paragraph after the chapter renders. */
  initialAnchor?: { chapterId: string; locator: string } | null;
  /** When set, the reader scans the rendered chapter for this string,
   *  wraps every match in a temporary <mark.search-flash> span, and
   *  scrolls the first match into view. The flash auto-clears after
   *  3 seconds. Used by the search-result jump path. */
  searchKeyword?: string | null;
  searchTargetChapterId?: string | null;
  onSearchHandled?: () => void;
}

export default function TxtReader({
  bookId, prefs, chapterOrd, pageMode,
  onChapterChange, onReady, onBusy, onSelection,
  styleColors, onProgressAnchor, onActiveChapterChange, onProgressPercent, initialAnchor,
  searchKeyword, searchTargetChapterId, onSearchHandled,
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
  const anchorRestoredRef = useRef(false);

  // Load chapter list once.
  useEffect(() => {
    let cancelled = false;
    onBusy?.(true);
    anchorRestoredRef.current = false;  // new book → restore anchor again
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
        // Tell ReaderPage which chapter is now displayed so the TOC
        // dock can update its highlighted entry without lagging behind
        // the page-flip path.
        onActiveChapterChange?.(d.chapter.id);
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
      // reports a single column width, so we measure on the parent.
      //
      // We use Math.ceil rather than round: a chapter that overflows
      // by even one line needs a second page to be flippable. The old
      // round() cost the user the last page on chapters whose final
      // text didn't fill more than half the column.
      const track = root.parentElement as HTMLElement | null;
      if (track) {
        const total = track.scrollWidth;
        const view = track.clientWidth || 1;
        setPageCount(Math.max(1, Math.ceil(total / view)));
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
        const pages = Math.max(1, Math.ceil(total / view));
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
      const pages = Math.max(1, Math.ceil(total / view));
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

  // ── Progress restore ────────────────────────────────────────────
  // After a chapter renders (and pagination has settled), if the
  // initial anchor matches THIS chapter, navigate to its paragraph.
  // Once consumed we set anchorRestoredRef so subsequent chapter
  // changes (user navigation) don't try to re-anchor.
  useEffect(() => {
    if (anchorRestoredRef.current) return;
    if (!body || !initialAnchor) return;
    if (initialAnchor.chapterId !== body.id) return;
    const root = proseRef.current;
    if (!root) return;
    const dec = decodeLocatorAny(initialAnchor.locator);
    if (!dec) return;
    // Wait two frames so multicol has measured.
    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(() => {
        const r = root;
        if (!r) return;
        const trackEl = r.parentElement as HTMLElement | null;
        const cfi: CFIv2 | null = dec.version === 'cfiv2' && dec.steps
          ? { chapterId: dec.chapterId ?? body.id, steps: dec.steps }
          : null;
        if (!cfi) return;
        navigateToCFIv2(r, cfi, undefined, {
          paginated: pageMode === 'paginated',
          trackWidth: trackEl?.clientWidth ?? 0,
          onPage: idx => setPageIdx(idx),
          onScroll: el => el.scrollIntoView({ block: 'start', behavior: 'auto' }),
        });
        anchorRestoredRef.current = true;
      });
      void raf2;
    });
    return () => cancelAnimationFrame(raf1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, initialAnchor, pageMode, html]);

  // ── Progress emit ───────────────────────────────────────────────
  // When the user flips a page (paginated) or scrolls (scroll mode),
  // report a CFIv2 anchor for the topmost visible paragraph. Throttled
  // so rapid page-flips don't spam the parent.
  useEffect(() => {
    if (!body) return;
    const root = proseRef.current;
    if (!root) return;

    const emit = () => {
      const r = proseRef.current;
      if (!r) return;
      const anchor = topVisibleAnchor(r, body.id);
      if (!anchor) {
        onProgressAnchor?.(null);
        return;
      }
      onProgressAnchor?.({
        chapterId: body.id,
        locator: encodeLocatorV2(anchor),
      });
    };

    if (pageMode === 'paginated') {
      // Page index changed — wait one frame for the transform to
      // settle, then emit.
      const raf = requestAnimationFrame(emit);
      return () => cancelAnimationFrame(raf);
    } else {
      const sc = scrollRef.current;
      if (!sc) return;
      let timer: number | null = null;
      const onScroll = () => {
        if (timer != null) window.clearTimeout(timer);
        timer = window.setTimeout(emit, 150);
      };
      sc.addEventListener('scroll', onScroll, { passive: true });
      // First emit so the parent has an initial anchor.
      const raf = requestAnimationFrame(emit);
      return () => {
        if (timer != null) window.clearTimeout(timer);
        cancelAnimationFrame(raf);
        sc.removeEventListener('scroll', onScroll);
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, pageIdx, pageMode]);

  // ── Progress percent emission ───────────────────────────────────
  // We blend "which chapter we're in" with "how far through the
  // current chapter's pages we are". For scroll modes the page
  // fraction is approximated from scrollTop / scrollHeight; for
  // paginated it's pageIdx / max(pageCount-1, 1). The result is a
  // monotonic 0..1 value the reader chrome can render as a hairline
  // bar without thrashing on every render.
  useEffect(() => {
    if (!onProgressPercent || chapters.length === 0) return;
    const total = Math.max(1, chapters.length);
    const base = chapterOrd / total;
    const slice = 1 / total;

    const emit = () => {
      let frac = 0;
      if (pageMode === 'paginated') {
        frac = pageCount > 1 ? pageIdx / (pageCount - 1) : 0;
      } else {
        const sc = scrollRef.current;
        if (sc && sc.scrollHeight > sc.clientHeight) {
          frac = sc.scrollTop / (sc.scrollHeight - sc.clientHeight);
        }
      }
      const pct = Math.max(0, Math.min(1, base + frac * slice));
      onProgressPercent(pct);
    };

    emit();

    if (pageMode !== 'paginated') {
      const sc = scrollRef.current;
      if (!sc) return;
      let timer: number | null = null;
      const onScroll = () => {
        if (timer != null) window.clearTimeout(timer);
        timer = window.setTimeout(emit, 120);
      };
      sc.addEventListener('scroll', onScroll, { passive: true });
      return () => {
        if (timer != null) window.clearTimeout(timer);
        sc.removeEventListener('scroll', onScroll);
      };
    }
    return undefined;
  }, [chapters.length, chapterOrd, pageIdx, pageCount, pageMode, onProgressPercent]);

  // ── Search-result flash ─────────────────────────────────────────
  // When the user arrives via /search, ReaderPage forwards the keyword
  // and target chapter id. Once the matching chapter has rendered we
  // walk text nodes, wrap each occurrence in a `<mark.search-flash>`,
  // scroll the first match into view (or flip pages to it in paginated
  // mode), and remove the wrappers after 3 seconds.
  //
  // Implementation notes:
  //   • We deliberately don't use mark.js here: it's a 30 KB dependency
  //     and our wrap loop is ~30 lines for a single keyword. Adding a
  //     full library is unjustified when the existing FTS5 server-side
  //     match is already the "professional" search; this is just the
  //     in-page indicator.
  //   • Wrappers are tagged with data-search-flash so cleanup is a
  //     single querySelectorAll.
  //   • If the user navigates chapters before the timeout expires we
  //     still clear at the next render, because the next chapter's
  //     html overwrites the DOM tree entirely.
  useEffect(() => {
    if (!searchKeyword || !searchTargetChapterId) return;
    if (!body || body.id !== searchTargetChapterId) return;
    const root = proseRef.current;
    if (!root) return;
    // Run after the layout effect has applied saved highlights, so we
    // wrap on top of the final DOM and don't get clobbered.
    const handle = window.setTimeout(() => {
      const wrapped = wrapKeywordMatches(root, searchKeyword);
      if (wrapped.length === 0) {
        onSearchHandled?.();
        return;
      }
      // Scroll the first match into view. In paginated mode the
      // chapter content lives in a CSS multicol track that doesn't
      // accept scrollIntoView meaningfully (the column track itself
      // doesn't scroll; we do via translateX). Compute which page
      // contains the first match by measuring its offsetLeft against
      // the track's viewport width.
      const first = wrapped[0];
      if (pageMode === 'paginated') {
        const track = root.parentElement as HTMLElement | null;
        if (track) {
          const view = track.clientWidth || 1;
          // first.offsetLeft is relative to the TRACK (its offsetParent
          // is the column track). page index = floor(offsetLeft / view).
          const target = Math.max(0, Math.floor(first.offsetLeft / view));
          setPageIdx(target);
        }
      } else {
        first.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      const cleanup = window.setTimeout(() => {
        unwrapKeywordMatches(root);
      }, 3000);
      onSearchHandled?.();
      // We don't return cleanup because the inner timeout's wrappers
      // are also cleared by any subsequent render that replaces the
      // chapter's HTML, which is the more common path.
      void cleanup;
    }, 60);
    return () => window.clearTimeout(handle);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, searchKeyword, searchTargetChapterId, pageMode]);

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
    const locator = encodeLocatorFromRange(root, body.id, range);
    if (!locator) return;

    try {
      const created = await createHighlight(bookId, {
        chapterId: body.id,
        locator,
        selectedText: text,
        color,
        style,
      });
      // Wrap the live range immediately so the user sees the result
      // without waiting for the next chapter re-render.
      try {
        wrapRange(range.cloneRange(), created, false);
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
  void onCopy;  // kept for binary-compat with any external callers; the
                // toolbar no longer surfaces 复制 because Ctrl/Cmd+C
                // already handles the same case.

  // Recolour an existing annotation. The server doesn't expose a PATCH
  // endpoint for highlights yet, so we implement this client-side as
  // "delete the old row, insert a fresh one with the new colour at the
  // same locator". The user-visible effect is identical; the only
  // observable difference is a new id, which doesn't matter for any
  // current consumer (notes are also re-pointed to the new highlight
  // if one was attached).
  const onRecolor = useCallback(async (color: HighlightColor) => {
    if (!tbCurrent || !body) return;
    const old = tbCurrent;
    if (old.color === color) {
      setTbMode(null);
      setTbAnchor(null);
      return;
    }
    try {
      const created = await createHighlight(bookId, {
        chapterId: old.chapterId ?? body.id,
        locator: old.locator,
        selectedText: old.selectedText,
        color,
        style: old.style ?? 'highlight',
      });
      // Re-attach any note that was bound to the old highlight.
      const attachedNote = notes.find(n => n.highlightId === old.id);
      let migratedNote: typeof attachedNote = undefined;
      if (attachedNote) {
        try {
          migratedNote = await createNote(bookId, {
            highlightId: created.id,
            chapterId: attachedNote.chapterId ?? body.id,
            locator: attachedNote.locator,
            selectedText: attachedNote.selectedText ?? old.selectedText,
            body: attachedNote.body,
          });
          await deleteNote(attachedNote.id).catch(() => { /* ignore */ });
        } catch {
          // If we created the new highlight but couldn't migrate the
          // note, prefer to keep the old highlight so the note isn't
          // orphaned. Roll the new one back.
          await deleteHighlight(created.id).catch(() => { /* ignore */ });
          throw new Error('迁移笔记失败');
        }
      }
      await deleteHighlight(old.id).catch(() => { /* ignore */ });

      setHighlights(prev => [
        ...prev.filter(h => h.id !== old.id),
        created,
      ]);
      setNotes(prev => {
        const without = prev.filter(n => n.id !== attachedNote?.id);
        return migratedNote ? [...without, migratedNote] : without;
      });
    } catch (e) {
      console.error('recolor failed', e);
    }
    setTbCurrent(null);
    setTbMode(null);
    setTbAnchor(null);
  }, [bookId, body, notes, tbCurrent]);

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
    // highlight (using the highlight-style colour from styleColors —
    // notes are bound to a highlight visually) and a note linked to it.
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
    const txt = range.toString();
    if (!txt || txt.trim().length === 0) return;
    const locator = encodeLocatorFromRange(root, body.id, range);
    if (!locator) return;
    try {
      const hl = await createHighlight(bookId, {
        chapterId: body.id,
        locator,
        selectedText: txt,
        color: styleColors.highlight,
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
        wrapRange(range.cloneRange(), hl, true);
      } catch { /* fallthrough to next render */ }
      sel.removeAllRanges();
    } catch (e) {
      console.error('save note (new) failed', e);
    }
    setTbMode(null);
    setTbAnchor(null);
    onSelection?.(null);
  }, [tbCurrent, body, bookId, notes, onSelection, styleColors]);

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
              // Inline font styles are needed here because the parent
              // track element's font cascade is sometimes overridden
              // by descendant inline-styled elements in the chapter
              // HTML. Setting them on the prose root makes the picker
              // wins-everywhere — without this, swapping fontFamily in
              // the settings drawer had no visible effect because some
              // chapter content (e.g. <p style="..."> from imported
              // EPUBs) shadowed the parent style.
              style={{
                fontSize: prefs.fontSize + 'px',
                lineHeight: prefs.lineHeight,
                fontFamily: bodyFontFamily,
              }}
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
          styleColors={styleColors}
          onApplyHighlight={onApplyHighlight}
          onRecolor={onRecolor}
          onOpenNote={onOpenNote}
          onSaveNote={onSaveNote}
          onDeleteNote={onDeleteNote}
          onDelete={onDelete}
          onClose={closeToolbar}
        />
      )}
    </div>
  );
}

// PaginatedFrame implements horizontal pagination via CSS columns.
//
// Layout (THREE nested elements — earlier 2-element layout had a
// subtle bug: padding + multicol on the same node meant translateX
// shifted by `100% of padding-box`, which is bigger than `100% of
// content-box`. That excess shift on every page produced "first page
// blank, content cut between pages, last page lost" — the symptom
// we hit on long Chinese chapters):
//
//   <viewport>            // overflow:hidden, this is the visible area
//     <padder>            // padding only, defines the *content* box
//       <track>           // columns + translateX live HERE
//         {children}      // the prose
//       </track>
//     </padder>
//   </viewport>
//
// `track`'s `width: 100%` is 100% of its parent's content-box, which
// EXCLUDES padding. So the column page width = the viewport width
// minus padding, and translateX(-100%) shifts by exactly that. Pages
// align cleanly.
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
    <div
      className="h-full w-full"
      style={{ overflow: 'hidden', boxSizing: 'border-box' }}
    >
      <div
        style={{
          height: '100%',
          padding: '3rem 1.5rem',
          maxWidth: columnMaxWidth(prefs),
          margin: '0 auto',
          boxSizing: 'border-box',
          overflow: 'hidden',
        }}
      >
        <div
          className="reader-paginated-track"
          style={{
            height: '100%',
            width: '100%',
            boxSizing: 'border-box',
            fontSize: prefs.fontSize + 'px',
            lineHeight: prefs.lineHeight,
            fontFamily: bodyFontFamily,
            // CSS columns: column-width:100% gives us one column ==
            // one viewport-width-of-content. column-fill:auto keeps
            // columns at the track's height (otherwise Chrome
            // distributes content evenly across the track's columns,
            // which we don't want — we want pages packed top-down).
            columnWidth: '100%',
            columnGap: '0',
            columnFill: 'auto',
            transform: `translateX(${-pageIdx * 100}%)`,
            transition: 'transform 220ms cubic-bezier(0.2, 0, 0, 1)',
          }}
        >
          {children}
        </div>
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

// ── search-flash helpers ──────────────────────────────────────────────
// Wrap every text-node occurrence of `kw` (case-insensitive) inside
// `root` in a <mark class="search-flash" data-search-flash>. Returns
// the inserted marks in document order. We skip text inside existing
// mark/script/style nodes so we don't double-wrap.

function wrapKeywordMatches(root: HTMLElement, kw: string): HTMLElement[] {
  const needle = kw.trim();
  if (!needle) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n: Node) {
      const p = n.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (p.closest('mark, script, style')) return NodeFilter.FILTER_REJECT;
      if (!(n as Text).data) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets: Text[] = [];
  let n: Node | null = walker.nextNode();
  while (n) {
    targets.push(n as Text);
    n = walker.nextNode();
  }
  const lower = needle.toLowerCase();
  const out: HTMLElement[] = [];
  for (const node of targets) {
    const data = node.data;
    if (!data) continue;
    const dl = data.toLowerCase();
    let from = 0;
    let matchAt = dl.indexOf(lower, from);
    if (matchAt < 0) continue;
    // Build a sequence of text + mark fragments to replace this node.
    const frag = document.createDocumentFragment();
    while (matchAt >= 0) {
      if (matchAt > from) {
        frag.appendChild(document.createTextNode(data.slice(from, matchAt)));
      }
      const m = document.createElement('mark');
      m.className = 'search-flash';
      m.setAttribute('data-search-flash', '1');
      m.appendChild(document.createTextNode(data.slice(matchAt, matchAt + needle.length)));
      frag.appendChild(m);
      out.push(m);
      from = matchAt + needle.length;
      matchAt = dl.indexOf(lower, from);
    }
    if (from < data.length) {
      frag.appendChild(document.createTextNode(data.slice(from)));
    }
    node.parentNode?.replaceChild(frag, node);
  }
  return out;
}

function unwrapKeywordMatches(root: HTMLElement): void {
  const marks = root.querySelectorAll<HTMLElement>('mark[data-search-flash]');
  marks.forEach(m => {
    const parent = m.parentNode;
    if (!parent) return;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
  });
  // Adjacent text nodes may now be siblings — normalise so subsequent
  // offset arithmetic in lib/annotations isn't tripped up.
  root.normalize();
}
