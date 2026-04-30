/*
中文导读：
themes.ts 定义阅读器主题，例如浅色、护眼、深色等。
主题配置通常会包含背景色、文字色、边框色、强调色等前端样式值。
阅读器设置面板会读取这些主题，让用户切换阅读体验。
如果你想新增一个主题，通常在这里增加配置，再确认 SettingsDrawer/ReaderPage 是否会自动展示。
这里不应该写后端请求；主题属于前端展示偏好。
*/

// Reader theme registry. Mirrors the eight CSS-variable blocks in
// styles.css. The picker reads `swatchBg` / `swatchFg` to render a
// little chip without having to mount an iframe.
//
// `id` doubles as the value of the `data-reader-theme` attribute the
// reader root sets on itself.
//
// We also expose `colors` for code that runs OUTSIDE the page's CSS
// scope — most notably the EPUB iframe, which doesn't share our CSS
// custom properties. Reading via getComputedStyle worked in principle
// but raced against React's effect ordering (child effects fire
// before parent effects, so the iframe could re-theme using the
// previous data-reader-theme value before the parent had updated
// documentElement). Pulling the colors from this typed table is
// deterministic.

export interface ReaderTheme {
  id: ThemeId;
  name: string;        // displayed in the picker
  swatchBg: string;
  swatchFg: string;
  /** Colors used by surfaces that can't read CSS vars (e.g. the EPUB
   *  iframe). Keep these in sync with the matching `[data-reader-theme]`
   *  block in styles.css. */
  colors: {
    bg: string;
    fg: string;
    border: string;
    muted: string;
  };
}

export type ThemeId =
  | 'light'
  | 'sepia'
  | 'eye'
  | 'mist'
  | 'peach'
  | 'forest'
  | 'slate'
  | 'dark';

export const THEMES: readonly ReaderTheme[] = [
  { id: 'light',  name: '正常',   swatchBg: '#FAF7F2', swatchFg: '#1B2230',
    colors: { bg: '#FAF7F2', fg: '#1B2230', border: '#EBE5D9', muted: '#7A828F' } },
  { id: 'sepia',  name: '羊皮纸', swatchBg: '#F4ECDA', swatchFg: '#3B2D1A',
    colors: { bg: '#F4ECDA', fg: '#3B2D1A', border: '#E5D7B7', muted: '#6E5B3A' } },
  { id: 'eye',    name: '护眼',   swatchBg: '#DDEAD3', swatchFg: '#1F2E1B',
    colors: { bg: '#DDEAD3', fg: '#1F2E1B', border: '#B7CCA6', muted: '#4D6443' } },
  { id: 'mist',   name: '雾色',   swatchBg: '#E7ECEF', swatchFg: '#1A2330',
    colors: { bg: '#E7ECEF', fg: '#1A2330', border: '#C9D2D9', muted: '#5A6878' } },
  { id: 'peach',  name: '蜜桃',   swatchBg: '#FBE5DA', swatchFg: '#4A2415',
    colors: { bg: '#FBE5DA', fg: '#4A2415', border: '#F0CCB8', muted: '#84493A' } },
  { id: 'forest', name: '林夜',   swatchBg: '#1F2E22', swatchFg: '#D9E5D2',
    colors: { bg: '#1F2E22', fg: '#D9E5D2', border: '#2F4233', muted: '#95A892' } },
  { id: 'slate',  name: '石板',   swatchBg: '#232831', swatchFg: '#DCE2EA',
    colors: { bg: '#232831', fg: '#DCE2EA', border: '#313945', muted: '#98A2B0' } },
  { id: 'dark',   name: '深夜',   swatchBg: '#0F1420', swatchFg: '#DCE2EA',
    colors: { bg: '#0F1420', fg: '#DCE2EA', border: '#232A38', muted: '#8C95A4' } },
];

export function getThemeColors(id: ThemeId | string | undefined) {
  const t = THEMES.find(x => x.id === id) ?? THEMES[0];
  return t.colors;
}

export function isThemeId(s: string): s is ThemeId {
  return THEMES.some(t => t.id === s);
}
