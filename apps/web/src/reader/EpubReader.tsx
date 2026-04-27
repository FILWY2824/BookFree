// EPUB reader. Uses epubjs to render the original .epub file inside
// an iframe with CFI-based pagination. The advantage over the chunk-
// based TxtReader path is that long chapters get paginated within
// the visible viewport instead of relying on page scroll, which is
// what most readers expect.
//
// Trade-offs:
//  - epubjs spawns its content inside a sandboxed iframe — our theme
//    CSS doesn't reach into it. We re-apply the active theme by
//    pushing a stylesheet into the iframe whenever theme/font/size
//    changes.
//  - We still receive the chapter list from the parent (via /chapters/list)
//    so the TocDrawer keeps working — epubjs's nav tree is not used.

import { useEffect, useRef, useState } from 'react';
import type { ReaderPrefs } from '../lib/prefs';

interface Props {
  bookId: string;
  prefs: ReaderPrefs;
  /** Chapter ord the user picked from the TOC (we map → spine index). */
  chapterOrd: number;
  onLocationChange: (ord: number) => void;
}

// Minimal type surface for the bits of epubjs we touch. We avoid
// pulling @types/epubjs (it's quite stale) and lean on `unknown` at
// the boundary.
interface EpubBook {
  ready: Promise<void>;
  destroy(): void;
  spine: { items: Array<{ idref: string; href: string }> };
  renderTo(el: HTMLElement, opts: Record<string, unknown>): EpubRendition;
  loaded: { navigation: Promise<{ toc: unknown[] }> };
}
interface EpubRendition {
  display(target?: string | number): Promise<void>;
  prev(): Promise<void>;
  next(): Promise<void>;
  on(ev: string, cb: (...args: unknown[]) => void): void;
  themes: {
    register(name: string, rules: Record<string, Record<string, string>>): void;
    select(name: string): void;
    fontSize(s: string): void;
  };
  destroy(): void;
}

export default function EpubReader({ bookId, prefs, chapterOrd, onLocationChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const renditionRef = useRef<EpubRendition | null>(null);
  const bookRef = useRef<EpubBook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Mount + destroy.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        const ePub = (await import('epubjs')).default as unknown as (input: ArrayBuffer | string) => EpubBook;
        // epubjs needs the bytes; we fetch with credentials so the
        // session cookie gets sent.
        const res = await fetch(`/api/books/${bookId}/file`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (cancelled) return;

        const book = ePub(buf);
        bookRef.current = book;
        await book.ready;
        if (cancelled || !containerRef.current) return;

        const rendition = book.renderTo(containerRef.current, {
          width: '100%',
          height: '100%',
          spread: 'none',
          flow: 'paginated',
          allowScriptedContent: false,
        });
        renditionRef.current = rendition;
        applyTheme(rendition, prefs);
        await rendition.display();

        rendition.on('relocated', (...args: unknown[]) => {
          // args[0] is a Location object; we use start.index for our
          // best-effort chapter ord. epubjs's `index` is the spine
          // index, which lines up with our book_chapters.ord because
          // the ingest path orders chapters in spine order.
          const loc = args[0] as { start?: { index?: number } } | undefined;
          const idx = loc?.start?.index;
          if (typeof idx === 'number') onLocationChange(idx);
        });

        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message ?? 'EPUB 加载失败');
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      try { renditionRef.current?.destroy(); } catch { /* ignore */ }
      try { bookRef.current?.destroy(); } catch { /* ignore */ }
      renditionRef.current = null;
      bookRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- prefs handled separately below
  }, [bookId]);

  // React to TOC clicks: jump to spine[chapterOrd].
  useEffect(() => {
    const r = renditionRef.current;
    const b = bookRef.current;
    if (!r || !b) return;
    const item = b.spine.items[chapterOrd];
    if (item) r.display(item.href).catch(() => { /* swallow */ });
  }, [chapterOrd]);

  // React to prefs changes — push theme + font into the iframe.
  useEffect(() => {
    const r = renditionRef.current;
    if (!r) return;
    applyTheme(r, prefs);
  }, [prefs]);

  function prev() { renditionRef.current?.prev().catch(() => {}); }
  function next() { renditionRef.current?.next().catch(() => {}); }

  return (
    <div
      className="h-full relative"
      style={{ background: 'var(--reader-bg)', color: 'var(--reader-fg)' }}
    >
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center" style={{ color: 'var(--reader-muted)' }}>
          正在打开 EPUB…
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center text-rose-500 px-6 text-center">
          EPUB 渲染失败：{error}
        </div>
      )}

      {/* Click left/right edges to flip pages — the common e-reader gesture. */}
      <div ref={containerRef} className="h-full w-full" />
      <button
        onClick={prev}
        aria-label="上一页"
        className="absolute left-0 top-0 h-full w-12 opacity-0 hover:opacity-30 bg-ink-900 transition-opacity"
      />
      <button
        onClick={next}
        aria-label="下一页"
        className="absolute right-0 top-0 h-full w-12 opacity-0 hover:opacity-30 bg-ink-900 transition-opacity"
      />
    </div>
  );
}

// applyTheme pushes our reader-bg/fg/font tokens into the rendition's
// iframe via epubjs's `themes` API. epubjs maintains a per-rendition
// stylesheet that gets injected into every chapter's iframe — so this
// survives chapter navigation without re-running.
function applyTheme(r: EpubRendition, prefs: ReaderPrefs) {
  // We read the live CSS variables off documentElement so the EPUB
  // styling tracks whatever data-reader-theme is currently active on
  // the host document. That way switching themes in SettingsDrawer
  // updates the EPUB iframe without us having to enumerate all eight.
  const cs = getComputedStyle(document.documentElement);
  const bg = cs.getPropertyValue('--reader-bg').trim() || '#FAF7F2';
  const fg = cs.getPropertyValue('--reader-fg').trim() || '#1B2230';
  const family = prefs.fontFamily === 'sans'
    ? 'ui-sans-serif, system-ui, -apple-system, sans-serif'
    : '"LXGW WenKai", ui-serif, Georgia, serif';

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
