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
export async function isAIConfigured(): Promise<boolean> {
  try {
    const r = await apiRequest<{ configured: boolean }>('/api/ai/status');
    return !!r.configured;
  } catch (e) {
    if (e instanceof ApiException && e.status === 404) {
      // Endpoint not deployed — treat as unconfigured rather than
      // surfacing a confusing 404 to the user.
      return false;
    }
    return false;
  }
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
