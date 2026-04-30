// 搜索页：负责把用户输入的关键词发送到后端 `/api/search`，并把返回结果分成
// “书籍片段”和“笔记”两栏展示。
//
// 对初学者来说，可以把这个文件理解为三个部分：
//   1. 页面状态：搜索框内容、当前搜索结果、分页页码、加载/错误状态；
//   2. 数据请求：调用 `api.get('/api/search?q=...')` 访问 Go 后端搜索接口；
//   3. 结果展示：把后端命中的书籍正文片段与笔记片段渲染成可点击的卡片。
//
// 前后端数据流：
//   用户输入关键词 → runSearch() → GET /api/search → Go 后端用 SQLite FTS5 搜索
//   book_chunks / notes → 返回 SearchResp → 前端渲染 Link，点击后进入 /book/:id。
//
// 为什么这里会用 `dangerouslySetInnerHTML`：
//   后端搜索接口会在命中的片段里插入 HTML 的 mark 标签，用于高亮关键词。
//   React 默认会把字符串当普通文本显示；如果要让 mark 标签真的变成高亮 HTML，
//   只能使用 `dangerouslySetInnerHTML`。这个名字听起来“危险”，所以项目约定：
//   只有后端已经清洗/生成过的 snippet 才这样渲染，不能直接渲染用户随便输入的 HTML。
//
// 搜索状态持久化：
//   用户明确希望“点进搜索结果阅读后，再返回搜索页时，搜索内容不要丢失”。
//   因此本页把关键词、结果、页码放进 sessionStorage。它只在当前浏览器标签页内有效：
//   - 路由跳转不会丢；
//   - 刷新通常也不会丢；
//   - 关闭标签页后会清空；
//   - 点击“清空”按钮会主动删除缓存。
//
// 分页策略：
//   书籍片段和笔记是两个独立信息流，因此分别分页，每页 PAGE_SIZE 条。
//   这样笔记很多时不会影响正文片段的页码，反之亦然。
//
// 与低内存约束的关系：
//   前端只保存当前搜索结果数组，不在浏览器里构建全文索引；全文索引由 SQLite FTS5 维护。
//   Go 服务端也不需要常驻大索引对象，有助于保持 BookFree 的小内存部署目标。

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import DashboardChrome from '../components/DashboardChrome';
import { truncate } from '../lib/format';

/**
 * 书籍正文命中结果。
 *
 * 后端搜索的是分块后的正文 chunks，而不是整本书一次性返回。
 * 这样可以减少网络传输量，也避免前端为了展示搜索结果而加载整本书正文。
 */
interface ChunkHit {
  id: string;
  bookId: string;
  bookTitle: string;
  chapterId?: string | null;
  chapterTitle?: string | null;
  pageNo?: number | null;
  snippet: string;
  plainSnippet: string;
  score: number;
}

/**
 * 笔记命中结果。
 *
 * 笔记搜索和正文搜索走同一个搜索页展示，但数据来源不同：
 * - 正文命中来自 book_chunks；
 * - 笔记命中来自 notes。
 */
interface NoteHit {
  id: string;
  bookId: string;
  bookTitle: string;
  chapterId?: string | null;
  body: string;
  snippet: string;
  selectedText?: string | null;
}

/** `/api/search` 的响应结构，必须与后端 search handler 返回的 JSON 字段对应。 */
interface SearchResp {
  q: string;
  chunks: ChunkHit[];
  notes: NoteHit[];
}

/**
 * 缓存在 sessionStorage 中的页面状态。
 *
 * 注意这里缓存的是“页面恢复体验”，不是长期业务数据：
 * 真正的书籍、笔记、搜索索引仍然在后端 SQLite 中。
 */
interface CachedState {
  q: string;
  results: SearchResp | null;
  chunkPage: number;
  notePage: number;
}

/** 每个搜索分区一页展示多少条。数值越大，一屏 DOM 节点越多；这里保持轻量。 */
const PAGE_SIZE = 5;

/** sessionStorage 的 key 加上项目名和版本号，避免和其他页面缓存冲突。 */
const CACHE_KEY = 'bookfree.search.state.v1';

/**
 * 从 sessionStorage 恢复搜索页状态。
 *
 * 这里用 try/catch 是因为：
 * - 浏览器隐私模式可能限制 storage；
 * - 用户或插件可能写入了非法 JSON；
 * - 旧版本缓存结构可能与当前代码不兼容。
 *
 * 任何异常都不应该导致页面崩溃，最多只是不能恢复上次搜索。
 */
function loadCache(): CachedState | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedState;
    if (typeof parsed.q !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 保存搜索状态；如果浏览器配额满了，静默失败即可，搜索功能本身仍然可用。 */
function saveCache(s: CachedState) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(s));
  } catch {
    /* quota exceeded — nothing we can do, the page still works */
  }
}

/** 用户点击“清空”时删除缓存。 */
function clearCache() {
  try { sessionStorage.removeItem(CACHE_KEY); } catch { /* noop */ }
}

export default function SearchPage() {
  // useMemo(..., []) 表示只在组件第一次挂载时读取缓存。
  // 如果每次渲染都读 sessionStorage，会造成不必要的同步 I/O。
  const initial = useMemo(() => loadCache(), []);
  const [q, setQ] = useState(initial?.q ?? '');
  // committed 表示“已经提交并产生当前 results 的关键词”。
  //
  // 为什么不直接用 q？
  //   q 是输入框正在编辑的内容，用户可能搜索“机器学习”后又把输入框改成“深度学习”，
  //   但还没点搜索。此时页面上的结果仍然属于“机器学习”，高亮也应该按旧关键词来。
  //   所以 q 负责输入框，committed 负责当前结果。
  const [committed, setCommitted] = useState(initial?.q ?? '');
  const [results, setResults] = useState<SearchResp | null>(initial?.results ?? null);
  const [chunkPage, setChunkPage] = useState(initial?.chunkPage ?? 0);
  const [notePage, setNotePage] = useState(initial?.notePage ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 每当搜索结果或页码变化时，把完整状态写入 sessionStorage。
  // 这样用户点击某条结果进入阅读页，再返回搜索页时，能回到同一页码和同一组结果。
  useEffect(() => {
    saveCache({ q: committed, results, chunkPage, notePage });
  }, [committed, results, chunkPage, notePage]);

  /**
   * 执行搜索。
   *
   * 这个函数只负责一次“提交搜索”动作：
   * - 校验关键词长度；
   * - 调用后端；
   * - 成功后更新 results / committed / page；
   * - 失败后把错误消息显示给用户。
   */
  const runSearch = async (query: string) => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setError('请输入至少 2 个字符再搜索');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const r = await api.get<SearchResp>('/api/search?q=' + encodeURIComponent(trimmed));
      setResults(r);
      setCommitted(trimmed);
      setChunkPage(0);
      setNotePage(0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** 表单提交事件：阻止浏览器默认刷新页面，改由 React 调用 runSearch。 */
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    runSearch(q);
  };

  /** 清空按钮：同时清页面状态和 sessionStorage 缓存。 */
  const onClear = () => {
    setQ('');
    setCommitted('');
    setResults(null);
    setChunkPage(0);
    setNotePage(0);
    setError(null);
    clearCache();
  };

  // 从 committed 拆出关键词数组，供前端高亮纯文本字段使用。
  // useMemo 避免每次渲染都重新 split。
  const keywords = useMemo(
    () => committed.trim().split(/\s+/).filter(s => s.length > 0),
    [committed],
  );

  return (
    <DashboardChrome title="全文搜索">
      <form onSubmit={onSubmit} className="mb-5 flex items-stretch gap-2">
        <input
          type="search"
          value={q}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQ(e.target.value)}
          autoFocus
          placeholder="在你所有书籍与笔记中搜索…"
          className="flex-1 rounded-lg border border-paper-300 px-4 py-2.5 outline-none focus:border-accent text-base"
        />
        <button
          type="submit"
          disabled={busy || q.trim().length < 2}
          className="px-5 py-2.5 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-dark disabled:opacity-40"
        >
          搜索
        </button>
        <button
          type="button"
          onClick={onClear}
          disabled={!q && !results}
          className="px-4 py-2.5 rounded-lg border border-paper-300 text-ink-700 text-sm hover:bg-paper-100 disabled:opacity-40"
          title="清空搜索结果"
        >
          清空
        </button>
      </form>

      {busy && <div className="text-ink-500 text-sm">搜索中…</div>}
      {error && <div className="text-rose-600 text-sm">{error}</div>}

      {results && (
        <div className="space-y-8">
          <PaginatedSection
            title={`书籍片段（${results.chunks.length}）`}
            empty="没有匹配的段落"
            items={results.chunks}
            page={chunkPage}
            onPage={setChunkPage}
            renderItem={h => (
              <Link
                to={buildBookLink(h.bookId, committed, h.chapterId)}
                className="block rounded-lg border border-paper-300/70 hover:border-accent/40 bg-paper-50 px-4 py-3"
              >
                <div className="text-xs text-ink-500 mb-1">
                  《{h.bookTitle}》
                  {h.chapterTitle && ' · ' + truncate(h.chapterTitle, 30)}
                  {h.pageNo != null && ` · 第 ${h.pageNo} 页`}
                </div>
                <div
                  className="text-sm text-ink-800 leading-relaxed snippet-3-lines"
                  // 后端返回的 snippet 已经包含用于高亮的 mark 标签，这里直接渲染。
                  dangerouslySetInnerHTML={{ __html: h.snippet }}
                />
              </Link>
            )}
            keyOf={h => h.id}
          />

          <PaginatedSection
            title={`笔记（${results.notes.length}）`}
            empty="没有匹配的笔记"
            items={results.notes}
            page={notePage}
            onPage={setNotePage}
            renderItem={n => (
              <Link
                to={buildBookLink(n.bookId, committed, n.chapterId ?? null)}
                className="block rounded-lg border border-paper-300/70 bg-paper-50 px-4 py-3"
              >
                <div className="text-xs text-ink-500 mb-1">《{n.bookTitle}》</div>
                {n.selectedText && (
                  <div
                    className="text-xs italic mb-1 text-ink-600 border-l-2 border-accent/40 pl-2 snippet-3-lines"
                    dangerouslySetInnerHTML={{ __html: highlightKeywords(n.selectedText, keywords) }}
                  />
                )}
                <div
                  className="text-sm text-ink-800 leading-relaxed snippet-3-lines"
                  // 笔记正文 snippet 同样由后端生成 mark 标签。
                  dangerouslySetInnerHTML={{ __html: n.snippet }}
                />
              </Link>
            )}
            keyOf={n => n.id}
          />
        </div>
      )}
    </DashboardChrome>
  );
}

// 构造跳转到阅读页的链接。
//
// 如果搜索结果带有 chapterId，就把 q 和 chapter 放进查询参数：
//   /book/<id>?q=<keyword>&chapter=<chapterId>
//
// ReaderPage/TxtReader 会读取这些参数，在目标章节里临时闪烁高亮关键词，
// 帮助用户快速定位命中的段落。
//
// 如果结果没有章节信息，例如某些 PDF 笔记只有页码或旧数据缺少 chapterId，
// 就退化为普通 /book/<id> 链接。
function buildBookLink(bookId: string, q: string, chapterId: string | null | undefined): string {
  const base = `/book/${bookId}`;
  const qt = q.trim();
  if (!qt || !chapterId) return base;
  const params = new URLSearchParams({ q: qt, chapter: chapterId });
  return `${base}?${params.toString()}`;
}

// 通用分页区块组件。
//
// TypeScript 泛型 T 的含义：
//   这个组件不关心 item 到底是 ChunkHit 还是 NoteHit，只要求调用者告诉它：
//   - items：要分页的数据数组；
//   - renderItem：如何把一条数据渲染成 React 节点；
//   - keyOf：如何取稳定 key。
//
// 这样“书籍片段”和“笔记”可以复用同一套分页逻辑，避免复制两份几乎相同的代码。
function PaginatedSection<T>({
  title, empty, items, page, onPage, renderItem, keyOf,
}: {
  title: string;
  empty: string;
  items: T[];
  page: number;
  onPage: (p: number) => void;
  renderItem: (item: T) => React.ReactNode;
  keyOf: (item: T) => string;
}) {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, pageCount - 1));
  const start = safePage * PAGE_SIZE;
  const slice = items.slice(start, start + PAGE_SIZE);

  return (
    <section>
      <h2 className="text-sm font-medium text-ink-700 uppercase tracking-wide mb-3">{title}</h2>
      {total === 0 ? (
        <div className="text-sm text-ink-500">{empty}</div>
      ) : (
        <>
          <ul className="space-y-3">
            {slice.map(item => (
              <li key={keyOf(item)}>{renderItem(item)}</li>
            ))}
          </ul>
          {pageCount > 1 && (
            <div className="mt-4 flex items-center justify-between text-sm">
              <button
                onClick={() => onPage(Math.max(0, safePage - 1))}
                disabled={safePage === 0}
                className="px-3 py-1 rounded border border-paper-300 disabled:opacity-30 hover:bg-paper-100"
              >
                上一页
              </button>
              <span className="text-ink-500">
                第 {safePage + 1} / {pageCount} 页 · 共 {total} 条
              </span>
              <button
                onClick={() => onPage(Math.min(pageCount - 1, safePage + 1))}
                disabled={safePage >= pageCount - 1}
                className="px-3 py-1 rounded border border-paper-300 disabled:opacity-30 hover:bg-paper-100"
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// 轻量的前端关键词高亮函数。
//
// 使用场景：
//   后端只会给部分字段生成 snippet，例如笔记正文；但 selectedText 这类纯文本字段
//   没有后端 mark 标签，所以前端自己做一次高亮。
//
// 安全步骤：
//   1. 先把原文做 HTML 转义，避免用户笔记里写的 HTML 被当成页面代码执行；
//   2. 再把关键词出现的位置包成 mark 标签；
//   3. 关键词数量通常很少，因此 O(文本长度 × 关键词数量) 的简单算法足够。
function highlightKeywords(text: string, keywords: string[]): string {
  let escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  for (const kw of keywords) {
    if (!kw) continue;
    const safe = kw
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // regex-escape
    if (!safe) continue;
    const re = new RegExp(safe, 'gi');
    escaped = escaped.replace(re, m => `<mark>${m}</mark>`);
  }
  return escaped;
}
