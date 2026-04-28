// AIChatPanel — right-side drawer that lets the user chat with the
// AI about the current book.
//
// Behaviour change vs the previous version:
//   The "pinned" state used to morph the panel into a 360 × 520
//   floating card anchored in the bottom-right of the viewport, with
//   a drag handle. The user explicitly asked that pinning instead
//   keep the panel in its existing drawer position (full-height,
//   right edge of the viewport) and only differ from the unpinned
//   state in TWO ways:
//     1. no backdrop is drawn (so the reader stays interactive);
//     2. clicking outside the panel doesn't dismiss it — the user
//        has to press the ✕ button explicitly.
//   Everything else — width, height, header layout, body, footer —
//   stays exactly the same as the unpinned drawer. The pin button
//   in the header still toggles between the two states.
//
// Lifetime / persistence:
//   Chat history lives in component state for the duration of the
//   reader session. Persistence is on the backlog. We surface a tiny
//   "清空" button so a stale session ending is at least intentional.
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
  const [messages, setMessages] = useState<UIMsg[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [includeSelection, setIncludeSelection] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);

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

  // The aside element is identical whether pinned or not — we just
  // skip the backdrop and the click-outside handler when pinned.
  const aside = (
    <aside
      onMouseDown={pinned ? undefined : (e => e.stopPropagation())}
      className={
        'absolute right-0 top-0 h-full w-[360px] max-w-[92vw] border-l shadow-elev '
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
        messageCount={messages.length}
        onClear={() => setMessages([])}
        onClose={onClose}
        pinned={pinned}
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
  );

  if (pinned) {
    // Pinned: no backdrop, no click-outside-close, but the panel is
    // still positioned at the right edge of the viewport using a
    // pointer-events-none container so the rest of the reader stays
    // clickable behind it. The aside itself enables pointer events.
    return (
      <div
        className="fixed inset-0 z-40 pointer-events-none"
      >
        <div className="pointer-events-auto h-full">
          {aside}
        </div>
      </div>
    );
  }

  // Unpinned: backdrop + click-outside-close, exactly the legacy
  // behaviour for the drawer mode.
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

function Header({
  bookTitle, chapterTitle, messageCount, onClear, onClose,
  pinned, onTogglePin,
}: {
  bookTitle: string;
  chapterTitle?: string;
  messageCount: number;
  onClear: () => void;
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
