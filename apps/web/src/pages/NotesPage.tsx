// "标注与笔记" page. Cross-library feed of every annotation the user
// created while reading: text-only notes, plus four highlight styles
// (highlight / underline / wavy / strike-through). The reader's
// SelectionToolbar can produce any of these, and they all live as
// rows in highlights or notes — this page hydrates both endpoints and
// joins them by `locator` so a highlight that has an attached note
// shows up as a single card with both pieces.
//
// We also accept filters:
//   • all kinds vs one of {note, highlight, underline, wavy, strike}
//   • all books vs a single bookId
//
// The book filter pulls its options from the highlights+notes data
// itself rather than calling /api/books — only books with annotations
// are useful here.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import DashboardChrome from '../components/DashboardChrome';
import { formatRelative } from '../lib/format';
import type { HighlightColor, HighlightStyle } from '../lib/highlights';

interface NoteRow {
  id: string;
  bookId: string;
  bookTitle: string;
  body: string;
  selectedText?: string;
  locator?: string;
  updatedAt: number;
}

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

// Unified card shape after merging notes and highlights.
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

type KindFilter = 'all' | 'note' | HighlightStyle;

const KIND_LABELS: Record<KindFilter, string> = {
  all: '全部',
  note: '笔记',
  highlight: '高亮',
  underline: '下划线',
  wavy: '波浪线',
  strike: '删除线',
};

const KIND_ORDER: KindFilter[] = ['all', 'note', 'highlight', 'underline', 'wavy', 'strike'];

export default function NotesPage() {
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [highlights, setHighlights] = useState<HighlightRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<KindFilter>('all');
  const [bookFilter, setBookFilter] = useState<string>('all');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.get<{ notes: NoteRow[] }>('/api/notes'),
      // /api/highlights was added alongside this page; if a user is
      // running an older server build, swallow the 404 and continue
      // with notes only.
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

  // Merge notes and highlights into a single sorted list. We don't try
  // to dedupe by locator yet — a highlight + an attached note are two
  // rows here, which matches how the reader stored them.
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

  // Distinct books appearing in the merged feed, used to populate the
  // filter dropdown. Sorted alphabetically by title.
  const books = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of cards) seen.set(c.bookId, c.bookTitle);
    return Array.from(seen, ([id, title]) => ({ id, title }))
      .sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
  }, [cards]);

  const filtered = cards.filter(c => {
    if (kind !== 'all' && c.kind !== kind) return false;
    if (bookFilter !== 'all' && c.bookId !== bookFilter) return false;
    return true;
  });

  // Counts per kind for the filter chip — gives the user a glance at
  // how many of each they have without re-querying.
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

function KindBadge({ kind, color }: { kind: Card['kind']; color?: HighlightColor }) {
  if (kind === 'note') {
    return <span className="inline-block w-2 h-2 rounded-full bg-accent" aria-hidden />;
  }
  // For highlights, show a colored chip; for underline/wavy/strike, a
  // line preview.
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

function highlightInlineClass(kind: Card['kind'], color?: HighlightColor): string {
  if (kind === 'underline') return 'underline decoration-2 underline-offset-2';
  if (kind === 'wavy') return 'underline decoration-wavy underline-offset-2';
  if (kind === 'strike') return 'line-through';
  void color;
  return '';
}

function truncateText(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}
