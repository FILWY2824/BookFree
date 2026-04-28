// PDF reader. Lazy-imports pdf.js so login + library pages don't pay
// the cost of a 500 KB module they never use.
//
// Two render modes:
//   • 'paginated'    — one page at a time, prev/next flips. The
//                      common e-reader gesture for novels-as-PDFs.
//   • 'scroll-book'  — every page rendered into a vertical strip the
//                      user scrolls through. Faster for skimming and
//                      what most desktop PDF viewers default to.
//
// We don't ship 'scroll-chapter' for PDFs — chapters aren't
// well-defined in the format and it would surprise users.
//
// HiDPI: every render scales the canvas backing store to
// devicePixelRatio. Without this, retina displays got blurry text.
//
// Selection: the canvas-rendered text isn't selectable by default. We
// intentionally don't add the pdf.js text layer in this milestone —
// the highlights schema is keyed off chapter character offsets that
// don't apply cleanly to PDFs, so wiring annotations into PDFs is
// future work tracked separately.

import { useEffect, useRef, useState } from 'react';
import type { ReaderPrefs, PageMode } from '../lib/prefs';
import PageNav from '../components/PageNav';

interface Props {
  bookId: string;
  prefs: ReaderPrefs;
  page: number;                        // 1-indexed
  pageMode: PageMode;
  onPageChange: (p: number) => void;
  onReady?: () => void;
  onBusy?: (busy: boolean) => void;
}

interface PdfDoc {
  numPages: number;
  getPage: (n: number) => Promise<PdfPage>;
}
interface PdfPage {
  getViewport: (opts: { scale: number }) => { width: number; height: number };
  render: (opts: unknown) => { promise: Promise<void>; cancel?: () => void };
}

export default function PdfReader({
  bookId, prefs, page, pageMode,
  onPageChange, onReady, onBusy,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1.2);

  // Load pdf.js + the document on mount.
  useEffect(() => {
    let cancelled = false;
    onBusy?.(true);
    setError(null);
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        const workerSrc = (await import('pdfjs-dist/build/pdf.worker.mjs?url')).default as string;
        pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

        const url = `/api/books/${bookId}/file`;
        const task = pdfjs.getDocument({ url, withCredentials: true });
        const d = await task.promise;
        if (cancelled) return;
        setDoc(d as unknown as PdfDoc);
        onReady?.();
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? '加载失败');
      } finally {
        if (!cancelled) onBusy?.(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // Paginated render — one page at a time onto canvasRef.
  useEffect(() => {
    if (!doc || pageMode !== 'paginated') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let renderTask: { promise: Promise<void>; cancel?: () => void } | null = null;
    onBusy?.(true);
    (async () => {
      try {
        const p = await doc.getPage(Math.max(1, Math.min(doc.numPages, page)));
        if (cancelled) return;
        const vp = p.getViewport({ scale: zoom });
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(vp.width * dpr);
        canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width = vp.width + 'px';
        canvas.style.height = vp.height + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        renderTask = p.render({ canvasContext: ctx, viewport: vp });
        await renderTask.promise;
      } catch (e) {
        if (!cancelled) {
          const msg = (e as Error).message;
          if (msg && !msg.toLowerCase().includes('cancelled')) setError(msg);
        }
      } finally {
        if (!cancelled) onBusy?.(false);
      }
    })();
    return () => { cancelled = true; renderTask?.cancel?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, page, zoom, pageMode]);

  // Scroll-book render — every page into a vertical strip. We render
  // sequentially so DOM order matches page order; pdf.js handles
  // throughput fine in practice for sub-200-page books.
  useEffect(() => {
    if (!doc || pageMode === 'paginated') return;
    const strip = stripRef.current;
    if (!strip) return;
    let cancelled = false;
    onBusy?.(true);

    // Clear any previous strip on remount/zoom.
    while (strip.firstChild) strip.removeChild(strip.firstChild);

    (async () => {
      try {
        for (let n = 1; n <= doc.numPages; n++) {
          if (cancelled) return;
          const p = await doc.getPage(n);
          const vp = p.getViewport({ scale: zoom });
          const c = document.createElement('canvas');
          c.className = 'shadow-elev rounded mx-auto mb-4';
          const ctx = c.getContext('2d');
          if (!ctx) continue;
          const dpr = window.devicePixelRatio || 1;
          c.width = Math.floor(vp.width * dpr);
          c.height = Math.floor(vp.height * dpr);
          c.style.width = vp.width + 'px';
          c.style.height = vp.height + 'px';
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          await p.render({ canvasContext: ctx, viewport: vp }).promise;
          if (cancelled) return;
          strip.appendChild(c);
        }
      } catch (e) {
        if (!cancelled) {
          const msg = (e as Error).message;
          if (msg && !msg.toLowerCase().includes('cancelled')) setError(msg);
        }
      } finally {
        if (!cancelled) onBusy?.(false);
      }
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, zoom, pageMode]);

  const numPages = doc?.numPages ?? 0;
  const canPrev = page > 1;
  const canNext = page < numPages;

  return (
    <div
      className="h-full overflow-hidden flex flex-col"
      style={{ background: 'var(--reader-bg)', color: 'var(--reader-fg)' }}
    >
      <PageNav
        onPrev={() => canPrev && onPageChange(page - 1)}
        onNext={() => canNext && onPageChange(page + 1)}
        canPrev={canPrev}
        canNext={canNext}
        enabled={pageMode === 'paginated' && !error}
        interactiveZones={pageMode === 'paginated'}
        className="flex-1 min-h-0"
      >
        <div className="h-full overflow-y-auto scrollbar-thin">
          {error && <div className="text-center py-12 text-rose-500">PDF 加载失败：{error}</div>}
          {!error && pageMode === 'paginated' && (
            <div className="flex flex-col items-center py-8 px-4">
              <canvas ref={canvasRef} className="shadow-elev rounded" />
            </div>
          )}
          {!error && pageMode !== 'paginated' && (
            <div ref={stripRef} className="flex flex-col items-center py-8 px-4" />
          )}
        </div>
      </PageNav>

      <div
        className="shrink-0 flex items-center justify-center gap-3 px-4 h-10 border-t text-sm"
        style={{ borderColor: 'var(--reader-border)', color: 'var(--reader-muted)' }}
      >
        {pageMode === 'paginated' && (
          <>
            <span>第 {page} / {numPages || '…'} 页</span>
            <span className="opacity-50">·</span>
          </>
        )}
        <span>缩放</span>
        <button
          onClick={() => setZoom(z => Math.max(0.5, +(z - 0.1).toFixed(2)))}
          className="px-2 hover:opacity-100 opacity-70"
          aria-label="缩小"
        >
          −
        </button>
        <span className="tabular-nums">{Math.round(zoom * 100)}%</span>
        <button
          onClick={() => setZoom(z => Math.min(3, +(z + 0.1).toFixed(2)))}
          className="px-2 hover:opacity-100 opacity-70"
          aria-label="放大"
        >
          +
        </button>
      </div>

      {/* preserve `prefs` reference even when not used directly */}
      <span className="hidden">{prefs.theme}</span>
    </div>
  );
}
