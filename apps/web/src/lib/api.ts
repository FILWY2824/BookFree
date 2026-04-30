/*
 * lib/api.ts 是前端访问后端 API 的统一入口。
 *
 * 为什么要有这个文件？
 * - 如果每个页面都直接写 fetch('/api/xxx')，错误处理、登录 Cookie、JSON 解析会散落到各处；
 * - 这个文件把“请求如何发出、响应如何解析、错误如何抛出”统一封装；
 * - 以后如果要加 CSRF、防重复提交、刷新登录态、全局错误上报，只需要优先改这里。
 *
 * 本项目后端所有 JSON API 都约定返回同一种“信封”结构：
 *
 * 成功：
 *   { "ok": true, "data": { ... }, "error": null }
 *
 * 失败：
 *   { "ok": false, "data": null, "error": { "code": "...", "message": "..." } }
 *
 * apiRequest 会读取这个信封：
 * - ok=true 时返回 data；
 * - ok=false 或 HTTP 状态码非 2xx 时抛出 ApiException。
 *
 * 对初学者来说，页面里通常不需要直接用 fetch，只用下面的 api.get/api.post/api.put/api.delete 即可。
 */

// 后端 error 字段的 TypeScript 类型。
// interface 是 TypeScript 的“对象形状声明”：它只在开发/编译阶段帮助检查，不会出现在浏览器运行时代码中。
export interface ApiError {
  // 机器可读的错误码，例如 UNAUTHORIZED、VALIDATION、INTERNAL。
  // 前端可以根据 code 判断要不要跳登录页、显示表单错误等。
  code: string;

  // 给用户或开发者看的错误信息。
  message: string;

  // 可选的详细信息，常用于字段校验错误。
  details?: unknown;

  // 可选的错误编号。后端遇到内部错误时会生成 errorId，方便管理员查日志。
  errorId?: string;
}

/*
 * ApiException 是自定义异常类。
 *
 * JS/TS 中可以 throw 任意值，但统一 throw Error 子类更利于捕获和调试。
 * 页面代码 catch (e) 后可以判断：
 *
 *   if (e instanceof ApiException && e.status === 401) { ... }
 *
 * 这样就能拿到 HTTP 状态码、业务错误码、详细信息等。
 */
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

// apiRequest 支持的参数。
// 这里封装成对象，是为了后续扩展 signal、headers、rawBody 时不破坏已有调用。
export interface RequestOptions {
  // HTTP 方法：GET / POST / PUT / DELETE 等。
  method?: string;

  // 请求体。普通 JSON 请求传对象即可；上传文件时传 Blob/ArrayBuffer。
  body?: unknown;

  // AbortSignal 用来取消请求。
  // 典型场景：组件卸载了、搜索框输入变化了，就取消旧请求，避免旧结果覆盖新结果。
  signal?: AbortSignal;

  // 自定义请求头。
  headers?: Record<string, string>;

  /*
   * rawBody 用于文件上传等“原始二进制请求体”。
   *
   * 普通接口：
   * - body 是对象；
   * - apiRequest 会 JSON.stringify；
   * - Content-Type 是 application/json。
   *
   * 上传接口：
   * - body 是 Blob/ArrayBuffer；
   * - 不能 JSON.stringify；
   * - rawBody=true 表示按原样发送。
   */
  rawBody?: boolean;
}

/*
 * apiRequest 是所有 API 请求的底层实现。
 *
 * 泛型 <T> 表示“成功时 data 的类型”。
 * 例如：
 *   api.get<{ books: BookCardData[] }>('/api/books')
 *
 * 表示后端成功返回的 data 里应该有 books 字段，而且 books 是 BookCardData[]。
 */
export async function apiRequest<T = unknown>(
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  // 默认声明前端希望后端返回 JSON。
  // opts.headers 放在后面展开，表示调用方传入的 header 可以覆盖默认值。
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(opts.headers ?? {}),
  };

  let body: BodyInit | undefined;

  // 只有传了 body 才设置请求体。
  if (opts.body !== undefined) {
    if (opts.rawBody) {
      // 文件上传等场景：直接把 Blob/ArrayBuffer 交给 fetch。
      body = opts.body as BodyInit;
      if (!headers['Content-Type']) {
        headers['Content-Type'] = 'application/octet-stream';
      }
    } else {
      // 普通业务接口：把 JS 对象转成 JSON 字符串。
      body = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }
  }

  const res = await fetch(path, {
    // 如果调用方没有显式传 method：
    // - 有 body 默认用 POST；
    // - 没 body 默认用 GET。
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers,
    body,

    /*
     * credentials: 'same-origin' 的意思是：
     * 同源请求会自动携带 Cookie。
     *
     * 本项目登录态是后端设置的 session cookie，不是前端自己保存 token。
     * 所以这里必须保留，否则 /api/auth/me、/api/books 等接口会认为你未登录。
     */
    credentials: 'same-origin',
    signal: opts.signal,
  });

  /*
   * 后端理论上总是返回 JSON 信封。
   * 但真实部署中，反向代理、网关或浏览器扩展可能返回非 JSON 错误页。
   * 如果 res.json() 解析失败，这里把它转换成统一的 ApiException，页面就不用处理两套错误格式。
   */
  let envelope: { ok: boolean; data?: T; error?: ApiError };
  try {
    envelope = await res.json();
  } catch {
    throw new ApiException(res.status, {
      code: res.ok ? 'INTERNAL' : `HTTP_${res.status}`,
      message: `请求失败：${res.status} ${res.statusText}`,
    });
  }

  // HTTP 非 2xx 或业务信封 ok=false，都统一视为失败。
  if (!res.ok || envelope.ok === false) {
    throw new ApiException(res.status, envelope.error ?? {
      code: 'INTERNAL',
      message: '未知错误',
    });
  }

  // 成功时只把 data 返回给页面，页面无需关心 {ok, error} 外壳。
  return envelope.data as T;
}

/*
 * 便捷方法集合。
 *
 * 页面中推荐这样写：
 *   const data = await api.get<{ books: BookCardData[] }>('/api/books');
 *
 * 而不是每次都写：
 *   apiRequest('/api/books', { method: 'GET' })
 */
export const api = {
  get: <T>(path: string, signal?: AbortSignal) =>
    apiRequest<T>(path, { method: 'GET', signal }),

  post: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    apiRequest<T>(path, { method: 'POST', body, signal }),

  put: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    apiRequest<T>(path, { method: 'PUT', body, signal }),

  delete: <T>(path: string, signal?: AbortSignal) =>
    apiRequest<T>(path, { method: 'DELETE', signal }),

  /*
   * putRaw 专门用于上传文件：PUT /api/books/upload。
   *
   * 注意 filename 放在 URL 查询参数里，而不是 HTTP header 里。
   * 原因：
   * - HTTP header 对非 ASCII 字符支持很麻烦；
   * - 像 “红楼梦.epub” 这样的中文文件名可能让浏览器抛错或乱码；
   * - URL 查询参数可以安全 encodeURIComponent。
   */
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
