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
