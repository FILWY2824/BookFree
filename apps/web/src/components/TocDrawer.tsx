// Table-of-contents drawer. Renders the chapter list as a vertical
// list with an active-state highlight on the currently-rendered ord.

interface Chapter {
  id: string;
  ord: number;
  title?: string | null;
}

interface Props {
  open: boolean;
  chapters: Chapter[];
  current: number;
  onPick: (ord: number) => void;
  onClose: () => void;
}

export default function TocDrawer({ open, chapters, current, onPick, onClose }: Props) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40" onClick={onClose}>
      <div className="absolute inset-0 bg-ink-900/30 animate-fade-in" />
      <div
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
        className="absolute left-0 top-0 h-full w-80 bg-paper-50 border-r border-paper-300/70 shadow-elev overflow-y-auto"
        style={{ animation: 'drawer-in 220ms cubic-bezier(0.2, 0.8, 0.2, 1) reverse', transform: 'translateX(0)' }}
      >
        <div className="px-5 py-4 border-b border-paper-300/70 flex items-center justify-between">
          <h3 className="font-serif text-lg text-ink-800">目录</h3>
          <button onClick={onClose} className="text-ink-500 hover:text-ink-800" aria-label="关闭">✕</button>
        </div>
        <ul className="px-2 py-2">
          {chapters.length === 0 && (
            <li className="px-3 py-4 text-sm text-ink-500">暂无目录</li>
          )}
          {chapters.map(c => {
            const active = c.ord === current;
            return (
              <li key={c.id}>
                <button
                  onClick={() => { onPick(c.ord); onClose(); }}
                  className={
                    'w-full text-left px-3 py-2 rounded-lg text-sm leading-snug transition-colors ' +
                    (active
                      ? 'bg-accent/10 text-accent-dark font-medium'
                      : 'text-ink-700 hover:bg-paper-200/60')
                  }
                >
                  <div className="text-xs text-ink-400 mb-0.5">第 {c.ord + 1} 章</div>
                  <div className="line-clamp-2">{c.title || '（无标题）'}</div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
