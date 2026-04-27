// Library page — grid of book cards + upload + delete affordances.

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import DashboardChrome from '../components/DashboardChrome';
import BookCard, { type BookCardData } from '../components/BookCard';
import UploadButton from '../components/UploadButton';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';

export default function LibraryPage() {
  const [books, setBooks] = useState<BookCardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<BookCardData | null>(null);
  const { toast } = useToast();

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<{ books: BookCardData[] }>('/api/books');
      setBooks(r.books);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  async function confirmDelete() {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    try {
      await api.delete(`/api/books/${id}`);
      toast.success('已删除');
      setBooks(prev => prev.filter(b => b.id !== id));
    } catch (e) {
      toast.error('删除失败：' + (e as Error).message);
    }
  }

  return (
    <DashboardChrome
      title="书架"
      bare
      actions={<UploadButton onUploaded={reload} />}
    >
      {loading && books.length === 0 && (
        <div className="text-center py-20 text-ink-500">正在加载书架…</div>
      )}
      {error && (
        <div className="text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-4 py-3">
          {error}
        </div>
      )}
      {!loading && books.length === 0 && (
        <EmptyState />
      )}
      {books.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {books.map(b => (
            <BookCard
              key={b.id}
              book={b}
              onDelete={() => setPendingDelete(b)}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        title="删除这本书？"
        message={pendingDelete ? `「${pendingDelete.title}」将被永久删除，包含其笔记、高亮与阅读进度。此操作不可恢复。` : ''}
        confirmLabel="删除"
        destructive
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </DashboardChrome>
  );
}

function EmptyState() {
  return (
    <div className="text-center py-24">
      <div className="inline-block text-ink-400 mb-4">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
        </svg>
      </div>
      <h2 className="font-serif text-xl text-ink-700">书架还是空的</h2>
      <p className="text-sm text-ink-500 mt-2 mb-6">
        点击右上角「上传书籍」开始建立你的私有书房。<br />
        支持 EPUB、PDF、TXT；其它格式会被存储但暂不可阅读。
      </p>
    </div>
  );
}
