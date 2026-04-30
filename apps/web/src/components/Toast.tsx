/*
中文导读：
Toast 是全局轻提示组件，用于显示“上传成功、登录失败、保存完成”等短消息。
它通常通过 ToastProvider 在应用顶层提供能力，页面里调用 toast.success/toast.error 等方法。
Toast 的特点是：不打断用户操作，只在页面角落短暂显示。
如果你想修改提示出现位置、颜色、自动消失时间、动画效果，优先看这个文件。
如果只是想改某个业务提示文案，通常去调用 toast 的页面或 handler 里改。
*/

// Tiny toast system. We avoid bundling a notification library because
// most of them carry animation deps we already cover with raw CSS.
//
// Usage:
//   import { useToast } from '../components/Toast';
//   const { toast } = useToast();
//   toast.success('已删除');
//   toast.error('上传失败：' + e.message);

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';

type Tone = 'info' | 'success' | 'error';

interface ToastItem {
  id: number;
  tone: Tone;
  message: string;
}

interface Ctx {
  toast: {
    info: (m: string) => void;
    success: (m: string) => void;
    error: (m: string) => void;
  };
}

const ToastCtx = createContext<Ctx | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const push = useCallback((tone: Tone, message: string) => {
    const id = ++idRef.current;
    setItems(prev => [...prev, { id, tone, message }]);
    setTimeout(() => {
      setItems(prev => prev.filter(t => t.id !== id));
    }, tone === 'error' ? 5000 : 3000);
  }, []);

  const value = useMemo<Ctx>(() => ({
    toast: {
      info: m => push('info', m),
      success: m => push('success', m),
      error: m => push('error', m),
    },
  }), [push]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
        {items.map(t => <ToastView key={t.id} item={t} />)}
      </div>
    </ToastCtx.Provider>
  );
}

function ToastView({ item }: { item: ToastItem }) {
  const tone =
    item.tone === 'success' ? 'bg-emerald-600' :
    item.tone === 'error'   ? 'bg-rose-600' :
                              'bg-ink-700';
  return (
    <div className={`pointer-events-auto rounded-lg ${tone} text-white text-sm px-4 py-2.5 shadow-elev animate-fade-in`}>
      {item.message}
    </div>
  );
}

export function useToast(): Ctx {
  const v = useContext(ToastCtx);
  if (!v) {
    // Defensive: lets pages call useToast() outside a provider during
    // tests without crashing — they get an inert object.
    return {
      toast: {
        info: () => {}, success: () => {}, error: () => {},
      },
    };
  }
  return v;
}

// re-export for convenience in places where we wire effects to toasts.
export { useEffect };
