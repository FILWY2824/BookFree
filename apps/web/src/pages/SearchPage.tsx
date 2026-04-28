// Search page. Hits /api/search and renders book + note hits side by
// side. Snippet HTML uses <mark> emitted by the FTS5 helper which we
// render via dangerouslySetInnerHTML — server-side it's been bigram-
// tokenized then sanitised, no third-party content survives.
//
// State persistence:
//   The user explicitly asked that selecting a hit and reading the
//   passage should not wipe their search. Query, results, current
//   page, and last keyword are stashed in sessionStorage under one
//   namespaced key, and rehydrated on mount. The cache survives any
//   in-app navigation (router push) and only clears on explicit user
//   action (the 清空 button) or session end (closing the tab).
//
// Pagination:
//   5 hits per page, separately for chunks and notes (the user reads
//   them as two independent feeds). Page indices are kept in the same
//   sessionStorage record so they restore together.
//
// Match highlighting:
//   The server already wraps matches in <mark> for the chunk snippet
//   it returns. For plain-text fields (notes' selectedText, chapter
//   titles), we run a simple client-side highlighter that escapes
//   HTML, then wraps every keyword occurrence in <mark>. Keywords
//   are derived from the query by splitting on whitespace.

import { useEffect, useMemo, useState, type FormEvent } from 'react';
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

interface CachedState {
  q: string;
  results: SearchResp | null;
  chunkPage: number;
  notePage: number;
}

const PAGE_SIZE = 5;
const CACHE_KEY = 'bookfree.search.state.v1';

function loadCache(): CachedState | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedState;
    if (typeof parsed.q !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveCache(s: CachedState) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(s));
  } catch {
    /* quota exceeded — nothing we can do, the page still works */
  }
}

function clearCache() {
  try { sessionStorage.removeItem(CACHE_KEY); } catch { /* noop */ }
}

export default function SearchPage() {
  const initial = useMemo(() => loadCache(), []);
  const [q, setQ] = useState(initial?.q ?? '');
  // `committed` is the query that produced the current results — used
  // for client-side highlighting so we mark hits against what the user
  // actually searched, not whatever they're currently typing.
  const [committed, setCommitted] = useState(initial?.q ?? '');
  const [results, setResults] = useState<SearchResp | null>(initial?.results ?? null);
  const [chunkPage, setChunkPage] = useState(initial?.chunkPage ?? 0);
  const [notePage, setNotePage] = useState(initial?.notePage ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Persist the entire state to sessionStorage on every change so that
  // navigating into a book and back restores exactly where the user was.
  useEffect(() => {
    saveCache({ q: committed, results, chunkPage, notePage });
  }, [committed, results, chunkPage, notePage]);

  const runSearch = async (query: string) => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setError('请输入至少 2 个字符再搜索');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const r = await api.get<SearchResp>('/api/search?q=' + encodeURIComponent(trimmed));
      setResults(r);
      setCommitted(trimmed);
      setChunkPage(0);
      setNotePage(0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    runSearch(q);
  };

  const onClear = () => {
    setQ('');
    setCommitted('');
    setResults(null);
    setChunkPage(0);
    setNotePage(0);
    setError(null);
    clearCache();
  };

  const keywords = useMemo(
    () => committed.trim().split(/\s+/).filter(s => s.length > 0),
    [committed],
  );

  return (
    <DashboardChrome title="全文搜索">
      <form onSubmit={onSubmit} className="mb-5 flex items-stretch gap-2">
        <input
          type="search"
          value={q}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQ(e.target.value)}
          autoFocus
          placeholder="在你所有书籍与笔记中搜索…"
          className="flex-1 rounded-lg border border-paper-300 px-4 py-2.5 outline-none focus:border-accent text-base"
        />
        <button
          type="submit"
          disabled={busy || q.trim().length < 2}
          className="px-5 py-2.5 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-dark disabled:opacity-40"
        >
          搜索
        </button>
        <button
          type="button"
          onClick={onClear}
          disabled={!q && !results}
          className="px-4 py-2.5 rounded-lg border border-paper-300 text-ink-700 text-sm hover:bg-paper-100 disabled:opacity-40"
          title="清空搜索结果"
        >
          清空
        </button>
      </form>

      {busy && <div className="text-ink-500 text-sm">搜索中…</div>}
      {error && <div className="text-rose-600 text-sm">{error}</div>}

      {results && (
        <div className="space-y-8">
          <PaginatedSection
            title={`书籍片段（${results.chunks.length}）`}
            empty="没有匹配的段落"
            items={results.chunks}
            page={chunkPage}
            onPage={setChunkPage}
            renderItem={h => (
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
                  className="text-sm text-ink-800 leading-relaxed snippet-3-lines"
                  // Server snippet already contains <mark>; passthrough.
                  dangerouslySetInnerHTML={{ __html: h.snippet }}
                />
              </Link>
            )}
            keyOf={h => h.id}
          />

          <PaginatedSection
            title={`笔记（${results.notes.length}）`}
            empty="没有匹配的笔记"
            items={results.notes}
            page={notePage}
            onPage={setNotePage}
            renderItem={n => (
              <Link
                to={`/book/${n.bookId}`}
                className="block rounded-lg border border-paper-300/70 bg-paper-50 px-4 py-3"
              >
                <div className="text-xs text-ink-500 mb-1">《{n.bookTitle}》</div>
                {n.selectedText && (
                  <div
                    className="text-xs italic mb-1 text-ink-600 border-l-2 border-accent/40 pl-2 snippet-3-lines"
                    dangerouslySetInnerHTML={{ __html: highlightKeywords(n.selectedText, keywords) }}
                  />
                )}
                <div
                  className="text-sm text-ink-800 leading-relaxed snippet-3-lines"
                  // Server snippet already contains <mark> for note body.
                  dangerouslySetInnerHTML={{ __html: n.snippet }}
                />
              </Link>
            )}
            keyOf={n => n.id}
          />
        </div>
      )}
    </DashboardChrome>
  );
}

// PaginatedSection slices `items` into PAGE_SIZE chunks and renders
// page controls when there's more than one page. Generic so the same
// component handles chunk hits and note hits without duplicating
// pagination logic.
function PaginatedSection<T>({
  title, empty, items, page, onPage, renderItem, keyOf,
}: {
  title: string;
  empty: string;
  items: T[];
  page: number;
  onPage: (p: number) => void;
  renderItem: (item: T) => React.ReactNode;
  keyOf: (item: T) => string;
}) {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, pageCount - 1));
  const start = safePage * PAGE_SIZE;
  const slice = items.slice(start, start + PAGE_SIZE);

  return (
    <section>
      <h2 className="text-sm font-medium text-ink-700 uppercase tracking-wide mb-3">{title}</h2>
      {total === 0 ? (
        <div className="text-sm text-ink-500">{empty}</div>
      ) : (
        <>
          <ul className="space-y-3">
            {slice.map(item => (
              <li key={keyOf(item)}>{renderItem(item)}</li>
            ))}
          </ul>
          {pageCount > 1 && (
            <div className="mt-4 flex items-center justify-between text-sm">
              <button
                onClick={() => onPage(Math.max(0, safePage - 1))}
                disabled={safePage === 0}
                className="px-3 py-1 rounded border border-paper-300 disabled:opacity-30 hover:bg-paper-100"
              >
                上一页
              </button>
              <span className="text-ink-500">
                第 {safePage + 1} / {pageCount} 页 · 共 {total} 条
              </span>
              <button
                onClick={() => onPage(Math.min(pageCount - 1, safePage + 1))}
                disabled={safePage >= pageCount - 1}
                className="px-3 py-1 rounded border border-paper-300 disabled:opacity-30 hover:bg-paper-100"
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// Lightweight client-side keyword highlighter. Used for fields the
// server didn't already wrap in <mark> (e.g. plain note selectedText).
// Steps:
//   1. HTML-escape the input so we can't inject anything.
//   2. For each keyword, replace case-insensitive occurrences with
//      <mark>…</mark> on the escaped string. We keep this simple and
//      O(n·k) — keyword count is small in practice (typically 1-3).
function highlightKeywords(text: string, keywords: string[]): string {
  let escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  for (const kw of keywords) {
    if (!kw) continue;
    const safe = kw
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // regex-escape
    if (!safe) continue;
    const re = new RegExp(safe, 'gi');
    escaped = escaped.replace(re, m => `<mark>${m}</mark>`);
  }
  return escaped;
}
