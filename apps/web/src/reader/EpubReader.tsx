// EPUB reader. Uses epubjs to render the original .epub file inside a
// sandboxed iframe with CFI-based pagination.
//
// Three things this version gets right that the previous one didn't:
//
//   1. *No re-render loop on navigation*. The previous version captured
//      the saved chapter ord into `initialOrdRef` once at mount and
//      compared every later chapterOrd against it. As soon as the user
//      flipped past the saved chapter, the chapterOrd-effect saw
//      "current ≠ initial" forever and re-fired `r.display()` on every
//      page flip — which fires `onBusy(true)` and pops the
//      "正在重新渲染" modal mid-read for no reason. We now track the
//      *last seen* ord, updated both when we display() ourselves and
//      when epub.js reports a relocate. The effect only re-displays
//      when the prop differs from what's already on screen.
//
//   2. *Wheel flips work everywhere on the page*, not just over the
//      parent-level click zones. Events inside an iframe never bubble
//      to the parent, so the previous version only flipped on wheel
//      when the cursor was over the left/right zones. We now install
//      attachWheelPager inside each rendered iframe document on the
//      'rendered' event, so wheel-on-the-prose flips just like
//      wheel-on-the-zone.
//
//   3. *Font selection actually changes the typeface*. Most EPUB
//      stylesheets put `font-family` directly on `p`, `div`, etc.,
//      which beat our `body, html` rule. We now apply the family to
//      every selector with !important so the picker has authority
//      over the embedded styles.
//
// pageMode handling:
//   • 'paginated' → epubjs flow: 'paginated' (default e-reader feel)
//   • 'scroll-chapter' / 'scroll-book' → flow: 'scrolled-doc' inside
//     the chapter; book-wide scroll isn't natively supported by
//     epubjs's iframe model so we fall back to scrolled chapter.

import { useEffect, useRef, useState } from 'react';
import type { ReaderPrefs, PageMode } from '../lib/prefs';
import { fontFamilyOf } from '../lib/prefs';
import { getThemeColors } from '../lib/themes';
import PageNav, { attachWheelPager } from '../components/PageNav';

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
  /** Recompute pagination for the current container size. epubjs caches
   *  the iframe dimensions at renderTo time, so we have to call this
   *  ourselves whenever the layout reflows around it (TOC pin/unpin,
   *  AI panel pin/unpin, window resize). */
  resize?(width?: string | number, height?: string | number): void;
  themes: {
    register(name: string, rules: Record<string, Record<string, string>>): void;
    select(name: string): void;
    fontSize(s: string): void;
  };
  destroy(): void;
}

type IframeContents = {
  window?: Window;
  document?: Document;
};

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
  // Tracks the most recent chapter ord that's actually on screen — set
  // when we call display() ourselves AND when epub.js reports a
  // relocate from user navigation. The chapter-effect uses this to
  // decide whether the prop change reflects a real TOC click (different
  // from on-screen → re-display) or a feedback loop from our own
  // relocate handler (same as on-screen → no-op).
  const lastSeenOrdRef = useRef(chapterOrd);
  const [error, setError] = useState<string | null>(null);
  // Refs to the live callbacks so the wheel handler installed in the
  // iframe can call the latest functions without re-installing each
  // time props change.
  const onPrevRef = useRef<() => void>(() => {});
  const onNextRef = useRef<() => void>(() => {});

  // Each iframe we've installed a wheel handler on, with its teardown.
  // We rely on epub.js to dispose of old iframes; we just make sure
  // we don't install twice on the same one.
  const wheelTeardownsRef = useRef<Map<Document, () => void>>(new Map());

  function installIframeHandlers(contents: IframeContents | undefined) {
    const doc = contents?.document;
    if (!doc) return;
    if (wheelTeardownsRef.current.has(doc)) return;
    const teardown = attachWheelPager(doc, {
      onPrev: () => onPrevRef.current(),
      onNext: () => onNextRef.current(),
      canPrev: () => true,
      canNext: () => true,
      // The iframe documents we render don't have meaningful nested
      // scrollables for paginated reading.
      respectScrollables: false,
    });
    wheelTeardownsRef.current.set(doc, teardown);
  }

  function uninstallAllIframeHandlers() {
    for (const teardown of wheelTeardownsRef.current.values()) {
      try { teardown(); } catch { /* ignore */ }
    }
    wheelTeardownsRef.current.clear();
  }

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
        wireRenditionEvents(rendition);

        // Open at the saved chapter ord.
        const initialOrd = lastSeenOrdRef.current;
        const target = book.spine.items[initialOrd];
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
      uninstallAllIframeHandlers();
      try { renditionRef.current?.destroy(); } catch { /* ignore */ }
      try { bookRef.current?.destroy(); } catch { /* ignore */ }
      renditionRef.current = null;
      bookRef.current = null;
      initialRelocateRef.current = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // React to TOC clicks: jump to spine[chapterOrd]. We only re-display
  // when the prop disagrees with what's actually on screen, which is
  // tracked in lastSeenOrdRef. Without that guard, every navigation
  // triggered a re-display and re-rendered the same chapter, which is
  // what was popping the "正在重新渲染" modal during normal reading.
  useEffect(() => {
    if (chapterOrd === lastSeenOrdRef.current) return;
    const r = renditionRef.current;
    const b = bookRef.current;
    if (!r || !b) return;
    const item = b.spine.items[chapterOrd];
    if (!item) return;
    lastSeenOrdRef.current = chapterOrd;
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

  // Re-paginate when the container resizes (TOC pin/unpin, AI panel
  // pin/unpin, window resize). epubjs caches the iframe dimensions at
  // renderTo time, so pinning the TOC sidebar shrinks the host element
  // without telling epubjs about it — content keeps drawing at the
  // pre-pin width and the right edge bleeds outside the new column,
  // which is exactly what the user reported.
  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;
    if (typeof ResizeObserver === 'undefined') return;
    let lastW = host.clientWidth;
    let lastH = host.clientHeight;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      // Skip sub-pixel jitter from layout settling.
      if (Math.abs(w - lastW) < 2 && Math.abs(h - lastH) < 2) return;
      lastW = w;
      lastH = h;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = renditionRef.current;
        if (!r || typeof r.resize !== 'function') return;
        try { r.resize('100%', '100%'); } catch { /* epubjs version variance */ }
      });
    });
    ro.observe(host);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  // pageMode change requires us to re-create the rendition because
  // epubjs's flow option is set at renderTo time. We re-init by
  // changing the bookId effect's dependency artificially — the
  // simplest correct path is destroying + recreating directly here.
  useEffect(() => {
    const b = bookRef.current;
    const old = renditionRef.current;
    if (!b || !old || !containerRef.current) return;
    onBusy?.(true);
    uninstallAllIframeHandlers();
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
    wireRenditionEvents(rendition);

    initialRelocateRef.current = true;
    const target = b.spine.items[lastSeenOrdRef.current];
    rendition.display(target?.href ?? undefined).catch(() => onBusy?.(false));
  // We intentionally only rerun this when pageMode flips. chapterOrd
  // changes are handled by their own effect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageMode]);

  // Wire up rendition lifecycle events. Extracted because we need
  // identical wiring on initial mount AND on pageMode-driven re-init.
  function wireRenditionEvents(rendition: EpubRendition) {
    rendition.on('selected', (...args: unknown[]) => {
      const contents = args[1] as IframeContents | undefined;
      const sel = contents?.window?.getSelection?.();
      const text = sel ? sel.toString() : '';
      onSelection?.(text && text.trim().length > 0 ? text : null);
    });

    rendition.on('relocated', (...args: unknown[]) => {
      // Suppress the very first relocate (the one for our own initial
      // display() call) so we don't overwrite the saved chapter ord.
      if (initialRelocateRef.current) {
        initialRelocateRef.current = false;
        return;
      }
      const loc = args[0] as { start?: { index?: number } } | undefined;
      const idx = loc?.start?.index;
      if (typeof idx !== 'number') return;
      // Update lastSeen FIRST, so the chapter-effect that fires when
      // onLocationChange propagates the new ord up to ReaderPage will
      // see (chapterOrd === lastSeenOrdRef.current) and bail without
      // re-displaying.
      lastSeenOrdRef.current = idx;
      onLocationChange(idx);
    });

    rendition.on('rendered', (...args: unknown[]) => {
      // args = (section, view); newer epub.js versions pass the
      // Contents object as args[1] directly. Try a couple of shapes.
      const view = args[1] as
        | { contents?: IframeContents; document?: Document; window?: Window }
        | undefined;
      const contents: IframeContents | undefined =
        view?.contents ?? (view?.document ? view as IframeContents : undefined);
      installIframeHandlers(contents);
      onBusy?.(false);
    });
  }

  function prev() { renditionRef.current?.prev().catch(() => { /* */ }); }
  function next() { renditionRef.current?.next().catch(() => { /* */ }); }

  // Keep the ref-stable callbacks pointing at the latest closures so
  // the in-iframe wheel handler doesn't need to be reinstalled when
  // props change.
  onPrevRef.current = prev;
  onNextRef.current = next;

  // In scrolled flow, suppress click zones (the iframe wants the wheel
  // for its own scrolling), but keep the floating buttons for chapter
  // hopping. The buttons map to prev/next which epubjs interprets as
  // "scroll one page worth" in scrolled mode.
  const interactiveZones = pageMode === 'paginated';

  return (
    <div
      className="h-full w-full relative"
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
  // Why not getComputedStyle(documentElement)?
  //   The CSS variables come from a [data-reader-theme="X"] block bound
  //   to <html>. Setting that attribute is done in a parent component
  //   effect; this function runs from a child component effect. In
  //   React 18, child effects fire BEFORE parent effects, so when the
  //   user changes theme we used to read the OLD --reader-bg / --reader-fg
  //   values into the iframe, leaving the EPUB content stuck on the
  //   previous palette while the chrome around it correctly updated.
  //   Pulling the colors from the typed THEMES table is deterministic
  //   and order-independent.
  const colors = getThemeColors(prefs.theme);
  const bg = colors.bg;
  const fg = colors.fg;
  const family = fontFamilyOf(prefs.fontFamily);
  // Most EPUB CSS sets font-family on every text element directly, so
  // a single `body, html { font-family }` rule loses the cascade. We
  // hit every common text selector with !important so the user's
  // pick is the one that wins. Same goes for color/bg — books often
  // ship dark grey on white and would beat our themes' palette.
  const familyImportant = `${family} !important`;
  const fgImportant = `${fg} !important`;
  const bgImportant = `${bg} !important`;

  r.themes.register('bookfree', {
    'html, body': {
      background: bgImportant,
      color: fgImportant,
      'font-family': familyImportant,
      'line-height': String(prefs.lineHeight) + ' !important',
    },
    'p, li, span, div, blockquote, td, th, dd, dt, figcaption, section, article': {
      'font-family': familyImportant,
      color: fgImportant,
      'background-color': 'transparent !important',
    },
    'h1, h2, h3, h4, h5, h6': {
      'font-family': familyImportant,
      color: fgImportant,
      'background-color': 'transparent !important',
    },
    'a': {
      color: 'var(--reader-accent, #7C5A3A)',
    },
  });
  r.themes.select('bookfree');
  r.themes.fontSize(prefs.fontSize + 'px');
}
