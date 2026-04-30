// “标注与笔记”页面：展示当前用户在所有书籍里创建过的标注、高亮、下划线、
// 波浪线、删除线和纯文本笔记。
//
// 对初学者来说，可以把这个页面理解为一个“跨书籍的阅读痕迹时间线”：
//   1. 从后端 `/api/notes` 拉取所有笔记；
//   2. 从后端 `/api/highlights` 拉取所有标注；
//   3. 在前端合并成统一的 Card 数组；
//   4. 按更新时间倒序展示；
//   5. 允许按“类型”和“书籍”筛选。
//
// 与阅读器的关系：
//   用户在 TxtReader 中选中文本后，SelectionToolbar 可以创建：
//   - highlight：普通高亮；
//   - underline：下划线；
//   - wavy：波浪线；
//   - strike：删除线；
//   - note：笔记。
//   这些数据最终由 `server/internal/notes/handlers.go` 写入 SQLite。
//   本页只是把这些已经保存的阅读痕迹集中展示出来。
//
// 为什么 notes 和 highlights 要分开请求：
//   后端表结构把“视觉标注”和“文字笔记正文”拆成两类数据：
//   - highlights 表保存被选中的文本、颜色、样式、定位 locator；
//   - notes 表保存用户写下的笔记正文。
//   拆开后，纯高亮不必创建空笔记，纯笔记也能独立存在。
//   前端页面再把两类数据合并成统一卡片，方便用户浏览。
//
// 书籍筛选为什么不单独调用 `/api/books`：
//   本页只需要“有标注/笔记的书”。如果直接列出所有书，用户会看到大量无关选项。
//   因此书籍筛选项直接从 cards 中提取，既减少一次 API 请求，也让筛选更聚焦。
//
// 与低内存约束的关系：
//   本页不在前端或后端维护常驻索引，只按需读取 SQLite 中当前用户的标注/笔记小行数据。
//   标注通常是小文本，内存压力远小于整本书正文或全文索引。

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import DashboardChrome from '../components/DashboardChrome';
import { formatRelative } from '../lib/format';
import type { HighlightColor, HighlightStyle } from '../lib/highlights';

/**
 * 后端 `/api/notes` 返回的一条笔记。
 *
 * selectedText 是用户创建笔记时选中的原文片段；
 * body 是用户自己写下的笔记正文。
 */
interface NoteRow {
  id: string;
  bookId: string;
  bookTitle: string;
  body: string;
  selectedText?: string;
  locator?: string;
  updatedAt: number;
}

/**
 * 后端 `/api/highlights` 返回的一条视觉标注。
 *
 * locator 是关键字段：它不是页面坐标，而是一种稳定文本定位字符串，
 * 用来在重新打开章节时把标注重新放回原文位置。
 */
interface HighlightRow {
  id: string;
  bookId: string;
  bookTitle: string;
  selectedText: string;
  color: HighlightColor;
  style: HighlightStyle;
  locator: string;
  updatedAt: number;
}

/**
 * 页面内部统一使用的卡片结构。
 *
 * 为什么需要 Card：
 *   notes 和 highlights 来自两个接口、字段也不完全相同。
 *   如果 JSX 里直接分别处理两种结构，页面会有大量重复逻辑。
 *   先合并成 Card，再统一渲染，代码更容易读，也方便后续加筛选/排序。
 */
interface Card {
  key: string;
  bookId: string;
  bookTitle: string;
  kind: 'note' | HighlightStyle;
  color?: HighlightColor;
  selectedText?: string;
  body?: string;
  updatedAt: number;
}

/** 筛选类型：all 表示不过滤，其他值表示只看某一种标注/笔记。 */
type KindFilter = 'all' | 'note' | HighlightStyle;

/** 类型到中文标签的映射，集中放在这里，避免 JSX 中到处写硬编码中文。 */
const KIND_LABELS: Record<KindFilter, string> = {
  all: '全部',
  note: '笔记',
  highlight: '高亮',
  underline: '下划线',
  wavy: '波浪线',
  strike: '删除线',
};

/** 筛选按钮的展示顺序。 */
const KIND_ORDER: KindFilter[] = ['all', 'note', 'highlight', 'underline', 'wavy', 'strike'];

export default function NotesPage() {
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [highlights, setHighlights] = useState<HighlightRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<KindFilter>('all');
  const [bookFilter, setBookFilter] = useState<string>('all');

  // 首次进入页面时并行加载 notes 和 highlights。
  //
  // Promise.all 的含义：
  //   两个请求同时发出，等它们都完成后再进入 then。
  //   这样比先请求 notes、再请求 highlights 更快。
  //
  // cancelled 标记用于避免“组件已经卸载，但异步请求回来后仍然 setState”的问题。
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.get<{ notes: NoteRow[] }>('/api/notes'),
      // /api/highlights 是后续新增的接口。
      // 如果用户运行的是旧服务端，可能返回 404；这里吞掉错误并用空数组兜底，
      // 这样至少笔记列表还能显示，不会因为一个兼容性问题导致整个页面不可用。
      api.get<{ highlights: HighlightRow[] }>('/api/highlights')
        .catch(() => ({ highlights: [] as HighlightRow[] })),
    ])
      .then(([n, h]) => {
        if (cancelled) return;
        setNotes(n.notes);
        setHighlights(h.highlights);
      })
      .catch(e => !cancelled && setError((e as Error).message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  // 把 notes 和 highlights 合并成统一卡片列表，并按更新时间倒序排列。
  //
  // 当前没有按 locator 去重：
  //   如果一段文本既有高亮又有关联笔记，这里会显示为两条记录。
  //   这与当前阅读器的保存方式一致，也能让用户分别看到“标注动作”和“笔记内容”。
  //   未来如果希望合并成一张卡，可以在这里按 bookId + locator 做聚合。
  const cards: Card[] = useMemo(() => {
    const out: Card[] = [];
    for (const n of notes) {
      out.push({
        key: 'n:' + n.id,
        bookId: n.bookId,
        bookTitle: n.bookTitle,
        kind: 'note',
        body: n.body,
        selectedText: n.selectedText,
        updatedAt: n.updatedAt,
      });
    }
    for (const hl of highlights) {
      out.push({
        key: 'h:' + hl.id,
        bookId: hl.bookId,
        bookTitle: hl.bookTitle,
        kind: hl.style,
        color: hl.color,
        selectedText: hl.selectedText,
        updatedAt: hl.updatedAt,
      });
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }, [notes, highlights]);

  // 从合并后的 cards 中提取出现过的书籍，作为“书籍筛选”下拉框选项。
  //
  // Map 的作用：
  //   以 bookId 为 key，可以自然去重；同一本书出现多条笔记/标注，也只显示一次。
  // localeCompare(..., 'zh-Hans-CN') 让中文标题排序更符合中文环境。
  const books = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of cards) seen.set(c.bookId, c.bookTitle);
    return Array.from(seen, ([id, title]) => ({ id, title }))
      .sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
  }, [cards]);

  // 根据当前筛选条件得到真正展示的列表。
  // 注意这是纯前端筛选：数据量通常很小，不需要每次筛选都重新请求后端。
  const filtered = cards.filter(c => {
    if (kind !== 'all' && c.kind !== kind) return false;
    if (bookFilter !== 'all' && c.bookId !== bookFilter) return false;
    return true;
  });

  // 统计每种类型的数量，用于筛选按钮上的数字。
  // 这些数字来自已经加载到页面的 cards，不会额外访问后端。
  const counts: Record<KindFilter, number> = {
    all: cards.length,
    note: 0, highlight: 0, underline: 0, wavy: 0, strike: 0,
  };
  for (const c of cards) {
    counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  }

  return (
    <DashboardChrome title="标注与笔记">
      <div className="mb-5 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {KIND_ORDER.map(k => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={
                'px-3 py-1.5 rounded-full text-sm border ' +
                (kind === k
                  ? 'border-accent text-accent-dark bg-accent/10 font-medium'
                  : 'border-paper-300 text-ink-600 hover:bg-paper-100')
              }
            >
              {KIND_LABELS[k]} <span className="opacity-60">({counts[k]})</span>
            </button>
          ))}
        </div>
        {books.length > 0 && (
          <div className="flex items-center gap-2 text-sm">
            <label className="text-ink-500">书籍：</label>
            <select
              value={bookFilter}
              onChange={e => setBookFilter(e.target.value)}
              className="rounded-lg border border-paper-300 px-3 py-1.5 bg-white"
            >
              <option value="all">全部书籍</option>
              {books.map(b => (
                <option key={b.id} value={b.id}>《{b.title}》</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {loading && <div className="text-ink-500">加载中…</div>}
      {error && <div className="text-rose-600">{error}</div>}
      {!loading && filtered.length === 0 && (
        <div className="text-center py-16 text-ink-500">
          {cards.length === 0
            ? '还没有任何标注或笔记。打开任意书籍并选中文本即可创建。'
            : '当前筛选下没有匹配项。'}
        </div>
      )}

      {filtered.length > 0 && (
        <ul className="space-y-3">
          {filtered.map(c => (
            <li key={c.key}>
              <CardView card={c} />
            </li>
          ))}
        </ul>
      )}
    </DashboardChrome>
  );
}

/**
 * 单张标注/笔记卡片。
 *
 * 点击卡片会进入对应书籍的阅读页。当前只跳到书籍级别 `/book/:id`；
 * 如果未来要精确跳到标注位置，可以把 card 中补充 chapterId / locator，
 * 然后在链接里带上查询参数，让 ReaderPage 调用 locator 定位。
 */
function CardView({ card }: { card: Card }) {
  const tagLabel = KIND_LABELS[card.kind];
  return (
    <Link
      to={`/book/${card.bookId}`}
      className="block rounded-lg border border-paper-300/70 bg-paper-50 hover:border-accent/40 px-4 py-3"
    >
      <div className="flex items-center justify-between text-xs text-ink-500 mb-2">
        <span className="flex items-center gap-2">
          <KindBadge kind={card.kind} color={card.color} />
          <span>{tagLabel}</span>
          <span>·</span>
          <span>《{card.bookTitle}》</span>
        </span>
        <span>{formatRelative(card.updatedAt)}</span>
      </div>
      {card.selectedText && (
        <div
          className={
            'text-sm border-l-2 pl-3 mb-1 ' +
            (card.kind === 'note' ? 'italic text-ink-700 border-accent/40' : 'text-ink-800 border-ink-400/30')
          }
          style={
            card.kind === 'highlight' && card.color
              ? { background: highlightSwatchColor(card.color), borderColor: 'transparent' }
              : undefined
          }
        >
          <span className={highlightInlineClass(card.kind, card.color)}>
            {truncateText(card.selectedText, 240)}
          </span>
        </div>
      )}
      {card.body && (
        <div className="text-sm text-ink-800 whitespace-pre-wrap mt-1">
          {card.body}
        </div>
      )}
    </Link>
  );
}

/**
 * 左上角的小图标，用于快速区分笔记、高亮、下划线、波浪线、删除线。
 *
 * 这里不使用图片资源，而是用 CSS / SVG 画出来：
 * - 依赖少；
 * - 加载快；
 * - 颜色可直接跟随标注颜色变化。
 */
function KindBadge({ kind, color }: { kind: Card['kind']; color?: HighlightColor }) {
  if (kind === 'note') {
    return <span className="inline-block w-2 h-2 rounded-full bg-accent" aria-hidden />;
  }
  // 高亮显示色块；下划线/波浪线/删除线显示线条预览。
  const dot = color ? highlightSwatchColor(color) : '#d1c8b8';
  if (kind === 'highlight') {
    return <span className="inline-block w-3 h-3 rounded-sm" style={{ background: dot }} aria-hidden />;
  }
  if (kind === 'underline') {
    return <span className="inline-block w-3 h-3 border-b-2 border-current" style={{ color: dot }} aria-hidden />;
  }
  if (kind === 'wavy') {
    return (
      <span className="inline-block w-3 h-3 leading-none" style={{ color: dot }} aria-hidden>
        <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M1 9 q1.5 -2 3 0 t3 0 t3 0" />
        </svg>
      </span>
    );
  }
  // strike
  return <span className="inline-block w-3 h-px" style={{ background: dot, marginTop: 6 }} aria-hidden />;
}

/**
 * 把逻辑颜色名转换成实际 CSS 颜色。
 *
 * 后端只存储 'yellow' / 'red' 这样的稳定枚举值；
 * 前端可以随时调整具体 rgba 视觉效果，而不需要迁移数据库。
 */
function highlightSwatchColor(c: HighlightColor): string {
  switch (c) {
    case 'yellow': return 'rgba(247, 215, 92, 0.45)';
    case 'red':    return 'rgba(232, 119, 119, 0.40)';
    case 'green':  return 'rgba(132, 196, 132, 0.40)';
    case 'blue':   return 'rgba(120, 168, 224, 0.40)';
    case 'purple': return 'rgba(186, 142, 224, 0.40)';
    case 'orange': return 'rgba(245, 168, 96, 0.40)';
    default:       return 'rgba(247, 215, 92, 0.45)';
  }
}

/**
 * 给选中文本预览添加对应的行内样式。
 *
 * 普通 highlight 的背景色在 CardView 的 style 中处理；
 * underline / wavy / strike 更适合用 className 表达。
 */
function highlightInlineClass(kind: Card['kind'], color?: HighlightColor): string {
  if (kind === 'underline') return 'underline decoration-2 underline-offset-2';
  if (kind === 'wavy') return 'underline decoration-wavy underline-offset-2';
  if (kind === 'strike') return 'line-through';
  void color;
  return '';
}

/** 简单截断长文本，避免一条很长的摘录把整个列表撑得过高。 */
function truncateText(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}
