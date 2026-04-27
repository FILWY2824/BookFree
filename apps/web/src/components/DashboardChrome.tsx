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
