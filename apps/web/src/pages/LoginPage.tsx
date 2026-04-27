// Login & register form. The two modes share most of the same fields;
// we just toggle a flag rather than introduce two pages.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiException } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import Logo from '../components/Logo';

interface AuthResp {
  user: { id: string; email: string; name?: string };
}

export default function LoginPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const { toast } = useToast();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const path = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const body: Record<string, string> = { email: email.trim(), password };
      if (mode === 'register') body.name = name.trim();
      await api.post<AuthResp>(path, body);
      await refresh();
      toast.success(mode === 'login' ? '欢迎回来' : '账户已创建');
      navigate('/library', { replace: true });
    } catch (err) {
      const m = err instanceof ApiException ? err.message : (err as Error).message;
      setError(m);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-paper-50 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8 text-ink-700">
          <Logo size={36} />
          <p className="text-sm text-ink-500 mt-3">你的私有书房</p>
        </div>
        <form
          onSubmit={submit}
          className="bg-white rounded-2xl shadow-card border border-paper-300/70 p-6"
        >
          <h2 className="font-serif text-xl text-ink-800 mb-5">
            {mode === 'login' ? '登录' : '创建账户'}
          </h2>

          {mode === 'register' && (
            <Field label="姓名（可选）">
              <input
                type="text"
                value={name}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
                className="w-full rounded-lg border border-paper-300 px-3 py-2 outline-none focus:border-accent"
                autoComplete="name"
              />
            </Field>
          )}

          <Field label="邮箱">
            <input
              type="email"
              required
              value={email}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-paper-300 px-3 py-2 outline-none focus:border-accent"
              autoComplete="email"
            />
          </Field>

          <Field label="密码">
            <input
              type="password"
              required
              minLength={mode === 'register' ? 8 : 1}
              value={password}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-paper-300 px-3 py-2 outline-none focus:border-accent"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </Field>

          {error && (
            <div className="mb-4 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full bg-accent hover:bg-accent-dark text-white rounded-lg py-2.5 font-medium disabled:opacity-60"
          >
            {busy ? '请稍候…' : (mode === 'login' ? '登录' : '注册')}
          </button>

          <div className="text-center text-sm text-ink-500 mt-5">
            {mode === 'login' ? '还没有账户？ ' : '已有账户？ '}
            <button
              type="button"
              onClick={() => { setError(null); setMode(mode === 'login' ? 'register' : 'login'); }}
              className="text-accent-dark hover:underline"
            >
              {mode === 'login' ? '注册' : '登录'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block mb-4">
      <span className="block text-sm text-ink-700 mb-1.5">{label}</span>
      {children}
    </label>
  );
}
