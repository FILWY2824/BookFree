// Stats page. The current build does not have a dedicated stats
// endpoint, so we synthesize a minimal view from /api/books and
// /api/notes. Real reading-time tracking would belong to a future
// "reading_sessions" table — flagged in the README's not-built list.

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import DashboardChrome from '../components/DashboardChrome';

interface BookSummary {
  id: string;
  status: string;
  format: string;
  sizeBytes: number;
}

interface Note { id: string; }

export default function StatsPage() {
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get<{ books: BookSummary[] }>('/api/books'),
      api.get<{ notes: Note[] }>('/api/notes'),
    ])
      .then(([b, n]) => { setBooks(b.books); setNotes(n.notes); })
      .catch(() => { /* noop */ })
      .finally(() => setLoading(false));
  }, []);

  const ready = books.filter(b => b.status === 'ready').length;
  const totalBytes = books.reduce((acc, b) => acc + b.sizeBytes, 0);
  const byFormat = books.reduce<Record<string, number>>((acc, b) => {
    acc[b.format] = (acc[b.format] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <DashboardChrome title="统计">
      {loading ? <div className="text-ink-500">加载中…</div> : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Stat label="藏书数量" value={books.length.toString()} sub={`已就绪 ${ready}`} />
          <Stat label="笔记数量" value={notes.length.toString()} />
          <Stat label="总占用空间" value={formatGB(totalBytes)} />
          <FormatBreakdown byFormat={byFormat} />
        </div>
      )}
      <p className="text-xs text-ink-400 mt-6">
        阅读时长统计尚未实现，将在后续版本中加入。
      </p>
    </DashboardChrome>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-paper-50 border border-paper-300/70 rounded-xl px-5 py-4">
      <div className="text-xs uppercase tracking-wide text-ink-500">{label}</div>
      <div className="font-serif text-2xl text-ink-800 mt-1">{value}</div>
      {sub && <div className="text-xs text-ink-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function FormatBreakdown({ byFormat }: { byFormat: Record<string, number> }) {
  const entries = Object.entries(byFormat).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  return (
    <div className="bg-paper-50 border border-paper-300/70 rounded-xl px-5 py-4 md:col-span-3">
      <div className="text-xs uppercase tracking-wide text-ink-500 mb-3">按格式分布</div>
      <ul className="space-y-1.5">
        {entries.map(([fmt, count]) => (
          <li key={fmt} className="flex items-center justify-between text-sm">
            <span className="uppercase tracking-wide text-ink-700">{fmt}</span>
            <span className="text-ink-500">{count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatGB(n: number): string {
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}
