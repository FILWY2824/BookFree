// AIChatPanel — right-side drawer that lets the user chat with the
// AI about the current book. Two presentation modes:
//
//   1. drawer (pinned=false): sliding overlay with backdrop. Click
//      outside dismisses. This is the legacy mode.
//   2. pinned (pinned=true): floating card in the bottom-right corner,
//      no backdrop, stays open across page interactions. The header
//      doubles as a drag handle so the user can park it anywhere on
//      screen. The reader stays interactive behind it.
//
// Lifetime / persistence:
//   • The chat history lives in component state for the duration of
//     the reader session. We don't persist (no /api/ai/conversations
//     yet on the Go server). When the user navigates away, the
//     transcript is gone — we surface a tiny "清空" button so this
//     is at least intentional.
//   • The "include current chapter / current selection as context"
//     toggles are per-message — they live in the input bar and are
//     consulted when the user hits send.
//   • Pin position is local UI state. Pin on/off is owned by the
//     parent (it's persisted in prefs alongside tocPinned).
//
// We intentionally don't render markdown for now. The model's reply
// is shown in a <pre>-style bubble (whitespace-preserving) so any
// inline code / numbered lists are still legible without us shipping
// a markdown renderer that costs ~80 KB.

import { useEffect, useRef, useState } from 'react';
import { chat, isAIConfigured, type AIMessage } from '../lib/ai';

interface Props {
  open: boolean;
  onClose: () => void;
  bookId: string;
  bookTitle: string;
  chapterTitle?: string;
  /** Latest text excerpt the user selected — passed to the model as
   *  optional focus context when they tick "include selection". */
  selectedText?: string | null;
  /** When true, render as a free-floating draggable card instead of a
   *  modal drawer. Click-outside doesn't dismiss in this mode — the
   *  user has to press the close button explicitly, or unpin. */
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
  const [messages, setMessages] = useState<UIMsg[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [includeSelection, setIncludeSelection] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Pinned-mode position. Default: bottom-right with a small inset.
  // Stored as right/bottom offsets so the card stays anchored if the
  // viewport changes mid-session.
  const [pinPos, setPinPos] = useState<{ right: number; bottom: number }>(
    () => ({ right: 20, bottom: 20 }),
  );

  // Probe AI availability on first open.
  useEffect(() => {
    if (!open || configured !== null) return;
    let cancelled = false;
    isAIConfigured()
      .then(c => { if (!cancelled) setConfigured(c); })
      .catch(() => { if (!cancelled) setConfigured(false); });
    return () => { cancelled = true; };
  }, [open, configured]);

  // Auto-scroll to bottom when new messages arrive.
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  if (!open) return null;

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    const userMsg: UIMsg = { id: rid(), role: 'user', content: text };
    const history = [...messages, userMsg];
    setMessages(history);
    setDraft('');
    setBusy(true);

    const excerpt = includeSelection && selectedText && selectedText.trim()
      ? selectedText.trim()
      : null;
    const r = await chat({
      bookId,
      excerpt,
      messages: history.map(m => ({ role: m.role, content: m.content })),
    });
    setBusy(false);

    if (r.notConfigured) {
      setConfigured(false);
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

  // Drag handler — only active in pinned mode. Mousedown on the header
  // captures the offset from the card's current right/bottom anchor and
  // updates on every mousemove until mouseup.
  const onHeaderMouseDown = (e: React.MouseEvent<HTMLElement>) => {
    if (!pinned) return;
    // Don't start dragging when the user clicked an interactive control
    // inside the header.
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const startRight = pinPos.right;
    const startBottom = pinPos.bottom;
    const startX = e.clientX;
    const startY = e.clientY;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      // Right anchor decreases when cursor moves right; bottom anchor
      // decreases when cursor moves down.
      const nextRight = Math.max(8, Math.min(window.innerWidth - 200, startRight - dx));
      const nextBottom = Math.max(8, Math.min(window.innerHeight - 80, startBottom - dy));
      setPinPos({ right: nextRight, bottom: nextBottom });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ── Pinned mode: floating, draggable, no backdrop ──────────────────
  if (pinned) {
    return (
      <aside
        className="fixed z-40 w-[360px] max-w-[92vw] h-[520px] max-h-[80vh] border shadow-elev rounded-xl flex flex-col"
        style={{
          right: pinPos.right + 'px',
          bottom: pinPos.bottom + 'px',
          background: 'var(--reader-bg)',
          color: 'var(--reader-fg)',
          borderColor: 'var(--reader-border)',
        }}
      >
        <Header
          bookTitle={bookTitle}
          chapterTitle={chapterTitle}
          messageCount={messages.length}
          onClear={() => setMessages([])}
          onClose={onClose}
          pinned
          onTogglePin={onTogglePin}
          onMouseDown={onHeaderMouseDown}
        />
        <Body
          scrollRef={scrollRef}
          messages={messages}
          busy={busy}
          configured={configured}
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
      </aside>
    );
  }

  // ── Drawer mode: overlay with backdrop ─────────────────────────────
  return (
    <div
      className="fixed inset-0 z-40"
      onMouseDown={onClose}
    >
      <div className="absolute inset-0 bg-ink-900/30 animate-fade-in" />
      <aside
        onMouseDown={e => e.stopPropagation()}
        className="absolute right-0 top-0 h-full w-[360px] max-w-[92vw] bg-paper-50 border-l border-paper-300/70 shadow-elev animate-drawer-in-right flex flex-col"
        style={{ background: 'var(--reader-bg)', color: 'var(--reader-fg)' }}
      >
        <Header
          bookTitle={bookTitle}
          chapterTitle={chapterTitle}
          messageCount={messages.length}
          onClear={() => setMessages([])}
          onClose={onClose}
          pinned={false}
          onTogglePin={onTogglePin}
        />
        <Body
          scrollRef={scrollRef}
          messages={messages}
          busy={busy}
          configured={configured}
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
      </aside>
    </div>
  );
}

function Header({
  bookTitle, chapterTitle, messageCount, onClear, onClose,
  pinned, onTogglePin, onMouseDown,
}: {
  bookTitle: string;
  chapterTitle?: string;
  messageCount: number;
  onClear: () => void;
  onClose: () => void;
  pinned: boolean;
  onTogglePin?: () => void;
  onMouseDown?: (e: React.MouseEvent<HTMLElement>) => void;
}) {
  return (
    <header
      className={'px-5 py-3 border-b flex items-center justify-between '
        + (pinned ? 'cursor-move select-none' : '')}
      style={{ borderColor: 'var(--reader-border)' }}
      onMouseDown={onMouseDown}
    >
      <div className="min-w-0">
        <h3 className="font-serif text-base">AI 阅读助手</h3>
        <div className="text-[11px] truncate" style={{ color: 'var(--reader-muted)' }}>
          {chapterTitle ? `《${bookTitle}》· ${chapterTitle}` : `《${bookTitle}》`}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onClear}
          className="text-xs opacity-60 hover:opacity-100"
          title="清空对话"
          disabled={messageCount === 0}
        >
          清空
        </button>
        {onTogglePin && (
          <button
            onClick={onTogglePin}
            className="opacity-60 hover:opacity-100 p-1"
            aria-label={pinned ? '取消固定' : '固定为悬浮窗'}
            title={pinned ? '取消固定' : '固定为悬浮窗'}
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

function Body({
  scrollRef, messages, busy, configured,
}: {
  scrollRef: React.RefObject<HTMLDivElement>;
  messages: UIMsg[];
  busy: boolean;
  configured: boolean | null;
}) {
  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-4 py-4 flex flex-col gap-3">
      {messages.length === 0 && (
        <div className="text-sm py-12 px-2 text-center" style={{ color: 'var(--reader-muted)' }}>
          {configured === false ? (
            <>
              AI 接口尚未配置。<br />
              请在 <em>设置 → AI 设置</em> 中配置内置 AI 或导入自己的 API 密钥。
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
        <div
          key={m.id}
          className={m.role === 'user' ? 'ai-bubble-user' : 'ai-bubble-asst'}
          style={m.error ? { color: '#c93a3a' } : undefined}
        >
          {m.content || (m.role === 'assistant' && busy ? '思考中…' : '')}
        </div>
      ))}
      {busy && messages[messages.length - 1]?.role === 'user' && (
        <div className="ai-bubble-asst" style={{ color: 'var(--reader-muted)' }}>思考中…</div>
      )}
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

function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}
