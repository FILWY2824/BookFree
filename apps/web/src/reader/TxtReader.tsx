// TxtReader 是“按章节阅读”的核心阅读器组件。
// -----------------------------------------------------------------------------
// 它负责渲染后端 book_chapters 表中的章节内容。虽然名字叫 TxtReader，
// 但它不只服务 TXT：EPUB 等格式在前端解析、导入后，最终也会把章节正文
// 写入同一套 book_chapters / book_chunks 表，所以只要内容已经变成“章节 HTML
// 或章节纯文本”，这里就能用同一种方式阅读。
//
// 你可以把整个阅读链路理解成：
//   1. LibraryPage / UploadButton 上传书籍；
//   2. 前端解析书籍并调用后端 ingest API 写入章节；
//   3. ReaderPage 根据书籍格式选择 TxtReader / EpubReader / PdfReader；
//   4. TxtReader 按需请求“章节列表”和“当前章节正文”，再在浏览器里渲染。
// 这种设计能减少 Go 后端常驻内存：后端不需要一次性把整本书放进内存，
// 前端也只在用户阅读时加载当前章节或逐步加载章节。
//
// 本组件支持三种阅读模式：
//
//   • 'paginated'（分页模式）
//     当前章节会被放进 CSS 多列布局中，每一列相当于一页。
//     翻页时不是重新请求数据，而是把列容器横向 translateX。
//     好处：字体大小、行高、主题变化后，浏览器会自动重新排版，代码不需要
//     自己计算每一页应该有多少字。
//
//   • 'scroll-chapter'（单章节滚动）
//     一次只显示当前章节，用户在章节内纵向滚动。底部和左右浮动按钮可以切换
//     上一章 / 下一章。这是比较直观、容易理解的传统阅读模式。
//
//   • 'scroll-book'（整本连续滚动）
//     视觉上也是滚动阅读，但 ReaderPage 会配合章节切换/追加逻辑，让用户接近
//     当前章节底部时继续阅读后续章节。注意：连续保留更多章节会增加前端内存，
//     所以这种模式更适合普通体量书籍。
//
// 标注/笔记能力：
//   - 用户选中文本后，通过 document selectionchange 事件打开 SelectionToolbar；
//   - 已保存的高亮/下划线/笔记会通过 lib/annotations 重新包裹到正文 DOM 上；
//   - 点击已有 span[data-hl-id] 会进入编辑模式，可以改颜色、写笔记或删除。
// 这些标注数据保存在后端 SQLite，不保存在 Go 进程内存里，符合低内存约束。

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { columnMaxWidth, fontFamilyOf, type ReaderPrefs, type PageMode } from '../lib/prefs';
import {
  applyAllHighlights,
  clearHighlights,
  encodeLocatorFromRange,
  highlightClassName,
  locatorToRangeForHighlight,
  wrapRange,
} from '../lib/annotations';
import {
  topVisibleAnchor,
  navigateToCFIv2,
  decodeLocatorAny,
  encodeLocatorV2,
  precedingHeadings,
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

/**
 * ChapterMeta 是“章节列表”里的轻量字段。
 *
 * 后端的 `/api/books/{bookId}/chapters/list` 只返回这些元信息，
 * 不返回正文。这样书籍章节很多时，打开阅读页也不会一次性加载整本书，
 * 对浏览器内存和服务端查询压力都更友好。
 */
interface ChapterMeta {
  /** 后端 book_chapters.id，后续读取正文、保存进度、创建标注都会用到它。 */
  id: string;
  /** 章节顺序，从 0 或 1 开始取决于导入数据；这里作为数组索引/导航依据。 */
  ord: number;
  /** 章节标题，可能为空；为空时 ReaderPage 会使用兜底标题。 */
  title?: string | null;
  /** EPUB 等格式里的原始 href，TXT 可能没有；用于保留未来扩展能力。 */
  href?: string | null;
}

/**
 * ChapterBody 是“单章正文”接口返回的数据。
 *
 * 与 ChapterMeta 的区别：这里包含 html 或 text 正文。TxtReader 每次只请求
 * 当前要看的章节正文，避免一次性把整本书加载进前端内存。
 */
interface ChapterBody {
  /** 当前章节 id。 */
  id: string;
  /** 已经清洗/转换后的 HTML；如果存在，优先按 HTML 渲染。 */
  html?: string | null;
  /** 纯文本正文；如果 html 不存在，就会把 text 转成多个 <p> 段落。 */
  text?: string | null;
  /** 当前章节标题。 */
  title?: string | null;
  /** 当前章节顺序。 */
  ord: number;
}

/**
 * TxtReader 的 props 大多由 ReaderPage 传入。
 *
 * 初学者可以重点看三类 props：
 * 1. 数据定位：bookId、chapterOrd、initialAnchor、searchKeyword；
 * 2. 阅读设置：prefs、pageMode、styleColors；
 * 3. 向父组件汇报状态的回调：onChapterChange、onProgressAnchor、onReady 等。
 */
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
  /** Called with the ordered list of heading texts (h1..h6) that
   *  precede the topmost visible paragraph in document order. The
   *  LAST element is the deepest section the reader is currently
   *  inside. ReaderPage matches this against the TOC deepest-first
   *  so that when the user is in section "1.2.1" but the book's
   *  TOC tops out at "1.2", the parent can still highlight "1.2"
   *  rather than failing the match outright. Empty array when the
   *  chapter has no headings at all. */
  onActiveHeadingPath?: (path: string[]) => void;
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
  styleColors, onProgressAnchor, onActiveChapterChange, onActiveHeadingPath, onProgressPercent, initialAnchor,
  searchKeyword, searchTargetChapterId, onSearchHandled,
}: Props) {
  // chapters：当前书籍的章节目录元信息。只包含 id/title/ord，不包含正文。
  const [chapters, setChapters] = useState<ChapterMeta[]>([]);
  // body：当前正在阅读的单章正文。chapterOrd 改变时重新请求。
  const [body, setBody] = useState<ChapterBody | null>(null);
  // error：页面级错误信息，例如章节接口失败时展示给用户。
  const [error, setError] = useState<string | null>(null);
  // scrollRef 指向最外层滚动容器。滚动模式下用于监听 scrollTop、滚动到顶部等。
  const scrollRef = useRef<HTMLDivElement>(null);
  // proseRef 指向真正承载正文 HTML 的 DOM 节点。标注、搜索高亮、进度定位都围绕它做。
  const proseRef = useRef<HTMLDivElement>(null);
  // 分页状态：pageIdx 是当前页索引，pageCount 是当前章节计算出来的总页数。
  const [pageIdx, setPageIdx] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  // 标注与笔记：从后端 SQLite 读取后放入 React state，再同步到正文 DOM。
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  // 选区工具条状态：
  // tbMode 控制工具条处于“新建标注 / 编辑标注 / 写笔记”等哪种模式。
  const [tbMode, setTbMode] = useState<SelectionToolbarMode | null>(null);
  // tbAnchor 记录工具条应该贴在哪个矩形位置，来自用户选区或已有标注 span 的 DOMRect。
  const [tbAnchor, setTbAnchor] = useState<DOMRect | null>(null);
  // tbCurrent 是当前正在编辑的已有高亮；新建标注时为 null。
  const [tbCurrent, setTbCurrent] = useState<Highlight | null>(null);
  /** A snapshot of the user's selection at the moment the toolbar
   *  opened. We capture this in addition to relying on
   *  window.getSelection() at click time because some browsers /
   *  themes collapse the selection on focus changes — including a
   *  click on the toolbar — which made the apply step silently
   *  abort with "no range" and is the most likely culprit for the
   *  "annotations don't display" bug. With a stored range, the
   *  apply path is robust regardless of selection lifecycle. */
  const tbRangeRef = useRef<Range | null>(null);
  const readyFiredRef = useRef(false);
  const anchorRestoredRef = useRef(false);

  // 加载章节列表：bookId 改变时执行一次。
  //
  // 为什么这里只请求 list，不请求所有章节正文？
  // - 一本书可能有几百章，正文很大；
  // - 章节列表很小，足够支撑目录和上一章/下一章导航；
  // - 真正的正文在下面的 effect 中按 chapterOrd 单章加载。
  //
  // cancelled 是 React 异步请求常见保护：如果组件卸载或 bookId 已变化，
  // 旧请求返回时不再 setState，避免“旧数据覆盖新页面”。
  useEffect(() => {
    let cancelled = false;
    onBusy?.(true);
    anchorRestoredRef.current = false;  // 换了一本书后，允许重新恢复一次阅读进度锚点。
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

  // 加载标注与笔记：每本书加载一次。
  //
  // 这里使用 Promise.all 并行请求高亮和笔记。失败时吞掉错误，因为阅读正文是主功能，
  // 标注属于增强功能；即使标注接口临时失败，也不应该阻塞用户打开书。
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

  // 加载当前章节正文：chapterOrd 或章节列表变化时执行。
  //
  // chapterOrd 是 ReaderPage 持有的“当前章节序号”。这里先把它夹在合法范围内，
  // 再根据 chapters 找到真实 chapter id，最后请求 `/api/books/{bookId}/chapters/{chapterId}`。
  //
  // 加载成功后：
  // - setBody 保存当前章节；
  // - setPageIdx(0) 让新章节从第一页开始；
  // - 滚动模式下把滚动条回到顶部；
  // - 通知 ReaderPage 当前章节 id，用于目录高亮。
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
        // 告诉 ReaderPage 当前显示的是哪一章，这样目录面板可以及时高亮。
        onActiveChapterChange?.(d.chapter.id);
      })
      .catch(e => !cancelled && setError(e.message))
      .finally(() => !cancelled && onBusy?.(false));
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, chapterOrd, chapters]);

  // 把后端返回的 ChapterBody 统一整理成 HTML 字符串。
  //
  // 规则：
  // - 如果 body.html 存在，说明导入阶段已经生成了 HTML，直接使用；
  // - 否则如果只有 body.text，就先做 HTML 转义，避免用户文本里的 <script> 等内容
  //   被浏览器当成真实标签执行，然后按空行拆成 <p> 段落；
  // - 最后调用 cleanLeadingWhitespace 清理章节开头多余空白，避免第一页顶部空太多。
  //
  // useMemo 表示：只要 body 没变，就复用上次计算结果，避免每次渲染都重新处理正文。
  const html = useMemo(() => {
    if (!body) return '';
    const raw = body.html && body.html.trim()
      ? body.html
      : (body.text
        ? body.text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .split(/\n\s*\n+/)
          .map(p => `<p>${p.replace(/\n/g, '<br/>')}</p>`)
          .join('')
        : '');
    return cleanLeadingWhitespace(raw);
  }, [body]);

  // 章节内容或排版参数变化时，重新测量分页，并在绘制前应用已保存的标注。
  //
  // 标注应用策略：
  // - 此 useLayoutEffect 在章节 HTML / body / 排版 或标注数据变化时触发，
  //   负责在绘制前完成 clearHighlights + applyAllHighlights；
  // - onApplyHighlight 中不再立即包裹 DOM，而是仅创建后端记录 + 更新 state，
  //   由本 effect 统一在绘制前包裹，避免立即包裹后被 clearHighlights 清除；
  // - 退出阅读重新进入时：标注数据到达（即使晚于 body）会触发本 effect 重新执行。
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
  }, [html, body, pageMode, prefs.fontSize, prefs.lineHeight, prefs.fontFamily, prefs.columnWidth, highlights, notes]);

  // 标注增量同步：highlights / notes 数组变化时运行。
  //
  // 与上面的“整章重建高亮”不同，这里尽量只改发生变化的 DOM：
  // - 如果某个高亮 span 已经存在，只更新它是否带笔记的 class；
  // - 如果 state 中有高亮，但 DOM 中没有对应 span，就根据 locator 找回 Range 并包裹；
  // - 如果 DOM 中有 span，但 state 中没有，说明用户删除了高亮，需要把 span 拆掉。
  //
  // 这种做法避免频繁清空整章 DOM，对长章节更友好，也能减少标注刚创建后闪烁/消失的问题。
  useEffect(() => {
    const root = proseRef.current;
    if (!root || !body) return;
    const notedSet = new Set(
      notes.filter(n => n.highlightId).map(n => n.highlightId as string),
    );
    const wantById = new Map<string, typeof highlights[number]>();
    for (const h of highlights) {
      if (!h.chapterId || h.chapterId === body.id) wantById.set(h.id, h);
    }
    // Update existing / add missing.
    for (const [id, h] of wantById) {
      const existingSpans = root.querySelectorAll<HTMLSpanElement>(
        `span[data-hl-id="${cssEscape(id)}"]`,
      );
      if (existingSpans.length > 0) {
        const cls = highlightClassName(h, notedSet.has(id));
        existingSpans.forEach(s => {
          if (s.className !== cls) s.className = cls;
          if (notedSet.has(id)) s.setAttribute('data-has-note', '1');
          else s.removeAttribute('data-has-note');
        });
        continue;
      }
      // Missing — try to wrap from locator.
      const range = locatorToRangeForHighlight(root, h);
      if (range) {
        try { wrapRange(range, h, notedSet.has(id)); } catch { /* ignore */ }
      }
    }
    // Remove orphan spans (highlight deleted from state).
    const allSpans = root.querySelectorAll<HTMLSpanElement>('span[data-hl-id]');
    allSpans.forEach(s => {
      const id = s.getAttribute('data-hl-id');
      if (!id || !wantById.has(id)) {
        const parent = s.parentNode;
        if (!parent) return;
        while (s.firstChild) parent.insertBefore(s.firstChild, s);
        parent.removeChild(s);
      }
    });
    root.normalize();
  }, [highlights, notes, body]);

  // 容器尺寸变化时重新计算分页。
  //
  // 不能只监听 window.resize，因为目录抽屉、AI 面板固定在侧边时，浏览器窗口大小没变，
  // 但正文可用宽度变了。ResizeObserver 可以观察具体 track 元素尺寸变化，分页更准确。
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

  // ── 阅读进度恢复 ────────────────────────────────────────────────
  // ReaderPage 会把后端保存的 initialAnchor 传进来。当前章节渲染完成、分页稳定后，
  // 如果锚点属于这一章，就跳转到对应段落。
  //
  // anchorRestoredRef 用来保证“只恢复一次”。否则用户手动翻章后，组件可能又把他拉回
  // 初始进度位置，体验会非常差。
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

  // ── 阅读进度上报 ────────────────────────────────────────────────
  // 用户翻页或滚动时，TxtReader 会找出“当前屏幕最上方可见段落”，编码成 CFIv2
  // locator 后通过 onProgressAnchor 告诉 ReaderPage。ReaderPage 再防抖保存到后端。
  //
  // 同时还会上报当前段落前面的标题路径，用于目录高亮。滚动模式下做了 150ms 节流，
  // 避免用户快速滚动时频繁触发父组件和后端保存。
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
      } else {
        onProgressAnchor?.({
          chapterId: body.id,
          locator: encodeLocatorV2(anchor),
        });
      }
      // Section heading path — the parent matches this against the
      // TOC tree. We emit the array even when empty so the parent can
      // clear its activeHeadingPath state when navigating to a chapter
      // with no headings.
      onActiveHeadingPath?.(precedingHeadings(r));
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

  // ── 阅读百分比上报 ──────────────────────────────────────────────
  // 顶部细进度条需要一个 0..1 的百分比。这里把两个信息合并：
  // - 当前是第几章：chapterOrd / 总章节数；
  // - 当前章内读到哪里：分页模式用 pageIdx/pageCount，滚动模式用 scrollTop/scrollHeight。
  //
  // 这只是一个轻量估算，不追求逐字精确，但足够让阅读器进度条平滑移动。
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

  // ── 搜索结果闪烁定位 ────────────────────────────────────────────
  // 用户从 /search 点击某条搜索结果进入阅读页时，ReaderPage 会传入：
  // - searchKeyword：要在本章内闪烁标记的关键词；
  // - searchTargetChapterId：目标章节 id。
  //
  // 等目标章节渲染完成后，这里遍历文本节点，把匹配词包成
  // `<mark class="search-flash">`，滚动/翻页到第一个匹配位置，并在 3 秒后移除。
  //
  // 为什么不引入 mark.js 等库？
  // - 这里只需要单关键词临时闪烁，逻辑很小；
  // - 多引入一个库会增加前端包体；
  // - 服务端搜索已经由 SQLite FTS5 负责，这里只是页面内定位提示。
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

  // 翻页/翻章按钮是否可用。
  //
  // 分页模式下，“上一页/下一页”优先在当前章节内移动；到达章节边界后才切换章节。
  // 滚动模式下，浮动 PageNav 的上一页/下一页直接表示上一章/下一章。
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

  // 选中文本处理：监听 document 的 selectionchange 事件。
  //
  // 浏览器没有直接给“用户在某个 div 内完成选择”的高级事件，所以这里需要：
  // 1. 读取 window.getSelection()；
  // 2. 判断 Range 是否在 proseRef 正文容器内部；
  // 3. 取选区矩形位置，打开 SelectionToolbar；
  // 4. 把 Range clone 一份存到 tbRangeRef，避免用户点击工具条时选区丢失。
  useEffect(() => {
    const onSel = () => {
      const sel = window.getSelection();
      const root = proseRef.current;
      if (!sel || sel.rangeCount === 0 || !root) {
        return;
      }
      const range = sel.getRangeAt(0);
      const text = range.toString();
      // Empty selection in 'create' mode means the user clicked away
      // and the caret moved — close the toolbar. (Both cases land
      // here because selectionchange fires on caret moves too.)
      if (!text || text.trim().length === 0) {
        if (tbMode === 'create') {
          setTbMode(null);
          setTbAnchor(null);
          tbRangeRef.current = null;
          onSelection?.(null);
        }
        return;
      }
      // Confirm range is inside the prose root.
      if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
      const rect = range.getBoundingClientRect();
      if (rect.width < 1 && rect.height < 1) return;
      // Snapshot the range so the apply path doesn't depend on the
      // selection still being alive when the user clicks a chip.
      tbRangeRef.current = range.cloneRange();
      setTbCurrent(null);
      setTbMode('create');
      setTbAnchor(rect);
      onSelection?.(text);
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, [tbMode, onSelection]);

  // Click-outside dismissal for the selection toolbar. The previous
  // version only relied on selectionchange, which works when the
  // user clicks BACK INTO the prose (the click collapses the
  // selection, selectionchange fires, we close). It does NOT work
  // when the user clicks outside the prose entirely — header,
  // sidebar, dock — because in those cases the browser doesn't
  // change the selection at all and selectionchange never fires.
  // This handler picks up that case: any pointer-down whose target
  // is outside the toolbar AND outside an existing-annotation
  // <span data-hl-id> gets us to close. We listen on capture so a
  // click that lands on a button still closes the toolbar BEFORE
  // the button's own handler runs (matters for clicks on header
  // chips that would otherwise leave a stale toolbar floating).
  useEffect(() => {
    if (!tbMode) return;
    const onDocPointer = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // Click inside the toolbar itself? Don't close — that's the
      // user choosing an action. Detect via data-selection-toolbar
      // attribute we set on the toolbar root.
      if (target.closest('[data-selection-toolbar="1"]')) return;
      // Click on an existing highlight span in 'edit' mode? Let the
      // prose's onProseClick handler decide what to do (it may swap
      // to a different highlight in edit mode).
      if (tbMode === 'edit' && target.closest('span[data-hl-id]')) return;
      // Otherwise close. We don't clear the selection itself — the
      // browser's own click handling will collapse it as part of
      // moving the caret to wherever the user clicked.
      setTbMode(null);
      setTbAnchor(null);
      setTbCurrent(null);
      tbRangeRef.current = null;
      onSelection?.(null);
    };
    document.addEventListener('mousedown', onDocPointer, true);
    document.addEventListener('touchstart', onDocPointer as unknown as EventListener, true);
    return () => {
      document.removeEventListener('mousedown', onDocPointer, true);
      document.removeEventListener('touchstart', onDocPointer as unknown as EventListener, true);
    };
  }, [tbMode, onSelection]);

  // 点击已有高亮 span：进入编辑模式。
  //
  // 高亮渲染时会带 data-hl-id 属性。点击正文时向上找最近的 span[data-hl-id]，
  // 再根据 id 从 highlights state 里找到对应记录，打开工具条。
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

  // ── 标注/笔记操作 ───────────────────────────────────────────────
  //
  // 下面这些回调会被 SelectionToolbar 调用。它们大多遵循同一个模式：
  // 1. 从当前 DOM 选区或当前高亮中拿到 locator / selectedText；
  // 2. 调用 `lib/highlights.ts` 中的 API 函数请求后端；
  // 3. 成功后更新 React state；
  // 4. 必要时立即更新 DOM，让用户不用等下一次整章重渲染。
  //
  // containerRect 用于告诉工具条“阅读容器在屏幕上的位置”，工具条可据此避免超出边界。
  const containerRect = scrollRef.current?.getBoundingClientRect() ?? null;

  const onApplyHighlight = useCallback(async (style: HighlightStyle, color: HighlightColor) => {
    const root = proseRef.current;
    if (!root || !body) return;
    // Prefer the snapshot we took when the toolbar opened — the live
    // selection may have been collapsed by the click on the toolbar
    // chip itself, and on some browsers the preventDefault on the
    // toolbar's mousedown isn't enough to keep the caret pinned.
    let range: Range | null = tbRangeRef.current;
    if (!range || !root.contains(range.startContainer) || !root.contains(range.endContainer)) {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      range = sel.getRangeAt(0);
      if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
    }
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
      // 不在此处立即包裹 DOM——由 useLayoutEffect（依赖 highlights）
      // 在绘制前统一完成包裹。立即包裹会在 useLayoutEffect 的
      // clearHighlights 中被清除，然后重新从 locator 包裹。如果 locator
      // 解析因 DOM 变化而失败，标注就会丢失。统一在 useLayoutEffect 中
      // 包裹可避免两轮操作造成的不一致。
      setHighlights(prev => [...prev, created]);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      tbRangeRef.current = null;
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

  // 修改已有标注颜色。
  //
  // 当前后端还没有“PATCH /api/highlights/{id} 修改颜色”的接口，所以这里用一个
  // 兼容方案实现：
  // 1. 在同一个 locator 上创建一个新颜色的 highlight；
  // 2. 如果旧 highlight 绑定了笔记，就创建新 note 并迁移过去；
  // 3. 删除旧 highlight 和旧 note；
  // 4. 更新本地 state。
  //
  // 用户看到的效果就是“颜色变了”。代价是 highlight id 会变化，但当前业务不依赖稳定 id。
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

    // 路径 A：正在给已有高亮编辑/新增笔记。
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

    // 路径 B：从一段全新的选中文本创建笔记。
    //
    // 这里会先创建一个 highlight，再创建一个 note 并绑定到 highlight。
    // 原因：笔记需要在正文里有一个可点击、可定位的位置；highlight 就承担这个锚点角色。
    // styleColors.note 是“笔记默认颜色”，与普通高亮颜色独立记忆。
    let range: Range | null = tbRangeRef.current;
    if (!range || !root.contains(range.startContainer) || !root.contains(range.endContainer)) {
      const sel0 = window.getSelection();
      if (!sel0 || sel0.rangeCount === 0) return;
      range = sel0.getRangeAt(0);
      if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
    }
    const txt = range.toString();
    if (!txt || txt.trim().length === 0) return;
    const locator = encodeLocatorFromRange(root, body.id, range);
    if (!locator) return;
    try {
      const hl = await createHighlight(bookId, {
        chapterId: body.id,
        locator,
        selectedText: txt,
        color: styleColors.note,
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
      } catch { /* incremental effect will retry */ }
      const sel = window.getSelection();
      sel?.removeAllRanges();
      tbRangeRef.current = null;
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
    tbRangeRef.current = null;
  }, []);

  // ── 渲染 ────────────────────────────────────────────────────────
  //
  // JSX 可以分成三层理解：
  // 1. 最外层 scrollRef：负责滚动或隐藏溢出；
  // 2. PageNav：负责左右翻页/翻章交互；
  // 3. proseRef：真正承载章节 HTML，所有高亮、搜索闪烁、进度定位都作用在这里。
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
              className="reader-prose reader-paginated reader-paginated-track"
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
            className="reader-prose mx-auto px-10 py-14"
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

// PaginatedFrame：使用 CSS columns 实现“横向分页”。
//
// 这里是分页模式最关键的布局结构。它故意使用三层 div：
//
//   <viewport>            // overflow:hidden，屏幕真正可见的区域
//     <padder>            // 只负责 padding，定义内容盒子的宽度
//       <track>           // CSS columns 和 translateX 都放在这里
//         {children}      // 章节正文 prose
//       </track>
//     </padder>
//   </viewport>
//
// 为什么不能把 padding、columns、translateX 都放在同一个元素上？
// 因为 `translateX(-100%)` 的 100% 会按 padding-box 计算，而 CSS column 的
// 可读区域又受 content-box 影响，两者不一致时会出现：第一页空白、内容被切断、
// 最后一页丢失等问题。三层结构让“列宽”和“横向移动距离”严格一致。
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
          // 阅读区域四周留有充足间距，确保文字不贴边：
          // padding：上 3.5rem 下 5rem 左右 2.5rem。
          // 底部留更大空间以避免 CSS columns 中最后一行被截断的视觉问题。
          padding: '3.5rem 2.5rem 5rem',
          maxWidth: columnMaxWidth(prefs),
          margin: '0 auto',
          boxSizing: 'border-box',
          overflow: 'hidden',
        }}
      >
        <div
          className="reader-paginated reader-paginated-track"
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

// ── HTML 正规化/清理 ───────────────────────────────────────────────
//
// cleanLeadingWhitespace 会在渲染前遍历一次章节 HTML：
//   1. 删除开头多余的 <br>、空 <p>、空 <div> 等；
//   2. 清理第一个可见元素上的 margin-top / padding-top 等内联样式。
//
// 为什么使用 DOMParser，而不是正则替换字符串？
// HTML 可能有嵌套标签，用正则很容易误删合法内容。DOMParser 会把字符串解析成 DOM 树，
// 我们可以按节点类型安全处理；同时 DOMParser 解析出来的文档不会执行脚本，也不会发起资源请求。
function cleanLeadingWhitespace(rawHtml: string): string {
  if (!rawHtml) return rawHtml;
  let doc: Document;
  try {
    // Wrap in a body so DOMParser doesn't synthesise its own.
    doc = new DOMParser().parseFromString(
      `<!doctype html><body><div id="__root__">${rawHtml}</div></body>`,
      'text/html',
    );
  } catch {
    return rawHtml;
  }
  const container = doc.getElementById('__root__');
  if (!container) return rawHtml;

  // Strip leading empties. "Empty" = no non-whitespace text and no
  // descendants that introduce visible content (img, table, etc.).
  while (container.firstChild) {
    const node = container.firstChild;
    if (node.nodeType === Node.TEXT_NODE) {
      if ((node.textContent ?? '').trim() === '') {
        container.removeChild(node);
        continue;
      }
      break;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      container.removeChild(node);
      continue;
    }
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (tag === 'br' || tag === 'hr') {
      container.removeChild(el);
      continue;
    }
    const txt = (el.textContent ?? '').trim();
    const hasMedia = !!el.querySelector('img, svg, picture, video, audio, table, figure');
    if (!txt && !hasMedia) {
      container.removeChild(el);
      continue;
    }
    break;
  }

  // Cap top-margin / padding-top on the first element so an inline
  // `margin-top: 6em` doesn't push the heading down half a page.
  const first = container.firstElementChild as HTMLElement | null;
  if (first) {
    const style = first.getAttribute('style');
    if (style) {
      const cleaned = style
        .replace(/(^|;)\s*margin-top\s*:[^;]*;?/gi, ';')
        .replace(/(^|;)\s*padding-top\s*:[^;]*;?/gi, ';')
        .replace(/(^|;)\s*margin\s*:[^;]*;?/gi, ';')
        .replace(/^\s*;+/, '')
        .trim();
      if (cleaned) first.setAttribute('style', cleaned);
      else first.removeAttribute('style');
    }
  }

  return container.innerHTML;
}

// CSS.escape 的兼容封装。
//
// 我们需要把 highlight id 放进 CSS 属性选择器：`span[data-hl-id="..."]`。
// 如果 id 里包含特殊字符，不转义就可能让 querySelector 语法错误。
// 现代浏览器有 CSS.escape；没有时用一个简单 fallback 转义非字母数字字符。
function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(s);
  }
  return s.replace(/[^a-zA-Z0-9_-]/g, ch => '\\' + ch);
}

// ── 搜索闪烁辅助函数 ───────────────────────────────────────────────
//
// wrapKeywordMatches 会遍历 root 内所有文本节点，把关键词 kw 的每一次出现包成：
//   <mark class="search-flash" data-search-flash="1">关键词</mark>
//
// 返回值是所有新插入的 mark，顺序与文档中出现顺序一致。后续可以拿第一个 mark
// 滚动/翻页到对应位置。
// 注意：会跳过 mark/script/style 内的文本，避免重复包裹或误处理脚本/样式内容。

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
