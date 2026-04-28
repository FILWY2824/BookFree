// Table-of-contents drawer — now permanently docked.
//
// Behaviour change vs the previous version:
//   The drawer used to operate in two modes — a floating overlay
//   triggered from the header's TOC button, plus a "pinned" docked
//   variant the user could opt into. The user explicitly asked that
//   the TOC stay put in the docked position at all times, so we've
//   collapsed both modes into a single docked aside that the parent
//   renders next to the reader column. The header's TOC button now
//   only toggles VISIBILITY of this dock (so users with narrow
//   viewports can still claim the full reader width when they want).
//
// What this component is responsible for:
//   • rendering the hierarchical TOC tree returned by /api/books/{id}/toc
//   • indenting nested entries by depth
//   • highlighting the currently-active chapter
//   • emitting onPick(chapterId) when the user clicks an entry
//
// What it deliberately doesn't do:
//   • opening / closing animations (the dock is always present;
//     visibility toggling at the parent flips display entirely so we
//     don't need slide-in keyframes)
//   • pin / unpin chrome (there's nothing to pin to anymore)

import { useMemo } from 'react';
import type { TocItem } from '../lib/toc';

interface Props {
  items: TocItem[];
  /** Active chapter id — derived from the reader's chapterOrd in the
   *  parent. We accept the id directly (rather than an ord) so the
   *  drawer doesn't have to know how chapters are ordered. */
  activeChapterId: string | null;
  onPick: (chapterId: string) => void;
}

export default function TocDrawer({ items, activeChapterId, onPick }: Props) {
  // Flatten while preserving depth so we can render with one pass and
  // a single keyboard tab order. We compute this once per items change.
  const flat = useMemo(() => flatten(items), [items]);

  return (
    <aside
      className="h-full w-72 shrink-0 border-r overflow-y-auto scrollbar-thin"
      style={{
        background: 'var(--reader-bg)',
        borderColor: 'var(--reader-border)',
        color: 'var(--reader-fg)',
      }}
    >
      <div
        className="px-5 py-4 border-b"
        style={{ borderColor: 'var(--reader-border)' }}
      >
        <h3 className="font-serif text-lg">目录</h3>
      </div>
      <ul className="px-2 py-2">
        {flat.length === 0 && (
          <li className="px-3 py-4 text-sm" style={{ color: 'var(--reader-muted)' }}>
            暂无目录
          </li>
        )}
        {flat.map((entry, i) => {
          const active = !!entry.chapterId && entry.chapterId === activeChapterId;
          const clickable = !!entry.chapterId;
          return (
            <li key={(entry.chapterId ?? 'h') + ':' + i}>
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
