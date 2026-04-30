/*
中文导读：
SettingsDrawer 是阅读设置抽屉，负责调整主题、字号、行高、字体、栏宽等阅读偏好。
它通常读写 prefs.ts 中定义的本地偏好，并把变化传给 ReaderPage 或具体 reader。
这个组件偏 UI 控制，不应该关心书籍解析和后端章节查询。
如果你想新增阅读设置项，例如段落间距、背景纹理、自动翻页速度，通常要改这里、prefs.ts 和主题/reader 样式。
设置类功能要注意持久化，否则用户刷新后会丢失。
*/

// Reader settings drawer — slides in from the right. Modifies prefs
// in real time so the reader updates as you adjust controls.
//
// Layout overview (top → bottom):
//   1. 翻页方式 — three small ModeButton tiles, format-aware.
//   2. 主题     — 8 swatches in a 4×2 grid.
//   3. 字号 / 行距 / 栏宽 — three NumericStepper rows.
//   4. 字体     — 8 face tiles in a 4×2 grid (per user request:
//                "支持 8 种字体，一行列下 4 种").
//
// All numeric controls accept both buttoned and typed input via
// NumericStepper. There are no <input type="range"> sliders here
// any more — the user explicitly requested steppers because they
// wanted to be able to type a precise value.

import { useState } from 'react';
import { THEMES } from '../lib/themes';
import {
  availableModes,
  COLUMN_WIDTH,
  FONT_SIZE,
  FONTS,
  LINE_HEIGHT,
  type FontId,
  type PageMode,
  type ReaderPrefs,
} from '../lib/prefs';
import NumericStepper from './NumericStepper';

interface Props {
  open: boolean;
  prefs: ReaderPrefs;
  /** Format of the current book — drives which page modes are enabled. */
  format: string;
  onChange: (next: ReaderPrefs) => void;
  onClose: () => void;
}

export default function SettingsDrawer({ open, prefs, format, onChange, onClose }: Props) {
  if (!open) return null;
  const modes = availableModes(format);

  return (
    <div className="fixed inset-0 z-40" onMouseDown={onClose}>
      <div className="absolute inset-0 bg-ink-900/30 animate-fade-in" />
      <aside
        onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
        className="absolute right-0 top-0 h-full w-[22rem] max-w-[92vw] border-l shadow-elev animate-drawer-in-right overflow-y-auto scrollbar-thin"
        style={{
          background: 'var(--reader-bg)',
          borderColor: 'var(--reader-border)',
          color: 'var(--reader-fg)',
        }}
      >
        <div
          className="px-5 py-4 border-b flex items-center justify-between sticky top-0 z-10"
          style={{
            borderColor: 'var(--reader-border)',
            background: 'var(--reader-bg)',
          }}
        >
          <h3 className="text-base tracking-wide" style={{ fontFamily: 'inherit' }}>阅读设置</h3>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="opacity-60 hover:opacity-100 transition-opacity h-7 w-7 rounded-md flex items-center justify-center"
            style={{ background: 'transparent' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(0,0,0,0.04)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
          >
            ✕
          </button>
        </div>

        <div className="px-5 py-5 space-y-7 text-sm">
          <Section title="翻页方式" hint={`${format.toUpperCase()} 当前可用`}>
            <div className="grid grid-cols-3 gap-2">
              <ModeButton
                mode="paginated" label="左右翻页" desc="点击左右"
                current={prefs.pageMode}
                disabled={!modes.includes('paginated')}
                onPick={(m) => onChange({ ...prefs, pageMode: m })}
              />
              <ModeButton
                mode="scroll-chapter" label="按章上下滑" desc="逐章节"
                current={prefs.pageMode}
                disabled={!modes.includes('scroll-chapter')}
                onPick={(m) => onChange({ ...prefs, pageMode: m })}
              />
              <ModeButton
                mode="scroll-book" label="全文上下滑" desc="贯穿全书"
                current={prefs.pageMode}
                disabled={!modes.includes('scroll-book')}
                onPick={(m) => onChange({ ...prefs, pageMode: m })}
              />
            </div>
          </Section>

          <Section title="主题">
            <div className="grid grid-cols-4 gap-2">
              {THEMES.map(t => {
                const active = prefs.theme === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => onChange({ ...prefs, theme: t.id })}
                    className={
                      'aspect-square rounded-lg border text-[10px] font-medium flex items-end justify-center pb-1 transition-all '
                      + (active ? 'shadow-inner' : '')
                    }
                    style={{
                      background: t.swatchBg,
                      color: t.swatchFg,
                      borderColor: active ? 'var(--reader-accent)' : 'var(--reader-border)',
                      borderWidth: active ? 2 : 1,
                      transform: active ? 'scale(0.97)' : 'scale(1)',
                    }}
                    title={t.name}
                  >
                    {t.name}
                  </button>
                );
              })}
            </div>
          </Section>

          <Section title="字号 · 行距 · 栏宽">
            <div className="space-y-4">
              <NumericStepper
                label="字号"
                value={prefs.fontSize}
                min={FONT_SIZE.min} max={FONT_SIZE.max} step={FONT_SIZE.step}
                suffix="px"
                onChange={v => onChange({ ...prefs, fontSize: v })}
              />
              <NumericStepper
                label="行距"
                value={prefs.lineHeight}
                min={LINE_HEIGHT.min} max={LINE_HEIGHT.max} step={LINE_HEIGHT.step}
                onChange={v => onChange({ ...prefs, lineHeight: v })}
              />
              <NumericStepper
                label="栏宽"
                value={prefs.columnWidth}
                min={COLUMN_WIDTH.min} max={COLUMN_WIDTH.max} step={COLUMN_WIDTH.step}
                suffix="%"
                hint="文本占阅读区宽度的比例，越大越靠近屏幕边缘"
                onChange={v => onChange({ ...prefs, columnWidth: v })}
              />
            </div>
          </Section>

          <Section title="字体">
            <div className="grid grid-cols-4 gap-2">
              {FONTS.map(f => (
                <FontTile
                  key={f.id}
                  id={f.id}
                  label={f.label}
                  hint={f.hint}
                  family={f.family}
                  active={prefs.fontFamily === f.id}
                  onPick={() => onChange({ ...prefs, fontFamily: f.id })}
                />
              ))}
            </div>
          </Section>
        </div>
      </aside>
    </div>
  );
}

function Section({
  title, hint, children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2.5 flex items-baseline justify-between">
        <span className="font-medium tracking-wide">{title}</span>
        {hint && (
          <span className="text-[11px]" style={{ color: 'var(--reader-muted)' }}>{hint}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function ModeButton({
  mode, label, desc, current, disabled, onPick,
}: {
  mode: PageMode; label: string; desc: string;
  current: PageMode; disabled: boolean; onPick: (m: PageMode) => void;
}) {
  const active = !disabled && current === mode;
  return (
    <button
      onClick={() => !disabled && onPick(mode)}
      disabled={disabled}
      className="rounded-lg border px-2 py-2.5 text-xs leading-tight text-center transition-all"
      style={{
        borderColor: active ? 'var(--reader-accent)' : 'var(--reader-border)',
        borderWidth: active ? 2 : 1,
        background: active ? 'rgba(124, 90, 58, 0.08)' : 'transparent',
        color: disabled ? 'var(--reader-muted)' : (active ? 'var(--reader-accent)' : 'var(--reader-fg)'),
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
      title={disabled ? '此格式不支持该模式' : label}
    >
      <div className="font-medium">{label}</div>
      <div className="text-[10px] opacity-70 mt-0.5">{desc}</div>
    </button>
  );
}

function FontTile({
  id, label, hint, family, active, onPick,
}: {
  id: FontId;
  label: string;
  hint: string;
  family: string;
  active: boolean;
  onPick: () => void;
}) {
  // We render the label itself in the family it represents so the
  // user can preview the face before picking. The hint stays in the
  // drawer's UI font for legibility.
  const [hover, setHover] = useState(false);
  void id;
  return (
    <button
      onClick={onPick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="rounded-lg border px-1.5 py-2 text-center transition-all"
      style={{
        borderColor: active ? 'var(--reader-accent)' : 'var(--reader-border)',
        borderWidth: active ? 2 : 1,
        background: active ? 'rgba(124, 90, 58, 0.06)'
                   : hover  ? 'rgba(0, 0, 0, 0.02)'
                            : 'transparent',
        color: active ? 'var(--reader-accent)' : 'var(--reader-fg)',
        cursor: 'pointer',
      }}
    >
      <div className="text-[15px] leading-tight" style={{ fontFamily: family }}>
        {label}
      </div>
      <div className="text-[10px] opacity-60 mt-0.5">{hint}</div>
    </button>
  );
}
