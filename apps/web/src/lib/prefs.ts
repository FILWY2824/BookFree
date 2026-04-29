// Reader preferences persisted to localStorage.
//
// pageMode controls how a long body is divided up:
//   • 'paginated'      — left/right page flips, one screen of text
//                         at a time. Default for EPUB / chapter content.
//   • 'scroll-chapter' — vertical scroll within the current chapter,
//                         with prev/next chapter at the edges.
//   • 'scroll-book'    — vertical scroll across the entire book; we
//                         lazy-load the next chapter as the user nears
//                         the bottom. Only meaningful for chapter-based
//                         formats (TXT/EPUB-as-text). EpubReader (epub.js)
//                         falls back to 'scroll-chapter' under the hood.
//
// The TOC drawer is always docked — we no longer have a `tocPinned`
// pref. The header's TOC button toggles VISIBILITY of the dock so a
// narrow viewport can still claim the full reader column when wanted.
// Removing the legacy field keeps the project to one source of truth
// instead of two competing toggles.
//
// styleColors records the user's last-picked colour PER style. The
// reader page header now exposes one swatch row PER style (highlight
// / underline / wavy / strike), each remembering its own colour. New
// annotations of style X start with styleColors[X]. Existing
// annotations are NEVER auto-recoloured — the user has to click them
// and pick a new colour explicitly.
//
// Numeric controls:
//   • fontSize    — px, 12 .. 32, step 1, default 18
//   • lineHeight  — multiplier, 1.20 .. 2.60, step 0.05, default 1.85
//   • columnWidth — % of the reading area, 50 .. 100, step 5, default 85.
//                   Originally an enum ('narrow'/'normal'/'wide'), then
//                   a rem value (24..60). The rem version was confusing
//                   because on narrow viewports many values clipped to
//                   the same visible width; a percentage of the reading
//                   area is *always* visible — 50% obviously narrower
//                   than 100% — and matches how users describe the
//                   control ("how much of the screen the text fills,
//                   i.e. the inverse of the side margin").
//
// fontFamily is now a token id, not a CSS family. The token resolves
// to a real CSS family stack via FONT_STACKS so we can ship eight
// curated faces (four serif + four sans / display) and let the user
// pick from a 4-column grid.
//
// Persistence per platform:
//   The user explicitly asked that web / native-app / desktop store
//   their reader prefs separately, since UI density and reading
//   environment differ. We detect the runtime once and namespace the
//   storage key. Migrations from v1 / v2 land in the per-platform
//   key transparently.

import { isThemeId, type ThemeId } from './themes';

export type PageMode = 'paginated' | 'scroll-chapter' | 'scroll-book';
export type Platform = 'web' | 'app' | 'window';

// ── Font tokens ─────────────────────────────────────────────────────
// Keep this list narrow on purpose. Eight faces is enough variety
// without overwhelming the picker, and it matches the "two rows of
// four" grid the user asked for.

export type FontId =
  | 'wenkai'      // 霞鹜文楷 — bundled webfont, the reader's house font
  | 'han-serif'   // 思源宋体
  | 'songti'      // 系统宋体（Songti SC / SimSun）
  | 'kaiti'       // 楷体
  | 'han-sans'    // 思源黑体
  | 'pingfang'    // 苹方 / 微软雅黑
  | 'fangsong'    // 仿宋
  | 'mono';       // 等宽（JetBrains Mono / 等距更纱）

export interface FontDef {
  id: FontId;
  /** Short Chinese label for the picker tile. */
  label: string;
  /** Slightly longer hint shown below the label. */
  hint: string;
  /** CSS font-family value. */
  family: string;
  /** Whether this is a serif-style face (used by epubjs theme picker). */
  serif: boolean;
}

export const FONTS: readonly FontDef[] = [
  {
    id: 'wenkai',
    label: '霞鹜文楷',
    hint: '柔和宋体',
    family: '"LXGW WenKai", "霞鹜文楷", ui-serif, Georgia, serif',
    serif: true,
  },
  {
    id: 'han-serif',
    label: '思源宋体',
    hint: '正式书宋',
    family: '"Source Han Serif SC", "Source Han Serif CN", "Noto Serif CJK SC", "思源宋体", "Songti SC", "SimSun", serif',
    serif: true,
  },
  {
    id: 'songti',
    label: '宋体',
    hint: '系统宋体',
    family: '"Songti SC", "SimSun", "宋体", "Noto Serif CJK SC", ui-serif, serif',
    serif: true,
  },
  {
    id: 'kaiti',
    label: '楷体',
    hint: '楷书风',
    family: '"Kaiti SC", "STKaiti", "KaiTi", "楷体", "Noto Serif CJK SC", serif',
    serif: true,
  },
  {
    id: 'han-sans',
    label: '思源黑体',
    hint: '现代黑体',
    family: '"Source Han Sans SC", "Source Han Sans CN", "Noto Sans CJK SC", "思源黑体", "PingFang SC", sans-serif',
    serif: false,
  },
  {
    id: 'pingfang',
    label: '苹方',
    hint: '系统黑体',
    family: '"PingFang SC", "Microsoft YaHei", "微软雅黑", "Hiragino Sans GB", ui-sans-serif, sans-serif',
    serif: false,
  },
  {
    id: 'fangsong',
    label: '仿宋',
    hint: '半正式',
    family: '"FangSong", "STFangsong", "仿宋", "FangSong_GB2312", ui-serif, serif',
    serif: true,
  },
  {
    id: 'mono',
    label: '等宽',
    hint: '代码风',
    family: '"Sarasa Mono SC", "JetBrains Mono", "Fira Code", "Source Code Pro", ui-monospace, "Menlo", monospace',
    serif: false,
  },
] as const;

export function isFontId(s: unknown): s is FontId {
  return typeof s === 'string' && FONTS.some(f => f.id === s);
}

export function fontFamilyOf(id: FontId): string {
  return FONTS.find(f => f.id === id)?.family ?? FONTS[0].family;
}

export function isSerifFont(id: FontId): boolean {
  return FONTS.find(f => f.id === id)?.serif ?? true;
}

// ── Numeric control bounds ─────────────────────────────────────────
// Single source of truth so SettingsDrawer and prefs validation agree.

export const FONT_SIZE = { min: 12, max: 32, step: 1 } as const;
export const LINE_HEIGHT = { min: 1.2, max: 2.6, step: 0.05 } as const;
// 50% .. 100% of the reading area. The lower bound is intentionally
// not less than 50% — narrower than that is unreadable on phone-class
// viewports and the user would never end up there on purpose.
export const COLUMN_WIDTH = { min: 50, max: 100, step: 5 } as const;

// ── Prefs shape ────────────────────────────────────────────────────

export interface ReaderPrefs {
  theme: ThemeId;
  fontSize: number;       // px
  fontFamily: FontId;
  lineHeight: number;     // multiplier
  columnWidth: number;    // rem (was an enum; now free-form)
  pageMode: PageMode;
  /** Per-style memory of the last colour the user picked. Used to
   *  seed the SelectionToolbar when the user creates a NEW annotation
   *  of the given style. Existing annotations are not affected.
   *
   *  `note` is the colour used when the user attaches a note from a
   *  fresh selection — the underlying highlight gets this colour
   *  rather than reusing the highlight pref, so users can
   *  visually distinguish "marked passages" from "marked passages
   *  with my own commentary attached" at a glance. */
  styleColors: {
    highlight: 'yellow' | 'red' | 'green' | 'blue' | 'purple' | 'orange';
    underline: 'yellow' | 'red' | 'green' | 'blue' | 'purple' | 'orange';
    wavy:      'yellow' | 'red' | 'green' | 'blue' | 'purple' | 'orange';
    strike:    'yellow' | 'red' | 'green' | 'blue' | 'purple' | 'orange';
    note:      'yellow' | 'red' | 'green' | 'blue' | 'purple' | 'orange';
  };
  /** AI assistant panel pinned as a floating card. When pinned the
   *  panel doesn't take a backdrop and stays visible while the user
   *  reads — sized small, draggable, parked in the bottom-right by
   *  default. */
  aiPinned?: boolean;
}

export const DEFAULT_PREFS: ReaderPrefs = {
  theme: 'light',
  fontSize: 18,
  fontFamily: 'wenkai',
  lineHeight: 1.85,
  columnWidth: 85,
  pageMode: 'paginated',
  styleColors: {
    highlight: 'yellow',
    underline: 'blue',
    wavy:      'red',
    strike:    'purple',
    note:      'green',
  },
  aiPinned: false,
};

// ── Persistence ────────────────────────────────────────────────────

const KEY_BASE = 'bookfree.reader.prefs.v3';
const STORAGE_KEY_V2 = 'bookfree.reader.prefs.v2';
const STORAGE_KEY_V1 = 'bookfree.reader.prefs.v1';

/** Detects which runtime surface the user is on. We treat a PWA in
 *  standalone display mode as "app" because the user explicitly
 *  installed it, and a Tauri/Electron host as "window". Everything
 *  else (a browser tab, including mobile Safari without standalone)
 *  is plain "web".
 *
 *  Detection runs once at module load — any later runtime mode swap
 *  (extremely rare) won't be picked up, which is fine: prefs are
 *  per-launch state and you want them stable inside one session. */
export function detectPlatform(): Platform {
  try {
    if (typeof window === 'undefined') return 'web';
    type W = Window & {
      __TAURI__?: unknown;
      process?: { versions?: { electron?: unknown } };
      __NEUTRALINO__?: unknown;
    };
    const w = window as W;
    if (w.__TAURI__ || w.__NEUTRALINO__) return 'window';
    if (w.process?.versions?.electron) return 'window';
    // PWA standalone (Chromium / Safari iOS).
    if (window.matchMedia?.('(display-mode: standalone)').matches) return 'app';
    type N = Navigator & { standalone?: boolean };
    if ((navigator as N).standalone) return 'app';
    return 'web';
  } catch {
    return 'web';
  }
}

const PLATFORM: Platform = detectPlatform();
const STORAGE_KEY = `${KEY_BASE}.${PLATFORM}`;

/** Exported so non-prefs code (e.g. dashboards / debug overlays) can
 *  display the active platform without re-running detection. */
export function activePlatform(): Platform {
  return PLATFORM;
}

export function loadPrefs(): ReaderPrefs {
  try {
    // Priority: per-platform v3 → cross-platform v2 → v1 legacy.
    const raw =
      localStorage.getItem(STORAGE_KEY) ??
      localStorage.getItem(STORAGE_KEY_V2) ??
      localStorage.getItem(STORAGE_KEY_V1);
    if (!raw) return clonePrefs(DEFAULT_PREFS);
    const parsed = JSON.parse(raw) as Omit<Partial<ReaderPrefs>, 'fontFamily' | 'columnWidth' | 'styleColors'> & {
      // Legacy enum shapes — we accept and migrate. Wider type than
      // ReaderPrefs since older versions stored string enums here, and
      // a Partial<...> intersection isn't enough to reopen the field.
      fontFamily?: unknown;
      columnWidth?: unknown;
      styleColors?: unknown;
      tocPinned?: unknown;  // legacy field; ignored — we no longer support it
    };
    void parsed.tocPinned;  // explicitly drop legacy field

    // Migrate legacy fontFamily ('serif' | 'sans') → font id.
    let fontFamily: FontId = DEFAULT_PREFS.fontFamily;
    if (isFontId(parsed.fontFamily)) {
      fontFamily = parsed.fontFamily;
    } else if (parsed.fontFamily === 'sans') {
      fontFamily = 'han-sans';
    } else if (parsed.fontFamily === 'serif') {
      fontFamily = 'wenkai';
    }

    // Migrate legacy columnWidth.
    //   • 'narrow'/'normal'/'wide' (v1 enum) → 60 / 80 / 95
    //   • 24 .. 60 (rem, v2 / early v3)        → mapped to 50 .. 100 %
    //   • already in 50 .. 100 (current)        → kept as-is.
    let columnWidth: number = DEFAULT_PREFS.columnWidth;
    if (typeof parsed.columnWidth === 'number' && Number.isFinite(parsed.columnWidth)) {
      const v = parsed.columnWidth;
      if (v >= COLUMN_WIDTH.min && v <= COLUMN_WIDTH.max) {
        columnWidth = clamp(v, COLUMN_WIDTH.min, COLUMN_WIDTH.max);
      } else if (v >= 24 && v <= 60) {
        const pct = Math.round(50 + ((v - 24) / (60 - 24)) * 50);
        columnWidth = clamp(pct, COLUMN_WIDTH.min, COLUMN_WIDTH.max);
      } else {
        columnWidth = clamp(v, COLUMN_WIDTH.min, COLUMN_WIDTH.max);
      }
    } else if (parsed.columnWidth === 'narrow') {
      columnWidth = 60;
    } else if (parsed.columnWidth === 'wide') {
      columnWidth = 95;
    } else if (parsed.columnWidth === 'normal') {
      columnWidth = 80;
    }

    // Per-style colour memory. Old prefs files don't have this — fall
    // back to the defaults.
    const styleColors = parseStyleColors(parsed.styleColors);

    return {
      theme: parsed.theme && isThemeId(parsed.theme) ? parsed.theme : DEFAULT_PREFS.theme,
      fontSize: clamp(parsed.fontSize ?? DEFAULT_PREFS.fontSize, FONT_SIZE.min, FONT_SIZE.max),
      fontFamily,
      lineHeight: clamp(parsed.lineHeight ?? DEFAULT_PREFS.lineHeight, LINE_HEIGHT.min, LINE_HEIGHT.max),
      columnWidth,
      pageMode:
        parsed.pageMode === 'scroll-chapter' || parsed.pageMode === 'scroll-book'
          ? parsed.pageMode
          : 'paginated',
      styleColors,
      aiPinned: !!parsed.aiPinned,
    };
  } catch {
    return clonePrefs(DEFAULT_PREFS);
  }
}

function clonePrefs(p: ReaderPrefs): ReaderPrefs {
  return { ...p, styleColors: { ...p.styleColors } };
}

const VALID_COLORS = new Set(['yellow', 'red', 'green', 'blue', 'purple', 'orange']);
function parseStyleColors(raw: unknown): ReaderPrefs['styleColors'] {
  const def = DEFAULT_PREFS.styleColors;
  if (!raw || typeof raw !== 'object') return { ...def };
  const r = raw as Record<string, unknown>;
  const pick = (k: keyof ReaderPrefs['styleColors']): ReaderPrefs['styleColors'][typeof k] => {
    const v = r[k];
    return typeof v === 'string' && VALID_COLORS.has(v)
      ? (v as ReaderPrefs['styleColors'][typeof k])
      : def[k];
  };
  return {
    highlight: pick('highlight'),
    underline: pick('underline'),
    wavy:      pick('wavy'),
    strike:    pick('strike'),
    note:      pick('note'),
  };
}

export function savePrefs(p: ReaderPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* ignore quota / private mode */
  }
}

/** Returns the column max-width as a CSS length. We accept both the
 *  full ReaderPrefs and just a number for callers that already
 *  resolved the value. The number is interpreted as a percentage of
 *  the reading area width, so the value is always visible regardless
 *  of viewport size. */
export function columnMaxWidth(prefs: ReaderPrefs | number): string {
  const v = typeof prefs === 'number' ? prefs : prefs.columnWidth;
  return `${v}%`;
}

// Which page modes the format actually supports.
export function availableModes(format: string): PageMode[] {
  switch (format) {
    case 'pdf':
      return ['paginated', 'scroll-book'];
    case 'cbz':
      return ['paginated'];
    case 'epub':
      return ['paginated', 'scroll-chapter', 'scroll-book'];
    default:
      // TXT / FB2 / MOBI / AZW — anything backed by book_chapters.
      return ['paginated', 'scroll-chapter', 'scroll-book'];
  }
}

// Narrow a requested mode to one the format supports.
export function resolvePageMode(format: string, requested: PageMode): PageMode {
  const allowed = availableModes(format);
  if (allowed.includes(requested)) return requested;
  if (requested.startsWith('scroll')) {
    if (allowed.includes('scroll-book')) return 'scroll-book';
    if (allowed.includes('scroll-chapter')) return 'scroll-chapter';
  }
  return allowed[0];
}

/** Snap a number to the nearest `step`, then clamp to bounds. Used by
 *  the NumericStepper after free-text input so e.g. "1.83" snaps to
 *  1.85 if step is 0.05. */
export function snapTo(value: number, step: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  const snapped = Math.round(value / step) * step;
  // Round to step's decimals to avoid 1.7500000000001 ugliness.
  const decimals = decimalsOf(step);
  const rounded = +snapped.toFixed(decimals);
  return clamp(rounded, lo, hi);
}

function decimalsOf(step: number): number {
  if (Number.isInteger(step)) return 0;
  const s = String(step);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
