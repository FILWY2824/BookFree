// /ai — full-page AI conversation surface.
//
// Differs from the in-reader AIChatPanel in two ways:
//
//   1. Scope toggle. The user picks "全部书库" or one specific book
//      from a dropdown. When a book is chosen we send its bookId
//      with the chat request so the server can ground answers in
//      that book's content (the existing /api/ai/chat already
//      accepts bookId — the proxy uses it as a future RAG hook).
//
//   2. Inline search. Below the conversation, we let the user run a
//      keyword search against the same library. This is the user's
//      requested "AI 结合用户输入与书籍内容回答；并展示原文检索
//      结果" — they get the model answer AND the underlying source
//      snippets at the same time, so the answer is verifiable.
//
// Provider toggle:
//   We expose a "使用：内置 AI / <自定义 AI>" picker that mirrors the
//   user's saved provider profiles. When a custom profile is picked,
//   we pass providerId to /api/ai/chat. Otherwise the server uses the
//   built-in path with quota enforcement.

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiException } from '../lib/api';
import DashboardChrome from '../components/DashboardChrome';
import { chat, type AIMessage } from '../lib/ai';
import { truncate } from '../lib/format';

interface BookRow { id: string; title: string; status: string; }
interface ProviderRow {
  id: string;
  label: string;
  isDefault: boolean;
  enabled: boolean;
  hasKey: boolean;
}

interface UIMsg extends AIMessage {
  id: string;
  error?: boolean;
}

interface ChunkHit {
  id: string;
  bookId: string;
  bookTitle: string;
  chapterTitle?: string | null;
  pageNo?: number | null;
  snippet: string;
  plainSnippet: string;
}

interface NoteHit { id: string; bookId: string; bookTitle: string; snippet: string; }

interface SearchResp { q: string; chunks: ChunkHit[]; notes: NoteHit[]; }

export default function AIChatPage() {
  const [books, setBooks] = useState<BookRow[]>([]);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [scope, setScope] = useState<string>('all');         // 'all' or bookId
  const [providerId, setProviderId] = useState<string>(''); // '' = built-in
  const [messages, setMessages] = useState<UIMsg[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResp | null>(null);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    Promise.all([
      api.get<{ books: BookRow[] }>('/api/books').catch(() => ({ books: [] })),
      api.get<{ providers: ProviderRow[] }>('/api/ai/providers')
        .catch(() => ({ providers: [] as ProviderRow[] })),
    ]).then(([b, p]) => {
      setBooks(b.books);
      setProviders(p.providers ?? []);
      const def = (p.providers ?? []).find(x => x.isDefault && x.enabled && x.hasKey);
      if (def) setProviderId(def.id);
    });
  }, []);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    const userMsg: UIMsg = { id: rid(), role: 'user', content: text };
    const history = [...messages, userMsg];
    setMessages(history);
    setDraft('');
    setBusy(true);
    const r = await chat({
      bookId: scope === 'all' ? undefined : scope,
      messages: history.map(m => ({ role: m.role, content: m.content })),
      // Custom-provider routing if selected; chat() already understands
      // any extra fields on the request body.
      ...(providerId ? { providerId } : {}),
    } as Parameters<typeof chat>[0] & { providerId?: string });
    setBusy(false);
    if (r.errorMessage) {
      setMessages(m => [...m, { id: rid(), role: 'assistant', error: true, content: r.errorMessage! }]);
      return;
    }
    setMessages(m => [...m, { id: rid(), role: 'assistant', content: r.message.content }]);
  };

  const onSendForm = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    send();
  };

  const runSearch = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const q = searchQ.trim();
    if (q.length < 2) {
      setSearchErr('至少输入 2 个字符');
      return;
    }
    setSearchErr(null);
    setSearchBusy(true);
    try {
      const r = await api.get<SearchResp>('/api/search?q=' + encodeURIComponent(q));
      // Filter by current scope, if a specific book is selected.
      if (scope !== 'all') {
        r.chunks = r.chunks.filter(h => h.bookId === scope);
        r.notes = r.notes.filter(n => n.bookId === scope);
      }
      setSearchResults(r);
    } catch (err) {
      const e = err as ApiException;
      setSearchErr(e.message ?? '搜索失败');
    } finally {
      setSearchBusy(false);
    }
  };

  const usableBooks = useMemo(
    () => books.filter(b => b.status === 'ready'),
    [books],
  );

  return (
    <DashboardChrome title="AI 对话">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Left column — chat */}
        <section className="border border-paper-300/70 rounded-xl bg-paper-50 flex flex-col min-h-[60vh]">
          <header className="px-4 py-3 border-b border-paper-300/60 flex flex-wrap items-center gap-2">
            <label className="text-xs text-ink-500">范围：</label>
            <select
              value={scope}
              onChange={e => setScope(e.target.value)}
              className="rounded-lg border border-paper-300 px-2 py-1 text-sm bg-white"
            >
              <option value="all">全部书库</option>
              {usableBooks.map(b => (
                <option key={b.id} value={b.id}>《{truncate(b.title, 30)}》</option>
              ))}
            </select>
            <label className="text-xs text-ink-500 ml-3">使用：</label>
            <select
              value={providerId}
              onChange={e => setProviderId(e.target.value)}
              className="rounded-lg border border-paper-300 px-2 py-1 text-sm bg-white"
            >
              <option value="">内置 AI</option>
              {providers
                .filter(p => p.enabled && p.hasKey)
                .map(p => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
            </select>
            <button
              onClick={() => setMessages([])}
              disabled={messages.length === 0}
              className="ml-auto text-xs text-ink-500 hover:text-ink-800 disabled:opacity-30"
            >
              清空对话
            </button>
          </header>

          <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-3">
            {messages.length === 0 && (
              <div className="text-sm py-12 text-center text-ink-500">
                选择范围与模型后，开始你的提问。
              </div>
            )}
            {messages.map(m => (
              <div
                key={m.id}
                className={m.role === 'user' ? 'ai-bubble-user' : 'ai-bubble-asst'}
                style={m.error ? { color: '#c93a3a' } : undefined}
              >
                {m.content || (m.role === 'assistant' && busy ? '思考中…' : '')}
              </div>
            ))}
            {busy && messages[messages.length - 1]?.role === 'user' && (
              <div className="ai-bubble-asst text-ink-500">思考中…</div>
            )}
          </div>

          <form onSubmit={onSendForm} className="border-t border-paper-300/60 p-3 flex items-end gap-2">
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={2}
              placeholder="请提问… Shift+Enter 换行"
              className="flex-1 resize-none rounded-lg border border-paper-300 px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <button
              type="submit"
              disabled={busy || !draft.trim()}
              className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-30 hover:bg-accent-dark"
            >
              发送
            </button>
          </form>
        </section>

        {/* Right column — search */}
        <section className="border border-paper-300/70 rounded-xl bg-paper-50 flex flex-col min-h-[60vh]">
          <header className="px-4 py-3 border-b border-paper-300/60">
            <form onSubmit={runSearch} className="flex items-center gap-2">
              <input
                type="search"
                value={searchQ}
                onChange={e => setSearchQ(e.target.value)}
                placeholder={scope === 'all' ? '在全部书库搜索…' : '在当前书内搜索…'}
                className="flex-1 rounded-lg border border-paper-300 px-3 py-1.5 text-sm outline-none focus:border-accent"
              />
              <button
                type="submit"
                disabled={searchBusy || searchQ.trim().length < 2}
                className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm disabled:opacity-30"
              >
                搜索
              </button>
              <button
                type="button"
                onClick={() => { setSearchQ(''); setSearchResults(null); setSearchErr(null); }}
                disabled={!searchQ && !searchResults}
                className="px-3 py-1.5 rounded-lg border border-paper-300 text-ink-700 text-sm hover:bg-paper-100 disabled:opacity-30"
              >
                清空
              </button>
            </form>
          </header>

          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
            {searchBusy && <div className="text-sm text-ink-500">搜索中…</div>}
            {searchErr && <div className="text-sm text-rose-600">{searchErr}</div>}
            {!searchResults && !searchBusy && !searchErr && (
              <div className="text-sm text-ink-500 py-12 text-center">
                输入关键词，从原文中检索内容；点击条目可跳到对应位置。
              </div>
            )}
            {searchResults && (
              <>
                <h3 className="text-xs uppercase tracking-wide text-ink-500">书籍片段（{searchResults.chunks.length}）</h3>
                {searchResults.chunks.length === 0 ? (
                  <div className="text-sm text-ink-500">没有匹配的段落</div>
                ) : (
                  <ul className="space-y-2">
                    {searchResults.chunks.slice(0, 20).map(h => (
                      <li key={h.id}>
                        <Link
                          to={`/book/${h.bookId}`}
                          className="block rounded-lg border border-paper-300/60 hover:border-accent/40 bg-white px-3 py-2"
                        >
                          <div className="text-[11px] text-ink-500 mb-1">
                            《{h.bookTitle}》
                            {h.chapterTitle && ' · ' + truncate(h.chapterTitle, 24)}
                          </div>
                          <div
                            className="text-xs text-ink-700 leading-relaxed snippet-3-lines"
                            dangerouslySetInnerHTML={{ __html: h.snippet }}
                          />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
                {searchResults.notes.length > 0 && (
                  <>
                    <h3 className="text-xs uppercase tracking-wide text-ink-500 mt-4">笔记（{searchResults.notes.length}）</h3>
                    <ul className="space-y-2">
                      {searchResults.notes.slice(0, 10).map(n => (
                        <li key={n.id}>
                          <Link
                            to={`/book/${n.bookId}`}
                            className="block rounded-lg border border-paper-300/60 bg-white px-3 py-2"
                          >
                            <div className="text-[11px] text-ink-500 mb-1">《{n.bookTitle}》</div>
                            <div
                              className="text-xs text-ink-700 snippet-3-lines"
                              dangerouslySetInnerHTML={{ __html: n.snippet }}
                            />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
          </div>
        </section>
      </div>
    </DashboardChrome>
  );
}

function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}
