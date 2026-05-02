/*
中文导读：
TocDrawer 是阅读器中的“目录抽屉”组件，用于展示一本书的章节目录并支持跳转。
它通常接收章节列表、当前章节位置、关闭回调和章节点击回调。
这个组件只负责目录 UI 和用户点击，不应该自己去解析书籍或请求章节正文。
如果你想改目录层级缩进、当前章节高亮、抽屉打开/关闭样式，优先看这里。
如果你想改变目录数据从哪里来，需要去 ReaderPage、后端 chapters 接口或具体 parser 中查看。
*/

// Table-of-contents drawer — permanently docked.
//
// Rewrite (per Round-3 user feedback):
//
//   ─ Foldable tree.
//     Every node with children gets a chevron toggle. The flat-list
//     rendering of the previous version made it impossible to fold
//     long sections away — and made deeply-nested books feel
//     unnavigable. Each parent now shows a `▸` / `▾` glyph; clicking
//     the glyph (or pressing Enter on it) toggles its subtree.
//     Clicking the LABEL still navigates as before so users with
//     "I just want to jump to this chapter" muscle memory aren't
//     hijacked by the new affordance.
//
//   ─ Auto-expand active branch.
//     The parent passes `activePath` (an ordered list of ancestor
//     labels from root → current section). Every node on that path
//     is forced expanded for the duration the user is in that
//     section, so the highlighted row is always visible without the
//     user having to manually fold things open. User-toggled state
//     is layered on top: if you EXPAND a node the active path
//     doesn't touch, it stays expanded; if you COLLAPSE a node on
//     the active path, the auto-expand wins until you navigate away.
//
//   ─ Track to ancestor.
//     The flat `activeChapterId` / `activeLabel` matching from the
//     previous version still works, but now we ALSO accept a path.
//     If the parent matched a deeper heading against a shallower
//     TOC entry (e.g. user is in section "1.2.1" but TOC tops out
//     at "1.2"), the activeLabel is the matched ancestor — and that
//     ancestor's row is highlighted.
//
//   ─ Hierarchical depth respected.
//     The previous version flattened with `depth * 14px` indentation
//     but rendered every node clickable as a single list item. The
//     new version preserves the tree shape, which means the auto-
//     expand can do something meaningful and indentation reads as
//     real hierarchy rather than a visual hint.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { TocItem } from '../lib/toc';

interface Props {
  items: TocItem[];
  /** Active chapter id from the spine — used as the LAST-RESORT
   *  match when we couldn't match the heading text against the TOC.
   *  Many books have multiple TOC sections per chapter file, so the
   *  chapterId match alone isn't enough; see activeLabel/activePath. */
  activeChapterId: string | null;
  /** Active TOC entry label (the deepest matched node's label). When
   *  given, we prefer label match over chapterId match — the same
   *  chapterId can map to several rows but the label is unique per
   *  row. */
  activeLabel?: string | null;
  /** Path of TOC labels from root → matched node, used to auto-
   *  expand every parent on the way down. Empty when no heading
   *  matched the TOC at all (in which case nothing is force-
   *  expanded). */
  activePath?: string[];
  onPick: (chapterId: string) => void;
  /** Counter incremented by the parent whenever the user clicks the
   *  in-drawer "定位" button. */
  locateTick: number;
  onLocateRequest: () => void;
}

export default function TocDrawer({
  items, activeChapterId, activeLabel, activePath = [],
  onPick, locateTick, onLocateRequest,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  // User-toggled expand/collapse state. Keyed by the same path-string
  // we use for the auto-expand set, so the two layers compose
  // cleanly. `null` value = follow the auto-expand default; `true` /
  // `false` = explicit user override.
  const [userToggle, setUserToggle] = useState<Record<string, boolean>>({});

  // Auto-expand set — every label on the active path is in here, plus
  // all labels equal to or above the active row. Recomputed when the
  // active path changes. We use a Set of the FULL path-keys so labels
  // that repeat at different depths don't collide.
  const autoExpandKeys = useMemo(() => {
    const s = new Set<string>();
    let acc = '';
    for (const lbl of activePath) {
      acc = acc ? acc + ' ▸ ' + lbl : lbl;
      s.add(acc);
    }
    return s;
  }, [activePath]);

  // When the active path changes, we don't WIPE userToggle — we just
  // ensure freshly-active branches default to expanded. User overrides
  // for OFF-path branches survive across navigations, which is the
  // expected behaviour for a long reading session.

  // Locate button — scroll the active row into view.
  useEffect(() => {
    if (locateTick === 0) return;
    const el = activeRef.current;
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [locateTick]);

  // When the active branch changes, also auto-scroll the active row
  // into view (smoothly) so the user's current position is always
  // visible. This is what "TOC tracks the reader" actually feels
  // like in practice — the previous version highlighted the row but
  // didn't keep it visible, so a fast-flipped chapter could land off-
  // screen and the user would think tracking had failed.
  useEffect(() => {
    const el = activeRef.current;
    if (!el) return;
    // `nearest` so we don't jerk the scroll when the active row is
    // already visible — only correct when it's actually off-screen.
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeLabel, activeChapterId]);

  return (
    <aside
      className="reader-toc-dock h-full w-72 shrink-0 border-r flex flex-col"
      style={{
        background: 'var(--reader-bg)',
        borderColor: 'var(--reader-border)',
        color: 'var(--reader-fg)',
      }}
    >
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

      <div ref={listRef} className="flex-1 overflow-y-auto scrollbar-thin px-1.5 py-2">
        {items.length === 0 && (
          <div className="px-3 py-4 text-sm" style={{ color: 'var(--reader-muted)' }}>
            暂无目录
          </div>
        )}
        {items.map((it, i) => (
          <TocNode
            key={(it.chapterId ?? 'h') + ':' + i}
            item={it}
            depth={0}
            pathKey={it.label}
            activeChapterId={activeChapterId}
            activeLabel={activeLabel ?? null}
            autoExpandKeys={autoExpandKeys}
            userToggle={userToggle}
            setUserToggle={setUserToggle}
            onPick={onPick}
            activeRef={activeRef}
          />
        ))}
      </div>
    </aside>
  );
}

interface NodeProps {
  item: TocItem;
  depth: number;
  pathKey: string;
  activeChapterId: string | null;
  activeLabel: string | null;
  autoExpandKeys: Set<string>;
  userToggle: Record<string, boolean>;
  setUserToggle: (fn: (prev: Record<string, boolean>) => Record<string, boolean>) => void;
  onPick: (chapterId: string) => void;
  activeRef: React.MutableRefObject<HTMLDivElement | null>;
}

function TocNode({
  item, depth, pathKey, activeChapterId, activeLabel,
  autoExpandKeys, userToggle, setUserToggle, onPick, activeRef,
}: NodeProps) {
  const hasChildren = !!(item.children && item.children.length);

  // Determine whether the row is the "active" one (highlighted).
  // Label match wins; chapterId match is the fallback. We check
  // only when there IS a current label or id, so empty inputs
  // can't match an empty TOC label.
  const isActive = (() => {
    if (activeLabel && item.label === activeLabel) return true;
    if (!activeLabel && activeChapterId && item.chapterId === activeChapterId) return true;
    return false;
  })();

  // isAncestor：当前节点是活跃路径上的祖先节点（但不是叶子节点本身）。
  // 祖先节点需要二级高亮，以便用户看到三级、四级子目录时，
  // 其上级目录标题在目录树中也保持视觉高亮，不脱离目录追踪。
  const isAncestor = !isActive && autoExpandKeys.has(pathKey);

  const userPref = userToggle[pathKey];
  const autoExpanded = autoExpandKeys.has(pathKey);
  const expanded = autoExpanded || userPref !== false;

  const clickable = !!item.chapterId;

  const toggle = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setUserToggle(prev => ({ ...prev, [pathKey]: !expanded }));
  };

  return (
    <div>
      <div
        ref={isActive ? activeRef : undefined}
        className="toc-row"
        data-active={isActive ? '1' : isAncestor ? 'ancestor' : undefined}
        style={{
          // Indent by depth: 14px per level, plus 8px gutter.
          paddingLeft: 8 + depth * 14 + 'px',
          background: isActive
            ? 'var(--reader-accent)'
            : isAncestor
              ? 'var(--reader-accent-weak, rgba(124,90,58,0.12))'
              : 'transparent',
          color: isActive ? '#fff' : 'var(--reader-fg)',
          // 祖先节点左侧加一条细线，表示当前阅读位置在这条路径上
          borderLeft: isAncestor
            ? '2px solid var(--reader-accent)'
            : '2px solid transparent',
        }}
      >
        {/* Chevron — only for parents. We render a placeholder for
            leaves so labels at the same depth align horizontally. */}
        {hasChildren ? (
          <button
            type="button"
            className="toc-chevron"
            onClick={toggle}
            onKeyDown={(e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') toggle(e);
            }}
            aria-expanded={expanded}
            aria-label={expanded ? '收起' : '展开'}
            title={expanded ? '收起' : '展开'}
            style={{ color: isActive ? '#fff' : 'var(--reader-fg)' }}
          >
            <svg
              width="10" height="10" viewBox="0 0 16 16"
              style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 120ms ease' }}
              aria-hidden="true"
            >
              <path d="M5 3 L11 8 L5 13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : (
          <span className="toc-chevron toc-chevron-spacer" aria-hidden="true" />
        )}

        <button
          type="button"
          className="toc-label"
          onClick={() => clickable && onPick(item.chapterId!)}
          disabled={!clickable}
          title={item.label}
          style={{
            color: 'inherit',
            opacity: clickable || isActive ? 1 : 0.65,
            cursor: clickable ? 'pointer' : 'default',
          }}
        >
          <span className="toc-label-text">{item.label}</span>
        </button>
      </div>

      {hasChildren && expanded && (
        <div role="group">
          {item.children!.map((child, idx) => (
            <TocNode
              key={(child.chapterId ?? 'h') + ':' + idx}
              item={child}
              depth={depth + 1}
              pathKey={pathKey + ' ▸ ' + child.label}
              activeChapterId={activeChapterId}
              activeLabel={activeLabel}
              autoExpandKeys={autoExpandKeys}
              userToggle={userToggle}
              setUserToggle={setUserToggle}
              onPick={onPick}
              activeRef={activeRef}
            />
          ))}
        </div>
      )}
    </div>
  );
}
