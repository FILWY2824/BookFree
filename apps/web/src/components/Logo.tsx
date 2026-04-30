/*
中文导读：
Logo 是 BookFree 的品牌图标组件，负责在侧边栏、登录页或顶部区域展示统一标识。
它通常不包含业务逻辑，只包含 SVG/HTML 结构和样式 className。
如果你想换图标、改颜色、改大小，优先看这个文件。
如果某个页面只想临时改变 Logo 尺寸，一般通过传入 className 或外层容器样式实现，而不是复制一份新 Logo。
*/

// The BookFree mark — an open-book glyph drawn from primitives so it
// scales crisply at any size and inherits currentColor for theming.

interface Props {
  size?: number;
  className?: string;
  withText?: boolean;
}

export default function Logo({ size = 28, className = '', withText = true }: Props) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <path
          d="M4 6.5C4 5.67 4.67 5 5.5 5H14a3 3 0 013 3v18a1 1 0 01-1.45.9A8 8 0 0012 26H5.5A1.5 1.5 0 014 24.5v-18z"
          fill="currentColor" opacity="0.85"
        />
        <path
          d="M28 6.5C28 5.67 27.33 5 26.5 5H18a3 3 0 00-3 3v18a1 1 0 001.45.9A8 8 0 0120 26h6.5a1.5 1.5 0 001.5-1.5v-18z"
          fill="currentColor"
        />
        <line x1="16" y1="9" x2="16" y2="26" stroke="white" strokeWidth="0.6" opacity="0.4" />
      </svg>
      {withText && <span className="font-serif text-lg tracking-wide">BookFree</span>}
    </span>
  );
}
