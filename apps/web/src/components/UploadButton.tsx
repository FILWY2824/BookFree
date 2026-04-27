// UploadButton owns the full ingest pipeline:
//
//   1. Pick a file with <input type="file">.
//   2. Stream it to /api/books/upload (PUT). Server returns the new
//      books row id + format.
//   3. Hand the file over to the format-specific parser.
//   4. POST the parsed chapters/chunks to /api/books/{id}/ingest.
//   5. On parser error, POST /api/books/{id}/ingest/fail with a short
//      reason so the library can show the failed pill.
//
// We keep this as a self-contained component because every page that
// can accept a file (Library, drag-drop on Reader) gets to reuse it.

import { useRef, useState } from 'react';
import { api, ApiException } from '../lib/api';
import { parseFile } from '../parsers';
import { useToast } from './Toast';

interface Props {
  onUploaded?: () => void;
  variant?: 'primary' | 'secondary';
}

interface UploadResult {
  bookId: string;
  format: string;
  sizeBytes: number;
  status: string;
}

const ACCEPT = '.epub,.pdf,.txt,.fb2,.fbz,.cbz,.mobi,.azw,.azw3';

export default function UploadButton({ onUploaded, variant = 'primary' }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<{ name: string; phase: string } | null>(null);
  const { toast } = useToast();

  function open() {
    inputRef.current?.click();
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = ''; // reset so picking the same file twice still triggers
    if (!f) return;
    await upload(f);
  }

  async function upload(file: File) {
    setBusy({ name: file.name, phase: '上传中' });
    let bookId = '';
    let format = '';
    try {
      const r = await api.putRaw<UploadResult>('/api/books/upload', file, file.name);
      bookId = r.bookId;
      format = r.format;
    } catch (err) {
      const m = err instanceof ApiException ? err.message : (err as Error).message;
      toast.error('上传失败：' + m);
      setBusy(null);
      return;
    }

    // PDFs aren't ingested — pdf.js paginates them at read time so the
    // book is "ready enough" without chapters/chunks. We still call
    // /ingest with empty chapters so search has something attached.
    if (format === 'pdf') {
      try {
        await api.post(`/api/books/${bookId}/ingest`, {
          title: stripExt(file.name),
          chapters: [],
          chunks: [],
        });
      } catch {
        /* OK if it fails — the book stays uploaded and is still readable. */
      }
      toast.success(`已添加：${file.name}`);
      setBusy(null);
      onUploaded?.();
      return;
    }

    if (format !== 'epub' && format !== 'txt') {
      // Stored, but no parser path. Library will show as "uploaded".
      toast.info(`已上传 ${format.toUpperCase()}（暂不支持解析，文件已保存）`);
      setBusy(null);
      onUploaded?.();
      return;
    }

    setBusy({ name: file.name, phase: '解析中' });
    let parsed;
    try {
      parsed = await parseFile(file, format as 'epub' | 'txt');
    } catch (err) {
      const m = (err as Error).message ?? '未知错误';
      toast.error('解析失败：' + m);
      try { await api.post(`/api/books/${bookId}/ingest/fail`, { error: m }); } catch { /* ignore */ }
      setBusy(null);
      onUploaded?.();
      return;
    }

    setBusy({ name: file.name, phase: '建立索引' });
    try {
      await api.post(`/api/books/${bookId}/ingest`, parsed);
    } catch (err) {
      const m = err instanceof ApiException ? err.message : (err as Error).message;
      toast.error('索引失败：' + m);
      setBusy(null);
      onUploaded?.();
      return;
    }
    toast.success(`已添加：${parsed.title || file.name}`);
    setBusy(null);
    onUploaded?.();
  }

  const baseBtn =
    variant === 'primary'
      ? 'bg-accent hover:bg-accent-dark text-white'
      : 'bg-paper-100 hover:bg-paper-200 text-ink-700 border border-paper-300/70';

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        onChange={onPick}
        className="hidden"
      />
      <button
        onClick={open}
        disabled={busy !== null}
        className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium ${baseBtn} disabled:opacity-60`}
      >
        {busy ? (
          <>
            <Spinner />
            <span>{busy.phase}：{busy.name}</span>
          </>
        ) : (
          <>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span>上传书籍</span>
          </>
        )}
      </button>
    </>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function stripExt(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name;
  return name.slice(0, dot);
}
