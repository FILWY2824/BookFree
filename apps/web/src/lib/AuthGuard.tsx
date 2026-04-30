/*
 * AuthGuard.tsx 是“登录保护组件”。
 *
 * 它不负责真正登录，也不负责请求后端。
 * 它只做一件事：判断当前用户是否可以访问某个页面。
 *
 * 在 App.tsx 中你会看到类似写法：
 *
 *   <AuthGuard>
 *     <LibraryPage />
 *   </AuthGuard>
 *
 * 这表示 LibraryPage 是受保护页面：
 * - 正在检查登录态：先显示加载中；
 * - 未登录：跳转到 /login；
 * - 已登录：渲染 LibraryPage。
 *
 * 这种写法的好处是：
 * - 每个页面不用重复写“没登录就跳转”的代码；
 * - 以后新增需要登录的页面，只要用 AuthGuard 包起来即可；
 * - 登录逻辑集中在 auth.tsx，路由保护逻辑集中在这里。
 */

import { type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './auth';

export function AuthGuard({ children }: { children: ReactNode }) {
  /*
   * useAuth() 从 AuthProvider 中读取当前登录状态。
   *
   * user:
   * - 有值：已登录；
   * - null：未登录。
   *
   * loading:
   * - true：前端正在请求 /api/auth/me，还不能确定用户是否登录；
   * - false：检查结束，可以做跳转或渲染判断。
   */
  const { user, loading } = useAuth();

  /*
   * location 表示用户当前访问的地址。
   *
   * 例如用户直接打开 /book/abc123：
   * - 未登录时会跳到 /login；
   * - state={{ from: location }} 会把原本想去的 /book/abc123 记录下来；
   * - 登录页可以读取这个 state，在登录成功后跳回原目标页面。
   */
  const location = useLocation();

  if (loading) {
    return (
      <div style={{ padding: '4rem', textAlign: 'center', color: '#666' }}>
        加载中…
      </div>
    );
  }
  /*
   * loading=true 时不能立刻跳转到 /login。
   *
   * 原因：
   * 刷新 /library 这种受保护页面时，浏览器 Cookie 其实可能是有效的，
   * 只是 /api/auth/me 还没返回。如果此时立刻判断 user=null 并跳登录页，
   * 用户就会遇到“明明已登录，刷新却被踢回登录页”的问题。
   */
  if (!user) {
    /*
     * Navigate 是 React Router 的重定向组件。
     *
     * replace:
     * - 表示用 /login 替换当前历史记录；
     * - 用户登录后按浏览器后退，不会回到这个被拦截的页面再跳一次。
     *
     * state:
     * - 把原始目标页面传给登录页；
     * - 便于登录成功后回到用户本来想访问的位置。
     */
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  /*
   * 走到这里说明：
   * - 登录态检查已经结束；
   * - user 存在；
   * - 可以安全渲染受保护页面。
   *
   * <>{children}</> 是 React Fragment，表示不额外生成 DOM 节点，只原样返回子组件。
   */
  return <>{children}</>;
}
