/*
 * App.tsx 是前端应用的“总装配文件”。
 *
 * 对初学者来说，可以先把它理解成三件事：
 *
 * 1. 放全局 Provider：
 *    Provider 是 React 里向整棵组件树提供能力的组件。
 *    例如 AuthProvider 提供“当前用户 / 登录 / 退出”等能力，
 *    ToastProvider 提供“弹出成功或失败提示”的能力。
 *
 * 2. 配置前端路由：
 *    路由就是“浏览器地址栏路径”和“要显示哪个页面组件”的对应关系。
 *    例如 /library 显示 LibraryPage，/book/:id 显示 ReaderPage。
 *
 * 3. 决定哪些页面需要登录：
 *    被 <AuthGuard> 包住的页面需要登录后才能访问。
 *    未登录访问这些页面时，会被 AuthGuard 重定向到 /login。
 *
 * 如果你以后想新增一个页面，通常步骤是：
 * 1. 在 apps/web/src/pages/ 下新建 XxxPage.tsx；
 * 2. 在本文件 import 这个页面；
 * 3. 在 <Routes> 里新增一行 <Route path="/xxx" element={...} />；
 * 4. 如果这个页面需要登录，就用 <AuthGuard> 包起来。
 */

import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './lib/auth';
import { AuthGuard } from './lib/AuthGuard';
import { ToastProvider } from './components/Toast';

import LoginPage from './pages/LoginPage';
import LibraryPage from './pages/LibraryPage';
import ReaderPage from './pages/ReaderPage';
import SearchPage from './pages/SearchPage';
import NotesPage from './pages/NotesPage';
import StatsPage from './pages/StatsPage';
import SettingsPage from './pages/SettingsPage';
import AIChatPage from './pages/AIChatPage';

/*
 * 当前前端路由清单：
 *
 *   /             → 自动跳转到 /library
 *   /login        → 登录/注册页，公开页面，不需要登录
 *   /library      → 书架页，展示书籍卡片和上传入口，需要登录
 *   /book/:id     → 阅读页，:id 是动态参数，例如 /book/abc123，需要登录
 *   /search       → 全文搜索页，需要登录
 *   /notes        → 笔记与高亮汇总页，需要登录
 *   /ai           → AI 对话页，需要登录
 *   /stats        → 阅读统计页，需要登录
 *   /settings     → 设置页，需要登录
 *
 * 注意：
 * - 这里的路由是“前端路由”，不会导致浏览器重新加载整个页面；
 * - React Router 会根据 URL 在页面内部切换组件；
 * - 后端需要配合把未知路径都返回前端 index.html，这样刷新 /book/:id 才不会 404。
 */
export function App() {
  return (
    /*
     * AuthProvider 放在最外层之一，表示其内部所有页面和组件都能通过 useAuth()
     * 读取登录用户、调用 login/logout/register/refresh。
     */
    <AuthProvider>
      {/*
       * ToastProvider 提供全局消息提示能力。
       * 例如上传成功、删除失败等提示，不需要每个页面自己重复写弹窗系统。
       */}
      <ToastProvider>
        {/*
         * BrowserRouter 启用浏览器 history 路由。
         * 它会监听地址栏变化，并让 <Routes> 匹配当前路径。
         */}
        <BrowserRouter>
          {/*
           * Routes 内部放一组 Route。
           * React Router 会从这些 Route 中找出和当前 URL 匹配的一项来渲染。
           */}
          <Routes>
            {/*
             * 访问根路径 / 时，直接跳转到 /library。
             * replace 表示替换当前历史记录，避免用户按“后退”又回到 / 再次跳转。
             */}
            <Route path="/" element={<Navigate to="/library" replace />} />

            {/* 登录页是公开页面，不需要 AuthGuard。 */}
            <Route path="/login" element={<LoginPage />} />

            {/*
             * 下面这些页面都被 AuthGuard 包住，表示必须登录。
             * AuthGuard 会先检查当前登录状态：
             * - 正在检查时显示“加载中”；
             * - 未登录时跳到 /login；
             * - 已登录时才真正渲染内部页面。
             */}
            <Route
              path="/library"
              element={
                <AuthGuard>
                  <LibraryPage />
                </AuthGuard>
              }
            />
            <Route
              path="/book/:id"
              element={
                <AuthGuard>
                  <ReaderPage />
                </AuthGuard>
              }
            />
            <Route
              path="/search"
              element={
                <AuthGuard>
                  <SearchPage />
                </AuthGuard>
              }
            />
            <Route
              path="/notes"
              element={
                <AuthGuard>
                  <NotesPage />
                </AuthGuard>
              }
            />
            <Route
              path="/ai"
              element={
                <AuthGuard>
                  <AIChatPage />
                </AuthGuard>
              }
            />
            <Route
              path="/stats"
              element={
                <AuthGuard>
                  <StatsPage />
                </AuthGuard>
              }
            />
            <Route
              path="/settings"
              element={
                <AuthGuard>
                  <SettingsPage />
                </AuthGuard>
              }
            />

            {/*
             * 兜底路由：如果用户访问了前端未定义的路径，例如 /abc，
             * 就跳回 /library，避免出现空白页。
             */}
            <Route path="*" element={<Navigate to="/library" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  );
}
