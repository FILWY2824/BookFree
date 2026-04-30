/*
中文导读：
BlockingModal 是一种阻塞式弹窗，用于展示必须等待或必须处理的状态。
和 Toast 不同，BlockingModal 会覆盖页面并阻止用户继续操作，适合上传解析中、重要确认中或不可恢复错误提示。
这个组件应保持简单，只负责展示遮罩、标题、说明、按钮或 loading 状态。
如果你想改全局遮罩样式、居中弹窗样式、按钮排列，优先看这里。
如果你只想改某个阻塞弹窗的业务文案，通常去调用它的页面里改 props。
*/

// BlockingModal — a centered card with a spinner and a label that
// blocks all interaction with the reader underneath. We use it for
// two scenarios:
//
//   1. The book is opening. Until the format-specific reader signals
//      that it's ready to render the first page, we show "正在打开
//      书籍引擎…" so the user has feedback for what could otherwise
//      be a multi-second blank screen.
//
//   2. A reading-setting change has been made (font, theme, page
//      mode). Some changes — especially layout-affecting ones in
//      paginated mode — require us to re-paginate the whole chapter,
//      which can take 100-400 ms. Without this modal, the user clicks
//      the toggle, sees nothing happen, and clicks again before we've
//      had a chance to react.
//
// Both scenarios pass `open` and a label; we don't try to be clever
// about progress (no percentage), because the underlying tasks don't
// expose one and a fake bar would feel worse than a busy spinner.
//
// We deliberately accept clicks on the backdrop without dismissing —
// this is "blocking" in the literal sense: the user can't do anything
// else until the work finishes.

interface Props {
  open: boolean;
  label: string;
}

export default function BlockingModal({ open, label }: Props) {
  if (!open) return null;
  return (
    <div className="modal-blocking-backdrop" role="alertdialog" aria-busy="true" aria-live="polite">
      <div className="modal-blocking-card">
        <span className="spinner-ring" aria-hidden="true" />
        <span className="text-sm">{label}</span>
      </div>
    </div>
  );
}
