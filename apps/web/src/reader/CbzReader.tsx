// CbzReader — comic-book viewer for .cbz files.
//
// Strategy: stream the original .cbz from /api/books/{id}/file once,
// open it with zip.js (random-access on the Blob), and render the
// page at chapterOrd as an <img> using a per-page blob URL. The
// chapter list — already populated by the cbz parser at ingest time —
// gives us the zip-entry filename for each page in chapter.href.
//
// CBZ only supports paginated mode — comics don't reflow and a strip
// of full-bleed images would defeat the format's whole point. The
// PageMode prop is accepted for prop-shape parity with other readers
// but we ignore it.
//
// Memory: one decoded page in flight as a blob URL, revoked on every
// page change. We rely on zip.js's lazy decoding so we never have
// the whole archive decompressed at once. On unmount we close the
// reader and revoke any outstanding URL.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  configure as zipConfigure,
  ZipReader,
  BlobReader,
  BlobWriter,
  type Entry,
} from '@zip.js/zip.js';
import { api } from '../lib/api';
import PageNav from '../components/PageNav';

interface Chapter {
  id: string;
  ord: number;
  title?: string | null;
  href?: string | null;
}

interface Props {
  bookId: string;
  /** Active page (zero-indexed, matches chapterOrd in the parent). */
  chapterOrd: number;
  onChapterChange: (ord: number) => void;
  onReady?: () => void;
  onBusy?: (busy: boolean) => void;
}

zipConfigure({ useWebWorkers: false });

export default function CbzReader({
  bookId, chapterOrd, onChapterChange, onReady, onBusy,
}: Props) {
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [entries, setEntries] = useState<Map<string, Entry> | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);
  const readerRef = useRef<ZipReader<Blob> | null>(null);
  // Captured at mount; used to fire onReady exactly once after the
  // first image actually paints.
  const readyFiredRef = useRef(false);

  // Step 1: load the chapter (page) list.
  useEffect(() => {
    let cancelled = false;
    api.get<{ chapters: Chapter[] }>(`/api/books/${bookId}/chapters/list`)
      .then(d => { if (!cancelled) setChapters(d.chapters); })
      .catch(e => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [bookId]);

  // Step 2: stream and open the .cbz once, keep the entries map.
  useEffect(() => {
    let cancelled = false;
    onBusy?.(true);
    (async () => {
      try {
        const res = await fetch(`/api/books/${bookId}/file`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        const reader = new ZipReader(new BlobReader(blob));
        readerRef.current = reader;
        const list = await reader.getEntries();
        if (cancelled) return;
        const map = new Map<string, Entry>();
        for (const e of list) map.set(e.filename, e);
        setEntries(map);
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? 'CBZ 加载失败');
      } finally {
        if (!cancelled) onBusy?.(false);
      }
    })();
    return () => {
      cancelled = true;
      readerRef.current?.close().catch(() => { /* ignore */ });
      readerRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // Step 3: whenever the active chapter or zip changes, swap the image.
  useEffect(() => {
    if (!entries || chapters.length === 0) return;
    const ch = chapters[Math.max(0, Math.min(chapters.length - 1, chapterOrd))];
    if (!ch?.href) {
      setError('该页缺少图片路径');
      return;
    }
    const entry = entries.get(ch.href);
    if (!entry || !('getData' in entry) || typeof entry.getData !== 'function') {
      setError('CBZ 内未找到该图片：' + ch.href);
      return;
    }
    let cancelled = false;
    onBusy?.(true);
    (async () => {
      try {
        const blob: Blob = await (entry.getData(new BlobWriter(guessImageMime(ch.href!))) as Promise<Blob>);
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = url;
        setImgUrl(url);
        setError(null);
        if (!readyFiredRef.current) {
          readyFiredRef.current = true;
          onReady?.();
        }
      } catch (e) {
        if (!cancelled) setError('页面解压失败：' + (e as Error).message);
      } finally {
        if (!cancelled) onBusy?.(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, chapters, chapterOrd]);

  useEffect(() => () => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  const canPrev = chapterOrd > 0;
  const canNext = chapterOrd < chapters.length - 1;

  const footerLabel = useMemo(() => {
    if (chapters.length === 0) return '';
    return `${chapterOrd + 1} / ${chapters.length}`;
  }, [chapterOrd, chapters.length]);

  return (
    <div
      className="h-full flex flex-col"
      style={{ background: 'var(--reader-bg)', color: 'var(--reader-fg)' }}
    >
      <PageNav
        onPrev={() => canPrev && onChapterChange(chapterOrd - 1)}
        onNext={() => canNext && onChapterChange(chapterOrd + 1)}
        canPrev={canPrev}
        canNext={canNext}
        enabled={!error}
        className="flex-1 min-h-0"
      >
        <div className="h-full w-full relative overflow-hidden">
          {error && (
            <div className="absolute inset-0 flex items-center justify-center text-rose-500 px-6 text-center">
              {error}
            </div>
          )}
          {!error && imgUrl && (
            <div className="h-full w-full flex items-start justify-center p-2">
              <img
                src={imgUrl}
                alt={`Page ${chapterOrd + 1}`}
                className="max-w-full h-auto select-none"
                draggable={false}
              />
            </div>
          )}
        </div>
      </PageNav>

      <div
        className="shrink-0 flex items-center justify-center px-4 h-10 border-t text-sm"
        style={{ borderColor: 'var(--reader-border)', color: 'var(--reader-muted)' }}
      >
        <span className="tabular-nums">{footerLabel}</span>
      </div>
    </div>
  );
}

function guessImageMime(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'png':  return 'image/png';
    case 'webp': return 'image/webp';
    case 'gif':  return 'image/gif';
    case 'bmp':  return 'image/bmp';
    case 'avif': return 'image/avif';
    default:     return 'application/octet-stream';
  }
}
