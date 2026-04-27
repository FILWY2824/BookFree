// One portrait card per book. Cover-less books get a deterministic
// spine colour from the title hash so the library still feels visual.

import { Link } from 'react-router-dom';
import { formatBytes, stringHashColor, truncate } from '../lib/format';

export interface BookCardData {
  id: string;
  title: string;
  authors?: string[];
  format: string;
  sizeBytes: number;
  status: string;
  coverStorageKey?: string | null;
  error?: string | null;
}

interface Props {
  book: BookCardData;
  onDelete?: (id: string) => void;
}

const STATUS_COPY: Record<string, { label: string; tone: string }> = {
  uploaded: { label: '待解析', tone: 'bg-amber-100 text-amber-800' },
  parsing:  { label: '解析中', tone: 'bg-amber-100 text-amber-800' },
  chunking: { label: '处理中', tone: 'bg-amber-100 text-amber-800' },
  indexing: { label: '建立索引', tone: 'bg-amber-100 text-amber-800' },
  ready:    { label: '就绪', tone: 'bg-emerald-100 text-emerald-800' },
  failed:   { label: '失败', tone: 'bg-rose-100 text-rose-800' },
};

export default function BookCard({ book, onDelete }: Props) {
  const author = book.authors?.[0] ?? '未知作者';
  const colors = stringHashColor(book.title);
  const status = STATUS_COPY[book.status] ?? { label: book.status, tone: 'bg-paper-200 text-ink-600' };

  return (
    <div className="group relative">
      <Link
        to={`/book/${book.id}`}
        className="block rounded-xl bg-white border border-paper-300/70 shadow-card hover:shadow-elev transition-shadow"
      >
        <div
          className="relative aspect-[2/3] rounded-t-xl overflow-hidden book-card-spine flex items-end p-4"
          style={{
            // CSS variables consumed by .book-card-spine.
            ['--card-spine' as never]: colors.bg,
            ['--card-cover' as never]: colors.fg,
          }}
        >
          <div className="text-white/95 drop-shadow">
            <div className="font-serif text-base leading-tight">
              {truncate(book.title, 38)}
            </div>
            <div className="text-xs text-white/80 mt-1">{author}</div>
          </div>
        </div>
        <div className="px-3 py-2.5 text-xs text-ink-500 flex items-center justify-between">
          <span className="uppercase tracking-wide">{book.format}</span>
          <span>{formatBytes(book.sizeBytes)}</span>
        </div>
      </Link>
      <div className="absolute top-2 left-2 flex flex-col gap-1">
        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${status.tone}`}>
          {status.label}
        </span>
      </div>
      {onDelete && (
        <button
          aria-label="删除"
          title="删除"
          onClick={(e: React.MouseEvent) => { e.preventDefault(); onDelete(book.id); }}
          className="absolute top-2 right-2 hidden group-hover:flex h-7 w-7 items-center justify-center rounded-full bg-white/90 text-ink-600 hover:bg-white hover:text-rose-600 shadow-card"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
            <path d="M10 11v6M14 11v6" />
          </svg>
        </button>
      )}
    </div>
  );
}
