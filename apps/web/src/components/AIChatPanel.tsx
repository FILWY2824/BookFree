/*
中文导读：
AIChatPanel 是前端 AI 对话面板，负责展示消息列表、输入问题、发送请求、显示流式回复等交互。
它是 AI 阅读能力的主要 UI 入口，可能被阅读器页面或独立 AI 页面复用。
这个组件通常会处理：用户输入、发送中状态、消息滚动、错误提示、停止生成、引用书籍上下文等。
如果你想改 AI 对话的界面样式、输入框按钮、消息气泡、空状态文案，优先看这里。
如果你想改真正的 AI 请求参数或接口路径，需要结合 lib/ai.ts、lib/aiSessions.ts 和后端 ai handler 一起看。
*/

// AIChatPanel — the right-side drawer that lets the user chat with
// the AI about the current book.
//
// What changed in this rewrite (per user request):
//
//   1. Chat-history sidebar.
//      The panel now has two columns: a narrow list of past
//      conversations on the left, the active conversation on the
//      right. Tapping a row swaps it in. New conversations are
//      created via the ＋ button at the top of the sidebar; deletion
//      is per-row. Sessions are stored in localStorage scoped to
//      bookId — each book has its own conversation history.
//
//   2. Markdown rendering.
//      Assistant replies are now rendered through a tiny in-house
//      Markdown parser (lib/markdown.ts) so headings, lists, code
//      blocks, bold/italic, and links all display properly. User
//      bubbles stay as plain text — there's no upside to letting a
//      user inject HTML through their own message. We keep the
//      bundle hit at zero (no external library).
//
//   3. Draft persistence.
//      The textarea contents are mirrored to localStorage keyed by
//      bookId, so closing the panel or switching pages and coming
//      back doesn't drop your half-written question. The draft is
//      cleared on send or on explicit clear.
//
//   4. Provider auto-detection.
//      We now query both /api/ai/status (built-in availability) AND
//      /api/ai/providers (the user's imported provider profiles).
//      The header shows a dropdown with all usable destinations:
//      "内置 AI" (if available) plus every enabled-with-key custom
//      provider. We default to the user's marked-default custom
//      provider if there is one — that fixes the bug where a user
//      had configured their own key but the panel still said "AI
//      未配置".
//
//   5. Pinned vs unpinned still works the same — pinned drops the
//      backdrop and the click-outside-close, otherwise identical.

import { useCallback, useEffect, useRef, useState } from 'react';
import { chat, getAIAvailability, type AIMessage, type ProviderSummary } from '../lib/ai';
import { renderMarkdown } from '../lib/markdown';
import {
  type ChatSession,
  createSession,
  deleteSession,
  deriveTitle,
  getSession,
  listSessions,
  loadDraft,
  saveDraft,
  setActiveId,
  updateSession,
  getActiveId,
} from '../lib/aiSessions';

interface Props {
  open: boolean;
  onClose: () => void;
  bookId: string;
  bookTitle: string;
  chapterTitle?: string;
  /** Latest text excerpt the user selected — passed to the model as
   *  optional focus context when they tick "include selection". */
  selectedText?: string | null;
  /** When true, suppress the backdrop and the click-outside-close
   *  handler so the panel stays open while the user keeps reading. */
  pinned?: boolean;
  onTogglePin?: () => void;
}

interface UIMsg extends AIMessage {
  id: string;
  // Populated when the assistant replies were errors so we can render
  // them differently from a normal completion.
  error?: boolean;
}

export default function AIChatPanel({
  open, onClose, bookId, bookTitle, chapterTitle, selectedText,
  pinned = false, onTogglePin,
}: Props) {
  // Provider availability (built-in flag + custom provider list).
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [builtinAvailable, setBuiltinAvailable] = useState<boolean | null>(null);
  const [providerId, setProviderId] = useState<string>('');  // '' = built-in

  // Active session + history.
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionIdState] = useState<string | null>(null);
  const [messages, setMessages] = useState<UIMsg[]>([]);

  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [includeSelection, setIncludeSelection] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Probe provider availability on first open ──────────────────
  useEffect(() => {
    if (!open || builtinAvailable !== null) return;
    let cancelled = false;
    getAIAvailability()
      .then(av => {
        if (cancelled) return;
        setBuiltinAvailable(av.builtin);
        setProviders(av.providers);
        // Seed the picker with the recommended default. This is the
        // line that fixes the "I configured my key but it doesn't
        // work" bug: previously we ignored av.providers entirely and
        // just showed "AI not configured" if av.builtin was false.
        setProviderId(av.defaultProviderId);
      })
      .catch(() => {
        if (!cancelled) {
          setBuiltinAvailable(false);
          setProviders([]);
        }
      });
    return () => { cancelled = true; };
  }, [open, builtinAvailable]);

  // ── Hydrate history + draft when opening / book changes ────────
  useEffect(() => {
    if (!open) return;
    const list = listSessions(bookId);
    setSessions(list);

    let activeId = getActiveId(bookId);
    let active = activeId ? getSession(bookId, activeId) : null;
    if (!active && list.length > 0) {
      active = list[0];
      activeId = active.id;
      setActiveId(bookId, activeId);
    }
    setActiveSessionIdState(activeId);
    setMessages(active ? active.messages.map(m => ({ ...m, id: rid() })) : []);
    setDraft(loadDraft(bookId));
  }, [open, bookId]);

  // ── Persist draft across navigations ───────────────────────────
  useEffect(() => {
    if (!open) return;
    saveDraft(bookId, draft);
  }, [draft, bookId, open]);

  // ── Auto-scroll to bottom when new messages arrive ─────────────
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  // ── Persist messages into the active session ───────────────────
  // We snapshot whenever the message list changes. Throttling isn't
  // needed: messages only change a handful of times per request and
  // localStorage writes for these payload sizes are sub-millisecond.
  useEffect(() => {
    if (!activeSessionId) return;
    const cleanMessages = messages.map(m => ({
      role: m.role,
      content: m.content,
      error: m.error,
    }));
    const updated = updateSession(bookId, activeSessionId, {
      messages: cleanMessages,
      title: deriveTitle(cleanMessages),
    });
    if (updated) {
      setSessions(listSessions(bookId));
    }
  }, [messages, activeSessionId, bookId]);

  const switchToSession = useCallback((sid: string) => {
    const s = getSession(bookId, sid);
    if (!s) return;
    setActiveId(bookId, sid);
    setActiveSessionIdState(sid);
    setMessages(s.messages.map(m => ({ ...m, id: rid() })));
  }, [bookId]);

  const startNewSession = useCallback(() => {
    const s = createSession(bookId);
    setSessions(listSessions(bookId));
    setActiveSessionIdState(s.id);
    setMessages([]);
  }, [bookId]);

  const removeSession = useCallback((sid: string) => {
    deleteSession(bookId, sid);
    const list = listSessions(bookId);
    setSessions(list);
    if (activeSessionId === sid) {
      const next = list[0];
      if (next) {
        setActiveId(bookId, next.id);
        setActiveSessionIdState(next.id);
        setMessages(next.messages.map(m => ({ ...m, id: rid() })));
      } else {
        setActiveId(bookId, null);
        setActiveSessionIdState(null);
        setMessages([]);
      }
    }
  }, [bookId, activeSessionId]);

  if (!open) return null;

  const usableProviders = providers.filter(p => p.enabled && p.hasKey);
  const aiConfigured = builtinAvailable === true || usableProviders.length > 0;

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;

    // Make sure we have a session to write into.
    let sid = activeSessionId;
    if (!sid) {
      const s = createSession(bookId);
      sid = s.id;
      setActiveSessionIdState(sid);
      setSessions(listSessions(bookId));
    }

    const userMsg: UIMsg = { id: rid(), role: 'user', content: text };
    const history = [...messages, userMsg];
    setMessages(history);
    setDraft('');
    saveDraft(bookId, '');
    setBusy(true);

    const excerpt = includeSelection && selectedText && selectedText.trim()
      ? selectedText.trim()
      : null;
    const r = await chat({
      bookId,
      excerpt,
      providerId: providerId || undefined,
      messages: history.map(m => ({ role: m.role, content: m.content })),
    });
    setBusy(false);

    if (r.notConfigured) {
      setMessages(m => [...m, {
        id: rid(),
        role: 'assistant',
        error: true,
        content: r.errorMessage ?? '服务器尚未配置 AI 提供商。',
      }]);
      return;
    }
    if (r.errorMessage) {
      setMessages(m => [...m, { id: rid(), role: 'assistant', error: true, content: '出错了：' + r.errorMessage }]);
      return;
    }
    setMessages(m => [...m, { id: rid(), role: 'assistant', content: r.message.content }]);
  };

  // The aside element is identical whether pinned or not — we just
  // skip the backdrop and the click-outside handler when pinned.
  const aside = (
    <aside
      onMouseDown={pinned ? undefined : (e => e.stopPropagation())}
      className={
        'absolute right-0 top-0 h-full w-[480px] max-w-[96vw] border-l shadow-elev '
        + 'flex flex-col '
        + (pinned ? '' : 'animate-drawer-in-right')
      }
      style={{
        background: 'var(--reader-bg)',
        color: 'var(--reader-fg)',
        borderColor: 'var(--reader-border)',
      }}
    >
      <Header
        bookTitle={bookTitle}
        chapterTitle={chapterTitle}
        onClose={onClose}
        pinned={pinned}
        onTogglePin={onTogglePin}
      />
      <ProviderRow
        providerId={providerId}
        setProviderId={setProviderId}
        builtinAvailable={builtinAvailable === true}
        providers={usableProviders}
      />
      <div className="ai-panel-grid flex-1 min-h-0">
        <HistorySidebar
          sessions={sessions}
          activeId={activeSessionId}
          onPick={switchToSession}
          onNew={startNewSession}
          onDelete={removeSession}
        />
        <div className="ai-panel-conversation min-h-0">
          <Body
            scrollRef={scrollRef}
            messages={messages}
            busy={busy}
            configured={aiConfigured}
          />
          <Footer
            draft={draft}
            setDraft={setDraft}
            busy={busy}
            send={send}
            selectedText={selectedText}
            includeSelection={includeSelection}
            setIncludeSelection={setIncludeSelection}
          />
        </div>
      </div>
    </aside>
  );

  if (pinned) {
    return (
      <div className="fixed inset-0 z-40 pointer-events-none">
        <div className="pointer-events-auto h-full">
          {aside}
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-40"
      onMouseDown={onClose}
    >
      <div className="absolute inset-0 bg-ink-900/30 animate-fade-in" />
      {aside}
    </div>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────

function Header({
  bookTitle, chapterTitle, onClose, pinned, onTogglePin,
}: {
  bookTitle: string;
  chapterTitle?: string;
  onClose: () => void;
  pinned: boolean;
  onTogglePin?: () => void;
}) {
  return (
    <header
      className="px-5 py-3 border-b flex items-center justify-between"
      style={{ borderColor: 'var(--reader-border)' }}
    >
      <div className="min-w-0">
        <h3 className="font-serif text-base">AI 阅读助手</h3>
        <div className="text-[11px] truncate" style={{ color: 'var(--reader-muted)' }}>
          {chapterTitle ? `《${bookTitle}》· ${chapterTitle}` : `《${bookTitle}》`}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {onTogglePin && (
          <button
            onClick={onTogglePin}
            className="opacity-60 hover:opacity-100 p-1"
            aria-label={pinned ? '取消固定' : '固定面板'}
            title={pinned ? '取消固定（恢复点击外部关闭）' : '固定面板（不再点击外部关闭）'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24"
                 fill={pinned ? 'currentColor' : 'none'}
                 stroke="currentColor" strokeWidth="1.7"
                 strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 2.5L21.5 10l-4 1-3.5 6.5-3-3-5 5-1-1 5-5-3-3L13.5 6 14 2.5z"/>
            </svg>
          </button>
        )}
        <button onClick={onClose} aria-label="关闭" className="opacity-60 hover:opacity-100">✕</button>
      </div>
    </header>
  );
}

function ProviderRow({
  providerId, setProviderId, builtinAvailable, providers,
}: {
  providerId: string;
  setProviderId: (s: string) => void;
  builtinAvailable: boolean;
  providers: ProviderSummary[];
}) {
  return (
    <div className="ai-provider-row">
      <span>使用：</span>
      <select
        value={providerId}
        onChange={e => setProviderId(e.target.value)}
      >
        {builtinAvailable && <option value="">内置 AI</option>}
        {!builtinAvailable && providers.length === 0 && (
          <option value="" disabled>未配置 AI</option>
        )}
        {providers.map(p => (
          <option key={p.id} value={p.id}>
            {p.label}{p.isDefault ? ' · 默认' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

function HistorySidebar({
  sessions, activeId, onPick, onNew, onDelete,
}: {
  sessions: ChatSession[];
  activeId: string | null;
  onPick: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="ai-history">
      <div className="ai-history-header">
        <span className="ai-history-title">历史</span>
        <button
          type="button"
          className="ai-history-new"
          onClick={onNew}
          title="开启新对话"
          aria-label="开启新对话"
        >
          ＋
        </button>
      </div>
      <div className="ai-history-list scrollbar-thin">
        {sessions.length === 0 && (
          <div className="ai-history-empty">
            还没有历史对话<br />
            点击 ＋ 开启
          </div>
        )}
        {sessions.map(s => (
          <button
            key={s.id}
            type="button"
            className="ai-history-item"
            data-active={s.id === activeId ? '1' : undefined}
            onClick={() => onPick(s.id)}
          >
            <div className="ai-history-item-main">
              <div className="ai-history-item-title">{s.title || '新对话'}</div>
              <div className="ai-history-item-time">{formatTime(s.updatedAt)}</div>
            </div>
            <span
              role="button"
              tabIndex={0}
              className="ai-history-item-del"
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation();
                if (confirm('删除这条对话？')) onDelete(s.id);
              }}
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  if (confirm('删除这条对话？')) onDelete(s.id);
                }
              }}
              title="删除"
              aria-label="删除"
            >
              ✕
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Body({
  scrollRef, messages, busy, configured,
}: {
  scrollRef: React.RefObject<HTMLDivElement>;
  messages: UIMsg[];
  busy: boolean;
  configured: boolean;
}) {
  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-4 py-4 flex flex-col gap-3">
      {messages.length === 0 && (
        <div className="text-sm py-12 px-2 text-center" style={{ color: 'var(--reader-muted)' }}>
          {!configured ? (
            <>
              AI 接口尚未配置。<br />
              请在 <em>设置 → AI 设置</em> 中启用内置 AI 或导入自己的 API 密钥。
            </>
          ) : (
            <>
              你可以问我关于这本书的任何问题。<br />
              例如：<em>"总结一下这一章的主要观点"</em> 或 <em>"这段话的修辞手法是什么？"</em>。
            </>
          )}
        </div>
      )}
      {messages.map(m => (
        <MessageBubble key={m.id} msg={m} />
      ))}
      {busy && messages[messages.length - 1]?.role === 'user' && (
        <div className="ai-bubble-asst" style={{ color: 'var(--reader-muted)' }}>思考中…</div>
      )}
    </div>
  );
}

function MessageBubble({ msg }: { msg: UIMsg }) {
  // Assistant messages render Markdown; user messages render plain text.
  // Errors render plain so the model's apology / failure reason isn't
  // re-interpreted through the markdown parser.
  if (msg.role === 'assistant' && !msg.error && msg.content) {
    const html = renderMarkdown(msg.content);
    return (
      <div
        className="ai-bubble-asst ai-md"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return (
    <div
      className={msg.role === 'user' ? 'ai-bubble-user' : 'ai-bubble-asst'}
      style={msg.error ? { color: '#c93a3a' } : undefined}
    >
      {msg.content || (msg.role === 'assistant' ? '（暂无回复）' : '')}
    </div>
  );
}

function Footer({
  draft, setDraft, busy, send, selectedText, includeSelection, setIncludeSelection,
}: {
  draft: string;
  setDraft: (s: string) => void;
  busy: boolean;
  send: () => void;
  selectedText: string | null | undefined;
  includeSelection: boolean;
  setIncludeSelection: (v: boolean) => void;
}) {
  return (
    <footer
      className="border-t px-3 py-3 space-y-2"
      style={{ borderColor: 'var(--reader-border)' }}
    >
      {selectedText && selectedText.trim() && (
        <label className="text-[11px] flex items-start gap-2 cursor-pointer" style={{ color: 'var(--reader-muted)' }}>
          <input
            type="checkbox"
            checked={includeSelection}
            onChange={e => setIncludeSelection(e.target.checked)}
            className="mt-0.5"
          />
          <span className="flex-1">
            附带选区：
            <span className="italic line-clamp-2">"{selectedText.trim().slice(0, 90)}{selectedText.length > 90 ? '…' : ''}"</span>
          </span>
        </label>
      )}
      <div className="flex items-end gap-2">
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
          placeholder="问我关于这本书的事…  Shift+Enter 换行"
          rows={2}
          className="flex-1 resize-none rounded-lg border px-3 py-2 text-sm"
          style={{
            background: 'transparent',
            color: 'var(--reader-fg)',
            borderColor: 'var(--reader-border)',
          }}
        />
        <button
          onClick={send}
          disabled={busy || !draft.trim()}
          className="px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-30"
          style={{ background: 'var(--reader-accent)', color: '#fff' }}
        >
          发送
        </button>
      </div>
    </footer>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = Date.now();
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const yesterday = new Date(now - 86400_000).toDateString() === d.toDateString();
  if (yesterday) return '昨天';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}
