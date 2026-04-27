// Reader preferences persisted to localStorage. We keep them client-side
// because there's no value in syncing "I like 18 px serif" across
// devices for the v1 scope, and avoiding a server round-trip on every
// page load makes the reader feel crisp.

import { isThemeId, type ThemeId } from './themes';

export interface ReaderPrefs {
  theme: ThemeId;
  fontSize: number;       // px
  fontFamily: 'serif' | 'sans';
  lineHeight: number;     // multiplier — 1.6 .. 2.2
  columnWidth: 'narrow' | 'normal' | 'wide';
}

const STORAGE_KEY = 'bookfree.reader.prefs.v1';

export const DEFAULT_PREFS: ReaderPrefs = {
  theme: 'light',
  fontSize: 18,
  fontFamily: 'serif',
  lineHeight: 1.85,
  columnWidth: 'normal',
};

export function loadPrefs(): ReaderPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<ReaderPrefs>;
    return {
      theme: parsed.theme && isThemeId(parsed.theme) ? parsed.theme : DEFAULT_PREFS.theme,
      fontSize: clamp(parsed.fontSize ?? DEFAULT_PREFS.fontSize, 12, 32),
      fontFamily: parsed.fontFamily === 'sans' ? 'sans' : 'serif',
      lineHeight: clamp(parsed.lineHeight ?? DEFAULT_PREFS.lineHeight, 1.4, 2.4),
      columnWidth:
        parsed.columnWidth === 'narrow' || parsed.columnWidth === 'wide'
          ? parsed.columnWidth
          : 'normal',
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(p: ReaderPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* ignore quota / private mode */
  }
}

export function columnMaxWidth(prefs: ReaderPrefs): string {
  switch (prefs.columnWidth) {
    case 'narrow': return '34rem';
    case 'wide':   return '52rem';
    default:       return '42rem';
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
