// EPUB reader. Uses epubjs to render the original .epub file inside a
// sandboxed iframe with CFI-based pagination.
//
// Three things this version gets right that the previous one didn't:
//
//   1. *Progress restoration*. Mounting now opens the book directly at
//      `spine[chapterOrd].href`. The first 'relocated' event from
//      epubjs (which fires immediately at index 0 before the display
//      promise resolves) is suppressed via a one-shot ref guard so we
//      never overwrite the saved chapter ord with 0.
//
//   2. *Reader-busy signalling*. Whenever epubjs is rendering — first
//      paint, theme change, chapter jump — we flip onBusy(true) so the
//      ReaderPage's blocking modal can stay up until the rendition is
//      ready. We use the rendition's own 'rendered' event for this.
//
//   3. *Selection reporting*. We listen for 'selected' on the
//      rendition, pull the selected text out of the iframe, and bubble
//      it up via onSelection so the host can show the selection
//      toolbar even though epubjs renders inside an iframe we don't
//      directly own.
//
// We deliberately keep highlight wiring out of EpubReader for now — the
// host only mounts the floating SelectionToolbar in chapter-based
// readers (TxtReader). Doing range overlays inside the epubjs iframe
// requires their CFI annotation API and a separate rendering pipeline,
// which is a larger surface area than fits this milestone.
//
// pageMode handling:
//   • 'paginated' → epubjs flow: 'paginated' (default e-reader feel)
//   • 'scroll-chapter' / 'scroll-book' → flow: 'scrolled-doc' inside
//     the chapter; book-wide scroll isn't natively supported by
//     epubjs's iframe model so we fall back to scrolled chapter.

import { useEffect, useRef, useState } from 'react';
import type { ReaderPrefs, PageMode } from '../lib/prefs';
import { fontFamilyOf } from '../lib/prefs';
import PageNav from '../components/PageNav';

interface Props {
  bookId: string;
  prefs: ReaderPrefs;
  /** Chapter ord the user picked from the TOC (we map → spine index). */
  chapterOrd: number;
  pageMode: PageMode;
  onLocationChange: (ord: number) => void;
  onReady?: () => void;
  onBusy?: (busy: boolean) => void;
  onSelection?: (text: string | null) => void;
}

interface EpubBook {
  ready: Promise<void>;
  destroy(): void;
  spine: { items: Array<{ idref: string; href: string; index?: number }> };
  renderTo(el: HTMLElement, opts: Record<string, unknown>): EpubRendition;
  loaded: { navigation: Promise<{ toc: unknown[] }> };
}
interface EpubRendition {
  display(target?: string | number): Promise<void>;
  prev(): Promise<void>;
  next(): Promise<void>;
  on(ev: string, cb: (...args: unknown[]) => void): void;
  off?(ev: string, cb: (...args: unknown[]) => void): void;
  themes: {
    register(name: string, rules: Record<string, Record<string, string>>): void;
    select(name: string): void;
    fontSize(s: string): void;
  };
  destroy(): void;
}

export default function EpubReader({
  bookId, prefs, chapterOrd, pageMode,
  onLocationChange, onReady, onBusy, onSelection,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const renditionRef = useRef<EpubRendition | null>(null);
  const bookRef = useRef<EpubBook | null>(null);
  // The very first 'relocated' event fires synchronously after display()
  // and reports the destination's index. Without this guard, mount-time
  // location callbacks (chapterOrd=savedOrd) and post-mount user
  // navigation are indistinguishable. We swallow exactly one event,
  // which is the one fired by our initial display() call.
  const initialRelocateRef = useRef(true);
  const [error, setError] = useState<string | null>(null);
  // Initial chapter is captured once at mount and ignored thereafter —
  // the chapterOrd-changed effect handles user TOC clicks. Without
  // this, every chapterOrd change would force a full book re-init.
  const initialOrdRef = useRef(chapterOrd);

  // Mount + destroy. Only re-runs when bookId changes.
  useEffect(() => {
    let cancelled = false;
    onBusy?.(true);
    setError(null);

    (async () => {
      try {
        const ePub = (await import('epubjs')).default as unknown as (input: ArrayBuffer | string) => EpubBook;
        const res = await fetch(`/api/books/${bookId}/file`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (cancelled) return;

        const book = ePub(buf);
        bookRef.current = book;
        await book.ready;
        if (cancelled || !containerRef.current) return;

        const flow = pageMode === 'paginated' ? 'paginated' : 'scrolled-doc';
        const rendition = book.renderTo(containerRef.current, {
          width: '100%',
          height: '100%',
          spread: 'none',
          flow,
          allowScriptedContent: false,
        });
        renditionRef.current = rendition;
        applyTheme(rendition, prefs);

        // Wire selection BEFORE display so the first chapter's iframe
        // already has the listener attached when its DOM appears.
        rendition.on('selected', (...args: unknown[]) => {
          const cfi = args[0];
          const contents = args[1] as
            | { window?: Window; document?: Document }
            | undefined;
          // contents.window.getSelection() returns the selection inside
          // the rendition's sandboxed iframe.
          const sel = contents?.window?.getSelection?.();
          const text = sel ? sel.toString() : '';
          // Surface a non-empty selection so the host can decide what
          // to do with it (currently: ignore — Epub annotations are a
          // future extension. The cfi parameter is plumbed through for
          // when we wire highlights into the iframe).
          void cfi;
          onSelection?.(text && text.trim().length > 0 ? text : null);
        });

        rendition.on('relocated', (...args: unknown[]) => {
          // Suppress the first relocate so we don't overwrite the
          // saved chapter ord with the index of where we just told
          // epubjs to land.
          if (initialRelocateRef.current) {
            initialRelocateRef.current = false;
            return;
          }
          const loc = args[0] as { start?: { index?: number } } | undefined;
          const idx = loc?.start?.index;
          if (typeof idx === 'number') onLocationChange(idx);
        });

        rendition.on('rendered', () => {
          // Each chapter render finishes here. We mute the busy flag
          // so the modal closes; the host re-arms it on theme/chapter
          // change via the prefs / chapterOrd effects below.
          if (!cancelled) onBusy?.(false);
        });

        // Open at the saved chapter ord.
        const target = book.spine.items[initialOrdRef.current];
        await rendition.display(target?.href ?? undefined);

        if (!cancelled) {
          onReady?.();
          onBusy?.(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message ?? 'EPUB 加载失败');
          onBusy?.(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      try { renditionRef.current?.destroy(); } catch { /* ignore */ }
      try { bookRef.current?.destroy(); } catch { /* ignore */ }
      renditionRef.current = null;
      bookRef.current = null;
      initialRelocateRef.current = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // React to TOC clicks: jump to spine[chapterOrd]. Skips the synthetic
  // first run because initialOrdRef captures it.
  useEffect(() => {
    if (chapterOrd === initialOrdRef.current) return;
    const r = renditionRef.current;
    const b = bookRef.current;
    if (!r || !b) return;
    const item = b.spine.items[chapterOrd];
    if (!item) return;
    onBusy?.(true);
    r.display(item.href).catch(() => { /* swallow */ });
  }, [chapterOrd, onBusy]);

  // React to prefs changes — push theme + font into the iframe. Theme
  // changes don't trigger 'rendered', so we time-bound the busy flag
  // ourselves with a microtask + RAF so the modal can render the
  // updated content.
  useEffect(() => {
    const r = renditionRef.current;
    if (!r) return;
    onBusy?.(true);
    applyTheme(r, prefs);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => onBusy?.(false));
    });
  }, [prefs, onBusy]);

  // pageMode change requires us to re-create the rendition because
  // epubjs's flow option is set at renderTo time. We re-init by
  // changing the bookId effect's dependency artificially — the
  // simplest correct path is destroying + recreating directly here.
  useEffect(() => {
    const b = bookRef.current;
    const old = renditionRef.current;
    if (!b || !old || !containerRef.current) return;
    onBusy?.(true);
    try { old.destroy(); } catch { /* ignore */ }
    const flow = pageMode === 'paginated' ? 'paginated' : 'scrolled-doc';
    const rendition = b.renderTo(containerRef.current, {
      width: '100%',
      height: '100%',
      spread: 'none',
      flow,
      allowScriptedContent: false,
    });
    renditionRef.current = rendition;
    applyTheme(rendition, prefs);

    rendition.on('selected', (...args: unknown[]) => {
      const contents = args[1] as { window?: Window } | undefined;
      const sel = contents?.window?.getSelection?.();
      const text = sel ? sel.toString() : '';
      onSelection?.(text && text.trim().length > 0 ? text : null);
    });
    rendition.on('relocated', (...args: unknown[]) => {
      if (initialRelocateRef.current) {
        initialRelocateRef.current = false;
        return;
      }
      const loc = args[0] as { start?: { index?: number } } | undefined;
      const idx = loc?.start?.index;
      if (typeof idx === 'number') onLocationChange(idx);
    });
    rendition.on('rendered', () => onBusy?.(false));

    initialRelocateRef.current = true;
    const target = b.spine.items[chapterOrd];
    rendition.display(target?.href ?? undefined).catch(() => onBusy?.(false));
  // We intentionally only rerun this when pageMode flips. chapterOrd
  // changes are handled by their own effect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageMode]);

  function prev() { renditionRef.current?.prev().catch(() => { /* */ }); }
  function next() { renditionRef.current?.next().catch(() => { /* */ }); }

  // In scrolled flow, suppress click zones (the iframe wants the wheel
  // for its own scrolling), but keep the floating buttons for chapter
  // hopping. The buttons map to prev/next which epubjs interprets as
  // "scroll one page worth" in scrolled mode.
  const interactiveZones = pageMode === 'paginated';

  return (
    <div
      className="h-full relative"
      style={{ background: 'var(--reader-bg)', color: 'var(--reader-fg)' }}
    >
      {error && (
        <div className="absolute inset-0 flex items-center justify-center text-rose-500 px-6 text-center">
          EPUB 渲染失败：{error}
        </div>
      )}

      <PageNav
        onPrev={prev}
        onNext={next}
        canPrev={true}
        canNext={true}
        enabled={!error}
        interactiveZones={interactiveZones}
      >
        <div ref={containerRef} className="h-full w-full" />
      </PageNav>
    </div>
  );
}

function applyTheme(r: EpubRendition, prefs: ReaderPrefs) {
  const cs = getComputedStyle(document.documentElement);
  const bg = cs.getPropertyValue('--reader-bg').trim() || '#FAF7F2';
  const fg = cs.getPropertyValue('--reader-fg').trim() || '#1B2230';
  const family = fontFamilyOf(prefs.fontFamily);

  r.themes.register('bookfree', {
    'body, html': {
      background: bg,
      color: fg,
      'font-family': family,
      'line-height': String(prefs.lineHeight),
    },
    'p, li, span, div': {
      color: fg,
    },
    'a': {
      color: 'var(--reader-accent, #7C5A3A)',
    },
  });
  r.themes.select('bookfree');
  r.themes.fontSize(prefs.fontSize + 'px');
}
