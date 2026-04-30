/*
 * ReaderPage 是“阅读页”的总控组件。
 *
 * 你可以把这个文件理解成阅读功能的调度中心：
 * - 它不直接解析 TXT/EPUB/PDF 的具体内容；
 * - 它负责根据书籍格式选择 TxtReader / EpubReader / PdfReader / CbzReader；
 * - 它负责页面顶部工具栏、目录栏、阅读设置、AI 面板、加载遮罩等阅读器外壳；
 * - 它负责从后端加载书籍、章节列表、目录、阅读进度；
 * - 它负责把阅读器上报的最新进度防抖保存到后端。
 *
 * 状态职责拆分：
 *
 *   ReaderPage：
 *   - 当前打开哪本书；
 *   - 当前章节序号 / PDF 页码；
 *   - 阅读偏好 prefs，例如主题、字号、翻页模式；
 *   - 目录和设置面板是否打开；
 *   - 阅读进度同步；
 *   - AI 面板；
 *   - 批注样式对应颜色；
 *   - 顶部显示的章节标题和目录高亮。
 *
 *   各具体 Reader：
 *   - 负责获取并渲染具体内容；
 *   - 负责监听用户选择文本；
 *   - 负责上报当前阅读位置；
 *   - 负责上报当前活跃章节；
 *   - 负责告诉 ReaderPage 自己是否 ready/busy。
 *
 * 当前几个重要行为：
 *
 * 1. 目录栏 TocDrawer 常驻
 *    用户曾反馈“目录不允许收起来”，所以非 PDF 书籍会一直显示目录栏。
 *    PDF 是例外，因为 PDF 没有普通章节目录结构。
 *
 * 2. 目录高亮由 reader 上报
 *    过去如果只依赖 chapters[chapterOrd]，快速翻页或章节加载失败时可能高亮错。
 *    现在由具体 reader 上报 activeChapterId 和 activeHeadingPath，更贴近真实阅读位置。
 *
 * 3. 阅读进度使用 CFIv2 locator / paragraph anchor
 *    只保存 chapterOrd 不够精确：字号、主题、翻页方式变化后，用户可能无法回到同一段。
 *    所以这里会保存 locator + chapterId。
 *    同时仍写入旧字段 chapterOrder，保证旧逻辑或旧客户端还能工作。
 *
 * 4. 搜索跳转
 *    从搜索页点击结果会进入 /book/:id?q=关键词&chapter=章节ID。
 *    ReaderPage 读取这些参数后跳转到对应章节并让 TxtReader 高亮关键词。
 *    处理完成后会删除 URL 参数，避免刷新页面时重复触发跳转。
 *
 * 5. 对低内存后端的意义
 *    阅读页的大量交互状态都保存在前端；
 *    后端主要提供按需 API，不长期保存大块内存状态；
 *    这符合 BookFree “Go 后端轻量常驻、Web 优先、Android 可复用 API”的架构目标。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, Link, useSearchParams } from 'react-router-dom';
import { api, ApiException } from '../lib/api';
import { loadPrefs, savePrefs, resolvePageMode, type ReaderPrefs } from '../lib/prefs';
import { fetchToc, findTocByHeadingPath, type TocItem } from '../lib/toc';
import type { HighlightColor, HighlightStyle } from '../lib/highlights';
import SettingsDrawer from '../components/SettingsDrawer';
import TocDrawer from '../components/TocDrawer';
import BlockingModal from '../components/BlockingModal';
import AIChatPanel from '../components/AIChatPanel';
import TxtReader from '../reader/TxtReader';
import EpubReader from '../reader/EpubReader';
import PdfReader from '../reader/PdfReader';
import CbzReader from '../reader/CbzReader';

/*
 * BookDTO 是阅读页需要的书籍元数据。
 *
 * 它对应后端 GET /api/books/{id} 返回的 book 对象中的一部分字段。
 * ReaderPage 不需要书籍列表页的所有信息，只关心：
 * - id：请求章节、文件、进度时要用；
 * - title：顶部标题展示；
 * - authors：未来可以展示作者；
 * - format：决定使用哪个 reader；
 * - status：可用于判断是否可读。
 */
interface BookDTO {
  id: string;
  title: string;
  authors?: string[];
  format: string;
  status: string;
}

/*
 * Chapter 是章节列表中的一项。
 *
 * ord 是章节顺序，从 0 开始。
 * title 允许为空，因为有些文件格式或解析器无法提取章节标题。
 */
interface Chapter {
  id: string;
  ord: number;
  title?: string | null;
}

/*
 * ProgressAnchor 表示一个更精确的阅读位置。
 *
 * chapterId：位置属于哪个章节。
 * locator：章节内部定位符，例如段落锚点 / CFIv2 字符串。
 *
 * 它比单纯 chapterOrd 精确，能让用户重新打开书时回到更接近上次阅读的段落。
 */
interface ProgressAnchor {
  chapterId: string;
  locator: string;
}

export default function ReaderPage() {
  /*
   * useParams 从路由 /book/:id 中读取 id。
   * 如果 URL 是 /book/abc123，这里的 id 就是 abc123。
   */
  const { id = '' } = useParams<{ id: string }>();

  /*
   * useNavigate 用于代码中主动跳转页面。
   * 例如书籍不存在时跳回 /library。
   */
  const navigate = useNavigate();

  /*
   * useSearchParams 用于读取和修改 URL 查询参数。
   * 搜索页跳转阅读页时会带上 ?q=关键词&chapter=章节ID。
   */
  const [searchParams, setSearchParams] = useSearchParams();

  /*
   * book：当前书籍元数据。
   * error：打开书籍失败时显示错误页。
   * prefs：阅读偏好，从 localStorage 或默认值加载。
   *
   * useState(() => loadPrefs()) 使用函数作为初始值：
   * - React 只会在组件首次挂载时调用 loadPrefs；
   * - 避免每次渲染都读取 localStorage。
   */
  const [book, setBook] = useState<BookDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<ReaderPrefs>(() => loadPrefs());

  /*
   * chapters：扁平章节列表，主要用于上一章/下一章和章节 ord 定位。
   * tocItems：层级目录树，主要用于左侧目录展示。
   * chapterOrd：当前章节序号，TXT/EPUB/CBZ 等章节型阅读器使用。
   * pdfPage：当前 PDF 页码，PDF 阅读器使用。
   */
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [tocItems, setTocItems] = useState<TocItem[]>([]);
  const [chapterOrd, setChapterOrd] = useState(0);
  const [pdfPage, setPdfPage] = useState(1);

  /*
   * progressLoaded 表示“已尝试从后端读取阅读进度”。
   *
   * 为什么需要它？
   * - 如果进度还没加载，就立刻渲染 reader，reader 可能先跳到第 0 章；
   * - 随后进度加载回来又跳转，用户会看到闪烁；
   * - 所以等 progressLoaded 后再渲染具体 reader。
   */
  const [progressLoaded, setProgressLoaded] = useState(false);

  /*
   * initialAnchor 是后端返回的初始精确位置。
   * 它通常只被 reader 消费一次，用于首次定位到上次读到的段落。
   */
  const [initialAnchor, setInitialAnchor] = useState<ProgressAnchor | null>(null);

  /*
   * progressAnchor 是 reader 实时上报的最新精确位置。
   * ReaderPage 会把它防抖保存到后端。
   */
  const [progressAnchor, setProgressAnchor] = useState<ProgressAnchor | null>(null);

  /*
   * activeChapterId 是 reader 认为当前正在阅读的章节 ID。
   * 它是目录高亮的主要依据，比 chapterOrd 更可靠。
   */
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null);

  /*
   * 面板与抽屉状态：
   * - settingsOpen：阅读设置抽屉是否打开；
   * - aiOpen：AI 阅读助手是否打开；
   * - tocLocateTick：用于通知 TocDrawer “请滚动定位到当前章节”。
   *
   * tocLocateTick 为什么用数字而不是 boolean？
   * - 每点一次按钮就 +1；
   * - 子组件监听变化即可执行一次定位；
   * - 如果用 boolean，连续点击同一个 true 不一定触发变化。
   */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [tocLocateTick, setTocLocateTick] = useState(0);

  /*
   * progressPct 是 0 到 1 之间的阅读进度估算值。
   * 它驱动顶部细进度条的宽度。
   */
  const [progressPct, setProgressPct] = useState(0);

  /*
   * activeHeadingPath 表示 reader 在当前屏幕附近识别到的标题路径。
   *
   * 例如：
   * ["第一章 基础", "1.2 一致性", "1.2.1 一致性模型"]
   *
   * 最深标题放在数组最后。
   * ReaderPage 会用它匹配 TOC，决定顶部显示哪个章节标题以及目录高亮哪一项。
   */
  const [activeHeadingPath, setActiveHeadingPath] = useState<string[]>([]);

  /*
   * bookReady：具体 reader 是否已经准备好。
   * readerBusy：具体 reader 是否正在忙，例如重新排版。
   * prefsChangeBusyUntil：修改阅读偏好后短暂展示“正在重新渲染”遮罩。
   * forceRender：某些偏好变更后强制触发一次重新渲染。
   * selectedText：用户当前选中的文本，传给 AIChatPanel 使用。
   */
  const [bookReady, setBookReady] = useState(false);
  const [readerBusy, setReaderBusy] = useState(false);
  const [prefsChangeBusyUntil, setPrefsChangeBusyUntil] = useState(0);
  const [, forceRender] = useState(0);
  const [selectedText, setSelectedText] = useState<string | null>(null);

  /*
   * searchJump 从 URL 参数中提取搜索跳转信息。
   *
   * useMemo 的作用：
   * - 只有 searchParams 变化时才重新计算；
   * - 返回 null 表示当前不是搜索跳转。
   */
  const searchJump = useMemo(() => {
    const q = searchParams.get('q')?.trim();
    const chapterId = searchParams.get('chapter')?.trim();
    if (!q || !chapterId) return null;
    return { keyword: q, chapterId };
  }, [searchParams]);

  /*
   * 保存阅读偏好。
   *
   * 每当 prefs 变化，就写入本地存储。
   * 这类偏好放在前端本地即可，不需要每次都请求后端。
   */
  useEffect(() => {
    savePrefs(prefs);
  }, [prefs]);

  /*
   * 把阅读主题绑定到 document.documentElement，也就是 <html> 标签。
   *
   * CSS 可以通过 [data-reader-theme="dark"] 等选择器切换变量。
   * cleanup 函数会在组件卸载或主题变化前移除旧属性。
   */
  useEffect(() => {
    document.documentElement.setAttribute('data-reader-theme', prefs.theme);
    return () => document.documentElement.removeAttribute('data-reader-theme');
  }, [prefs.theme]);

  /*
   * 加载书籍元数据。
   *
   * 当路由 id 变化时，需要清空旧书状态，再请求新书。
   * cancelled 用于避免异步请求返回时组件已经卸载或 id 已经切换。
   */
  useEffect(() => {
    let cancelled = false;

    /*
     * 先重置旧书状态，避免用户从 A 书切到 B 书时短暂看到 A 书的章节/进度。
     */
    setBook(null);
    setBookReady(false);
    setProgressLoaded(false);
    setInitialAnchor(null);
    setProgressAnchor(null);
    setActiveChapterId(null);
    setChapters([]);
    setTocItems([]);
    setChapterOrd(0);
    setPdfPage(1);

    api.get<{ book: BookDTO }>(`/api/books/${id}`)
      .then(d => {
        if (!cancelled) setBook(d.book);
      })
      .catch(e => {
        if (!cancelled) {
          /*
           * 404 表示这本书不存在或不属于当前用户。
           * 这种情况下回到书架，比停留在错误阅读页更自然。
           */
          if (e instanceof ApiException && e.status === 404) {
            navigate('/library', { replace: true });
            return;
          }
          setError(e.message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [id, navigate]);

  /*
   * 加载保存过的阅读进度。
   *
   * 后端可能返回：
   * - chapterOrder：旧版章节序号；
   * - pageNo：PDF 页码；
   * - locator + chapterId：新版精确定位。
   *
   * finally 中无论成功失败都设置 progressLoaded=true：
   * - 即使读取进度失败，也允许用户从默认位置开始阅读；
   * - 阅读进度不是打开书籍的硬性依赖。
   */
  useEffect(() => {
    if (!book) return;

    let cancelled = false;

    api.get<{
      progress: {
        chapterOrder?: number;
        pageNo?: number;
        locator?: string | null;
        chapterId?: string | null;
      };
    }>(`/api/books/${book.id}/progress`)
      .then(d => {
        if (cancelled) return;
        if (typeof d.progress.chapterOrder === 'number') setChapterOrd(d.progress.chapterOrder);
        if (typeof d.progress.pageNo === 'number') setPdfPage(d.progress.pageNo);
        if (d.progress.locator && d.progress.chapterId) {
          setInitialAnchor({
            locator: d.progress.locator,
            chapterId: d.progress.chapterId,
          });
        }
      })
      .catch(() => {
        /*
         * 阅读进度读取失败不是致命错误。
         * 用户仍然可以从开头开始阅读，所以这里不弹错误。
         */
      })
      .finally(() => {
        if (!cancelled) setProgressLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [book]);

  /*
   * 加载章节列表。
   *
   * PDF 不需要普通章节列表，所以直接跳过。
   * 如果失败，目录区域可以显示为空，不影响 PDF 或原始文件下载。
   */
  useEffect(() => {
    if (!book || book.format === 'pdf') return;

    let cancelled = false;

    api.get<{ chapters: Chapter[] }>(`/api/books/${book.id}/chapters/list`)
      .then(d => {
        if (!cancelled) setChapters(d.chapters);
      })
      .catch(() => {
        /*
         * 章节列表失败时不打断阅读页。
         * 具体 reader 可能仍能通过其他方式显示内容，目录也可以为空。
         */
      });

    return () => {
      cancelled = true;
    };
  }, [book]);

  /*
   * 加载层级目录 TOC。
   *
   * fetchToc 封装了 /api/books/{id}/toc 请求。
   * 如果后端没有存储真实 TOC，后端会尝试用章节列表合成一个扁平目录。
   */
  useEffect(() => {
    if (!book || book.format === 'pdf') return;

    let cancelled = false;

    fetchToc(book.id).then(items => {
      if (!cancelled) setTocItems(items);
    });

    return () => {
      cancelled = true;
    };
  }, [book]);

  /*
   * 防抖保存阅读进度。
   *
   * 为什么要防抖？
   * - 阅读器可能在滚动、翻页、重排时频繁上报进度；
   * - 每次都请求后端会增加数据库写入压力；
   * - 600ms 防抖可以把连续变化合并成一次保存。
   *
   * lastSavedSig 用于避免重复保存完全一样的 body。
   */
  const lastSavedSig = useRef('');
  useEffect(() => {
    if (!book || !progressLoaded) return;

    const handle = setTimeout(() => {
      const body: Record<string, unknown> = { percent: 0 };

      if (book.format === 'pdf') {
        body.pageNo = pdfPage;
      } else {
        body.chapterOrder = chapterOrd;

        /*
         * 新版精确进度。
         * 同时保存 chapterOrder 是为了兼容旧逻辑。
         */
        if (progressAnchor) {
          body.locator = progressAnchor.locator;
          body.chapterId = progressAnchor.chapterId;
        }
      }

      const sig = JSON.stringify(body);
      if (sig === lastSavedSig.current) return;
      lastSavedSig.current = sig;

      /*
       * 保存进度失败不提示用户：
       * - 阅读本身不应被打断；
       * - 下一次上报进度还会继续尝试保存。
       */
      api.put(`/api/books/${book.id}/progress`, body).catch(() => {
        /* ignore */
      });
    }, 600);

    return () => clearTimeout(handle);
  }, [book, chapterOrd, pdfPage, progressLoaded, progressAnchor]);

  /*
   * 应用搜索跳转。
   *
   * 当从搜索页进入阅读页时：
   * - searchJump.chapterId 指定目标章节；
   * - 这里把 chapterOrd 切到目标章节；
   * - 关键词高亮交给 TxtReader 处理。
   */
  useEffect(() => {
    if (!book || !progressLoaded || !searchJump) return;
    if (chapters.length === 0) return;

    const target = chapters.find(c => c.id === searchJump.chapterId);
    if (target && target.ord !== chapterOrd) {
      setChapterOrd(target.ord);
    }
    /*
     * 这里关闭 exhaustive-deps 是有意的：
     * 如果把 chapterOrd 放进依赖，setChapterOrd 后 effect 可能重复运行；
     * 这个 effect 的目标只是“消费 URL 中的搜索跳转请求”。
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, progressLoaded, chapters, searchJump]);

  /*
   * 当 TxtReader 已经处理完搜索高亮后，删除 URL 参数。
   *
   * replace: true 表示替换当前历史记录，而不是新增一条历史记录。
   * 用户按浏览器后退时不会回到带 q/chapter 的临时 URL。
   */
  const handleSearchHandled = useCallback(() => {
    if (!searchJump) return;
    const next = new URLSearchParams(searchParams);
    next.delete('q');
    next.delete('chapter');
    setSearchParams(next, { replace: true });
  }, [searchJump, searchParams, setSearchParams]);

  /*
   * 根据书籍格式决定渲染哪个 reader。
   *
   * isTxtBacked：
   * - 表示这些格式已经被前端解析成章节；
   * - 虽然原始格式可能是 epub/fb2/mobi，但最终可用 TxtReader 渲染章节 HTML/text。
   *
   * isEPUBLegacy：
   * - 兼容旧 EPUB 路径；
   * - 如果 EPUB 没有章节入库，就走 EpubReader 的 iframe/foliate 路径。
   *
   * cantParse：
   * - 后端保存了原始文件；
   * - 但当前前端没有对应阅读器；
   * - 页面会提示“不支持阅读”并提供原始文件下载。
   */
  const isPDF = book?.format === 'pdf';
  const isEPUB = book?.format === 'epub';
  const isCBZ = book?.format === 'cbz';
  const TXT_BACKED_FORMATS = ['txt', 'fb2', 'fbz', 'mobi', 'azw', 'azw3', 'epub'];
  const isTxtBacked = !!book && TXT_BACKED_FORMATS.includes(book.format) && chapters.length > 0;
  const isEPUBLegacy = !!isEPUB && chapters.length === 0;
  const cantParse = !!book && !isPDF && !isEPUB && !isCBZ && !TXT_BACKED_FORMATS.includes(book.format);

  /*
   * effectiveMode 是最终生效的翻页模式。
   *
   * 有些格式可能不支持用户选择的 pageMode，
   * resolvePageMode 会根据格式做兼容修正。
   */
  const effectiveMode = useMemo(
    () => (book ? resolvePageMode(book.format, prefs.pageMode) : prefs.pageMode),
    [book, prefs.pageMode],
  );

  /*
   * 计算顶部章节标题、目录高亮标签和目录展开路径。
   *
   * 匹配优先级：
   * 1. 优先用 activeHeadingPath 从最深标题往上匹配 TOC；
   * 2. 如果 TOC 匹配不到，就显示最深标题文本；
   * 3. 如果没有标题路径，就回退到章节列表中的 title；
   * 4. 如果章节标题看起来是解析器生成的“第 N 章”占位符，就不显示；
   * 5. 最后返回空字符串，宁可不显示，也不显示误导用户的假标题。
   */
  const { chapterTitle, activeTocLabel, activeTocPath } = useMemo(() => {
    type R = {
      chapterTitle: string;
      activeTocLabel: string | null;
      activeTocPath: string[];
    };

    if (!book || isPDF) {
      return { chapterTitle: '', activeTocLabel: null, activeTocPath: [] } as R;
    }

    if (activeHeadingPath.length > 0) {
      const hit = findTocByHeadingPath(tocItems, activeHeadingPath);
      if (hit) {
        return {
          chapterTitle: hit.match.label,
          activeTocLabel: hit.match.label,
          activeTocPath: hit.ancestorLabels,
        } as R;
      }

      /*
       * 如果 TOC 没有匹配项，仍然显示 reader 识别到的最深标题。
       * 这样比顶部完全空白更有帮助。
       */
      const deepest = activeHeadingPath[activeHeadingPath.length - 1];
      return {
        chapterTitle: deepest,
        activeTocLabel: null,
        activeTocPath: [],
      } as R;
    }

    /*
     * 没有标题路径时，退回到章节列表。
     */
    const active = activeChapterId
      ? chapters.find(c => c.id === activeChapterId)
      : chapters[chapterOrd];

    const raw = active?.title?.trim() ?? '';
    if (raw && !isAutoChapterTitle(raw, active?.ord ?? -1)) {
      return { chapterTitle: raw, activeTocLabel: null, activeTocPath: [] } as R;
    }

    return { chapterTitle: '', activeTocLabel: null, activeTocPath: [] } as R;
  }, [book, chapters, chapterOrd, activeChapterId, activeHeadingPath, tocItems, isPDF]);

  /*
   * 传给具体 reader 的回调。
   *
   * useCallback 可以让函数引用在依赖不变时保持稳定，
   * 减少子组件不必要的重新渲染。
   */
  const handleReaderReady = useCallback(() => setBookReady(true), []);
  const handleReaderBusy = useCallback((b: boolean) => setReaderBusy(b), []);
  const handleSelection = useCallback((text: string | null) => setSelectedText(text), []);
  const handleProgressAnchor = useCallback((a: ProgressAnchor | null) => {
    setProgressAnchor(a);
  }, []);
  const handleActiveChapterChange = useCallback((cid: string) => {
    setActiveChapterId(cid);
  }, []);

  /*
   * reader 会频繁上报标题路径。
   * 这里先比较新旧数组内容，只有真正变化时才 setState。
   * 这样可以避免下游 useMemo 和 TocDrawer 频繁重算。
   */
  const handleActiveHeadingPath = useCallback((path: string[]) => {
    setActiveHeadingPath(prev => {
      if (prev.length !== path.length) return path;
      for (let i = 0; i < prev.length; i++) {
        if (prev[i] !== path[i]) return path;
      }
      return prev;
    });
  }, []);

  const handleProgressPercent = useCallback((p: number) => setProgressPct(p), []);

  /*
   * 用户点击目录项时，TocDrawer 传回 chapterId。
   * ReaderPage 需要把 chapterId 转成 chapterOrd，因为 reader 当前使用 ord 定位章节。
   */
  const handleTocPick = useCallback((chapterId: string) => {
    const ch = chapters.find(c => c.id === chapterId);
    if (ch) setChapterOrd(ch.ord);
  }, [chapters]);

  /*
   * 修改阅读偏好。
   *
   * 除了 setPrefs，还人为制造一个短暂 busy 窗口，
   * 让用户知道页面正在按新字号/主题/列宽重新排版。
   */
  const handlePrefsChange = useCallback((next: ReaderPrefs) => {
    setPrefs(next);
    setPrefsChangeBusyUntil(performance.now() + 600);
    setTimeout(() => forceRender(t => t + 1), 620);
  }, []);

  /*
   * 顶部批注样式颜色变更。
   *
   * styleColors 的结构类似：
   * {
   *   highlight: 'yellow',
   *   underline: 'blue',
   *   note: 'purple'
   * }
   */
  const handleStyleColorChange = useCallback((style: HighlightStyle | 'note', color: HighlightColor) => {
    setPrefs(p => ({
      ...p,
      styleColors: { ...p.styleColors, [style]: color },
    }));
  }, []);

  /*
   * readerBusy 当前只是为了接收子组件 busy 状态。
   * 这里 void readerBusy 用来告诉 TypeScript/ESLint：
   * “这个变量目前确实没有直接使用，但保留它是有意的。”
   */
  void readerBusy;

  /*
   * modalOpen 控制阻塞式加载遮罩：
   * - 书籍存在、格式可读，但 reader 还没 ready；
   * - 或者刚修改阅读偏好，正在重新渲染。
   */
  const modalOpen =
    (!!book && !cantParse && !bookReady) ||
    performance.now() < prefsChangeBusyUntil;
  const modalLabel = !bookReady ? '正在打开书籍引擎…' : '正在重新渲染…';

  /*
   * 错误状态：例如后端返回非 404 错误、网络失败等。
   */
  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-paper-50">
        <div className="text-center">
          <h2 className="text-xl font-serif text-ink-700 mb-2">无法打开本书</h2>
          <p className="text-sm text-ink-500">{error}</p>
          <Link to="/library" className="inline-block mt-4 text-accent-dark hover:underline text-sm">
            返回书架
          </Link>
        </div>
      </div>
    );
  }

  /*
   * book 还没加载回来时，先显示空背景和加载遮罩。
   */
  if (!book) {
    return (
      <>
        <BlockingModal open label="正在打开书籍引擎…" />
        <div className="min-h-screen bg-paper-50" />
      </>
    );
  }

  return (
    <div
      className="h-screen flex flex-col"
      data-reader-theme={prefs.theme}
      style={{ background: 'var(--reader-bg)' }}
    >
      {/*
       * 顶部工具栏：
       * - 返回书架；
       * - 显示书名和当前章节；
       * - 设置批注颜色；
       * - 打开 AI 助手；
       * - 打开阅读设置。
       */}
      <ReaderHeader
        bookTitle={book.title}
        chapterTitle={chapterTitle}
        onSettings={() => setSettingsOpen(true)}
        onAI={() => setAiOpen(true)}
        onBack={() => navigate('/library')}
        styleColors={prefs.styleColors}
        onStyleColorChange={handleStyleColorChange}
      />

      {/*
       * 顶部细进度条。
       * progressPct 被限制在 0..1，再乘以 100 转成百分比宽度。
       */}
      <div className="reader-progress" aria-hidden="true">
        <div
          className="reader-progress-fill"
          style={{ width: `${(Math.max(0, Math.min(1, progressPct)) * 100).toFixed(2)}%` }}
        />
      </div>

      <div className="flex-1 min-h-0 flex">
        {/*
         * 非 PDF 书籍显示目录栏。
         * 如果 tocItems 为空，就把 chapters 转成扁平目录兜底。
         */}
        {!isPDF && (
          <TocDrawer
            items={tocItems.length > 0 ? tocItems : chaptersToTocFallback(chapters)}
            activeChapterId={activeChapterId ?? chapters[chapterOrd]?.id ?? null}
            activeLabel={activeTocLabel}
            activePath={activeTocPath}
            onPick={handleTocPick}
            locateTick={tocLocateTick}
            onLocateRequest={() => setTocLocateTick(t => t + 1)}
          />
        )}

        <div className="flex-1 min-w-0 relative">
          {/*
           * 不支持阅读的格式：
           * - 原始文件仍在书架中；
           * - 用户可以下载；
           * - 后续实现 parser/reader 后再支持在线阅读。
           */}
          {cantParse && (
            <div className="h-full flex items-center justify-center px-6 text-center">
              <div className="max-w-md">
                <h2 className="font-serif text-xl mb-2" style={{ color: 'var(--reader-fg)' }}>
                  这种格式暂不支持阅读
                </h2>
                <p className="text-sm" style={{ color: 'var(--reader-muted)' }}>
                  {book.format.toUpperCase()} 文件已存储在你的书架。文档解析尚未实现，但你随时可以下载原始文件。
                </p>
                <a
                  href={`/api/books/${book.id}/file`}
                  className="inline-block mt-4 px-4 py-2 rounded-lg bg-accent text-white"
                >
                  下载原始文件
                </a>
              </div>
            </div>
          )}

          {/*
           * PDF 阅读器：
           * - 使用 page/pdfPage 保存页码；
           * - 通过 /api/books/{id}/file 支持 Range 请求；
           * - 不依赖章节列表。
           */}
          {!cantParse && progressLoaded && isPDF && (
            <PdfReader
              bookId={book.id}
              prefs={prefs}
              page={pdfPage}
              pageMode={effectiveMode}
              onPageChange={p => setPdfPage(Math.max(1, p))}
              onReady={handleReaderReady}
              onBusy={handleReaderBusy}
            />
          )}

          {/*
           * EPUB 旧路径：
           * 当 EPUB 没有入库章节时，使用 EpubReader 直接读取原始 EPUB。
           */}
          {!cantParse && progressLoaded && isEPUBLegacy && (
            <EpubReader
              bookId={book.id}
              prefs={prefs}
              chapterOrd={chapterOrd}
              pageMode={effectiveMode}
              onLocationChange={setChapterOrd}
              onReady={handleReaderReady}
              onBusy={handleReaderBusy}
              onSelection={handleSelection}
            />
          )}

          {/*
           * CBZ 漫画阅读器。
           * CBZ 通常是图片压缩包，按图片/章节顺序阅读。
           */}
          {!cantParse && progressLoaded && isCBZ && (
            <CbzReader
              bookId={book.id}
              chapterOrd={chapterOrd}
              onChapterChange={n => setChapterOrd(Math.max(0, n))}
              onReady={handleReaderReady}
              onBusy={handleReaderBusy}
            />
          )}

          {/*
           * 文本/章节型阅读器。
           *
           * 这里覆盖 TXT、FB2、MOBI、AZW、以及已经被解析入库的 EPUB。
           * TxtReader 会负责：
           * - 请求章节正文；
           * - 渲染文本/HTML；
           * - 处理选择文本；
           * - 上报阅读定位；
           * - 上报标题路径；
           * - 处理搜索关键词高亮。
           */}
          {!cantParse && progressLoaded && isTxtBacked && (
            <TxtReader
              bookId={book.id}
              prefs={prefs}
              chapterOrd={chapterOrd}
              pageMode={effectiveMode}
              onChapterChange={n => setChapterOrd(Math.max(0, n))}
              onReady={handleReaderReady}
              onBusy={handleReaderBusy}
              onSelection={handleSelection}
              styleColors={prefs.styleColors}
              onProgressAnchor={handleProgressAnchor}
              onActiveChapterChange={handleActiveChapterChange}
              onActiveHeadingPath={handleActiveHeadingPath}
              onProgressPercent={handleProgressPercent}
              initialAnchor={initialAnchor}
              searchKeyword={searchJump?.keyword ?? null}
              searchTargetChapterId={searchJump?.chapterId ?? null}
              onSearchHandled={handleSearchHandled}
            />
          )}
        </div>
      </div>

      {/*
       * 阅读设置抽屉。
       * onChange 会更新 prefs，并触发短暂“正在重新渲染”提示。
       */}
      <SettingsDrawer
        open={settingsOpen}
        prefs={prefs}
        format={book.format}
        onChange={handlePrefsChange}
        onClose={() => setSettingsOpen(false)}
      />

      {/*
       * AI 阅读助手面板。
       *
       * selectedText 会把用户选中的文本传给 AI 面板，
       * 这样可以针对选中文字解释、总结或提问。
       *
       * prefs.aiPinned 表示 AI 面板是否固定显示。
       */
      }
      <AIChatPanel
        open={aiOpen || !!prefs.aiPinned}
        onClose={() => {
          setAiOpen(false);
          if (prefs.aiPinned) handlePrefsChange({ ...prefs, aiPinned: false });
        }}
        bookId={book.id}
        bookTitle={book.title}
        chapterTitle={chapters.find(c => c.id === activeChapterId)?.title ?? undefined}
        selectedText={selectedText}
        pinned={!!prefs.aiPinned}
        onTogglePin={() => {
          const next = !prefs.aiPinned;
          handlePrefsChange({ ...prefs, aiPinned: next });
          if (next) setAiOpen(true);
        }}
      />

      <BlockingModal open={modalOpen} label={modalLabel} />
    </div>
  );
}

/*
 * 当后端没有真实层级 TOC 时，用章节列表合成一个扁平目录。
 *
 * 这样 TocDrawer 至少能显示：
 * - 第 1 章；
 * - 第 2 章；
 * - ...
 *
 * 而不是完全空白。
 */
function chaptersToTocFallback(chapters: Chapter[]): TocItem[] {
  return chapters.map(c => ({
    label: c.title?.trim() || `第 ${c.ord + 1} 章`,
    chapterId: c.id,
    depth: 0,
  }));
}

/*
 * 判断章节标题是否像“自动生成的占位标题”。
 *
 * 为什么需要这个函数？
 * - 有些解析器在没有真实章节标题时，会生成“第 1 章”“Chapter 2”；
 * - 这些标题不一定是作者原文；
 * - 如果顶部一直显示这种假标题，用户会觉得不准确；
 * - 所以这里识别并隐藏明显的占位标题。
 */
function isAutoChapterTitle(title: string, ord: number): boolean {
  const t = title.replace(/\s+/g, '').trim();
  if (!t) return true;

  /*
   * 中文常见占位格式：
   * 第1章 / 第一章 / 第十回 / 第3节 等。
   */
  if (/^第[0-9零一二三四五六七八九十百千]+(章|节|節|篇|回|卷)$/.test(t)) return true;

  /*
   * 标题正好等于章节序号，也认为是占位符。
   */
  if (ord >= 0 && t === String(ord + 1)) return true;

  /*
   * 英文常见占位格式：
   * Chapter 12 / Section 3 / Part 2。
   */
  if (/^(chapter|section|part)\s*\d+$/i.test(title.trim())) return true;

  return false;
}

/*
 * ReaderHeader 是阅读页顶部工具栏。
 *
 * 布局大致是：
 *
 *   [返回 + 书名]       [当前章节标题]       [批注颜色组] [AI] [设置]
 *
 * 这个组件只负责展示和按钮回调，不自己请求后端。
 * 这样它保持为“展示组件”，业务逻辑留在 ReaderPage。
 */
function ReaderHeader({
  bookTitle, chapterTitle, onSettings, onAI, onBack,
  styleColors, onStyleColorChange,
}: {
  bookTitle: string;
  chapterTitle: string;
  onSettings: () => void;
  onAI: () => void;
  onBack: () => void;
  styleColors: ReaderPrefs['styleColors'];
  onStyleColorChange: (s: HighlightStyle | 'note', c: HighlightColor) => void;
}) {
  /*
   * 顶部使用三段式布局：
   * - 左侧：返回按钮和书名，书名过长时截断；
   * - 中间：章节标题，尽量保持在视口中央；
   * - 右侧：批注颜色、AI、设置按钮。
   */
  return (
    <header className="reader-header">
      <div className="reader-header-left">
        <button
          onClick={onBack}
          className="reader-header-icon-btn"
          title="返回书架"
          aria-label="返回书架"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="reader-header-book" title={bookTitle}>
          {bookTitle}
        </div>
      </div>

      {/*
       * aria-live="polite" 表示章节标题变化时，辅助技术可以温和地提示用户。
       */}
      <div className="reader-header-center" aria-live="polite">
        {chapterTitle && (
          <div className="reader-header-chapter" title={chapterTitle}>
            {chapterTitle}
          </div>
        )}
      </div>

      <div className="reader-header-right">
        {/*
         * 批注样式颜色组。
         * 每个 StyleColorChip 代表一种批注样式的默认颜色。
         */}
        <div className="reader-style-cluster" aria-label="批注样式与颜色">
          <StyleColorChip styleKey="highlight" label="高亮" current={styleColors.highlight} onPick={onStyleColorChange} />
          <StyleColorChip styleKey="underline" label="下划" current={styleColors.underline} onPick={onStyleColorChange} />
          <StyleColorChip styleKey="wavy" label="波浪" current={styleColors.wavy} onPick={onStyleColorChange} />
          <StyleColorChip styleKey="strike" label="删除" current={styleColors.strike} onPick={onStyleColorChange} />
          <StyleColorChip styleKey="note" label="笔记" current={styleColors.note} onPick={onStyleColorChange} />
        </div>

        <button
          onClick={onAI}
          className="reader-header-icon-btn"
          title="AI 阅读助手"
          aria-label="AI 阅读助手"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
        </button>
        <button
          onClick={onSettings}
          className="reader-header-icon-btn"
          title="阅读设置"
          aria-label="阅读设置"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
        </button>
      </div>
    </header>
  );
}

/*
 * 可选批注颜色列表。
 *
 * HighlightColor 是联合类型，所以这里的每个字符串都必须是合法颜色。
 */
const COLOR_CYCLE: HighlightColor[] = ['yellow', 'red', 'green', 'blue', 'purple', 'orange'];

/*
 * StyleColorChip 是顶部的“批注样式颜色选择器”。
 *
 * 例如：
 * - 高亮：黄色；
 * - 下划：蓝色；
 * - 波浪：绿色。
 *
 * 点击 chip 会打开颜色弹层；
 * 点击某个色块后调用 onPick(style, color)，再关闭弹层。
 */
function StyleColorChip({
  styleKey, label, current, onPick,
}: {
  styleKey: HighlightStyle | 'note';
  label: string;
  current: HighlightColor;
  onPick: (s: HighlightStyle | 'note', c: HighlightColor) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  /*
   * 弹层打开时，监听：
   * - 鼠标点击页面其他地方：关闭弹层；
   * - Esc 键：关闭弹层。
   *
   * cleanup 中移除事件监听，避免组件卸载后仍保留全局监听器。
   */
  useEffect(() => {
    if (!open) return;

    const onDocClick = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="reader-style-chip"
        aria-haspopup="true"
        aria-expanded={open}
        title={`${label}：当前 ${colorZh(current)}色（点击选择）`}
      >
        <span
          className="reader-style-chip-dot"
          style={{ background: swatchHex(current) }}
        />
        <span className="reader-style-chip-label">{label}</span>
      </button>

      {open && (
        <div
          className="color-popover"
          style={{ top: '100%', right: 0, marginTop: 6 }}
          role="listbox"
          onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
        >
          {COLOR_CYCLE.map(c => (
            <button
              key={c}
              type="button"
              role="option"
              aria-selected={c === current}
              data-active={c === current ? '1' : undefined}
              className="color-popover-swatch"
              style={{ background: swatchHex(c) }}
              onClick={() => {
                onPick(styleKey, c);
                setOpen(false);
              }}
              title={colorZh(c)}
              aria-label={colorZh(c)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/*
 * 把内部颜色枚举转换成实际 CSS 颜色值。
 */
function swatchHex(c: HighlightColor): string {
  switch (c) {
    case 'yellow': return '#FFD900';
    case 'red': return '#FF6363';
    case 'green': return '#5FC86E';
    case 'blue': return '#63A5FF';
    case 'purple': return '#BA82EB';
    case 'orange': return '#FF9F50';
  }
}

/*
 * 把内部颜色枚举转换成中文短标签。
 */
function colorZh(c: HighlightColor): string {
  switch (c) {
    case 'yellow': return '黄';
    case 'red': return '红';
    case 'green': return '绿';
    case 'blue': return '蓝';
    case 'purple': return '紫';
    case 'orange': return '橙';
  }
}
