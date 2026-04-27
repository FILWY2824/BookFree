// Sidebar — fixed-width nav rail. Mirrors the reference design's
// vertical column with logo, primary nav, and the user/sign-out at
// the bottom. Active route gets the accent stripe + tinted bg.

import { NavLink, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import Logo from './Logo';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
}

const ICON_LIB = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
  </svg>
);
const ICON_SEARCH = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);
const ICON_NOTES = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="9" y1="13" x2="15" y2="13" />
    <line x1="9" y1="17" x2="13" y2="17" />
  </svg>
);
const ICON_STATS = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="20" x2="12" y2="10" />
    <line x1="18" y1="20" x2="18" y2="4" />
    <line x1="6"  y1="20" x2="6"  y2="14" />
  </svg>
);
const ICON_SETTINGS = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
  </svg>
);

const NAV: NavItem[] = [
  { to: '/library',  label: '书架',     icon: ICON_LIB },
  { to: '/search',   label: '全文搜索', icon: ICON_SEARCH },
  { to: '/notes',    label: '笔记',     icon: ICON_NOTES },
  { to: '/stats',    label: '统计',     icon: ICON_STATS },
  { to: '/settings', label: '设置',     icon: ICON_SETTINGS },
];

export default function Sidebar() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();

  async function logout() {
    try {
      await api.post('/api/auth/logout');
    } catch {
      /* ignore */
    }
    await refresh();
    navigate('/login', { replace: true });
  }

  return (
    <aside className="hidden md:flex w-60 shrink-0 flex-col bg-paper-100 border-r border-paper-300/60">
      <div className="px-5 pt-6 pb-5 text-ink-700">
        <Logo />
      </div>

      <nav className="px-3 flex-1">
        <ul className="space-y-1">
          {NAV.map(item => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                className={({ isActive }) =>
                  [
                    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                    isActive
                      ? 'bg-accent/10 text-accent-dark font-medium'
                      : 'text-ink-600 hover:bg-paper-200/60 hover:text-ink-800',
                  ].join(' ')
                }
              >
                <span className="text-current">{item.icon}</span>
                <span>{item.label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="border-t border-paper-300/60 p-3 text-sm">
        {user && (
          <div className="px-2 py-1.5">
            <div className="font-medium text-ink-800 truncate" title={user.email}>
              {user.name || user.email}
            </div>
            <div className="text-xs text-ink-500 truncate">{user.email}</div>
          </div>
        )}
        <button
          onClick={logout}
          className="mt-2 w-full text-left rounded-lg px-3 py-2 text-sm text-ink-600 hover:bg-paper-200/60 hover:text-ink-800"
        >
          退出登录
        </button>
      </div>
    </aside>
  );
}
