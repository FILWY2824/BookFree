// Table-of-contents drawer — permanently docked.
//
// Behaviour change vs the previous version:
//   • Header bar is now STICKY at the top of the drawer's scroll
//     container, so "目录" and the locate button stay reachable as
//     the user scrolls a long TOC.
//   • Adds a "定位到当前章节" button that scrolls the active entry
//     into view. The parent owns the trigger via `locateTick`; we
//     observe it with a ref and run scrollIntoView when it changes.
//
// What this component is responsible for:
//   • rendering the hierarchical TOC tree
//   • indenting nested entries by depth
//   • highlighting the currently-active chapter
//   • emitting onPick(chapterId) when the user clicks an entry
//   • scrolling the active entry into view on locateTick change
//
// What it deliberately doesn't do:
//   • slide-in animation (the dock is always present; visibility
//     toggling at the parent flips display entirely)
//   • pin / unpin chrome (the legacy `tocPinned` pref is gone)

import { useEffect, useMemo, useRef } from 'react';
import type { TocItem } from '../lib/toc';

interface Props {
  items: TocItem[];
  /** Active chapter id — derived from the reader's emitted
   *  activeChapterId in the parent. We accept the id directly (not
   *  an ord) so the drawer doesn't have to know chapter ordering. */
  activeChapterId: string | null;
  onPick: (chapterId: string) => void;
  /** Counter incremented by the parent whenever the user clicks the
   *  in-drawer "定位" button. We watch this with a ref and scroll
   *  the active entry into view whenever it changes. */
  locateTick: number;
  /** Called when the user clicks the in-drawer locate button. The
   *  parent reciprocates by bumping locateTick. We could trigger
   *  scrollIntoView ourselves on click, but routing through a parent
   *  state lets ReaderPage also expose the same behaviour from the
   *  header in the future. */
  onLocateRequest: () => void;
}

export default function TocDrawer({
  items, activeChapterId, onPick, locateTick, onLocateRequest,
}: Props) {
  const flat = useMemo(() => flatten(items), [items]);
  const listRef = useRef<HTMLUListElement>(null);
  const activeRef = useRef<HTMLLIElement>(null);

  // Scroll the active entry into view whenever the locate tick changes.
  useEffect(() => {
    if (locateTick === 0) return;
    const el = activeRef.current;
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [locateTick]);

  return (
    <aside
      className="h-full w-72 shrink-0 border-r flex flex-col"
      style={{
        background: 'var(--reader-bg)',
        borderColor: 'var(--reader-border)',
        color: 'var(--reader-fg)',
      }}
    >
      {/* Fixed header bar — sits at the top of the drawer; the list
          below it scrolls independently. We tag it shrink-0 so the
          height is stable and the title doesn't get pushed off when
          the list is long. */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b shrink-0"
        style={{ borderColor: 'var(--reader-border)', background: 'var(--reader-bg)' }}
      >
        <h3 className="font-serif text-lg">目录</h3>
        <button
          type="button"
          onClick={onLocateRequest}
          disabled={!activeChapterId}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-xs"
          style={{
            background: activeChapterId ? 'rgba(0,0,0,0.05)' : 'transparent',
            opacity: activeChapterId ? 1 : 0.4,
            color: 'var(--reader-fg)',
          }}
          title="定位到当前章节"
          aria-label="定位到当前章节"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>
          </svg>
          定位
        </button>
      </div>

      <ul ref={listRef} className="px-2 py-2 flex-1 overflow-y-auto scrollbar-thin">
        {flat.length === 0 && (
          <li className="px-3 py-4 text-sm" style={{ color: 'var(--reader-muted)' }}>
            暂无目录
          </li>
        )}
        {flat.map((entry, i) => {
          const active = !!entry.chapterId && entry.chapterId === activeChapterId;
          const clickable = !!entry.chapterId;
          return (
            <li
              key={(entry.chapterId ?? 'h') + ':' + i}
              ref={active ? activeRef : undefined}
            >
              <button
                onClick={() => clickable && onPick(entry.chapterId!)}
                disabled={!clickable}
                className={
                  'w-full text-left px-3 py-1.5 rounded-lg text-sm leading-snug transition-colors '
                  + (active ? 'font-medium ' : '')
                  + (clickable ? '' : 'cursor-default')
                }
                style={{
                  paddingLeft: 12 + entry.depth * 14 + 'px',
                  background: active ? 'var(--reader-accent)' : 'transparent',
                  color: active ? '#fff' : 'var(--reader-fg)',
                  opacity: clickable || active ? 1 : 0.65,
                }}
                onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => {
                  if (!active && clickable) {
                    (e.currentTarget as HTMLButtonElement).style.background = 'rgba(0,0,0,0.04)';
                  }
                }}
                onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
                  if (!active) {
                    (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                  }
                }}
                title={entry.label}
              >
                <span className="line-clamp-2 block">{entry.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

interface FlatEntry {
  label: string;
  chapterId?: string;
  depth: number;
}

function flatten(items: TocItem[]): FlatEntry[] {
  const out: FlatEntry[] = [];
  const walk = (list: TocItem[], depth: number) => {
    for (const it of list) {
      out.push({
        label: it.label,
        chapterId: it.chapterId,
        depth: typeof it.depth === 'number' ? it.depth : depth,
      });
      if (it.children && it.children.length) walk(it.children, depth + 1);
    }
  };
  walk(items, 0);
  return out;
}
