// Reader theme registry. Mirrors the eight CSS-variable blocks in
// styles.css. The picker reads `swatchBg` / `swatchFg` to render a
// little chip without having to mount an iframe.
//
// `id` doubles as the value of the `data-reader-theme` attribute the
// reader root sets on itself.

export interface ReaderTheme {
  id: ThemeId;
  name: string;        // displayed in the picker
  swatchBg: string;
  swatchFg: string;
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
  { id: 'light',  name: '正常',   swatchBg: '#FAF7F2', swatchFg: '#1B2230' },
  { id: 'sepia',  name: '羊皮纸', swatchBg: '#F4ECDA', swatchFg: '#3B2D1A' },
  { id: 'eye',    name: '护眼',   swatchBg: '#DDEAD3', swatchFg: '#1F2E1B' },
  { id: 'mist',   name: '雾色',   swatchBg: '#E7ECEF', swatchFg: '#1A2330' },
  { id: 'peach',  name: '蜜桃',   swatchBg: '#FBE5DA', swatchFg: '#4A2415' },
  { id: 'forest', name: '林夜',   swatchBg: '#1F2E22', swatchFg: '#D9E5D2' },
  { id: 'slate',  name: '石板',   swatchBg: '#232831', swatchFg: '#DCE2EA' },
  { id: 'dark',   name: '深夜',   swatchBg: '#0F1420', swatchFg: '#DCE2EA' },
];

export function isThemeId(s: string): s is ThemeId {
  return THEMES.some(t => t.id === s);
}
