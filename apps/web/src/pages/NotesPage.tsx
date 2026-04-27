// Notes page. Pulls /api/notes (cross-library) and groups by book.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import DashboardChrome from '../components/DashboardChrome';
import { formatRelative } from '../lib/format';

interface Note {
  id: string;
  bookId: string;
  bookTitle: string;
  body: string;
  selectedText?: string;
  updatedAt: number;
}

export default function NotesPage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get<{ notes: Note[] }>('/api/notes')
      .then(d => !cancelled && setNotes(d.notes))
      .catch(e => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  return (
    <DashboardChrome title="笔记">
      {loading && <div className="text-ink-500">加载中…</div>}
      {error && <div className="text-rose-600">{error}</div>}
      {!loading && notes.length === 0 && (
        <div className="text-center py-16 text-ink-500">
          还没有笔记。打开任意书籍并选中文本来创建第一条。
        </div>
      )}
      {notes.length > 0 && (
        <ul className="space-y-3">
          {notes.map(n => (
            <li key={n.id}>
              <Link
                to={`/book/${n.bookId}`}
                className="block rounded-lg border border-paper-300/70 bg-paper-50 hover:border-accent/40 px-4 py-3"
              >
                <div className="flex items-center justify-between text-xs text-ink-500 mb-2">
                  <span>《{n.bookTitle}》</span>
                  <span>{formatRelative(n.updatedAt)}</span>
                </div>
                {n.selectedText && (
                  <div className="text-xs text-ink-600 italic mb-2 border-l-2 border-accent/40 pl-3">
                    {n.selectedText}
                  </div>
                )}
                <div className="text-sm text-ink-800 whitespace-pre-wrap">{n.body}</div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </DashboardChrome>
  );
}
