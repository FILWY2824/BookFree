// Table-of-contents drawer.
//
// History: this used to share the right-side `drawer-in` keyframe
// with the SettingsDrawer and applied `animation-direction: reverse`
// to "play it backwards" for a left-side drawer. That made the
// drawer animate AWAY from its visible position before snapping back
// (because the inline `transform: translateX(0)` overrode the
// animation's final state), producing the brief "flash" the user
// reported. We now have a dedicated left-side keyframe
// (`drawer-in-left`) and rely on `animation-fill-mode: both` so the
// final transform sticks.
//
// New: pinning. The drawer can be docked to the side (`pinned=true`),
// in which case it shrinks the reader column instead of overlaying
// it, doesn't take a backdrop, and stays put when the user clicks
// inside the reader. Pin state is owned by the parent (it has to
// reflow the reader column), so we just expose onTogglePin.

interface Chapter {
  id: string;
  ord: number;
  title?: string | null;
}

interface Props {
  open: boolean;
  pinned: boolean;
  chapters: Chapter[];
  current: number;
  onPick: (ord: number) => void;
  onClose: () => void;
  onTogglePin: () => void;
}

export default function TocDrawer({
  open, pinned, chapters, current, onPick, onClose, onTogglePin,
}: Props) {
  if (!open && !pinned) return null;

  // Pinned mode: render as a flow-positioned aside the parent
  // arranges in a flex layout. No backdrop, no overlay.
  if (pinned) {
    return (
      <aside
        className="h-full w-72 shrink-0 border-r overflow-y-auto scrollbar-thin"
        style={{
          background: 'var(--reader-bg)',
          borderColor: 'var(--reader-border)',
          color: 'var(--reader-fg)',
        }}
      >
        <Header pinned title onTogglePin={onTogglePin} onClose={onClose} />
        <List chapters={chapters} current={current} onPick={(o) => onPick(o)} />
      </aside>
    );
  }

  // Floating mode.
  return (
    <div className="fixed inset-0 z-40" onMouseDown={onClose}>
      <div className="absolute inset-0 bg-ink-900/30 animate-fade-in" />
      <aside
        onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
        className="absolute left-0 top-0 h-full w-80 max-w-[88vw] border-r shadow-elev animate-drawer-in-left overflow-y-auto scrollbar-thin"
        style={{
          background: 'var(--reader-bg)',
          borderColor: 'var(--reader-border)',
          color: 'var(--reader-fg)',
        }}
      >
        <Header pinned={false} title onTogglePin={onTogglePin} onClose={onClose} />
        <List
          chapters={chapters}
          current={current}
          onPick={(o) => { onPick(o); onClose(); }}
        />
      </aside>
    </div>
  );
}

function Header({
  pinned, title, onTogglePin, onClose,
}: {
  pinned: boolean; title: boolean;
  onTogglePin: () => void; onClose: () => void;
}) {
  void title;
  return (
    <div
      className="px-5 py-4 border-b flex items-center justify-between"
      style={{ borderColor: 'var(--reader-border)' }}
    >
      <h3 className="font-serif text-lg">目录</h3>
      <div className="flex items-center gap-1">
        <button
          onClick={onTogglePin}
          aria-label={pinned ? '取消固定' : '固定目录'}
          title={pinned ? '取消固定' : '固定目录'}
          className="p-1.5 opacity-70 hover:opacity-100"
        >
          {pinned ? (
            // Pin filled (already pinned)
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M14 2.5L21.5 10l-4 1-3.5 6.5-3-3-5 5-1-1 5-5-3-3L13.5 6 14 2.5z"/>
            </svg>
          ) : (
            // Pin outline (not yet pinned)
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 2.5L21.5 10l-4 1-3.5 6.5-3-3-5 5-1-1 5-5-3-3L13.5 6 14 2.5z"/>
            </svg>
          )}
        </button>
        {!pinned && (
          <button
            onClick={onClose}
            aria-label="关闭"
            className="p-1.5 opacity-70 hover:opacity-100"
            title="关闭"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

function List({
  chapters, current, onPick,
}: { chapters: Chapter[]; current: number; onPick: (ord: number) => void }) {
  return (
    <ul className="px-2 py-2">
      {chapters.length === 0 && (
        <li className="px-3 py-4 text-sm" style={{ color: 'var(--reader-muted)' }}>暂无目录</li>
      )}
      {chapters.map(c => {
        const active = c.ord === current;
        return (
          <li key={c.id}>
            <button
              onClick={() => onPick(c.ord)}
              className={
                'w-full text-left px-3 py-2 rounded-lg text-sm leading-snug transition-colors '
                + (active ? 'font-medium' : '')
              }
              style={
                active
                  ? { background: 'var(--reader-accent)', color: '#fff' }
                  : { color: 'var(--reader-fg)' }
              }
              onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => {
                if (!active) {
                  (e.currentTarget as HTMLButtonElement).style.background = 'rgba(0,0,0,0.04)';
                }
              }}
              onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
                if (!active) {
                  (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                }
              }}
            >
              <div
                className="text-xs mb-0.5"
                style={{ opacity: active ? 0.85 : 0.55 }}
              >第 {c.ord + 1} 章</div>
              <div className="line-clamp-2">{c.title || '（无标题）'}</div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
