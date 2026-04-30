/*
中文导读：
aiSessions.ts 负责前端 AI 会话相关 API 或状态辅助逻辑。
AI 阅读功能通常包括：围绕当前书籍提问、续聊、查看历史消息、保存会话等。
这个文件一般作为页面/组件和后端 AI 接口之间的薄封装，帮助统一请求路径、参数和响应结构。
如果以后 Android 端也要复用 AI 能力，真正稳定的是后端 /api/ai* 接口；这里是 Web 前端调用这些接口的实现。
如果你想改 AI 面板 UI，更多看 AIChatPanel；如果你想改请求结构或会话列表加载，优先看这里。
*/

// Chat-session persistence for the in-reader AI panel.
//
// A "session" is one back-and-forth conversation with the model,
// scoped to a single book. Sessions live in localStorage so the user
// can come back later and continue, or browse old conversations from
// the panel's history sidebar without re-sending context.
//
// Layout in storage (one key per book):
//
//   bookfree.ai.sessions.<bookId> = JSON{
//     active: <sessionId | null>,
//     sessions: [
//       { id, title, createdAt, updatedAt, messages: [{ role, content, error? }] },
//       ...
//     ]
//   }
//
// Drafts (the half-typed user message that hasn't been sent yet) are
// stored separately so they persist even if the user never sent the
// message — closing the panel or switching pages doesn't lose work:
//
//   bookfree.ai.draft.<bookId> = "<plain string>"
//
// Why localStorage and not the server: the chat history is comfort
// scaffolding; losing it would be annoying but not catastrophic, and
// the server's /api/ai/chat is stateless. Persisting client-side keeps
// the migration simple and avoids a new table; if we later want the
// history to roam between devices, this is the obvious place to swap
// in an HTTP-backed store without touching the panel UI.

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  error?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

interface SessionsBlob {
  active: string | null;
  sessions: ChatSession[];
}

function sessionsKey(bookId: string): string {
  return `bookfree.ai.sessions.${bookId}`;
}
function draftKey(bookId: string): string {
  return `bookfree.ai.draft.${bookId}`;
}

const MAX_SESSIONS_PER_BOOK = 30;
const MAX_TITLE_LEN = 40;

export function loadBlob(bookId: string): SessionsBlob {
  try {
    const raw = localStorage.getItem(sessionsKey(bookId));
    if (!raw) return { active: null, sessions: [] };
    const parsed = JSON.parse(raw) as Partial<SessionsBlob> | null;
    if (!parsed || !Array.isArray(parsed.sessions)) return { active: null, sessions: [] };
    return {
      active: typeof parsed.active === 'string' ? parsed.active : null,
      sessions: parsed.sessions.filter(s => s && typeof s.id === 'string'),
    };
  } catch {
    return { active: null, sessions: [] };
  }
}

function saveBlob(bookId: string, blob: SessionsBlob): void {
  try {
    // Keep the blob bounded — old sessions are dropped FIFO so the
    // localStorage quota doesn't pile up over time.
    const trimmed: SessionsBlob = {
      active: blob.active,
      sessions: blob.sessions
        .slice(-MAX_SESSIONS_PER_BOOK)
        .map(s => ({ ...s, messages: s.messages.slice(-200) })),
    };
    localStorage.setItem(sessionsKey(bookId), JSON.stringify(trimmed));
  } catch {
    /* quota or private mode — best-effort persistence */
  }
}

export function listSessions(bookId: string): ChatSession[] {
  // Newest first so the sidebar reads top-to-bottom by recency.
  const { sessions } = loadBlob(bookId);
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getActiveId(bookId: string): string | null {
  return loadBlob(bookId).active;
}

export function setActiveId(bookId: string, id: string | null): void {
  const blob = loadBlob(bookId);
  blob.active = id;
  saveBlob(bookId, blob);
}

export function getSession(bookId: string, id: string): ChatSession | null {
  const blob = loadBlob(bookId);
  return blob.sessions.find(s => s.id === id) ?? null;
}

export function createSession(bookId: string, title?: string): ChatSession {
  const now = Date.now();
  const session: ChatSession = {
    id: rid(),
    title: (title ?? '新对话').slice(0, MAX_TITLE_LEN),
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  const blob = loadBlob(bookId);
  blob.sessions.push(session);
  blob.active = session.id;
  saveBlob(bookId, blob);
  return session;
}

export function updateSession(
  bookId: string,
  id: string,
  patch: Partial<Pick<ChatSession, 'title' | 'messages'>>,
): ChatSession | null {
  const blob = loadBlob(bookId);
  const idx = blob.sessions.findIndex(s => s.id === id);
  if (idx < 0) return null;
  const next: ChatSession = {
    ...blob.sessions[idx],
    ...patch,
    title: patch.title !== undefined
      ? patch.title.slice(0, MAX_TITLE_LEN)
      : blob.sessions[idx].title,
    updatedAt: Date.now(),
  };
  blob.sessions[idx] = next;
  saveBlob(bookId, blob);
  return next;
}

export function deleteSession(bookId: string, id: string): void {
  const blob = loadBlob(bookId);
  blob.sessions = blob.sessions.filter(s => s.id !== id);
  if (blob.active === id) blob.active = null;
  saveBlob(bookId, blob);
}

// Derive a session title from its first user message — saves the
// user from manually labelling each conversation. Falls back to a
// timestamp if the first message is unusable.
export function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find(m => m.role === 'user');
  if (firstUser && firstUser.content.trim()) {
    const t = firstUser.content.trim().replace(/\s+/g, ' ');
    return t.length <= MAX_TITLE_LEN ? t : t.slice(0, MAX_TITLE_LEN - 1) + '…';
  }
  return new Date().toLocaleString();
}

// ─── Drafts ───────────────────────────────────────────────────────

export function loadDraft(bookId: string): string {
  try {
    return localStorage.getItem(draftKey(bookId)) ?? '';
  } catch {
    return '';
  }
}

export function saveDraft(bookId: string, value: string): void {
  try {
    if (!value) localStorage.removeItem(draftKey(bookId));
    else localStorage.setItem(draftKey(bookId), value);
  } catch {
    /* ignore */
  }
}

function rid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
