// Settings — split into two top-level sections per the user's spec:
//
//   • 用户设置  — account info, sign-out. We deliberately removed the
//                  阅读偏好 preview block; reading prefs live in the
//                  in-reader drawer only (still reachable from there).
//
//   • AI 设置   — per-user choice between the server's built-in AI
//                  and a self-imported OpenAI-compatible provider.
//                  Built-in test returns success/failure ONLY (no
//                  model or interface details leak). Custom-provider
//                  test returns the model + a name derived from the
//                  user's URL host.
//
// Security note (custom AI URLs):
//   The server applies strict validation to any baseUrl the user
//   submits — HTTPS-only, public IPs only, no userinfo, no query, no
//   fragment, length-bounded path. Network connections also re-check
//   the resolved IP at dial time so a malicious DNS record can't be
//   used for SSRF. We don't replicate the validation in the client;
//   the server is the source of truth, and we surface its rejection
//   message verbatim in the form.

import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiException } from '../lib/api';
import { useAuth } from '../lib/auth';
import DashboardChrome from '../components/DashboardChrome';

interface ProviderRow {
  id: string;
  label: string;
  providerType: string;
  baseUrl: string;
  chatModel?: string | null;
  enabled: boolean;
  isDefault: boolean;
  hasKey: boolean;
  keyHint?: string;
  createdAt: number;
  updatedAt: number;
}

interface LimitsView {
  canUseSystem: boolean;
  ratePerMinuteUsed: number;
  monthlyUsedUsd: number;
  ratePerMinuteCap?: number;
  monthlyCapUsd?: number;
}

export default function SettingsPage() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();

  const [tab, setTab] = useState<'user' | 'ai'>('user');

  async function logout() {
    await api.post('/api/auth/logout').catch(() => {});
    await refresh();
    navigate('/login', { replace: true });
  }

  return (
    <DashboardChrome title="设置">
      <nav className="border-b border-paper-300/70 mb-6 flex gap-4 text-sm">
        <TabButton active={tab === 'user'} onClick={() => setTab('user')}>用户设置</TabButton>
        <TabButton active={tab === 'ai'} onClick={() => setTab('ai')}>AI 设置</TabButton>
      </nav>

      {tab === 'user' && (
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
      )}

      {tab === 'ai' && <AISettings isAdmin={user?.role === 'admin'} />}
    </DashboardChrome>
  );
}

// ── AI Settings panel ──────────────────────────────────────────────

function AISettings({ isAdmin }: { isAdmin: boolean }) {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [limits, setLimits] = useState<LimitsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [builtinTest, setBuiltinTest] = useState<{ ok?: boolean; msg?: string; busy?: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<{ providers: ProviderRow[] }>('/api/ai/providers').catch(() => ({ providers: [] as ProviderRow[] })),
      api.get<LimitsView>('/api/ai/limits').catch(() => null as LimitsView | null),
    ])
      .then(([p, l]) => {
        if (cancelled) return;
        setProviders(p.providers ?? []);
        setLimits(l);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [reload]);

  const testBuiltin = async () => {
    setBuiltinTest({ busy: true });
    try {
      const r = await api.post<{ ok: boolean; errorMessage?: string }>('/api/ai/test', { target: 'builtin' });
      setBuiltinTest({ ok: r.ok, msg: r.ok ? '调用成功' : (r.errorMessage ?? '调用失败') });
    } catch (e) {
      setBuiltinTest({ ok: false, msg: (e as Error).message });
    }
  };

  if (loading) return <div className="text-ink-500">加载中…</div>;

  return (
    <>
      <Section title="内置 AI">
        <div className="text-sm text-ink-700 mb-3">
          使用服务端预置的 AI。具体接口与模型不对外暴露。
        </div>
        {limits && (
          <div className="space-y-2 mb-4">
            <UsageBar
              label="本月额度"
              valueLabel={`$${limits.monthlyUsedUsd.toFixed(3)}${limits.monthlyCapUsd != null ? ` / $${limits.monthlyCapUsd.toFixed(2)}` : ''}`}
              fraction={limits.monthlyCapUsd ? limits.monthlyUsedUsd / limits.monthlyCapUsd : 0}
              warningAt={0.8}
            />
            <UsageBar
              label="过去 1 分钟"
              valueLabel={`${limits.ratePerMinuteUsed}${limits.ratePerMinuteCap != null ? ` / ${limits.ratePerMinuteCap}` : ''} 次`}
              fraction={limits.ratePerMinuteCap ? limits.ratePerMinuteUsed / limits.ratePerMinuteCap : 0}
              warningAt={0.8}
            />
            <div className="text-xs text-ink-500">
              当前状态：
              <span className={limits.canUseSystem ? 'text-emerald-700' : 'text-rose-600'}>
                {limits.canUseSystem ? '可用' : '已暂停'}
              </span>
            </div>
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={testBuiltin}
            disabled={builtinTest?.busy}
            className="px-4 py-2 rounded-lg bg-accent text-white text-sm hover:bg-accent-dark disabled:opacity-30"
          >
            {builtinTest?.busy ? '测试中…' : '测试内置 AI'}
          </button>
          {builtinTest && !builtinTest.busy && (
            <span className={'text-sm ' + (builtinTest.ok ? 'text-emerald-700' : 'text-rose-600')}>
              {builtinTest.ok ? '✓ 调用成功' : '✗ ' + (builtinTest.msg ?? '调用失败')}
            </span>
          )}
        </div>
        {isAdmin && <AdminLimitsForm onSaved={() => setReload(x => x + 1)} />}
      </Section>

      <Section title="自定义 AI 接口">
        <p className="text-sm text-ink-700 mb-3">
          导入你自己的 OpenAI 兼容 API。URL 必须为 <code>https://</code>，不允许指向内网或保留地址。
        </p>
        {providers.length > 0 && (
          <ul className="space-y-3 mb-4">
            {providers.map(p => (
              <ProviderCard
                key={p.id}
                row={p}
                onChanged={() => setReload(x => x + 1)}
              />
            ))}
          </ul>
        )}
        <ProviderCreateButton onCreated={() => setReload(x => x + 1)} />
      </Section>
    </>
  );
}

// Compact horizontal usage bar. Goes amber > 60% and red > warningAt.
function UsageBar({
  label, valueLabel, fraction, warningAt = 0.8,
}: {
  label: string; valueLabel: string; fraction: number; warningAt?: number;
}) {
  const pct = Math.max(0, Math.min(1, fraction));
  const danger = pct >= warningAt;
  const warn = !danger && pct >= 0.6;
  const color = danger ? '#dc2626' : warn ? '#d97706' : '#059669';
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs mb-1">
        <span className="text-ink-600">{label}</span>
        <span className="text-ink-500 tabular-nums">{valueLabel}</span>
      </div>
      <div className="h-2 rounded-full bg-paper-200 overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${(pct * 100).toFixed(1)}%`, background: color }}
        />
      </div>
    </div>
  );
}

function AdminLimitsForm({ onSaved }: { onSaved: () => void }) {
  const [monthly, setMonthly] = useState('10');
  const [rate, setRate] = useState('5');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Pre-populate once.
  useEffect(() => {
    api.get<LimitsView>('/api/ai/limits').then(l => {
      if (l.monthlyCapUsd != null) setMonthly(String(l.monthlyCapUsd));
      if (l.ratePerMinuteCap != null) setRate(String(l.ratePerMinuteCap));
    }).catch(() => {});
  }, []);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api.put('/api/ai/limits', {
        monthlyUsd: Number(monthly),
        ratePerMinute: Number(rate),
      });
      setMsg('已保存');
      onSaved();
    } catch (e) {
      const err = e as ApiException;
      setMsg(err.message ?? '保存失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 p-3 rounded-lg border border-paper-300/70 bg-paper-100/50">
      <h4 className="text-xs uppercase tracking-wide text-ink-500 mb-2">管理员：内置 AI 用量限制</h4>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col">
          <span className="text-xs text-ink-500 mb-1">每月额度（美元）</span>
          <input
            type="number" step="0.5" min="0" max="10000"
            value={monthly}
            onChange={e => setMonthly(e.target.value)}
            className="w-32 rounded-lg border border-paper-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-ink-500 mb-1">每分钟调用次数</span>
          <input
            type="number" step="1" min="1" max="600"
            value={rate}
            onChange={e => setRate(e.target.value)}
            className="w-32 rounded-lg border border-paper-300 px-2 py-1.5 text-sm"
          />
        </label>
        <button
          onClick={save}
          disabled={busy}
          className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm disabled:opacity-30 hover:bg-accent-dark"
        >
          {busy ? '保存中…' : '保存'}
        </button>
        {msg && <span className="text-xs text-ink-600">{msg}</span>}
      </div>
    </div>
  );
}

function ProviderCard({ row, onChanged }: { row: ProviderRow; onChanged: () => void }) {
  const [models, setModels] = useState<string[] | null>(null);
  const [chatModel, setChatModel] = useState(row.chatModel ?? '');
  const [busy, setBusy] = useState<'fetch' | 'test' | 'save' | 'delete' | null>(null);
  const [test, setTest] = useState<{ ok?: boolean; name?: string; model?: string; msg?: string } | null>(null);

  const fetchModels = async () => {
    setBusy('fetch');
    try {
      const r = await api.get<{ models: string[] }>(`/api/ai/providers/${row.id}/models`);
      setModels(r.models);
      if (!chatModel && r.models[0]) setChatModel(r.models[0]);
    } catch (e) {
      setTest({ ok: false, msg: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const runTest = async () => {
    setBusy('test');
    setTest(null);
    try {
      const r = await api.post<{ ok: boolean; name?: string; model?: string; errorMessage?: string }>(
        '/api/ai/test', { target: 'provider', providerId: row.id });
      setTest(r.ok ? { ok: true, name: r.name, model: r.model } : { ok: false, msg: r.errorMessage });
    } catch (e) {
      setTest({ ok: false, msg: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const saveModel = async () => {
    setBusy('save');
    try {
      await api.put(`/api/ai/providers/${row.id}`, { chatModel: chatModel || null });
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  const setDefault = async (val: boolean) => {
    await api.put(`/api/ai/providers/${row.id}`, { isDefault: val });
    onChanged();
  };

  const remove = async () => {
    if (!confirm(`删除「${row.label}」？此操作不可恢复。`)) return;
    setBusy('delete');
    try {
      await api.delete(`/api/ai/providers/${row.id}`);
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="rounded-lg border border-paper-300/70 bg-paper-50 px-4 py-3">
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="font-medium text-ink-800">
            {row.label}
            {row.isDefault && <span className="ml-2 text-[10px] uppercase tracking-wide text-emerald-700 bg-emerald-100/60 px-1.5 py-0.5 rounded">默认</span>}
          </div>
          <div className="text-xs text-ink-500 mt-0.5 break-all">
            {row.baseUrl}
            {row.keyHint && <span className="ml-2 text-ink-400">key {row.keyHint}</span>}
          </div>
        </div>
        <button
          onClick={remove}
          disabled={busy === 'delete'}
          className="text-xs text-rose-600 hover:underline disabled:opacity-30"
        >删除</button>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-2">
        <button
          onClick={fetchModels}
          disabled={busy === 'fetch'}
          className="px-3 py-1.5 rounded-lg border border-paper-300 text-ink-700 text-sm hover:bg-paper-100 disabled:opacity-30"
        >
          {busy === 'fetch' ? '拉取中…' : '拉取模型'}
        </button>
        {models ? (
          <select
            value={chatModel}
            onChange={e => setChatModel(e.target.value)}
            className="rounded-lg border border-paper-300 px-2 py-1.5 text-sm"
          >
            <option value="">（不指定）</option>
            {models.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        ) : (
          <input
            value={chatModel}
            onChange={e => setChatModel(e.target.value)}
            placeholder="模型名（可手动输入）"
            className="rounded-lg border border-paper-300 px-2 py-1.5 text-sm"
          />
        )}
        <button
          onClick={saveModel}
          disabled={busy === 'save' || (chatModel === (row.chatModel ?? ''))}
          className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm disabled:opacity-30 hover:bg-accent-dark"
        >
          保存模型
        </button>
        <button
          onClick={runTest}
          disabled={busy === 'test'}
          className="px-3 py-1.5 rounded-lg border border-paper-300 text-ink-700 text-sm hover:bg-paper-100 disabled:opacity-30"
        >
          {busy === 'test' ? '测试中…' : '测试'}
        </button>
        <label className="text-xs text-ink-600 ml-2 inline-flex items-center gap-1">
          <input
            type="checkbox"
            checked={row.isDefault}
            onChange={e => setDefault(e.target.checked)}
          />
          设为默认
        </label>
      </div>

      {test && (
        <div className={'text-xs ' + (test.ok ? 'text-emerald-700' : 'text-rose-600')}>
          {test.ok
            ? `✓ 调用成功 — 接入名：${test.name ?? '—'} · 模型：${test.model ?? '—'}`
            : `✗ ${test.msg ?? '调用失败'}`}
        </div>
      )}
    </li>
  );
}

// Modal-based "add custom AI" flow.
//
// Why modal instead of inline form: the user reported that the inline
// form felt out of place — they wanted "添加自定义 AI" to feel like a
// distinct action with focus, not a panel that just expanded under
// the list. The modal also gives us room for the "fetch models on
// paste" UX without crowding the main page.
//
// Auto-fetch models:
//   When BOTH baseUrl and apiKey are filled and have changed since
//   the last fetch, we auto-call /api/ai/test in dry-run mode (the
//   server lets us pass the URL+key inline rather than requiring a
//   provider id) to list models. This way the user can pick the
//   model name from a dropdown DURING creation, instead of creating
//   a row first and clicking "拉取模型" afterwards.
//
// Failure transparency:
//   If the dry-run test fails with HTTP 502 / 504 / etc. — i.e. the
//   upstream returned an error rather than us refusing the URL —
//   we now surface the constructed full URL (without the key) in
//   the error message. Users were getting bare "✗ 502 Bad Gateway"
//   responses with no idea what URL the server even tried; printing
//   the URL closes the loop.
function ProviderCreateButton({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="px-4 py-2 rounded-lg border border-dashed border-paper-300 text-ink-700 text-sm hover:bg-paper-100 w-full"
      >
        + 添加自定义 AI
      </button>
      {open && (
        <ProviderCreateModal
          onClose={() => setOpen(false)}
          onCreated={() => { setOpen(false); onCreated(); }}
        />
      )}
    </>
  );
}

function ProviderCreateModal({
  onClose, onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [chatModel, setChatModel] = useState('');
  const [models, setModels] = useState<string[] | null>(null);
  const [probing, setProbing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track which (baseUrl, apiKey) tuple we last probed so we don't
  // re-fetch on every keystroke.
  const lastProbedRef = useState({ baseUrl: '', apiKey: '' })[0];

  // Debounce: probe 800ms after the user stops typing (and only if
  // both fields are non-empty and the URL parses as https://...).
  useEffect(() => {
    const u = baseUrl.trim();
    const k = apiKey.trim();
    if (!u || !k) return;
    if (lastProbedRef.baseUrl === u && lastProbedRef.apiKey === k) return;
    if (!/^https?:\/\//i.test(u)) return;
    const handle = setTimeout(async () => {
      lastProbedRef.baseUrl = u;
      lastProbedRef.apiKey = k;
      setProbing(true);
      setError(null);
      try {
        // Dry-run test: server accepts inline URL+key without persisting.
        const r = await api.post<{
          ok: boolean;
          models?: string[];
          errorMessage?: string;
          attemptedUrl?: string;
        }>('/api/ai/test', {
          target: 'inline',
          baseUrl: u,
          apiKey: k,
          listModels: true,
        });
        if (r.ok) {
          setModels(r.models ?? []);
          if (!chatModel && r.models && r.models[0]) setChatModel(r.models[0]);
        } else {
          const url = r.attemptedUrl ? `\n请求 URL: ${r.attemptedUrl}` : '';
          setError((r.errorMessage ?? '探测失败') + url);
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setProbing(false);
      }
    }, 800);
    return () => clearTimeout(handle);
  }, [baseUrl, apiKey, chatModel, lastProbedRef]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/ai/providers', {
        label: label.trim(),
        providerType: 'openai-compatible',
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        chatModel: chatModel.trim() || null,
      });
      onCreated();
    } catch (err) {
      setError((err as Error).message ?? '创建失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: 'rgba(0,0,0,0.4)' }}
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
        className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 space-y-3"
      >
        <h3 className="text-lg font-medium text-ink-800 mb-2">添加自定义 AI</h3>

        <div>
          <label className="text-xs text-ink-500 block mb-1">显示名称</label>
          <input
            required
            maxLength={60}
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="例如：DeepSeek"
            className="w-full rounded-lg border border-paper-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-ink-500 block mb-1">Base URL</label>
          <input
            required
            maxLength={2048}
            type="url"
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            placeholder="https://api.deepseek.com/v1"
            className="w-full rounded-lg border border-paper-300 px-3 py-2 text-sm font-mono"
          />
          <div className="text-[11px] text-ink-500 mt-1">
            仅支持 https:// 公网地址。不允许 localhost / 内网 IP / 含 ?查询 或 #片段。
          </div>
        </div>
        <div>
          <label className="text-xs text-ink-500 block mb-1">API Key</label>
          <input
            required
            maxLength={1024}
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder="sk-…"
            className="w-full rounded-lg border border-paper-300 px-3 py-2 text-sm font-mono"
          />
          <div className="text-[11px] text-ink-500 mt-1">
            密钥经服务端加密存储；仅在调用上游 API 时短暂解密。
          </div>
        </div>

        <div>
          <label className="text-xs text-ink-500 block mb-1 flex items-center gap-2">
            <span>模型</span>
            {probing && <span className="text-ink-400">（正在探测可用模型…）</span>}
          </label>
          {models && models.length > 0 ? (
            <select
              value={chatModel}
              onChange={e => setChatModel(e.target.value)}
              className="w-full rounded-lg border border-paper-300 px-3 py-2 text-sm"
            >
              <option value="">（不指定，由上游决定）</option>
              {models.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <input
              value={chatModel}
              onChange={e => setChatModel(e.target.value)}
              placeholder="填写 URL 与 Key 后将自动探测可选模型"
              className="w-full rounded-lg border border-paper-300 px-3 py-2 text-sm font-mono"
            />
          )}
        </div>

        {error && (
          <div className="text-xs text-rose-600 whitespace-pre-wrap rounded-md bg-rose-50 px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-paper-300 text-ink-700 text-sm hover:bg-paper-100"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={busy}
            className="px-4 py-2 rounded-lg bg-accent text-white text-sm disabled:opacity-30 hover:bg-accent-dark"
          >
            {busy ? '创建中…' : '创建'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── small reusable bits ────────────────────────────────────────────

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={
        'px-3 py-2 -mb-px border-b-2 ' +
        (active
          ? 'border-accent text-accent-dark font-medium'
          : 'border-transparent text-ink-500 hover:text-ink-800')
      }
    >
      {children}
    </button>
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
