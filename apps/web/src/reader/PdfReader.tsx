// PDF 阅读器。
// 这个组件负责在阅读页中显示原始 PDF 文件。它使用 pdf.js 把 PDF 页面渲染到 canvas 上，
// 而不是把 PDF 转成 HTML 或纯文本。
//
// 为什么要 lazy-import pdf.js？
// pdf.js 体积相对较大，如果用户只打开登录页、书架页或 TXT 阅读器，就不应该提前加载它。
// 因此这里在真正进入 PDF 阅读器时才 import('pdfjs-dist')，减少首屏 JS 体积。
//
// 当前支持两种显示模式：
//   • 'paginated'    —— 一次只渲染一页，通过上一页/下一页翻页。
//                      适合把 PDF 当小说或长文档阅读。
//   • 'scroll-book'  —— 把每一页依次渲染成纵向 canvas 列表，用户向下滚动浏览。
//                      更接近桌面 PDF 阅读器，适合快速浏览。
//   • 'scroll-chapter' 对 PDF 不单独实现，因为 PDF 本身没有稳定的“章节正文”结构。
//
// HiDPI / Retina 屏幕处理：
// canvas 有“实际像素尺寸”和“CSS 显示尺寸”两套概念。
// 如果只按 CSS 尺寸渲染，在高分屏上文字会发糊。
// 所以下方渲染时会把 canvas.width/height 乘以 devicePixelRatio，
// 再用 CSS width/height 控制显示大小，让文字更清晰。
//
// 为什么当前 PDF 不支持划线/高亮/笔记？
// pdf.js 渲染到 canvas 后，文字本身不是真正的 DOM 文本，不能像 TXT/HTML 那样直接选中并包裹 span。
// 虽然 pdf.js 可以额外渲染 text layer，但当前项目的标注定位模型主要基于章节和字符偏移，
// 与 PDF 页内坐标/文本层不完全一致。因此 PDF 标注属于后续增强能力，不在本轮实现。

import { useEffect, useRef, useState } from 'react';
import type { ReaderPrefs, PageMode } from '../lib/prefs';
import PageNav from '../components/PageNav';

// ReaderPage 传给 PDF 阅读器的参数。
// PDFReader 不直接负责保存进度，只通过 onPageChange 把页码变化交给外层。
// 这样 TXT/EPUB/PDF 的阅读进度保存逻辑都能集中在 ReaderPage 或后端进度 API 中。
interface Props {
  // 后端书籍 ID，用来请求 /api/books/{bookId}/file 获取原始 PDF 文件。
  bookId: string;
  // 阅读偏好。当前 PDF 主要使用主题色背景，字体/行高对 canvas 内 PDF 不直接生效。
  // 但保留 prefs 可以让 ReaderPage 对所有阅读器传参保持一致。
  prefs: ReaderPrefs;
  // 当前页码。这里使用 1-indexed，也就是第一页为 1，而不是程序数组常见的 0。
  page: number;                        // 1-indexed
  // 阅读模式：分页或整书滚动。
  pageMode: PageMode;
  // 翻页时通知外层更新页码与保存阅读进度。
  onPageChange: (p: number) => void;
  // PDF 文档加载完成后通知外层。
  onReady?: () => void;
  // 通知外层显示/隐藏忙碌状态，例如“正在重新渲染”。
  onBusy?: (busy: boolean) => void;
}

// pdf.js 文档对象的最小类型声明。
// 这里只声明本组件实际使用的字段，避免引入过多 pdf.js 内部类型。
interface PdfDoc {
  // PDF 总页数。
  numPages: number;
  // 获取第 n 页。pdf.js 的页码也是 1-indexed。
  getPage: (n: number) => Promise<PdfPage>;
}

// pdf.js 单页对象的最小类型声明。
interface PdfPage {
  // 根据缩放比例得到页面视口，包括渲染宽高。
  getViewport: (opts: { scale: number }) => { width: number; height: number };
  // 把页面渲染到 canvas。返回的 task.promise 在渲染完成时 resolve。
  render: (opts: unknown) => { promise: Promise<void>; cancel?: () => void };
}

export default function PdfReader({
  bookId, prefs, page, pageMode,
  onPageChange, onReady, onBusy,
}: Props) {
  // 分页模式下只需要一个 canvas，当前页变化时重复渲染到这个 canvas。
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 整书滚动模式下会动态创建多个 canvas，并追加到这个容器里。
  const stripRef = useRef<HTMLDivElement>(null);
  // pdf.js 解析后的文档对象。未加载完成前为 null。
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  // 加载或渲染错误。
  const [error, setError] = useState<string | null>(null);
  // 缩放比例。1.2 表示 120%。
  const [zoom, setZoom] = useState(1.2);

  // 加载 pdf.js 和 PDF 文档。
  //
  // 关键点：
  // 1. import('pdfjs-dist') 是动态导入，只有打开 PDF 时才加载；
  // 2. pdf.worker.mjs?url 让 Vite 返回 worker 文件 URL；
  // 3. pdf.js 解析 PDF 时会用 worker，避免阻塞主线程；
  // 4. getDocument({ url, withCredentials: true }) 会携带同源 cookie，适配后端 session 鉴权；
  // 5. bookId 变化时重新加载，组件卸载时通过 cancelled 避免异步回调写入已卸载组件。
  //
  // 低内存说明：
  // Go 后端只负责通过 /api/books/{id}/file 流式提供原始 PDF 文件；
  // PDF 解析与页面渲染都发生在浏览器端，不让 Go 服务端常驻 PDF 解析库或页面缓存。
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
  // 这里故意只依赖 bookId，避免页码/缩放/阅读模式变化时重新下载和解析整个 PDF。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // 分页模式渲染。
  // 每次 doc/page/zoom/pageMode 变化时，把当前页渲染到 canvasRef。
  //
  // 渲染流程：
  // 1. 根据当前页码取 PDF 页面，并把页码限制在 1..numPages 范围内；
  // 2. 根据 zoom 得到 viewport；
  // 3. 根据 devicePixelRatio 放大 canvas 实际像素尺寸；
  // 4. 用 CSS 尺寸控制视觉大小；
  // 5. ctx.setTransform(dpr, ...) 让绘制坐标仍按 CSS 像素工作；
  // 6. 调用 pdf.js render() 绘制页面。
  //
  // cleanup 中 cancel renderTask：
  // 如果用户快速翻页或缩放，旧页面还没画完就不需要继续画了，应尽量取消旧任务。
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
  // onBusy 是外部回调，放进依赖可能造成不必要重渲染；这里沿用现有约定禁用 exhaustive-deps。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, page, zoom, pageMode]);

  // 整书滚动模式渲染。
  // 这里会为每一页创建一个 canvas，并按页码顺序追加到 stripRef 容器中。
  //
  // 注意内存影响：
  // - scroll-book 会同时保留多页 canvas，前端内存占用明显高于 paginated；
  // - 对页数很多或图片很多的 PDF，浏览器内存可能上升；
  // - 但这部分发生在用户浏览器中，不会增加 Go 后端常驻内存；
  // - 如果未来要优化，可以做虚拟列表/只渲染可视区域附近页面。
  //
  // 为什么顺序渲染？
  // 顺序渲染可以保证 DOM 中页面顺序和真实页码一致，也避免一次性并发渲染太多页导致浏览器卡顿。
  // Scroll-book render — every page into a vertical strip. We render
  // sequentially so DOM order matches page order; pdf.js handles
  // throughput fine in practice for sub-200-page books.
  useEffect(() => {
    if (!doc || pageMode === 'paginated') return;
    const strip = stripRef.current;
    if (!strip) return;
    let cancelled = false;
    onBusy?.(true);

    // 重新进入滚动模式或缩放变化时，先清空旧 canvas。
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
  // 这里不依赖 page，因为整书滚动模式下当前页码不驱动单页重绘。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, zoom, pageMode]);

  // 从文档对象中得到总页数；文档未加载时显示 0。
  const numPages = doc?.numPages ?? 0;
  // 上一页/下一页按钮是否可用。
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
              {/* 分页模式：只渲染当前页到这一个 canvas。 */}
              <canvas ref={canvasRef} className="shadow-elev rounded" />
            </div>
          )}
          {!error && pageMode !== 'paginated' && (
            /* 整书滚动模式：effect 会动态创建多个 canvas 并放进这个容器。 */
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

      {/* 保留 prefs 引用。
          当前 PDF canvas 不能直接继承字体/行高，但主题切换等外层逻辑仍可能希望所有阅读器都接收 prefs。
          这个隐藏 span 可以避免 TypeScript/ESLint 认为 prefs 完全未使用。 */}
      {/* preserve `prefs` reference even when not used directly */}
      <span className="hidden">{prefs.theme}</span>
    </div>
  );
}
