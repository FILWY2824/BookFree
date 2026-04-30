/*
中文导读：
format.ts 放一些纯格式化工具函数，例如把字节数显示成 KB/MB、把时间戳显示成人类可读文本。
这类函数应该保持“输入什么，输出什么”，不要在里面请求后端或修改全局状态。
页面和组件可以复用这些函数，避免每个地方都重复写格式化逻辑。
如果你发现多个页面的日期、文件大小、百分比显示不一致，优先把规则统一到这里。
*/

// Tiny formatters reused across pages.

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatRelative(unixSec: number): string {
  const now = Date.now() / 1000;
  const delta = now - unixSec;
  if (delta < 60) return '刚刚';
  if (delta < 3600) return `${Math.floor(delta / 60)} 分钟前`;
  if (delta < 86400) return `${Math.floor(delta / 3600)} 小时前`;
  if (delta < 7 * 86400) return `${Math.floor(delta / 86400)} 天前`;
  const d = new Date(unixSec * 1000);
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
}

// Deterministic colour from a string — used to give books a stable
// spine colour without forcing the user to upload a cover.
export function stringHashColor(s: string): { bg: string; fg: string } {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  const palette = [
    { bg: '#7C5A3A', fg: '#A57E55' }, // accent
    { bg: '#3F4855', fg: '#5A626F' }, // ink
    { bg: '#475C49', fg: '#6E8870' }, // forest
    { bg: '#5C3A4A', fg: '#7A506A' }, // wine
    { bg: '#3A4A5C', fg: '#5A6E84' }, // ocean
    { bg: '#5C5A3A', fg: '#827E55' }, // straw
    { bg: '#3A5C5A', fg: '#557E7A' }, // teal
    { bg: '#5C3A3A', fg: '#825555' }, // brick
  ];
  return palette[Math.abs(h) % palette.length];
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
