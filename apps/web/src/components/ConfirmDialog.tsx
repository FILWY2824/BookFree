/*
中文导读：
ConfirmDialog 是一个通用的“确认弹窗”组件，常用于删除书籍、退出危险操作等场景。
它不关心具体业务，只接收标题、说明文字、确认按钮文案、取消按钮文案和回调函数。
这种写法属于前端组件复用：页面负责决定“什么时候弹出、确认后做什么”，弹窗组件只负责展示和触发事件。
如果你以后想调整所有确认弹窗的样式、按钮颜色、遮罩层透明度，优先改这个文件。
如果只想改某一个删除操作的文案，通常不改这里，而是去调用 ConfirmDialog 的页面里改 props。
*/

// Generic confirmation modal. We use it for delete operations.

import { useEffect } from 'react';

interface Props {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open, title, message,
  confirmLabel = '确认',
  cancelLabel = '取消',
  destructive,
  onConfirm,
  onCancel,
}: Props) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 animate-fade-in"
      onClick={onCancel}
    >
      <div
        className="bg-white rounded-2xl shadow-elev w-full max-w-md mx-4 p-6"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <h2 className="font-serif text-lg text-ink-800 mb-2">{title}</h2>
        {message && <p className="text-sm text-ink-600 leading-relaxed">{message}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm rounded-lg text-ink-700 hover:bg-paper-100"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={
              'px-4 py-2 text-sm rounded-lg text-white ' +
              (destructive ? 'bg-rose-600 hover:bg-rose-700' : 'bg-accent hover:bg-accent-dark')
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
