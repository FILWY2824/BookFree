/*
中文导读：
ai.ts 是前端 AI 功能的接口封装层。
页面或组件不应该到处手写 fetch('/api/ai/...')，而是通过这里统一调用。
这样未来如果后端接口路径、请求字段、错误格式发生变化，只需要集中修改这里。
如果你要新增 AI 功能，例如“总结当前章节”“解释选中文本”“生成读书卡片”，通常先在后端加接口，再在这里加对应函数，最后给页面调用。
*/

// AI client. Talks to the server's /api/ai/chat endpoint.
//
// The server is responsible for holding the API key (env var or per-
// user provider profile, see migration 0007). We just send messages
// and optional context, and parse the JSON envelope.
//
// We try a streaming endpoint first — the user sees tokens arriving
// in real time, which makes the UI feel an order of magnitude faster.
// If the server doesn't support streaming we fall back to the plain
// non-streaming response.

import { ApiException, apiRequest } from './api';

export interface AIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AIChatRequest {
  bookId?: string;
  chapterId?: string | null;
  /** Optional excerpt the user wants the model to focus on (e.g. the
   *  current selection). When set, the server prepends it to the user
   *  message in a clearly-labelled block so the model doesn't have to
   *  guess what's being asked about. */
  excerpt?: string | null;
  /** When set, route to a user-imported AI provider profile instead
   *  of the server's built-in proxy. Server resolves this against
   *  ai_provider_profiles scoped to the current user. */
  providerId?: string;
  messages: AIMessage[];
}

export interface AIChatResponse {
  message: AIMessage;
  /** When the server didn't have an API key configured (or some other
   *  graceful failure), we surface this as `notConfigured` so the UI
   *  can render a helpful explanation. */
  notConfigured?: boolean;
  errorMessage?: string;
}

// Check whether the server has any AI provider configured. We use this
// once on AI panel mount to decide which empty state to show.
//
// "Configured" = at least one of:
//   • the server's built-in AI (env var) is reachable and the user
//     hasn't been quota-blocked, OR
//   • the user has imported their own provider profile that's enabled
//     and has a stored API key.
//
// We probe both surfaces in parallel because the built-in /api/ai/status
// only knows about the server-side env var: a user who has only their
// own custom provider would otherwise see "AI not configured" on the
// reader panel even though their key works fine in /api/ai/chat. The
// previous version of this function had exactly that bug, which is
// what the user described as "I configured my own key but it doesn't
// detect anything".
export async function isAIConfigured(): Promise<boolean> {
  const result = await getAIAvailability();
  return result.builtin || result.providers.some(p => p.enabled && p.hasKey);
}

export interface ProviderSummary {
  id: string;
  label: string;
  enabled: boolean;
  hasKey: boolean;
  isDefault: boolean;
}

export interface AIAvailability {
  /** Whether the server's built-in AI is configured AND the caller is
   *  permitted to use it (quota / per-user toggle). */
  builtin: boolean;
  /** All custom provider profiles owned by the current user. */
  providers: ProviderSummary[];
  /** The provider id we recommend the UI default to. Picks the user's
   *  marked-default custom provider if it has a key, else the first
   *  enabled custom provider with a key, else '' for built-in. */
  defaultProviderId: string;
}

export async function getAIAvailability(): Promise<AIAvailability> {
  // Both endpoints are independent; if one 404s the other can still
  // give us useful information.
  const [statusRes, providersRes] = await Promise.all([
    apiRequest<{ configured: boolean }>('/api/ai/status').catch((e) => {
      if (e instanceof ApiException) return { configured: false };
      return { configured: false };
    }),
    apiRequest<{ providers: ProviderSummary[] }>('/api/ai/providers').catch((e) => {
      if (e instanceof ApiException) return { providers: [] as ProviderSummary[] };
      return { providers: [] as ProviderSummary[] };
    }),
  ]);
  const providers = providersRes.providers ?? [];
  // Pick a sensible default: explicit `isDefault` wins, then first
  // enabled-with-key, then fall back to built-in.
  const explicitDefault = providers.find(p => p.isDefault && p.enabled && p.hasKey);
  const firstUsable = providers.find(p => p.enabled && p.hasKey);
  const defaultProviderId = explicitDefault?.id
    ?? (statusRes.configured ? '' : (firstUsable?.id ?? ''));
  return {
    builtin: !!statusRes.configured,
    providers,
    defaultProviderId,
  };
}

// Non-streaming chat call. Always tries first, because if the server
// hasn't been built with the AI handler we want to learn about it
// without leaving an SSE connection hanging.
export async function chat(req: AIChatRequest): Promise<AIChatResponse> {
  try {
    const r = await apiRequest<AIChatResponse>('/api/ai/chat', { method: 'POST', body: req });
    return r;
  } catch (e) {
    if (e instanceof ApiException) {
      if (e.status === 404) {
        return {
          message: { role: 'assistant', content: '' },
          notConfigured: true,
          errorMessage: '服务器还没有部署 AI 接口（/api/ai/chat 不存在）。',
        };
      }
      if (e.status === 501 || e.code === 'NOT_CONFIGURED') {
        return {
          message: { role: 'assistant', content: '' },
          notConfigured: true,
          errorMessage: e.message || '服务器尚未配置 AI 提供商。',
        };
      }
      return {
        message: { role: 'assistant', content: '' },
        errorMessage: e.message,
      };
    }
    return {
      message: { role: 'assistant', content: '' },
      errorMessage: (e as Error).message ?? '请求失败',
    };
  }
}

// ─── Streaming chat ────────────────────────────────────────────────

export interface CitationFromServer {
  id: string;
  bookId: string;
  bookTitle: string;
  chapterId?: string | null;
  chapterTitle?: string | null;
  snippet: string;
}

export interface StreamChatOptions {
  bookId?: string;
  providerId?: string;
  excerpt?: string | null;
  messages: AIMessage[];
  signal?: AbortSignal;
  /** Called once at the start of the stream with the citations the
   *  server retrieved. Empty array if retrieval was not performed
   *  (e.g. no book scope). */
  onCitations?: (citations: CitationFromServer[]) => void;
  /** Called for each text delta. */
  onChunk: (delta: string) => void;
}

/**
 * Stream a chat response via SSE.
 *
 * Wire format (one event per line group, terminated by blank line):
 *
 *   event: citations
 *   data: [{...}, {...}]
 *
 *   event: delta
 *   data: { "text": "..." }
 *
 *   event: done
 *   data: {}
 *
 *   event: error
 *   data: { "message": "..." }
 *
 * The default event ('message' in EventSource terms) is unused — every
 * frame is named explicitly so we can route without inspecting payload.
 *
 * Why we don't use EventSource: it can't send a POST body, and we need
 * to send the chat request as JSON. Manual fetch + ReadableStream gives
 * us SSE semantics with a body.
 */
export async function streamChat(opts: StreamChatOptions): Promise<void> {
  const body = {
    bookId: opts.bookId,
    providerId: opts.providerId,
    excerpt: opts.excerpt,
    messages: opts.messages,
    stream: true,
  };
  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    credentials: 'same-origin',
    signal: opts.signal,
  });

  if (!res.ok) {
    // The server might have responded JSON (validation/auth error).
    // Try to surface its message; otherwise give a generic one.
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error?.message) msg = j.error.message;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  if (!res.body) {
    throw new Error('服务器没有返回流');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';

  // SSE frames are separated by a blank line. We accumulate in `buf`
  // until we see "\n\n", then parse the headers / data lines.
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep = buf.indexOf('\n\n');
    while (sep !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      handleSseFrame(frame, opts);
      sep = buf.indexOf('\n\n');
    }
  }
  if (buf.trim().length > 0) handleSseFrame(buf, opts);
}

function handleSseFrame(frame: string, opts: StreamChatOptions): void {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
    // ignore id:, retry:, comments
  }
  if (dataLines.length === 0) return;
  const data = dataLines.join('\n');

  switch (event) {
    case 'citations': {
      try {
        const cits = JSON.parse(data) as CitationFromServer[];
        opts.onCitations?.(cits);
      } catch { /* ignore malformed frame */ }
      break;
    }
    case 'delta': {
      try {
        const j = JSON.parse(data) as { text?: string };
        if (j.text) opts.onChunk(j.text);
      } catch { /* ignore */ }
      break;
    }
    case 'error': {
      try {
        const j = JSON.parse(data) as { message?: string };
        throw new Error(j.message ?? '上游错误');
      } catch (e) {
        if (e instanceof Error) throw e;
        throw new Error('上游错误');
      }
    }
    case 'done':
      break;
    default:
      break;
  }
}
