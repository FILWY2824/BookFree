// PDF reader. Lazy-imports pdf.js so the library + login pages don't
// pay the bundle cost of a 500 KB module they never use. The viewer
// renders one page at a time onto a canvas, with prev/next + jump-to.
//
// We deliberately don't try to extract text for ingest — pdf.js is
// fine as a renderer but slow as a parser, and the search index
// quality on PDF text is poor enough that we'd rather just say "PDFs
// aren't full-text searchable" than promise something flaky.

import { useEffect, useRef, useState } from 'react';
import type { ReaderPrefs } from '../lib/prefs';

interface Props {
  bookId: string;
  prefs: ReaderPrefs;
  page: number;                        // 1-indexed
  onPageChange: (p: number) => void;
}

// We pin a specific pdfjs-dist version on the package.json side and
// load the worker from the same package. Using the bundled worker
// avoids the CSP gymnastics that the eval-based fallback needs.

export default function PdfReader({ bookId, prefs, page, onPageChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<{ numPages: number; getPage: (n: number) => Promise<unknown> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(1.2);

  // Load pdf.js + the document on mount.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        // Dynamic import keeps the static bundle small.
        const pdfjs = await import('pdfjs-dist');
        const workerSrc = (await import('pdfjs-dist/build/pdf.worker.mjs?url')).default as string;
        pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

        const url = `/api/books/${bookId}/file`;
        const task = pdfjs.getDocument({ url, withCredentials: true });
        const d = await task.promise;
        if (cancelled) return;
        setDoc(d as unknown as { numPages: number; getPage: (n: number) => Promise<unknown> });
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? '加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [bookId]);

  // Render the current page whenever doc/page/zoom changes.
  useEffect(() => {
    if (!doc) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let renderTask: { promise: Promise<void>; cancel?: () => void } | null = null;
    (async () => {
      try {
        const p = await doc.getPage(Math.max(1, Math.min(doc.numPages, page))) as {
          getViewport: (opts: { scale: number }) => { width: number; height: number };
          render: (opts: unknown) => { promise: Promise<void>; cancel?: () => void };
        };
        if (cancelled) return;
        const vp = p.getViewport({ scale: zoom });
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        // HiDPI: scale the canvas backing store to devicePixelRatio.
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
          // pdf.js throws RenderingCancelledException when we abort, ignore that.
          const msg = (e as Error).message;
          if (msg && !msg.toLowerCase().includes('cancelled')) setError(msg);
        }
      }
    })();
    return () => { cancelled = true; renderTask?.cancel?.(); };
  }, [doc, page, zoom]);

  const numPages = doc?.numPages ?? 0;
  const canPrev = page > 1;
  const canNext = page < numPages;

  return (
    <div
      className="h-full overflow-y-auto scrollbar-thin"
      style={{ background: 'var(--reader-bg)', color: 'var(--reader-fg)' }}
    >
      <div className="flex flex-col items-center py-8 px-4">
        {loading && <div style={{ color: 'var(--reader-muted)' }}>正在加载 PDF…</div>}
        {error && <div className="text-rose-500">PDF 加载失败：{error}</div>}
        {!loading && !error && (
          <>
            <canvas ref={canvasRef} className="shadow-elev rounded" />
            <div className="mt-6 flex items-center gap-2 text-sm" style={{ color: 'var(--reader-muted)' }}>
              <button
                disabled={!canPrev}
                onClick={() => onPageChange(page - 1)}
                className="px-3 py-1 rounded disabled:opacity-30"
              >← 上一页</button>
              <span>第 {page} / {numPages} 页</span>
              <button
                disabled={!canNext}
                onClick={() => onPageChange(page + 1)}
                className="px-3 py-1 rounded disabled:opacity-30"
              >下一页 →</button>
              <span className="ml-4">缩放</span>
              <button onClick={() => setZoom(z => Math.max(0.5, z - 0.1))} className="px-2">−</button>
              <span>{Math.round(zoom * 100)}%</span>
              <button onClick={() => setZoom(z => Math.min(3, z + 0.1))} className="px-2">+</button>
            </div>
          </>
        )}
      </div>
      {/* preserve `prefs` reference even when not used directly */}
      <span className="hidden">{prefs.theme}</span>
    </div>
  );
}
