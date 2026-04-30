// CBZ 阅读器。
// -----------------------------------------------------------------------------
// CBZ 通常表示 Comic Book Zip：本质上是一个 .zip 压缩包，里面按顺序放了
// jpg/png/webp 等图片，每张图片就是漫画/图册的一页。
//
// 这个组件负责在阅读页里显示 .cbz 文件。它和 TxtReader / EpubReader / PdfReader
// 一样由 ReaderPage 分发调用，但它的渲染方式最简单：
//   1. 从后端 `/api/books/{bookId}/file` 下载原始 CBZ 文件；
//   2. 用 zip.js 在浏览器端打开 zip；
//   3. 根据章节列表中的 chapter.href 找到当前页对应的 zip entry；
//   4. 只解压当前这一张图片，生成 blob URL，交给 <img> 显示；
//   5. 翻页时释放旧 blob URL，再解压新图片。
//
// 为什么章节列表里会有“页”？
// 上传/导入 CBZ 时，前端解析器会把 zip 内图片文件名按自然顺序整理出来，
// 并在 ingest 阶段写入后端 book_chapters 表。对 CBZ 来说，一条 chapter
// 记录基本就对应一页图片，chapter.href 保存 zip 内的图片路径。
// 因此这里可以复用 `/chapters/list` 这个通用接口，而不需要为 CBZ 单独设计目录 API。
//
// 为什么只支持分页模式？
// 漫画图片是固定版式，不像 TXT/HTML 能根据字体大小重新排版。
// 如果把所有图片一次性纵向铺开，浏览器会同时持有大量解码后的图片，内存压力会很高。
// 所以 CBZ 默认采用“一次一页”的翻页体验，也最接近漫画阅读器。
//
// 低内存说明：
// - Go 后端只通过 ServeContent/文件流把原始 CBZ 交给浏览器，不在服务端解压整本漫画；
// - 浏览器端 zip.js 只在需要时读取当前 entry；
// - 本组件只保留当前页的 blob URL，翻页和卸载时都会 revoke；
// - 因此该实现对“服务端常驻内存 50MB 内”约束友好，主要内存压力在用户浏览器端。

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  configure as zipConfigure,
  ZipReader,
  BlobReader,
  BlobWriter,
  type Entry,
} from '@zip.js/zip.js';
import { api } from '../lib/api';
import PageNav from '../components/PageNav';

// CBZ 的章节元信息。
// 对普通文本书籍，“章节”代表一章；对 CBZ，“章节”基本代表一页图片。
interface Chapter {
  // 后端 book_chapters.id。
  id: string;
  // 页序号。ReaderPage 用 chapterOrd 表示当前页/章节位置。
  ord: number;
  // 页标题。CBZ 通常可以为空，或者是图片文件名。
  title?: string | null;
  // zip 包内图片文件名/路径，例如 "001.jpg" 或 "chapter1/page-01.png"。
  href?: string | null;
}

// ReaderPage 传给 CbzReader 的参数。
// 这里没有 prefs/pageMode，是因为 CBZ 图片不受字体、行高等文本阅读设置影响。
interface Props {
  // 后端书籍 ID，用于请求章节列表和原始文件。
  bookId: string;
  // 当前页序号。这里是 zero-indexed，与 ReaderPage 的 chapterOrd 保持一致。
  /** Active page (zero-indexed, matches chapterOrd in the parent). */
  chapterOrd: number;
  // 翻页时通知 ReaderPage 更新当前页，并由外层负责保存阅读进度。
  onChapterChange: (ord: number) => void;
  // 第一张图片成功生成并准备展示后通知外层，通常用于关闭初始加载态。
  onReady?: () => void;
  // 通知外层当前是否忙碌，例如正在下载 CBZ、解压当前页。
  onBusy?: (busy: boolean) => void;
}

// zip.js 默认可能使用 Web Worker。
// 这里关闭 Worker，主要是为了让本地构建/部署更简单，避免额外处理 worker 文件路径。
// 代价是解压当前图片时会占用主线程一小段时间；因为本组件一次只解压一页，通常可以接受。
// 如果未来要支持超大 CBZ 或更顺滑的预加载，可以再评估开启 worker。
zipConfigure({ useWebWorkers: false });

export default function CbzReader({
  bookId, chapterOrd, onChapterChange, onReady, onBusy,
}: Props) {
  // 当前书籍的“页列表”。由后端 chapters/list 返回，不包含图片二进制内容。
  const [chapters, setChapters] = useState<Chapter[]>([]);
  // zip 文件内的 entry 索引表：filename -> Entry。
  // 建好 Map 后，按 href 查找当前图片会比每次遍历数组更直观。
  const [entries, setEntries] = useState<Map<string, Entry> | null>(null);
  // 当前页图片的 blob URL。<img src={imgUrl}> 会使用它显示图片。
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  // 加载/解压错误信息。
  const [error, setError] = useState<string | null>(null);

  // 当前创建出来的 blob URL。必须在翻页或卸载时 URL.revokeObjectURL，
  // 否则浏览器会一直保留这块 Blob 内存。
  const urlRef = useRef<string | null>(null);
  // 当前打开的 ZipReader。组件卸载时需要 close，释放 zip.js 内部资源。
  const readerRef = useRef<ZipReader<Blob> | null>(null);
  // 只在第一张图片真正准备好时触发一次 onReady。
  // 如果每次翻页都触发 onReady，外层加载状态会被重复扰动。
  // Captured at mount; used to fire onReady exactly once after the
  // first image actually paints.
  const readyFiredRef = useRef(false);

  // Step 1：加载章节/页列表。
  //
  // 这个接口只返回 id/ord/title/href，不返回图片内容，所以非常轻量。
  // cancelled 是 React 异步请求常见保护：如果 bookId 改变或组件卸载，
  // 旧请求返回时不再 setState，避免旧书的数据覆盖新书页面。
  // Step 1: load the chapter (page) list.
  useEffect(() => {
    let cancelled = false;
    api.get<{ chapters: Chapter[] }>(`/api/books/${bookId}/chapters/list`)
      .then(d => { if (!cancelled) setChapters(d.chapters); })
      .catch(e => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [bookId]);

  // Step 2：下载并打开 CBZ 文件。
  //
  // 注意这里虽然调用了 res.blob()，会把整个 CBZ 文件作为 Blob 交给浏览器，
  // 但解压并不会一次性把所有图片都解码成像素。zip.js 会根据 entry 按需读取。
  //
  // 为什么不让 Go 后端解压？
  // - 服务端解压大漫画会增加 CPU 和内存峰值；
  // - 自托管小内存部署下，后端应尽量只做鉴权、文件存储和流式传输；
  // - 浏览器本来就要显示图片，把解压放到客户端更符合本项目低内存原则。
  // Step 2: stream and open the .cbz once, keep the entries map.
  useEffect(() => {
    let cancelled = false;
    onBusy?.(true);
    (async () => {
      try {
        const res = await fetch(`/api/books/${bookId}/file`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;

        const reader = new ZipReader(new BlobReader(blob));
        readerRef.current = reader;

        const list = await reader.getEntries();
        if (cancelled) return;

        const map = new Map<string, Entry>();
        for (const e of list) map.set(e.filename, e);
        setEntries(map);
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? 'CBZ 加载失败');
      } finally {
        if (!cancelled) onBusy?.(false);
      }
    })();

    return () => {
      cancelled = true;
      readerRef.current?.close().catch(() => { /* ignore */ });
      readerRef.current = null;
    };
  // onBusy 是外部回调。这里沿用项目现有约定，不把它放入依赖，避免父组件回调变化导致重复下载 CBZ。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // Step 3：当前页变化时，解压并替换图片。
  //
  // chapterOrd 改变通常来自：
  // - 用户点击 PageNav 的上一页/下一页；
  // - ReaderPage 从保存的阅读进度恢复；
  // - 用户从目录中选择某一页。
  //
  // 解压流程：
  // 1. 根据 chapterOrd 找到当前 Chapter；
  // 2. 用 chapter.href 在 entries Map 中找到 zip entry；
  // 3. entry.getData(new BlobWriter(mime)) 解压出当前图片 Blob；
  // 4. URL.createObjectURL(blob) 创建临时 URL；
  // 5. revoke 旧 URL，避免内存泄漏；
  // 6. setImgUrl 触发 React 重新渲染 <img>。
  // Step 3: whenever the active chapter or zip changes, swap the image.
  useEffect(() => {
    if (!entries || chapters.length === 0) return;
    const ch = chapters[Math.max(0, Math.min(chapters.length - 1, chapterOrd))];
    if (!ch?.href) {
      setError('该页缺少图片路径');
      return;
    }

    const entry = entries.get(ch.href);
    if (!entry || !('getData' in entry) || typeof entry.getData !== 'function') {
      setError('CBZ 内未找到该图片：' + ch.href);
      return;
    }

    let cancelled = false;
    onBusy?.(true);
    (async () => {
      try {
        const blob: Blob = await (entry.getData(new BlobWriter(guessImageMime(ch.href!))) as Promise<Blob>);
        if (cancelled) return;

        const url = URL.createObjectURL(blob);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = url;

        setImgUrl(url);
        setError(null);

        if (!readyFiredRef.current) {
          readyFiredRef.current = true;
          onReady?.();
        }
      } catch (e) {
        if (!cancelled) setError('页面解压失败：' + (e as Error).message);
      } finally {
        if (!cancelled) onBusy?.(false);
      }
    })();

    return () => { cancelled = true; };
  // onBusy/onReady 是外部回调，放入依赖可能造成不必要的重新解压；这里保持和原实现一致。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, chapters, chapterOrd]);

  // 组件卸载时释放最后一个 blob URL。
  // 这一步很重要：blob URL 不是普通字符串，它背后绑定了一块浏览器内存。
  useEffect(() => () => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  // 上一页/下一页按钮可用性。
  const canPrev = chapterOrd > 0;
  const canNext = chapterOrd < chapters.length - 1;

  // 底部页码展示，例如 “3 / 120”。
  // useMemo 不是必须的，但这里表达“只有 chapterOrd 或总页数变化时才重新计算”。
  const footerLabel = useMemo(() => {
    if (chapters.length === 0) return '';
    return `${chapterOrd + 1} / ${chapters.length}`;
  }, [chapterOrd, chapters.length]);

  return (
    <div
      className="h-full flex flex-col"
      style={{ background: 'var(--reader-bg)', color: 'var(--reader-fg)' }}
    >
      <PageNav
        onPrev={() => canPrev && onChapterChange(chapterOrd - 1)}
        onNext={() => canNext && onChapterChange(chapterOrd + 1)}
        canPrev={canPrev}
        canNext={canNext}
        enabled={!error}
        className="flex-1 min-h-0"
      >
        <div className="h-full w-full relative overflow-hidden">
          {error && (
            <div className="absolute inset-0 flex items-center justify-center text-rose-500 px-6 text-center">
              {error}
            </div>
          )}

          {!error && imgUrl && (
            <div className="h-full w-full flex items-start justify-center p-2">
              <img
                src={imgUrl}
                alt={`Page ${chapterOrd + 1}`}
                className="max-w-full h-auto select-none"
                draggable={false}
              />
            </div>
          )}
        </div>
      </PageNav>

      <div
        className="shrink-0 flex items-center justify-center px-4 h-10 border-t text-sm"
        style={{ borderColor: 'var(--reader-border)', color: 'var(--reader-muted)' }}
      >
        <span className="tabular-nums">{footerLabel}</span>
      </div>
    </div>
  );
}

// 根据文件扩展名推测图片 MIME 类型。
//
// BlobWriter 需要一个 MIME 字符串，这会影响浏览器如何理解解压出来的 Blob。
// 如果扩展名不认识，就退回 application/octet-stream，表示“普通二进制数据”。
// 大多数现代浏览器仍然能通过 <img> 尝试识别，但已知图片格式最好明确写出来。
function guessImageMime(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'png':  return 'image/png';
    case 'webp': return 'image/webp';
    case 'gif':  return 'image/gif';
    case 'bmp':  return 'image/bmp';
    case 'avif': return 'image/avif';
    default:     return 'application/octet-stream';
  }
}
