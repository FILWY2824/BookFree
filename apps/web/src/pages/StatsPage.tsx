// 阅读统计 — overview page modelled on the ReadAny project's stats
// dashboard the user pointed us to. Layout: a row of headline cards
// (total books / total annotations / total reading time / current
// reading book), then a format breakdown, then a recent activity
// feed.
//
// Reading time is read from /api/stats/reading if the server has a
// reading_sessions table populated (migration 0010). When that
// endpoint isn't there or returns zero, we still render the numeric
// cards we CAN compute purely from /api/books + /api/notes +
// /api/highlights, so a freshly-installed instance shows something
// useful instead of a blank screen.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import DashboardChrome from '../components/DashboardChrome';

interface BookSummary {
  id: string;
  title: string;
  status: string;
  format: string;
  sizeBytes: number;
  updatedAt?: number;
}

interface NoteRow { id: string; bookId: string; updatedAt: number; }
interface HighlightRow { id: string; bookId: string; style: string; updatedAt: number; }

interface ReadingStats {
  totalSeconds?: number;
  todaySeconds?: number;
  streakDays?: number;
  currentBookId?: string | null;
  currentBookTitle?: string | null;
}

export default function StatsPage() {
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [highlights, setHighlights] = useState<HighlightRow[]>([]);
  const [reading, setReading] = useState<ReadingStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<{ books: BookSummary[] }>('/api/books'),
      api.get<{ notes: NoteRow[] }>('/api/notes')
        .catch(() => ({ notes: [] as NoteRow[] })),
      api.get<{ highlights: HighlightRow[] }>('/api/highlights')
        .catch(() => ({ highlights: [] as HighlightRow[] })),
      // Reading-time endpoint is optional — we treat 404 / 501 as "not
      // available yet" and fall back to compute what we can.
      api.get<{ stats: ReadingStats }>('/api/stats/reading')
        .catch(() => ({ stats: {} as ReadingStats })),
    ])
      .then(([b, n, h, s]) => {
        if (cancelled) return;
        setBooks(b.books);
        setNotes(n.notes);
        setHighlights(h.highlights);
        setReading(s.stats ?? {});
      })
      .catch(() => { /* network — leave empty */ })
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  const ready = useMemo(() => books.filter(b => b.status === 'ready').length, [books]);
  const totalBytes = useMemo(() => books.reduce((acc, b) => acc + (b.sizeBytes || 0), 0), [books]);
  const annotationCount = notes.length + highlights.length;
  const readingTime = reading?.totalSeconds ?? 0;
  const todayTime = reading?.todaySeconds ?? 0;
  const streak = reading?.streakDays ?? 0;

  const byFormat = useMemo(() => {
    return books.reduce<Record<string, number>>((acc, b) => {
      acc[b.format] = (acc[b.format] ?? 0) + 1;
      return acc;
    }, {});
  }, [books]);

  // "Recent activity" — last 8 annotations across the library, mixed.
  const recent = useMemo(() => {
    const merged: Array<{ id: string; bookId: string; kind: string; updatedAt: number }> = [];
    for (const n of notes) merged.push({ id: n.id, bookId: n.bookId, kind: '笔记', updatedAt: n.updatedAt });
    for (const hl of highlights) merged.push({ id: hl.id, bookId: hl.bookId, kind: kindLabel(hl.style), updatedAt: hl.updatedAt });
    merged.sort((a, b) => b.updatedAt - a.updatedAt);
    return merged.slice(0, 8);
  }, [notes, highlights]);

  return (
    <DashboardChrome title="阅读统计">
      {loading ? (
        <div className="text-ink-500">加载中…</div>
      ) : (
        <div className="space-y-6">
          {/* Headline cards row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <BigStat
              label="藏书"
              value={books.length.toString()}
              sub={`已就绪 ${ready}`}
              accent="#7C5A3A"
            />
            <BigStat
              label="总阅读时长"
              value={formatDuration(readingTime)}
              sub={todayTime > 0 ? `今日 ${formatDuration(todayTime)}` : undefined}
              accent="#3a6e7c"
            />
            <BigStat
              label="标注 / 笔记"
              value={annotationCount.toString()}
              sub={`高亮 ${highlights.length} · 笔记 ${notes.length}`}
              accent="#7c3a6a"
            />
            <BigStat
              label="连续阅读天数"
              value={streak > 0 ? `${streak} 天` : '—'}
              sub={streak > 0 ? '保持下去！' : '开始记录，就在今日'}
              accent="#3a7c4d"
            />
          </div>

          {/* Currently reading + storage row */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Card title="正在读">
              {reading?.currentBookId && reading?.currentBookTitle ? (
                <Link
                  to={`/book/${reading.currentBookId}`}
                  className="text-ink-800 hover:text-accent-dark text-base font-serif"
                >
                  《{reading.currentBookTitle}》→
                </Link>
              ) : (
                <div className="text-ink-500 text-sm">还未在任何书中留下进度</div>
              )}
            </Card>
            <Card title="占用空间">
              <div className="font-serif text-2xl text-ink-800">{formatBytes(totalBytes)}</div>
              <div className="text-xs text-ink-500 mt-1">
                平均 {books.length > 0 ? formatBytes(Math.round(totalBytes / books.length)) : '—'} / 本
              </div>
            </Card>
          </div>

          {/* Format breakdown */}
          {Object.keys(byFormat).length > 0 && (
            <Card title="按格式分布">
              <FormatBars byFormat={byFormat} total={books.length} />
            </Card>
          )}

          {/* Recent activity */}
          {recent.length > 0 && (
            <Card title="最近活动">
              <ul className="space-y-2">
                {recent.map(r => {
                  const book = books.find(b => b.id === r.bookId);
                  return (
                    <li key={r.id} className="flex items-center justify-between text-sm">
                      <div className="text-ink-700">
                        <span className="text-xs text-ink-500 mr-2">{r.kind}</span>
                        <Link to={`/book/${r.bookId}`} className="hover:text-accent-dark">
                          《{book?.title ?? '已删除的书'}》
                        </Link>
                      </div>
                      <div className="text-xs text-ink-500">{formatRelativeShort(r.updatedAt)}</div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          {/* Footnote when reading-time tracking unavailable */}
          {readingTime === 0 && streak === 0 && (
            <p className="text-xs text-ink-400">
              阅读时长与连续天数尚未启用。开通后将自动记录，无需额外操作。
            </p>
          )}
        </div>
      )}
    </DashboardChrome>
  );
}

function BigStat({
  label, value, sub, accent,
}: { label: string; value: string; sub?: string; accent: string }) {
  return (
    <div className="bg-paper-50 border border-paper-300/70 rounded-xl px-4 py-4 relative overflow-hidden">
      <div
        className="absolute left-0 top-0 bottom-0 w-1"
        style={{ background: accent }}
        aria-hidden="true"
      />
      <div className="text-xs uppercase tracking-wide text-ink-500">{label}</div>
      <div className="font-serif text-2xl text-ink-800 mt-1">{value}</div>
      {sub && <div className="text-xs text-ink-500 mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-paper-50 border border-paper-300/70 rounded-xl px-5 py-4">
      <div className="text-xs uppercase tracking-wide text-ink-500 mb-2">{title}</div>
      {children}
    </div>
  );
}

function FormatBars({ byFormat, total }: { byFormat: Record<string, number>; total: number }) {
  const entries = Object.entries(byFormat).sort((a, b) => b[1] - a[1]);
  return (
    <ul className="space-y-2">
      {entries.map(([fmt, count]) => {
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        return (
          <li key={fmt}>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="uppercase tracking-wide text-ink-700">{fmt}</span>
              <span className="text-ink-500">{count} 本 · {pct}%</span>
            </div>
            <div className="h-2 rounded-full bg-paper-200 overflow-hidden">
              <div
                className="h-full bg-accent"
                style={{ width: pct + '%' }}
                aria-hidden="true"
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function kindLabel(style: string): string {
  switch (style) {
    case 'highlight': return '高亮';
    case 'underline': return '下划线';
    case 'wavy':      return '波浪线';
    case 'strike':    return '删除线';
    default:          return '标注';
  }
}

function formatDuration(s: number): string {
  if (!s || s <= 0) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分`;
  return `${s} 秒`;
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatRelativeShort(ts: number): string {
  const ms = ts * 1000;
  const dt = Date.now() - ms;
  const m = Math.floor(dt / 60_000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} 个月前`;
  return `${Math.floor(mo / 12)} 年前`;
}
