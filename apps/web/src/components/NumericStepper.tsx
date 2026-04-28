// NumericStepper — small "[−] [ value ] [+]" trio used in the
// settings drawer for font size, line height, and column width.
//
// Why a custom control instead of <input type="number">:
//   • The native spinner buttons are tiny and platform-themed; we
//     want them to read as part of the reader's surface.
//   • We need to honour a per-control `step` that's sometimes
//     fractional (lineHeight steps by 0.05). Type=number's spinners
//     already handle this, but we also want long-press repeat
//     (held button keeps stepping) which the native spinner
//     doesn't expose at all.
//
// UX details:
//   • Click [−] or [+] once → one step.
//   • Hold [−] or [+] → after 380 ms initial delay, autorepeat at
//     ~10 Hz until release. We handle pointerup/pointerleave/blur
//     to stop, so a swipe-off doesn't strand the timer.
//   • The center input is a real <input type="text" inputMode="decimal">
//     — typing freely is allowed, on Enter or blur we snap to the
//     step + clamp to bounds and fire onChange.
//   • While typing we keep the local draft string so cursor /
//     caret stay put; we only commit on Enter or blur.
//
// Theming: borders use --reader-border, text uses --reader-fg, the
// active accent on focus uses --reader-accent. The buttons get a
// subtle background tint on hover (rgb of accent at low alpha).

import { useCallback, useEffect, useRef, useState } from 'react';
import { snapTo } from '../lib/prefs';

interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Suffix displayed after the value while NOT focused (e.g. "px",
   *  "rem"). When the input is focused we hide it so the user can
   *  type a clean number. */
  suffix?: string;
  /** Optional one-line description shown under the row. Used when the
   *  control's purpose isn't obvious from the label alone (e.g. 栏宽
   *  could be read as either "column width" or "page margin"). */
  hint?: string;
  /** Number of decimals to render in the readout. Inferred from
   *  step if omitted. */
  decimals?: number;
  onChange: (n: number) => void;
}

export default function NumericStepper({
  label, value, min, max, step, suffix, hint, decimals, onChange,
}: Props) {
  const dec = decimals ?? decimalsOf(step);
  const [draft, setDraft] = useState<string | null>(null); // null = not editing
  const [focused, setFocused] = useState(false);

  const repeatRef = useRef<{
    timeout: ReturnType<typeof setTimeout> | null;
    interval: ReturnType<typeof setInterval> | null;
  }>({ timeout: null, interval: null });

  const stop = useCallback(() => {
    if (repeatRef.current.timeout) {
      clearTimeout(repeatRef.current.timeout);
      repeatRef.current.timeout = null;
    }
    if (repeatRef.current.interval) {
      clearInterval(repeatRef.current.interval);
      repeatRef.current.interval = null;
    }
  }, []);

  useEffect(() => stop, [stop]);

  const apply = useCallback((next: number) => {
    onChange(snapTo(next, step, min, max));
  }, [onChange, step, min, max]);

  const startRepeat = useCallback((dir: 1 | -1) => {
    apply(value + dir * step);
    stop();
    // After an initial pause, autorepeat. The pause matches the
    // OS double-click threshold so a single tap doesn't accidentally
    // start an autorepeat run.
    repeatRef.current.timeout = setTimeout(() => {
      let cur = value;
      repeatRef.current.interval = setInterval(() => {
        cur = snapTo(cur + dir * step, step, min, max);
        if ((dir > 0 && cur >= max) || (dir < 0 && cur <= min)) {
          stop();
        }
        onChange(cur);
      }, 100);
    }, 380);
  }, [apply, onChange, step, min, max, value]);

  const commitDraft = useCallback(() => {
    if (draft === null) return;
    const parsed = parseFloat(draft.replace(/[^\d.\-]/g, ''));
    if (Number.isFinite(parsed)) apply(parsed);
    setDraft(null);
  }, [draft, apply]);

  const display = draft ?? value.toFixed(dec);

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <span>{label}</span>
        <span className="text-[11px]" style={{ color: 'var(--reader-muted)' }}>
          {min.toFixed(dec)} – {max.toFixed(dec)}
          {suffix ? ' ' + suffix : ''}
        </span>
      </div>

      <div
        className={'reader-stepper ' + (focused ? 'reader-stepper-focused' : '')}
      >
        <button
          type="button"
          aria-label={`${label}减小`}
          className="reader-stepper-btn"
          disabled={value <= min}
          onPointerDown={(e: React.PointerEvent) => {
            e.preventDefault();
            (e.currentTarget as HTMLButtonElement).setPointerCapture?.(e.pointerId);
            startRepeat(-1);
          }}
          onPointerUp={stop}
          onPointerLeave={stop}
          onPointerCancel={stop}
        >
          <SvgMinus />
        </button>

        <div className="reader-stepper-display">
          <input
            type="text"
            inputMode="decimal"
            value={display}
            onFocus={(e: React.FocusEvent<HTMLInputElement>) => {
              setFocused(true);
              setDraft(value.toFixed(dec));
              // Select-all so typing replaces the value.
              requestAnimationFrame(() => e.target.select());
            }}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              setDraft(e.target.value);
            }}
            onBlur={() => { setFocused(false); commitDraft(); }}
            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitDraft();
                (e.currentTarget as HTMLInputElement).blur();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setDraft(null);
                (e.currentTarget as HTMLInputElement).blur();
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                apply(value + step);
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                apply(value - step);
              }
            }}
            className="reader-stepper-input"
            aria-label={label}
          />
          {!focused && suffix && (
            <span className="reader-stepper-suffix">{suffix}</span>
          )}
        </div>

        <button
          type="button"
          aria-label={`${label}增大`}
          className="reader-stepper-btn"
          disabled={value >= max}
          onPointerDown={(e: React.PointerEvent) => {
            e.preventDefault();
            (e.currentTarget as HTMLButtonElement).setPointerCapture?.(e.pointerId);
            startRepeat(1);
          }}
          onPointerUp={stop}
          onPointerLeave={stop}
          onPointerCancel={stop}
        >
          <SvgPlus />
        </button>
      </div>

      {hint && (
        <div
          className="text-[11px] mt-1 leading-snug"
          style={{ color: 'var(--reader-muted)' }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}

function SvgMinus() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function SvgPlus() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <line x1="12" y1="5"  x2="12" y2="19" />
      <line x1="5"  y1="12" x2="19" y2="12" />
    </svg>
  );
}

function decimalsOf(step: number): number {
  if (Number.isInteger(step)) return 0;
  const s = String(step);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}
