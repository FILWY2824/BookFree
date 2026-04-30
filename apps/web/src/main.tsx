/*
 * main.tsx 是整个前端应用的“启动入口”。
 *
 * 你可以把 React 前端理解成一个挂载到 HTML 某个节点上的程序：
 * 1. 浏览器先加载 apps/web/index.html；
 * 2. index.html 里有一个 id="root" 的空 div；
 * 3. Vite 会加载本文件；
 * 4. 本文件找到 #root，并把 <App /> 渲染进去；
 * 5. App.tsx 再负责路由、登录状态、页面组件等应用逻辑。
 *
 * 这个文件通常很少改。日常二次开发时：
 * - 想新增页面：优先改 App.tsx 的路由；
 * - 想新增全局状态：通常在 App.tsx 外层增加 Provider；
 * - 想改全局样式：看 styles.css；
 * - 想改具体页面：去 pages/ 或 components/ 目录。
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// index.html 中应当存在：<div id="root"></div>
// React 需要一个真实的 DOM 节点作为“挂载点”，后续所有页面内容都会渲染到这个节点内部。
const rootEl = document.getElementById('root');

// 如果找不到 #root，说明 index.html 结构异常，继续运行只会导致更难理解的空白页。
// 因此这里直接抛错，让开发者能在控制台看到明确原因。
if (!rootEl) throw new Error('#root missing');

// createRoot 是 React 18 的渲染入口。
// StrictMode 是 React 的开发期辅助组件：
// - 它不会在生产环境改变用户看到的页面；
// - 开发环境下会额外检查一些潜在问题；
// - 某些 useEffect 可能会被有意执行两次，用来暴露副作用写法问题。
// 如果你看到开发模式下请求或日志出现两次，先检查是不是 StrictMode 的正常行为。
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
