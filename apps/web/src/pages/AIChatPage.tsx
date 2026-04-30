/*
中文导读：
AIChatPage 是独立的 AI 对话页面，用于让用户在不进入具体阅读器时也能访问 AI 能力。
它通常会组合 AIChatPanel，并负责页面标题、布局、会话选择或全局上下文。
和 ReaderPage 内的 AI 能力相比，这个页面更偏“全局 AI 助手”入口。
如果你想调整 AI 页面整体布局、空状态、会话入口，优先看这里。
如果你想改消息发送、流式响应、Provider 选择等底层行为，需要继续看 AIChatPanel 和 lib/ai.ts。
*/

// /ai — full-page AI conversation surface.
//
// Single-column layout. The previous version had a side-by-side
// "chat | search" split — the user explicitly asked us to drop the
// search panel, since the AI answer is supposed to ALREADY ground
// itself in retrieved passages. The retrieval becomes a server-side
// concern: when the request is scoped to a book, the server runs
// FTS5 + vector rerank to assemble context, then asks the LLM to
// answer using THAT context. The retrieved passages come back with
// the answer as `citations`, and we render them as small cards
// directly under the assistant's bubble. The user gets one panel
// to read, with the source-of-truth right where they need it.
//
// Provider toggle:
//   We expose a "使用：内置 AI / <自定义 AI>" picker that mirrors the
//   user's saved provider profiles. When a custom profile is picked,
//   we pass providerId to /api/ai/chat. Otherwise the server uses the
//   built-in path with quota enforcement.
//
// Streaming:
//   The chat endpoint streams responses via SSE so the user sees the
//   answer materialise. We accumulate text in the in-progress
//   assistant message and finalise once the stream closes. Citations
//   are sent as a separate SSE event before the text stream begins
//   so the UI can render them above the answer immediately.

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import DashboardChrome from '../components/DashboardChrome';
import { streamChat, type AIMessage } from '../lib/ai';
import { truncate } from '../lib/format';

interface BookRow { id: string; title: string; status: string; }
interface ProviderRow {
  id: string;
  label: string;
  isDefault: boolean;
  enabled: boolean;
  hasKey: boolean;
}

interface Citation {
  /** Stable id for keying React lists. */
  id: string;
  bookId: string;
  bookTitle: string;
  chapterId?: string | null;
  chapterTitle?: string | null;
  /** First ~140 chars of the matched passage, with the user's
   *  query terms wrapped in <mark> by the server. */
  snippet: string;
}

interface UIMsg extends AIMessage {
  id: string;
  error?: boolean;
  /** Citations only present on assistant messages that were grounded
   *  in retrieved passages. The chat endpoint emits them at the start
   *  of the stream so we can render them as soon as we have the
   *  outline of an answer. */
  citations?: Citation[];
  /** True while the message is still being streamed. We use this to
   *  show a typing-cursor effect at the end of the bubble. */
  pending?: boolean;
}

export default function AIChatPage() {
  const [books, setBooks] = useState<BookRow[]>([]);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [scope, setScope] = useState<string>('all');         // 'all' or bookId
  const [providerId, setProviderId] = useState<string>(''); // '' = built-in
  const [messages, setMessages] = useState<UIMsg[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

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
    // Abort any in-flight chat on unmount.
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    const userMsg: UIMsg = { id: rid(), role: 'user', content: text };
    const assistantId = rid();
    const history = [...messages, userMsg];
    setMessages([
      ...history,
      { id: assistantId, role: 'assistant', content: '', pending: true },
    ]);
    setDraft('');
    setBusy(true);

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await streamChat({
        bookId: scope === 'all' ? undefined : scope,
        providerId: providerId || undefined,
        messages: history.map(m => ({ role: m.role, content: m.content })),
        signal: ac.signal,
        onCitations: (cits) => {
          setMessages(m => m.map(x => x.id === assistantId
            ? { ...x, citations: cits }
            : x));
        },
        onChunk: (delta) => {
          setMessages(m => m.map(x => x.id === assistantId
            ? { ...x, content: x.content + delta }
            : x));
        },
      });
    } catch (e) {
      const msg = (e as Error).message ?? '请求失败';
      setMessages(m => m.map(x => x.id === assistantId
        ? { ...x, content: x.content || msg, error: true, pending: false }
        : x));
    } finally {
      setMessages(m => m.map(x => x.id === assistantId
        ? { ...x, pending: false }
        : x));
      setBusy(false);
      abortRef.current = null;
    }
  };

  const onSendForm = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    send();
  };

  const usableBooks = useMemo(
    () => books.filter(b => b.status === 'ready'),
    [books],
  );

  return (
    <DashboardChrome title="AI 对话">
      <section className="border border-paper-300/70 rounded-xl bg-paper-50 flex flex-col min-h-[70vh] max-w-3xl mx-auto">
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
            disabled={messages.length === 0 || busy}
            className="ml-auto text-xs text-ink-500 hover:text-ink-800 disabled:opacity-30"
          >
            清空对话
          </button>
        </header>

        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4">
          {messages.length === 0 && (
            <div className="text-sm py-12 text-center text-ink-500">
              选择范围与模型后，开始你的提问。
              {scope !== 'all' && (
                <div className="mt-2 text-xs">
                  当前范围已限定到一本书；AI 回答时会从这本书检索相关段落。
                </div>
              )}
            </div>
          )}
          {messages.map(m => (
            <div key={m.id}>
              <div
                className={m.role === 'user' ? 'ai-bubble-user' : 'ai-bubble-asst'}
                style={m.error ? { color: '#c93a3a' } : undefined}
              >
                {m.content}
                {m.pending && <span className="ai-cursor">▌</span>}
                {m.role === 'assistant' && !m.pending && !m.content && '（暂无回复）'}
              </div>
              {m.role === 'assistant' && m.citations && m.citations.length > 0 && (
                <CitationStrip citations={m.citations} />
              )}
            </div>
          ))}
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
          {busy ? (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="px-4 py-2 rounded-lg border border-paper-300 text-ink-700 text-sm hover:bg-paper-100"
            >
              停止
            </button>
          ) : (
            <button
              type="submit"
              disabled={!draft.trim()}
              className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-30 hover:bg-accent-dark"
            >
              发送
            </button>
          )}
        </form>
      </section>
    </DashboardChrome>
  );
}

function CitationStrip({ citations }: { citations: Citation[] }) {
  return (
    <div className="mt-2 ml-2 flex flex-wrap gap-2">
      {citations.map(c => (
        <Link
          key={c.id}
          to={c.chapterId
            ? `/book/${c.bookId}?chapter=${encodeURIComponent(c.chapterId)}`
            : `/book/${c.bookId}`}
          className="block max-w-xs rounded-lg border border-paper-300/60 bg-white px-3 py-2 hover:border-accent/40"
          title={`跳转到《${c.bookTitle}》${c.chapterTitle ? '· ' + c.chapterTitle : ''}`}
        >
          <div className="text-[11px] text-ink-500 mb-0.5">
            《{truncate(c.bookTitle, 18)}》
            {c.chapterTitle && ' · ' + truncate(c.chapterTitle, 16)}
          </div>
          <div
            className="text-[11px] text-ink-700 leading-snug snippet-2-lines"
            dangerouslySetInnerHTML={{ __html: c.snippet }}
          />
        </Link>
      ))}
    </div>
  );
}

function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}
