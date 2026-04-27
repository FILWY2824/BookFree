// Settings page. Account-side: shows the current user, role, and
// log-out. Reader-side: the same preferences the in-reader drawer
// edits, but available outside the reader.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import DashboardChrome from '../components/DashboardChrome';
import SettingsDrawer from '../components/SettingsDrawer';
import { loadPrefs, savePrefs, type ReaderPrefs } from '../lib/prefs';

export default function SettingsPage() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const [prefs, setPrefs] = useState<ReaderPrefs>(() => loadPrefs());
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => savePrefs(prefs), [prefs]);

  async function logout() {
    await api.post('/api/auth/logout').catch(() => {});
    await refresh();
    navigate('/login', { replace: true });
  }

  return (
    <DashboardChrome title="设置">
      <Section title="账户">
        {user ? (
          <>
            <Row label="邮箱" value={user.email} />
            <Row label="姓名" value={user.name || '—'} />
            <Row label="角色" value={user.role || 'user'} />
            <button
              onClick={logout}
              className="mt-4 px-4 py-2 rounded-lg border border-paper-300 text-ink-700 hover:bg-paper-100 text-sm"
            >
              退出登录
            </button>
          </>
        ) : <div className="text-ink-500">未登录</div>}
      </Section>

      <Section title="阅读偏好">
        <div className="text-sm text-ink-700">
          当前主题：<span className="font-medium">{prefs.theme}</span> · 字号 {prefs.fontSize}px · 行距 {prefs.lineHeight.toFixed(2)}
        </div>
        <button
          onClick={() => setDrawerOpen(true)}
          className="mt-3 px-4 py-2 rounded-lg bg-accent text-white text-sm hover:bg-accent-dark"
        >
          打开阅读偏好设置
        </button>
      </Section>

      <SettingsDrawer
        open={drawerOpen}
        prefs={prefs}
        onChange={setPrefs}
        onClose={() => setDrawerOpen(false)}
      />
    </DashboardChrome>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-sm font-medium text-ink-700 uppercase tracking-wide mb-3">{title}</h2>
      {children}
    </section>
  );
}
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-paper-200 last:border-0">
      <span className="text-sm text-ink-500">{label}</span>
      <span className="text-sm text-ink-800">{value}</span>
    </div>
  );
}
