/*
中文导读：
DashboardChrome 是“后台/主应用布局壳子”，可以理解为页面外框。
它通常负责把 Sidebar 侧边栏和具体页面内容拼在一起，让 /library、/search、/notes 等页面保持统一布局。
这个组件不应该包含太多业务逻辑；它的职责是布局、边距、背景、响应式结构。
如果你想调整所有登录后页面的整体宽度、左右栏布局、顶部间距，优先看这个文件。
如果只想改书架页内容，不要在这里写书架业务，应去 LibraryPage。
*/

// Wraps non-reader pages with the sidebar + main column. The reader
// uses its own chrome (ReaderShell) so it can go full-bleed.

import type { ReactNode } from 'react';
import Sidebar from './Sidebar';

interface Props {
  children: ReactNode;
  title?: string;
  actions?: ReactNode;
  /** Removes the bordered card and lets children draw the surface. */
  bare?: boolean;
}

export default function DashboardChrome({ children, title, actions, bare }: Props) {
  return (
    <div className="flex h-full bg-paper-50">
      <Sidebar />
      <main className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-6 lg:px-10 py-8">
          {(title || actions) && (
            <header className="flex items-center justify-between mb-6">
              {title && <h1 className="text-2xl font-serif text-ink-800">{title}</h1>}
              {actions && <div className="flex items-center gap-2">{actions}</div>}
            </header>
          )}
          {bare ? children : (
            <div className="bg-white border border-paper-300/70 rounded-2xl shadow-card p-6">
              {children}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
