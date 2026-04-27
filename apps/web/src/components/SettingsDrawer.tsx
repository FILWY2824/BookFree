// Reader settings drawer — slides in from the right. Modifies prefs
// in real time so the reader updates as you adjust controls.

import { THEMES } from '../lib/themes';
import { type ReaderPrefs } from '../lib/prefs';

interface Props {
  open: boolean;
  prefs: ReaderPrefs;
  onChange: (next: ReaderPrefs) => void;
  onClose: () => void;
}

export default function SettingsDrawer({ open, prefs, onChange, onClose }: Props) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40" onClick={onClose}>
      <div className="absolute inset-0 bg-ink-900/30 animate-fade-in" />
      <div
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
        className="absolute right-0 top-0 h-full w-80 bg-paper-50 border-l border-paper-300/70 shadow-elev animate-drawer-in overflow-y-auto"
      >
        <div className="px-5 py-4 border-b border-paper-300/70 flex items-center justify-between">
          <h3 className="font-serif text-lg text-ink-800">阅读设置</h3>
          <button onClick={onClose} className="text-ink-500 hover:text-ink-800" aria-label="关闭">
            ✕
          </button>
        </div>

        <div className="px-5 py-4 space-y-6 text-sm">
          <div>
            <div className="text-ink-700 mb-2">主题</div>
            <div className="grid grid-cols-4 gap-2">
              {THEMES.map(t => (
                <button
                  key={t.id}
                  onClick={() => onChange({ ...prefs, theme: t.id })}
                  className={
                    'aspect-square rounded-lg border text-[10px] font-medium flex items-end justify-center pb-1 transition-all ' +
                    (prefs.theme === t.id ? 'ring-2 ring-accent border-accent' : 'border-paper-300/70')
                  }
                  style={{ background: t.swatchBg, color: t.swatchFg }}
                  title={t.name}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </div>

          <SliderRow
            label="字号"
            value={prefs.fontSize}
            min={14} max={28} step={1}
            display={prefs.fontSize + 'px'}
            onChange={v => onChange({ ...prefs, fontSize: v })}
          />
          <SliderRow
            label="行距"
            value={prefs.lineHeight}
            min={1.4} max={2.4} step={0.05}
            display={prefs.lineHeight.toFixed(2)}
            onChange={v => onChange({ ...prefs, lineHeight: v })}
          />

          <div>
            <div className="text-ink-700 mb-2">字体</div>
            <div className="flex gap-2">
              {(['serif', 'sans'] as const).map(f => (
                <button
                  key={f}
                  onClick={() => onChange({ ...prefs, fontFamily: f })}
                  className={
                    'flex-1 px-3 py-2 rounded-lg border text-sm ' +
                    (prefs.fontFamily === f
                      ? 'border-accent text-accent-dark bg-accent/5'
                      : 'border-paper-300/70 text-ink-600')
                  }
                >
                  {f === 'serif' ? '衬线（书宋）' : '无衬线'}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-ink-700 mb-2">栏宽</div>
            <div className="flex gap-2">
              {(['narrow', 'normal', 'wide'] as const).map(w => (
                <button
                  key={w}
                  onClick={() => onChange({ ...prefs, columnWidth: w })}
                  className={
                    'flex-1 px-3 py-2 rounded-lg border text-sm ' +
                    (prefs.columnWidth === w
                      ? 'border-accent text-accent-dark bg-accent/5'
                      : 'border-paper-300/70 text-ink-600')
                  }
                >
                  {w === 'narrow' ? '窄' : w === 'wide' ? '宽' : '中'}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SliderRow({
  label, value, min, max, step, display, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number;
  display: string; onChange: (n: number) => void;
}) {
  return (
    <div>
      <div className="flex justify-between text-ink-700 mb-1.5">
        <span>{label}</span>
        <span className="text-ink-500">{display}</span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step} value={value}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(parseFloat(e.target.value))}
        className="w-full accent-[#7C5A3A]"
      />
    </div>
  );
}
