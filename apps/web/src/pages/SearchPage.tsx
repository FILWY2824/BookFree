// Search page. Hits /api/search and renders book + note hits side by
// side. Snippet HTML uses <mark> emitted by the FTS5 helper which we
// render via dangerouslySetInnerHTML — server-side it's been bigram-
// tokenized then sanitised, no third-party content survives.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import DashboardChrome from '../components/DashboardChrome';
import { truncate } from '../lib/format';

interface ChunkHit {
  id: string;
  bookId: string;
  bookTitle: string;
  chapterTitle?: string | null;
  pageNo?: number | null;
  snippet: string;
  plainSnippet: string;
  score: number;
}

interface NoteHit {
  id: string;
  bookId: string;
  bookTitle: string;
  body: string;
  snippet: string;
  selectedText?: string | null;
}

interface SearchResp {
  q: string;
  chunks: ChunkHit[];
  notes: NoteHit[];
}

export default function SearchPage() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounced query.
  useEffect(() => {
    if (q.trim().length < 2) {
      setResults(null);
      return;
    }
    const handle = setTimeout(async () => {
      setBusy(true);
      setError(null);
      try {
        const r = await api.get<SearchResp>('/api/search?q=' + encodeURIComponent(q.trim()));
        setResults(r);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [q]);

  return (
    <DashboardChrome title="全文搜索">
      <div className="mb-5">
        <input
          type="search"
          value={q}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQ(e.target.value)}
          autoFocus
          placeholder="在你所有书籍与笔记中搜索…"
          className="w-full rounded-lg border border-paper-300 px-4 py-2.5 outline-none focus:border-accent text-base"
        />
      </div>

      {busy && <div className="text-ink-500 text-sm">搜索中…</div>}
      {error && <div className="text-rose-600 text-sm">{error}</div>}

      {results && (
        <div className="space-y-8">
          <Section title={`书籍片段（${results.chunks.length}）`}>
            {results.chunks.length === 0 ? (
              <div className="text-sm text-ink-500">没有匹配的段落</div>
            ) : (
              <ul className="space-y-3">
                {results.chunks.map(h => (
                  <li key={h.id}>
                    <Link
                      to={`/book/${h.bookId}`}
                      className="block rounded-lg border border-paper-300/70 hover:border-accent/40 bg-paper-50 px-4 py-3"
                    >
                      <div className="text-xs text-ink-500 mb-1">
                        《{h.bookTitle}》
                        {h.chapterTitle && ' · ' + truncate(h.chapterTitle, 30)}
                        {h.pageNo != null && ` · 第 ${h.pageNo} 页`}
                      </div>
                      <div
                        className="text-sm text-ink-800 leading-relaxed"
                        dangerouslySetInnerHTML={{ __html: h.snippet }}
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={`笔记（${results.notes.length}）`}>
            {results.notes.length === 0 ? (
              <div className="text-sm text-ink-500">没有匹配的笔记</div>
            ) : (
              <ul className="space-y-3">
                {results.notes.map(n => (
                  <li key={n.id}>
                    <Link
                      to={`/book/${n.bookId}`}
                      className="block rounded-lg border border-paper-300/70 bg-paper-50 px-4 py-3"
                    >
                      <div className="text-xs text-ink-500 mb-1">《{n.bookTitle}》</div>
                      <div
                        className="text-sm text-ink-800 leading-relaxed"
                        dangerouslySetInnerHTML={{ __html: n.snippet }}
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}
    </DashboardChrome>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-sm font-medium text-ink-700 uppercase tracking-wide mb-3">{title}</h2>
      {children}
    </section>
  );
}
