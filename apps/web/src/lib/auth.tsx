/*
 * lib/auth.tsx 负责“前端登录状态管理”。
 *
 * 在这个项目里，登录态不是存在 localStorage 里的 token，
 * 而是由后端通过 Cookie 保存 session。前端只需要：
 *
 * 1. 启动时请求 /api/auth/me，看看当前 Cookie 是否对应一个已登录用户；
 * 2. 登录成功后把用户信息保存到 React state；
 * 3. 退出登录后清空用户信息；
 * 4. 通过 React Context 把这些能力提供给任意页面组件。
 *
 * 对初学者来说，可以这样理解：
 * - api.ts：负责“怎么发请求”；
 * - auth.tsx：负责“当前是谁登录、怎么登录/注册/退出”；
 * - AuthGuard.tsx：负责“没登录时不让访问某些页面”。
 */

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiException } from './api';

/*
 * User 表示当前登录用户的数据结构。
 *
 * 这个类型要和后端返回的 JSON 字段保持一致。
 * 后端来源通常是 server/internal/models/types.go 里的 User 结构体。
 *
 * 注意：
 * - TypeScript 的 interface 只用于开发时类型检查；
 * - 浏览器运行时不会真的存在这个 interface；
 * - 如果后端字段改名，前端这里也要同步改，否则页面可能拿不到数据。
 */
export interface User {
  // 用户唯一 ID。前端通常用于请求、列表 key、权限判断等。
  id: string;

  // 登录邮箱。
  email: string;

  // 用户显示名称。
  name: string;

  // 头像地址，可选字段。问号 ? 表示后端可能不返回这个字段。
  avatarUrl?: string;

  // 用户角色：admin 通常拥有管理权限，user 是普通用户。
  role: 'user' | 'admin';

  // 用户状态。被 suspended 或 deleted 的用户通常不应继续正常使用系统。
  status: 'active' | 'suspended' | 'deleted';

  // 是否允许使用系统内置 AI 能力。
  // 这个字段可以让后端按用户控制 AI 额度或权限。
  canUseSystemAi: boolean;

  // 创建时间。这里用 number，通常对应 Unix 时间戳。
  createdAt: number;

  // 更新时间。后端更新用户资料或状态时会变化。
  updatedAt: number;
}

/*
 * AuthState 是整个认证上下文暴露给页面的能力清单。
 *
 * 任意位于 <AuthProvider> 内部的组件，都可以通过 useAuth() 拿到这些值：
 *
 *   const { user, loading, login, logout } = useAuth();
 *
 * 这样页面组件就不需要自己重复写“请求 /api/auth/me、保存用户状态”的逻辑。
 */
interface AuthState {
  /*
   * 当前用户。
   *
   * - User 对象：已经登录；
   * - null：未登录，或者登录态检查失败。
   */
  user: User | null;

  /*
   * 是否正在检查登录状态。
   *
   * 应用刚打开时，前端还不知道浏览器 Cookie 是否有效，
   * 需要先请求 /api/auth/me。
   *
   * 这个状态很重要：AuthGuard 会在 loading=true 时显示“加载中”，
   * 而不是立刻跳转到 /login，避免刷新已登录页面时闪退到登录页。
   */
  loading: boolean;

  // 重新向后端确认当前登录用户。常用于页面初始化或资料变更后刷新用户信息。
  refresh: () => Promise<void>;

  // 登录：成功后后端会设置 session cookie，前端保存返回的 user。
  login: (email: string, password: string) => Promise<User>;

  // 注册：成功后通常也会直接登录，前端保存返回的 user。
  register: (email: string, password: string, name: string) => Promise<User>;

  // 退出登录：通知后端清除 session，同时前端清空 user。
  logout: () => Promise<void>;
}

/*
 * React Context 可以理解成“组件树里的全局变量通道”。
 *
 * 为什么不用普通全局变量？
 * - 普通变量变化时 React 不会自动重新渲染页面；
 * - Context 内的 state 更新后，使用 useAuth() 的组件会自动重新渲染；
 * - 这样登录/退出后，导航栏、页面守卫、用户信息都能立即更新。
 *
 * 初始值为 null，是为了在 useAuth() 中检查是否忘记包 <AuthProvider>。
 */
const AuthContext = createContext<AuthState | null>(null);

/*
 * AuthProvider 是认证系统的“提供者组件”。
 *
 * App.tsx 会把整个应用包在 <AuthProvider> 里面，
 * 因此所有页面都能通过 useAuth() 访问登录状态。
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  // 保存当前用户。初始为 null，因为刚打开页面时还不知道是否登录。
  const [user, setUser] = useState<User | null>(null);

  // 保存“是否正在检查登录态”。初始为 true，因为应用启动后马上会请求 /api/auth/me。
  const [loading, setLoading] = useState(true);

  /*
   * refresh 用来向后端确认“当前浏览器 Cookie 对应哪个用户”。
   *
   * useCallback 的作用：
   * - 让 refresh 函数在依赖不变时保持同一个引用；
   * - 这样下面 useEffect([refresh]) 不会因为每次渲染都创建新函数而重复执行。
   */
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      /*
       * GET /api/auth/me：
       * - 如果 Cookie 有效，后端返回 { user: ... }；
       * - 如果未登录，后端返回 401。
       *
       * api.get 的泛型 <{ user: User }> 告诉 TypeScript：
       * 这个接口成功时 data 的形状应该是 { user: User }。
       */
      const data = await api.get<{ user: User }>('/api/auth/me');
      setUser(data.user);
    } catch (err) {
      /*
       * 401 对 /api/auth/me 来说不是程序异常，而是“游客/未登录”的正常状态。
       *
       * 所以：
       * - 401：静默处理，不打扰用户；
       * - 其他错误：打印到控制台，方便开发者排查网络、后端或配置问题。
       */
      if (!(err instanceof ApiException) || err.status !== 401) {
        console.warn('auth.refresh', err);
      }
      setUser(null);
    } finally {
      // 无论成功还是失败，都表示“登录态检查结束”。
      setLoading(false);
    }
  }, []);

  /*
   * 应用启动时自动检查一次登录态。
   *
   * useEffect 会在组件挂载后执行。
   * void refresh() 的意思是：调用这个 async 函数，但这里不等待返回值。
   *
   * 注意：
   * 在 React StrictMode 的开发模式下，这个 effect 可能被执行两次，
   * 这是 React 用来暴露副作用问题的开发期行为，生产构建不会这样重复。
   */
  useEffect(() => { void refresh(); }, [refresh]);

  /*
   * login 调用后端登录接口。
   *
   * 成功时：
   * 1. 后端验证邮箱和密码；
   * 2. 后端写入 session，并通过 Set-Cookie 设置浏览器 Cookie；
   * 3. 前端收到 user，更新本地状态；
   * 4. 使用 useAuth() 的组件会重新渲染。
   */
  const login = useCallback(async (email: string, password: string) => {
    const data = await api.post<{ user: User }>('/api/auth/login', { email, password });
    setUser(data.user);
    return data.user;
  }, []);

  /*
   * register 调用后端注册接口。
   *
   * 本项目前端注册成功后也会把 user 设置到上下文中，
   * 因此注册成功通常等同于“已登录”。
   */
  const register = useCallback(async (email: string, password: string, name: string) => {
    const data = await api.post<{ user: User }>('/api/auth/register', { email, password, name });
    setUser(data.user);
    return data.user;
  }, []);

  /*
   * logout 退出登录。
   *
   * 这里即使后端 /api/auth/logout 请求失败，也会清空前端 user。
   * 原因：
   * - 用户点击退出后，前端应该尽量回到未登录状态；
   * - 如果只是网络瞬断，继续保留 user 反而会让界面看起来仍然登录；
   * - 后续访问受保护 API 时，后端仍会根据真实 Cookie 判断权限。
   */
  const logout = useCallback(async () => {
    try { await api.post('/api/auth/logout'); } catch { /* ignore */ }
    setUser(null);
  }, []);

  /*
   * Provider 的 value 就是要共享给整棵子组件树的认证状态和方法。
   *
   * children 是 App.tsx 中包裹在 <AuthProvider> 内部的所有内容，
   * 包括 ToastProvider、BrowserRouter、所有页面等。
   */
  return (
    <AuthContext.Provider value={{ user, loading, refresh, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

/*
 * useAuth 是读取认证上下文的自定义 Hook。
 *
 * 页面里通常这样使用：
 *
 *   const { user, logout } = useAuth();
 *
 * 为什么要封装这个函数，而不是每次都直接 useContext(AuthContext)？
 * - 可以集中处理“没有包 AuthProvider”的错误；
 * - 调用方拿到的一定是 AuthState，不需要反复判断 null；
 * - 代码更短、更易读。
 */
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
