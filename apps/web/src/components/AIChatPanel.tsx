// AIChatPanel — right-side drawer that lets the user chat with the
// AI about the current book. Mirrors the SettingsDrawer's
// presentation so the reader feels coherent with both panels open.
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
}

interface UIMsg extends AIMessage {
  id: string;
  // Populated when the assistant replies were errors so we can render
  // them differently from a normal completion.
  error?: boolean;
}

export default function AIChatPanel({
  open, onClose, bookId, bookTitle, chapterTitle, selectedText,
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
              onClick={() => setMessages([])}
              className="text-xs opacity-60 hover:opacity-100"
              title="清空对话"
              disabled={messages.length === 0}
            >
              清空
            </button>
            <button onClick={onClose} aria-label="关闭" className="opacity-60 hover:opacity-100">✕</button>
          </div>
        </header>

        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-4 py-4 flex flex-col gap-3">
          {messages.length === 0 && (
            <div className="text-sm py-12 px-2 text-center" style={{ color: 'var(--reader-muted)' }}>
              {configured === false ? (
                <>
                  AI 接口尚未配置。<br />
                  请在服务器端设置 <code>ANTHROPIC_API_KEY</code> 环境变量后重启服务，
                  或在 <em>账户设置 → AI Provider</em> 中配置自己的密钥。
                </>
              ) : (
                <>
                  你可以问我关于这本书的任何问题。<br />
                  例如：<em>“总结一下这一章的主要观点”</em> 或 <em>“这段话的修辞手法是什么？”</em>。
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
                <span className="italic line-clamp-2">“{selectedText.trim().slice(0, 90)}{selectedText.length > 90 ? '…' : ''}”</span>
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
      </aside>
    </div>
  );
}

function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}
