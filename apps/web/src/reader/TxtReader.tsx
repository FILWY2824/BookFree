// TxtReader renders chapters served from book_chapters. The same
// component handles EPUB content too — both formats land in the same
// table after ingest, and the visual treatment is identical.
//
// Pagination model: one chapter at a time. We don't paginate within a
// chapter; we let the browser scroll inside .reader-prose. This is the
// simplest model that still feels good on phones, and it sidesteps the
// reflow problems Foliate-style page-cutting tries to solve.

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { columnMaxWidth, type ReaderPrefs } from '../lib/prefs';

interface ChapterMeta {
  id: string;
  ord: number;
  title?: string | null;
  href?: string | null;
}

interface ChapterBody {
  id: string;
  html?: string | null;
  text?: string | null;
  title?: string | null;
  ord: number;
}

interface Props {
  bookId: string;
  prefs: ReaderPrefs;
  /** Currently-active chapter ord (what the reader is scrolled to). */
  chapterOrd: number;
  onChapterChange: (ord: number) => void;
}

export default function TxtReader({ bookId, prefs, chapterOrd, onChapterChange }: Props) {
  const [chapters, setChapters] = useState<ChapterMeta[]>([]);
  const [body, setBody] = useState<ChapterBody | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load chapter list once.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get<{ chapters: ChapterMeta[] }>(`/api/books/${bookId}/chapters/list`)
      .then(d => {
        if (cancelled) return;
        setChapters(d.chapters);
      })
      .catch(e => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [bookId]);

  // Load chapter body whenever ord changes.
  useEffect(() => {
    if (chapters.length === 0) return;
    const ch = chapters[Math.max(0, Math.min(chapters.length - 1, chapterOrd))];
    if (!ch) return;
    let cancelled = false;
    setLoading(true);
    api.get<{ chapter: ChapterBody }>(`/api/books/${bookId}/chapters/${ch.id}`)
      .then(d => {
        if (cancelled) return;
        setBody(d.chapter);
        scrollRef.current?.scrollTo({ top: 0 });
      })
      .catch(e => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [bookId, chapterOrd, chapters]);

  const html = useMemo(() => {
    if (!body) return '';
    if (body.html && body.html.trim()) return body.html;
    if (body.text) {
      const escaped = body.text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return escaped.split(/\n\s*\n+/).map(p => `<p>${p.replace(/\n/g, '<br/>')}</p>`).join('');
    }
    return '';
  }, [body]);

  const canPrev = chapterOrd > 0;
  const canNext = chapterOrd < chapters.length - 1;

  return (
    <div
      ref={scrollRef}
      className="h-full overflow-y-auto scrollbar-thin"
      style={{ background: 'var(--reader-bg)' }}
    >
      <div
        className="reader-prose mx-auto px-6 py-12"
        style={{
          maxWidth: columnMaxWidth(prefs),
          fontSize: prefs.fontSize + 'px',
          lineHeight: prefs.lineHeight,
          fontFamily: prefs.fontFamily === 'sans'
            ? 'ui-sans-serif, system-ui, -apple-system, sans-serif'
            : '"LXGW WenKai", ui-serif, Georgia, serif',
        }}
      >
        {loading && (
          <div className="text-center py-20" style={{ color: 'var(--reader-muted)' }}>
            正在加载…
          </div>
        )}
        {error && (
          <div className="text-center py-20 text-rose-500">{error}</div>
        )}
        {!loading && !error && body && (
          <>
            {body.title && (
              <h1 className="text-center" style={{ fontSize: '1.4em' }}>{body.title}</h1>
            )}
            <div dangerouslySetInnerHTML={{ __html: html }} />
            <ChapterFooter
              canPrev={canPrev}
              canNext={canNext}
              onPrev={() => onChapterChange(chapterOrd - 1)}
              onNext={() => onChapterChange(chapterOrd + 1)}
            />
          </>
        )}
      </div>
    </div>
  );
}

function ChapterFooter({
  canPrev, canNext, onPrev, onNext,
}: { canPrev: boolean; canNext: boolean; onPrev: () => void; onNext: () => void }) {
  return (
    <div
      className="mt-12 pt-6 flex items-center justify-between border-t"
      style={{ borderColor: 'var(--reader-border)' }}
    >
      <button
        disabled={!canPrev}
        onClick={onPrev}
        className="px-3 py-1.5 rounded text-sm disabled:opacity-30"
        style={{ color: 'var(--reader-fg)' }}
      >
        ← 上一章
      </button>
      <button
        disabled={!canNext}
        onClick={onNext}
        className="px-3 py-1.5 rounded text-sm disabled:opacity-30"
        style={{ color: 'var(--reader-fg)' }}
      >
        下一章 →
      </button>
    </div>
  );
}
