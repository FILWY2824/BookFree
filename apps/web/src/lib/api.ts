// Thin fetch wrapper that understands the Go server's
// {ok, data, error} envelope. Every API call goes through here so we
// have one place to evolve auth/CSRF/error-handling later.
//
// We deliberately keep this dependency-free — no axios, no
// react-query — because the SPA target says "small initial bundle".
// React Query may move in for cache + revalidation when we add the
// reader page, but the auth + library shell doesn't need it.

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
  errorId?: string;
}

export class ApiException extends Error {
  status: number;
  code: string;
  details?: unknown;
  errorId?: string;

  constructor(status: number, err: ApiError) {
    super(err.message);
    this.name = 'ApiException';
    this.status = status;
    this.code = err.code;
    this.details = err.details;
    this.errorId = err.errorId;
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  // For uploads: pass a Blob or ReadableStream and set rawBody=true
  // so we don't JSON.stringify it. Content-Type defaults to
  // application/octet-stream for raw bodies.
  rawBody?: boolean;
}

export async function apiRequest<T = unknown>(
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(opts.headers ?? {}),
  };

  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    if (opts.rawBody) {
      body = opts.body as BodyInit;
      if (!headers['Content-Type']) {
        headers['Content-Type'] = 'application/octet-stream';
      }
    } else {
      body = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }
  }

  const res = await fetch(path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers,
    body,
    credentials: 'same-origin',
    signal: opts.signal,
  });

  // The server should always return JSON. If it doesn't (e.g. a 504
  // from a reverse proxy), surface a synthetic envelope so the caller
  // can render a sensible error.
  let envelope: { ok: boolean; data?: T; error?: ApiError };
  try {
    envelope = await res.json();
  } catch {
    throw new ApiException(res.status, {
      code: res.ok ? 'INTERNAL' : `HTTP_${res.status}`,
      message: `请求失败：${res.status} ${res.statusText}`,
    });
  }

  if (!res.ok || envelope.ok === false) {
    throw new ApiException(res.status, envelope.error ?? {
      code: 'INTERNAL',
      message: '未知错误',
    });
  }
  return envelope.data as T;
}

// Convenience wrappers — read like the calls they replace, no need to
// remember the option-object dance for simple GETs.
export const api = {
  get:    <T>(path: string, signal?: AbortSignal) =>
    apiRequest<T>(path, { method: 'GET', signal }),
  post:   <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    apiRequest<T>(path, { method: 'POST', body, signal }),
  put:    <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    apiRequest<T>(path, { method: 'PUT', body, signal }),
  delete: <T>(path: string, signal?: AbortSignal) =>
    apiRequest<T>(path, { method: 'DELETE', signal }),

  // putRaw is for streaming uploads (PUT /api/books/upload). The
  // filename is sent as a URL query param rather than a header,
  // because HTTP headers must be ASCII (RFC 7230 §3.2.4) — non-ASCII
  // names like "红楼梦.epub" make `fetch` either throw a TypeError
  // (Chrome/Safari) or send a garbled latin-1 encoding (Firefox).
  // The server's upload handler already reads `?filename=` as a
  // fallback (see books/upload.go), so this is purely a transport fix.
  putRaw: <T>(path: string, body: Blob | ArrayBuffer, filename: string, signal?: AbortSignal) => {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${path}${sep}filename=${encodeURIComponent(filename)}`;
    return apiRequest<T>(url, {
      method: 'PUT',
      body: body as unknown,
      rawBody: true,
      headers: {
        'Content-Type': body instanceof Blob && body.type ? body.type : 'application/octet-stream',
      },
      signal,
    });
  },
};
