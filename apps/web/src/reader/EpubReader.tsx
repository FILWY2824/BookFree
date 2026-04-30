// EPUB 阅读器。
// 这个文件负责“直接阅读原始 .epub 文件”：它并不把 EPUB 全部转换成 HTML 放到当前页面，
// 而是使用 epubjs 在一个受限制的 iframe 中渲染 EPUB 内容，并用 EPUB 自带的 CFI/章节索引来翻页。
//
// 对初学者来说，可以把本组件理解为 ReaderPage 分发出来的“EPUB 专用显示器”：
// - ReaderPage 负责顶部栏、目录、阅读设置、AI 面板、进度保存等通用能力；
// - EpubReader 只负责把一本 EPUB 文件渲染出来，并把“当前位置变化/选中文本/忙碌状态”回传给 ReaderPage。
//
// 这里保留原有英文说明的核心背景，并补充中文解释：
//
//   1. 避免导航导致的重复渲染循环。
//      EPUB 翻页后 epubjs 会触发 relocated 事件，ReaderPage 可能据此更新 chapterOrd。
//      如果本组件又把这个 chapterOrd 当作“外部要求跳转目录”去 display()，就会出现
//      “翻一页 → 回调更新 → 再 display 同一页 → 忙碌弹窗闪烁”的循环。
//      所以这里用 lastSeenOrdRef 记录“屏幕上实际所在章节”，只有真正不一致时才跳转。
//
//   2. 鼠标滚轮在 iframe 内也能翻页。
//      EPUB 内容实际在 iframe 里，iframe 内部事件不会冒泡到父页面。
//      如果只在父页面左右区域监听滚轮，光标放在正文上时就翻不了页。
//      因此本组件在 epubjs 每次 rendered 后进入 iframe document 安装 wheel handler。
//
//   3. 字体设置真正覆盖 EPUB 内置样式。
//      很多 EPUB 文件自带 CSS，会在 p/div/span 等元素上直接写 font-family。
//      只给 body 设置字体往往不生效，所以 applyTheme 会给常见文本元素都写上 !important。
//
// pageMode 处理：
//   - 'paginated'：epubjs 使用分页模式，接近电子书阅读器体验；
//   - 'scroll-chapter' / 'scroll-book'：epubjs 使用 scrolled-doc。
//     epubjs 的 iframe 模型不天然支持“整本书连续滚动”，因此这里退化为“当前章节滚动”。

import { useEffect, useRef, useState } from 'react';
import type { ReaderPrefs, PageMode } from '../lib/prefs';
import { fontFamilyOf } from '../lib/prefs';
import { getThemeColors } from '../lib/themes';
import PageNav, { attachWheelPager } from '../components/PageNav';

// ReaderPage 传入的参数。
// 注意：这里没有自己保存用户偏好或全局阅读状态，而是通过 props 接收/回调。
// 这样 ReaderPage 可以统一管理不同格式阅读器的通用行为，未来 Android 端也可以复用后端进度 API。
interface Props {
  // 后端书籍 ID，用于请求 /api/books/{bookId}/file 获取原始 EPUB 文件。
  bookId: string;
  // 当前阅读偏好：主题、字体大小、行高、字体族等。
  prefs: ReaderPrefs;
  // 用户从目录中选择的章节序号；这里会映射到 epubjs spine item。
  /** Chapter ord the user picked from the TOC (we map → spine index). */
  chapterOrd: number;
  // 阅读模式：分页、单章滚动、整书滚动（EPUB 中整书滚动会退化为单章滚动）。
  pageMode: PageMode;
  // epubjs 报告位置变化后通知 ReaderPage，ReaderPage 再负责保存进度。
  onLocationChange: (ord: number) => void;
  // 初次渲染完成后通知外层。
  onReady?: () => void;
  // 通知外层显示/关闭“正在重新渲染”之类的忙碌状态。
  onBusy?: (busy: boolean) => void;
  // 用户在 EPUB iframe 内选中文本时，把文本回传给外层工具条/AI 面板。
  onSelection?: (text: string | null) => void;
}

// epubjs 没有在本项目中完整暴露严格类型，这里只声明本组件真正用到的最小接口。
// 这样比直接使用 any 更安全，也能让初学者看到我们依赖了 epubjs 的哪些能力。
interface EpubBook {
  // EPUB 解析完成的 Promise。必须等待 ready 后才能安全读取 spine、navigation 等信息。
  ready: Promise<void>;
  // 销毁书籍对象，释放 iframe/事件/内部缓存等资源。
  destroy(): void;
  // spine 是 EPUB 的“阅读顺序列表”，可以近似理解为章节文件列表。
  spine: { items: Array<{ idref: string; href: string; index?: number }> };
  // 在指定 DOM 容器中创建渲染器。
  renderTo(el: HTMLElement, opts: Record<string, unknown>): EpubRendition;
  // 导航信息，当前组件未直接展开使用，但保留在类型中方便后续扩展。
  loaded: { navigation: Promise<{ toc: unknown[] }> };
}

interface EpubRendition {
  // 显示某个 spine href、CFI 或默认位置。
  display(target?: string | number): Promise<void>;
  // 上一页/上一段位置。
  prev(): Promise<void>;
  // 下一页/下一段位置。
  next(): Promise<void>;
  // 订阅 epubjs 事件，例如 selected、relocated、rendered。
  on(ev: string, cb: (...args: unknown[]) => void): void;
  // 某些 epubjs 版本支持 off；这里没有强依赖。
  off?(ev: string, cb: (...args: unknown[]) => void): void;
  /** Recompute pagination for the current container size. epubjs caches
   *  the iframe dimensions at renderTo time, so we have to call this
   *  ourselves whenever the layout reflows around it (TOC pin/unpin,
   *  AI panel pin/unpin, window resize). */
  resize?(width?: string | number, height?: string | number): void;
  // epubjs 的主题系统：可以把 CSS 注入 EPUB iframe。
  themes: {
    register(name: string, rules: Record<string, Record<string, string>>): void;
    select(name: string): void;
    fontSize(s: string): void;
  };
  // 销毁渲染器。
  destroy(): void;
}

// epubjs rendered/selected 事件中会给出 iframe 的 window/document。
// 只声明需要的字段，避免把 epubjs 内部对象类型化得过重。
type IframeContents = {
  window?: Window;
  document?: Document;
};

export default function EpubReader({
  bookId, prefs, chapterOrd, pageMode,
  onLocationChange, onReady, onBusy, onSelection,
}: Props) {
  // epubjs 会把 iframe 挂载到这个容器中。
  const containerRef = useRef<HTMLDivElement>(null);
  // 当前活跃的 rendition。翻页、应用主题、resize 都要通过它。
  const renditionRef = useRef<EpubRendition | null>(null);
  // 当前活跃的 EPUB book 对象。重建 rendition 或销毁时需要它。
  const bookRef = useRef<EpubBook | null>(null);

  // 第一次 display() 后，epubjs 通常会马上触发一次 relocated。
  // 那次事件只是“初始定位完成”的回声，不代表用户真的翻页。
  // 如果不忽略它，可能会覆盖 ReaderPage 中原本保存的章节进度。
  // The very first 'relocated' event fires synchronously after display()
  // and reports the destination's index. Without this guard, mount-time
  // location callbacks (chapterOrd=savedOrd) and post-mount user
  // navigation are indistinguishable. We swallow exactly one event,
  // which is the one fired by our initial display() call.
  const initialRelocateRef = useRef(true);

  // lastSeenOrdRef 记录“屏幕上实际显示到哪个 spine 序号”。
  // 它有两个更新来源：
  // 1. 我们主动调用 display() 跳转时；
  // 2. 用户翻页后 epubjs 通过 relocated 告诉我们位置变化时。
  //
  // 为什么不能只看 props.chapterOrd？
  // 因为 props.chapterOrd 既可能来自“用户点击目录”，也可能来自“我们刚刚上报位置变化后父组件回传”。
  // 用 lastSeenOrdRef 可以区分这两种情况，避免重复 display()。
  // Tracks the most recent chapter ord that's actually on screen — set
  // when we call display() ourselves AND when epub.js reports a
  // relocate from user navigation. The chapter-effect uses this to
  // decide whether the prop change reflects a real TOC click (different
  // from on-screen → re-display) or a feedback loop from our own
  // relocate handler (same as on-screen → no-op).
  const lastSeenOrdRef = useRef(chapterOrd);

  // EPUB 加载/渲染失败时展示错误。
  const [error, setError] = useState<string | null>(null);

  // iframe 内安装的事件处理函数如果直接闭包捕获 prev/next，可能拿到旧 props。
  // 因此这里用 ref 保存“最新的 prev/next 函数”，iframe 事件只调用 ref.current。
  // Refs to the live callbacks so the wheel handler installed in the
  // iframe can call the latest functions without re-installing each
  // time props change.
  const onPrevRef = useRef<() => void>(() => {});
  const onNextRef = useRef<() => void>(() => {});

  // 一个 EPUB 在翻页或切章时可能创建多个 iframe document。
  // Map<Document, teardown> 用来记录哪些 document 已经安装过滚轮监听，避免重复安装，
  // 也方便组件卸载或 pageMode 切换时统一清理。
  // Each iframe we've installed a wheel handler on, with its teardown.
  // We rely on epub.js to dispose of old iframes; we just make sure
  // we don't install twice on the same one.
  const wheelTeardownsRef = useRef<Map<Document, () => void>>(new Map());

  // 给 EPUB iframe 内部 document 安装滚轮翻页。
  // 由于 iframe 事件不会冒泡到父页面，必须进入 iframe document 单独安装。
  function installIframeHandlers(contents: IframeContents | undefined) {
    const doc = contents?.document;
    if (!doc) return;
    if (wheelTeardownsRef.current.has(doc)) return;
    // 滚动阅读模式下不要劫持滚轮，否则用户无法自然向下滚动正文。
    // 只有分页模式才把滚轮解释为上一页/下一页。
    // Skip wheel-pager installation in scroll modes — there the user
    // expects native vertical scrolling inside the iframe (epubjs
    // sets flow:'scrolled-doc'). Hijacking wheel for page flips would
    // strand them at the top of every chapter with no way to read on.
    if (pageMode !== 'paginated') return;
    const teardown = attachWheelPager(doc, {
      onPrev: () => onPrevRef.current(),
      onNext: () => onNextRef.current(),
      canPrev: () => true,
      canNext: () => true,
      // EPUB 分页模式下 iframe 里通常没有需要优先尊重的内部滚动容器。
      // The iframe documents we render don't have meaningful nested
      // scrollables for paginated reading.
      respectScrollables: false,
    });
    wheelTeardownsRef.current.set(doc, teardown);
  }

  // 统一卸载所有安装到 iframe document 上的滚轮监听。
  // 注意 try/catch：清理阶段失败不应该阻断 React 卸载流程。
  function uninstallAllIframeHandlers() {
    for (const teardown of wheelTeardownsRef.current.values()) {
      try { teardown(); } catch { /* ignore */ }
    }
    wheelTeardownsRef.current.clear();
  }

  // 挂载和销毁 EPUB。
  // 这个 effect 只在 bookId 变化时重新执行，也就是“换一本书”才完整重建。
  //
  // 关键链路：
  // 1. 动态 import('epubjs')，避免 EPUB 阅读器没有打开时就加载较大的解析库；
  // 2. 从后端 /api/books/{bookId}/file 拉取原始文件；
  // 3. 用 epubjs 解析 ArrayBuffer；
  // 4. renderTo(container) 创建 iframe 渲染器；
  // 5. 应用主题并绑定事件；
  // 6. display(saved chapter) 打开保存的位置。
  //
  // 低内存说明：
  // - Go 后端只通过 ServeContent 流式提供原始文件；
  // - EPUB 解析和 iframe 渲染在浏览器端完成，避免 Go 服务端常驻解析器/缓存；
  // - dynamic import 也避免普通 TXT/PDF 阅读时加载 epubjs。
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
          // 安全边界：不允许 EPUB 中脚本执行。
          // 这对自托管阅读器很重要，因为用户可能上传来源不明的书籍文件。
          allowScriptedContent: false,
        });
        renditionRef.current = rendition;
        applyTheme(rendition, prefs);
        wireRenditionEvents(rendition);

        // 打开保存的章节序号。spine.items[ord] 近似等价于“阅读顺序中的第 ord 个章节文件”。
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
  // 这里故意只依赖 bookId。
  // 如果把 prefs/pageMode/chapterOrd 都放进依赖，普通设置变化或翻页就可能完整重建 EPUB。
  // 这些变化分别由下面的 effect 精细处理。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // 响应目录点击：ReaderPage 会把用户选择的目录项转换成 chapterOrd 传进来。
  // 只有当 chapterOrd 和 lastSeenOrdRef 不一致时才真正 display()。
  // 如果一致，说明这只是我们上报位置后父组件回传的新 props，不需要重复跳转。
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

  // 响应阅读偏好变化：把主题、字体、行高等设置推入 EPUB iframe。
  // EPUB 内容在 iframe 里，不会自动继承父页面 CSS 变量，所以必须通过 epubjs themes 注入。
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

  // 当容器尺寸变化时重新分页。
  // 典型场景：目录侧栏固定/取消固定、AI 面板固定/取消固定、浏览器窗口变化。
  // epubjs 会缓存 renderTo 时的 iframe 尺寸，如果不调用 resize，正文可能溢出或分页不准。
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
      // 跳过布局稳定过程中的 1px 左右抖动，避免频繁 resize。
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

  // pageMode 改变时必须重建 rendition。
  // 原因：epubjs 的 flow 选项是在 renderTo 时确定的，不能可靠地在原 rendition 上热切换。
  // 所以这里销毁旧 rendition，用同一本 book 创建新 rendition，再跳回 lastSeenOrdRef 所在章节。
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
  // 这里故意只在 pageMode 改变时执行。
  // chapterOrd 跳转、prefs 改变都有自己的 effect，混在一起会造成无谓重建。
  // We intentionally only rerun this when pageMode flips. chapterOrd
  // changes are handled by their own effect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageMode]);

  // 绑定 epubjs rendition 生命周期事件。
  // 抽成函数是因为初次挂载和 pageMode 重建 rendition 时都需要执行同一组绑定。
  // Wire up rendition lifecycle events. Extracted because we need
  // identical wiring on initial mount AND on pageMode-driven re-init.
  function wireRenditionEvents(rendition: EpubRendition) {
    // 用户在 EPUB iframe 内选中文本。
    // selected 事件参数里可能包含 iframe contents，可以从 contents.window.getSelection() 取选中文本。
    rendition.on('selected', (...args: unknown[]) => {
      const contents = args[1] as IframeContents | undefined;
      const sel = contents?.window?.getSelection?.();
      const text = sel ? sel.toString() : '';
      onSelection?.(text && text.trim().length > 0 ? text : null);
    });

    // epubjs 位置变化事件，通常发生在 display()/prev()/next() 后。
    // 这里把 spine index 上报给 ReaderPage，用于目录高亮和阅读进度保存。
    rendition.on('relocated', (...args: unknown[]) => {
      // 抑制第一次 display() 触发的 relocated，避免把初始化过程误当用户操作。
      // Suppress the very first relocate (the one for our own initial
      // display() call) so we don't overwrite the saved chapter ord.
      if (initialRelocateRef.current) {
        initialRelocateRef.current = false;
        return;
      }
      const loc = args[0] as { start?: { index?: number } } | undefined;
      const idx = loc?.start?.index;
      if (typeof idx !== 'number') return;
      // 先更新 lastSeen，再调用 onLocationChange。
      // 因为 onLocationChange 会让父组件更新 chapterOrd 并回传；
      // 如果 lastSeen 已经是新值，chapterOrd effect 就会判断“无需重复 display”。
      // Update lastSeen FIRST, so the chapter-effect that fires when
      // onLocationChange propagates the new ord up to ReaderPage will
      // see (chapterOrd === lastSeenOrdRef.current) and bail without
      // re-displaying.
      lastSeenOrdRef.current = idx;
      onLocationChange(idx);
    });

    // 每次 epubjs 渲染出一个 iframe/view 时触发。
    // 在这里安装 iframe 内滚轮翻页，并关闭 busy 状态。
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

  // 上一页/下一页。
  // 在分页模式下通常是翻页；在 scrolled-doc 下，epubjs 会按它自己的方式移动阅读位置。
  function prev() { renditionRef.current?.prev().catch(() => { /* */ }); }
  function next() { renditionRef.current?.next().catch(() => { /* */ }); }

  // 保持 iframe 内 wheel handler 调用的始终是最新 prev/next。
  // 这是一种常见 React 模式：事件监听器不频繁重绑，但监听器内部通过 ref 读取最新回调。
  // Keep the ref-stable callbacks pointing at the latest closures so
  // the in-iframe wheel handler doesn't need to be reinstalled when
  // props change.
  onPrevRef.current = prev;
  onNextRef.current = next;

  // 滚动模式下关闭左右点击热区，避免干扰 iframe 内正常滚动。
  // 但仍保留 PageNav 的浮动按钮，因为它们可以作为章节/位置移动控制。
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
        {/* epubjs 会在这个容器中创建并管理 iframe。 */}
        <div ref={containerRef} className="h-full w-full" />
      </PageNav>
    </div>
  );
}

// 把 BookFree 的阅读偏好应用到 EPUB iframe。
// EPUB 与普通 DOM 最大的差异是：正文在 iframe 里，父页面 CSS 不会天然作用进去，
// 所以必须通过 epubjs 的 themes.register 注入 CSS 规则。
function applyTheme(r: EpubRendition, prefs: ReaderPrefs) {
  // 为什么不直接 getComputedStyle(documentElement) 读取 CSS 变量？
  //
  // React 18 中子组件 effect 可能早于父组件 effect 执行。
  // 如果父组件刚刚切换 data-reader-theme，但对应 CSS 变量还没被父 effect 写好，
  // 子组件此时读取 getComputedStyle 可能拿到旧主题颜色。
  // 因此这里直接从 getThemeColors(prefs.theme) 的主题表读取颜色，结果更确定。
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

  // 大多数 EPUB 自带 CSS，会直接给 p/div/span 等元素设置字体和颜色。
  // 如果我们只写 html/body，很可能被 EPUB 内部样式覆盖。
  // 因此下面对常见文本选择器使用 !important，确保用户在阅读设置里选择的字体/主题真正生效。
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
