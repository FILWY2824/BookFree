// Reader page. Owns the chrome (header bar, drawers) and dispatches
// to the format-specific reader component for content rendering.
//
// State responsibility split:
//   ReaderPage  → which book, which chapter/page, prefs, drawers open,
//                 progress sync.
//   *Reader     → fetch + render content for the current chapter/page.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { api, ApiException } from '../lib/api';
import { loadPrefs, savePrefs, type ReaderPrefs } from '../lib/prefs';
import SettingsDrawer from '../components/SettingsDrawer';
import TocDrawer from '../components/TocDrawer';
import TxtReader from '../reader/TxtReader';
import EpubReader from '../reader/EpubReader';
import PdfReader from '../reader/PdfReader';
import CbzReader from '../reader/CbzReader';

interface BookDTO {
  id: string;
  title: string;
  authors?: string[];
  format: string;
  status: string;
}

interface Chapter {
  id: string;
  ord: number;
  title?: string | null;
}

export default function ReaderPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [book, setBook] = useState<BookDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<ReaderPrefs>(() => loadPrefs());

  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [chapterOrd, setChapterOrd] = useState(0);
  const [pdfPage, setPdfPage] = useState(1);

  const [tocOpen, setTocOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Persist prefs to localStorage on every change.
  useEffect(() => { savePrefs(prefs); }, [prefs]);

  // Bind theme to the document root so the reader background flows
  // edge-to-edge. We swap it back when leaving.
  useEffect(() => {
    document.documentElement.setAttribute('data-reader-theme', prefs.theme);
    return () => document.documentElement.removeAttribute('data-reader-theme');
  }, [prefs.theme]);

  // Load book metadata once.
  useEffect(() => {
    let cancelled = false;
    api.get<{ book: BookDTO }>(`/api/books/${id}`)
      .then(d => { if (!cancelled) setBook(d.book); })
      .catch(e => {
        if (!cancelled) {
          if (e instanceof ApiException && e.status === 404) {
            navigate('/library', { replace: true });
            return;
          }
          setError(e.message);
        }
      });
    return () => { cancelled = true; };
  }, [id, navigate]);

  // Load saved progress on first mount of a known book.
  useEffect(() => {
    if (!book) return;
    let cancelled = false;
    api.get<{ progress: { chapterOrder?: number; pageNo?: number } }>(`/api/books/${book.id}/progress`)
      .then(d => {
        if (cancelled) return;
        if (typeof d.progress.chapterOrder === 'number') setChapterOrd(d.progress.chapterOrder);
        if (typeof d.progress.pageNo === 'number') setPdfPage(d.progress.pageNo);
      })
      .catch(() => { /* not critical */ });
    return () => { cancelled = true; };
  }, [book]);

  // Load the chapter list once we know the book — needed by the TOC
  // drawer for EPUB and any chapter-text-backed format (TXT/MOBI/FB2/...).
  // PDF skips this; its "TOC" is page numbers handled inside PdfReader.
  // CBZ skips this too — CbzReader fetches the page list itself so it
  // can keep the list scoped to the page-flip widget.
  useEffect(() => {
    if (!book || book.format === 'pdf' || book.format === 'cbz') return;
    let cancelled = false;
    api.get<{ chapters: Chapter[] }>(`/api/books/${book.id}/chapters/list`)
      .then(d => { if (!cancelled) setChapters(d.chapters); })
      .catch(() => { /* drawer just shows empty */ });
    return () => { cancelled = true; };
  }, [book]);

  // Save progress (debounced) on chapter/page change.
  useEffect(() => {
    if (!book) return;
    const handle = setTimeout(() => {
      const body: Record<string, unknown> = { percent: 0 };
      if (book.format === 'pdf') body.pageNo = pdfPage;
      else body.chapterOrder = chapterOrd;
      api.put(`/api/books/${book.id}/progress`, body).catch(() => { /* ignore */ });
    }, 600);
    return () => clearTimeout(handle);
  }, [book, chapterOrd, pdfPage]);

  const isPDF = book?.format === 'pdf';
  const isEPUB = book?.format === 'epub';
  const isCBZ = book?.format === 'cbz';
  // Formats served by the chapter/chunk-based TxtReader. It consumes
  // book_chapters rows regardless of source format, so MOBI/AZW/AZW3/
  // FB2/FBZ all flow through here once foliate-js has populated the
  // chapters table during ingest.
  const TXT_BACKED_FORMATS = ['txt', 'fb2', 'fbz', 'mobi', 'azw', 'azw3'];
  const isTxtBacked = !!book && TXT_BACKED_FORMATS.includes(book.format);
  // cantParse is reserved for formats we accept on upload but can't
  // render. Currently every supported format has a viewer — this is
  // a guard for future formats where ingest succeeds but we don't
  // ship a renderer yet.
  const cantParse = !!book && !isPDF && !isEPUB && !isCBZ && !isTxtBacked;

  const headerTitle = useMemo(() => {
    if (!book) return '';
    if (isPDF) return book.title;
    const ch = chapters[chapterOrd];
    return ch?.title || book.title;
  }, [book, chapters, chapterOrd, isPDF]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-paper-50">
        <div className="text-center">
          <h2 className="text-xl font-serif text-ink-700 mb-2">无法打开本书</h2>
          <p className="text-sm text-ink-500">{error}</p>
          <Link to="/library" className="inline-block mt-4 text-accent-dark hover:underline text-sm">
            返回书架
          </Link>
        </div>
      </div>
    );
  }
  if (!book) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-paper-50 text-ink-500">
        正在打开…
      </div>
    );
  }

  return (
    <div
      className="h-screen flex flex-col"
      data-reader-theme={prefs.theme}
      style={{ background: 'var(--reader-bg)' }}
    >
      <ReaderHeader
        title={headerTitle}
        bookTitle={book.title}
        onTOC={() => setTocOpen(true)}
        onSettings={() => setSettingsOpen(true)}
        onBack={() => navigate('/library')}
      />

      <div className="flex-1 min-h-0">
        {cantParse && (
          <div className="h-full flex items-center justify-center px-6 text-center">
            <div className="max-w-md">
              <h2 className="font-serif text-xl mb-2" style={{ color: 'var(--reader-fg)' }}>
                这种格式暂不支持阅读
              </h2>
              <p className="text-sm" style={{ color: 'var(--reader-muted)' }}>
                {book.format.toUpperCase()} 文件已存储在你的书架。文档解析尚未实现，但你随时可以下载原始文件。
              </p>
              <a
                href={`/api/books/${book.id}/file`}
                className="inline-block mt-4 px-4 py-2 rounded-lg bg-accent text-white"
              >
                下载原始文件
              </a>
            </div>
          </div>
        )}

        {!cantParse && isPDF && (
          <PdfReader
            bookId={book.id}
            prefs={prefs}
            page={pdfPage}
            onPageChange={p => setPdfPage(Math.max(1, p))}
          />
        )}

        {!cantParse && isEPUB && (
          <EpubReader
            bookId={book.id}
            prefs={prefs}
            chapterOrd={chapterOrd}
            onLocationChange={setChapterOrd}
          />
        )}

        {!cantParse && isCBZ && (
          <CbzReader
            bookId={book.id}
            chapterOrd={chapterOrd}
            onChapterChange={n => setChapterOrd(Math.max(0, n))}
          />
        )}

        {!cantParse && isTxtBacked && (
          <TxtReader
            bookId={book.id}
            prefs={prefs}
            chapterOrd={chapterOrd}
            onChapterChange={n => setChapterOrd(Math.max(0, n))}
          />
        )}
      </div>

      <SettingsDrawer
        open={settingsOpen}
        prefs={prefs}
        onChange={setPrefs}
        onClose={() => setSettingsOpen(false)}
      />
      <TocDrawer
        open={tocOpen}
        chapters={chapters}
        current={chapterOrd}
        onPick={setChapterOrd}
        onClose={() => setTocOpen(false)}
      />
    </div>
  );
}

function ReaderHeader({
  title, bookTitle, onTOC, onSettings, onBack,
}: {
  title: string; bookTitle: string; onTOC: () => void; onSettings: () => void; onBack: () => void;
}) {
  return (
    <header
      className="flex items-center gap-3 px-4 h-12 border-b shrink-0"
      style={{
        borderColor: 'var(--reader-border)',
        color: 'var(--reader-fg)',
        background: 'var(--reader-bg)',
      }}
    >
      <button
        onClick={onBack}
        className="opacity-70 hover:opacity-100 px-2 py-1 text-sm"
        title="返回书架"
        aria-label="返回书架"
      >
        ←
      </button>
      <button
        onClick={onTOC}
        className="opacity-70 hover:opacity-100 p-1.5"
        title="目录"
        aria-label="目录"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
          <line x1="3" y1="6" x2="3.01" y2="6" />
          <line x1="3" y1="12" x2="3.01" y2="12" />
          <line x1="3" y1="18" x2="3.01" y2="18" />
        </svg>
      </button>
      <div className="flex-1 min-w-0 text-center text-sm">
        <div className="truncate font-medium">{title}</div>
        {title !== bookTitle && (
          <div className="text-xs opacity-60 truncate">{bookTitle}</div>
        )}
      </div>
      <button
        onClick={onSettings}
        className="opacity-70 hover:opacity-100 p-1.5"
        title="阅读设置"
        aria-label="阅读设置"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
        </svg>
      </button>
    </header>
  );
}
