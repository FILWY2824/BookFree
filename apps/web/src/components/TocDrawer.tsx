/*
中文导读：
TocDrawer 是阅读器中的"目录抽屉"组件，用于展示一本书的章节目录并支持跳转。

颠覆式重构（v3）：
- 默认所有节点都展开。这是用户最常需要的状态——一进来就能看到全部层级。
- 用户可以点击展开/收起箭头主动收起某个分支；这种用户偏好会被记忆。
- 当前阅读位置所在的"活跃路径"上的所有节点强制展开（即使用户曾收起），
  保证用户始终能看到自己阅读到哪儿。
- 活跃叶子节点（最深匹配项）显示强高亮；其所有上级节点显示弱"祖先"高亮，
  这样多层目录里也能立刻看清当前在哪一支。
- 激活节点变化时自动滚动到视野中央。

数据契约：
- items：层级目录树
- activeChapterId：当前正在阅读的章节 ID
- activeLabel：在目录中匹配到的最深节点 label（用于强高亮）
- activePath：从根到匹配节点的全部 label 链（用于祖先高亮 + 自动展开）
*/

import { useEffect, useMemo, useRef, useState } from 'react';
import type { TocItem } from '../lib/toc';

interface Props {
  items: TocItem[];
  activeChapterId: string | null;
  activeLabel?: string | null;
  activePath?: string[];
  onPick: (chapterId: string) => void;
  locateTick: number;
  onLocateRequest: () => void;
}

export default function TocDrawer({
  items, activeChapterId, activeLabel, activePath = [],
  onPick, locateTick, onLocateRequest,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  // 用户主动收起的节点集合。键为节点路径字符串。
  // 默认展开 = 不在此集合中。用户点击收起 → 加入集合。再次点击展开 → 从集合移除。
  const [userCollapsed, setUserCollapsed] = useState<Set<string>>(() => new Set());

  // 活跃路径上每一级节点的路径键集合，这些节点强制展开（覆盖用户收起）。
  // 例如 activePath = ["A","B","C"] → 集合 = {"A", "A>B", "A>B>C"}。
  const forceExpandedKeys = useMemo(() => {
    const s = new Set<string>();
    let acc = '';
    for (const lbl of activePath) {
      acc = acc ? acc + '>' + lbl : lbl;
      s.add(acc);
    }
    return s;
  }, [activePath]);

  const toggle = (pathKey: string) => {
    setUserCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(pathKey)) next.delete(pathKey);
      else next.add(pathKey);
      return next;
    });
  };

  // "定位"按钮：把活跃行滚到视野中央。
  useEffect(() => {
    if (locateTick === 0) return;
    const el = activeRef.current;
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [locateTick]);

  // 活跃节点变化 → 自动滚动到视野中（如已可见则不动）。
  useEffect(() => {
    const id = window.requestAnimationFrame(() => {
      const el = activeRef.current;
      if (!el) return;
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    return () => window.cancelAnimationFrame(id);
  }, [activeLabel, activeChapterId]);

  // 首次挂载且数据齐全时滚到中央。
  const initialScrollDone = useRef(false);
  useEffect(() => {
    if (initialScrollDone.current) return;
    if (items.length === 0 || (!activeChapterId && !activeLabel)) return;
    initialScrollDone.current = true;
    const t = window.setTimeout(() => {
      const el = activeRef.current;
      if (el) el.scrollIntoView({ block: 'center', behavior: 'auto' });
    }, 120);
    return () => window.clearTimeout(t);
  }, [items, activeChapterId, activeLabel]);

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
          disabled={!activeChapterId && !activeLabel}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-xs"
          style={{
            background: (activeChapterId || activeLabel) ? 'rgba(0,0,0,0.05)' : 'transparent',
            opacity: (activeChapterId || activeLabel) ? 1 : 0.4,
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
            forceExpandedKeys={forceExpandedKeys}
            userCollapsed={userCollapsed}
            onToggle={toggle}
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
  forceExpandedKeys: Set<string>;
  userCollapsed: Set<string>;
  onToggle: (pathKey: string) => void;
  onPick: (chapterId: string) => void;
  activeRef: React.RefObject<HTMLDivElement>;
}

function TocNode({
  item, depth, pathKey, activeChapterId, activeLabel,
  forceExpandedKeys, userCollapsed, onToggle, onPick, activeRef,
}: NodeProps) {
  const hasChildren = !!(item.children && item.children.length);

  // 高亮判定（活跃叶子）：标签匹配优先；标签为空或没匹配时退回到 chapterId 匹配。
  const isActive = (() => {
    if (activeLabel && item.label === activeLabel) return true;
    if (!activeLabel && activeChapterId && item.chapterId === activeChapterId) return true;
    return false;
  })();

  // 祖先判定：当前节点在活跃路径上但不是叶子。
  const isAncestor = !isActive && forceExpandedKeys.has(pathKey);

  // 展开判定：默认展开；若用户主动收起且不在活跃路径上，则收起。
  // 活跃路径强制展开，覆盖用户收起。
  const expanded = forceExpandedKeys.has(pathKey) || !userCollapsed.has(pathKey);

  const clickable = !!item.chapterId;

  const handleChevron = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onToggle(pathKey);
  };

  return (
    <div>
      <div
        ref={isActive ? activeRef : undefined}
        className="toc-row"
        data-active={isActive ? '1' : isAncestor ? 'ancestor' : undefined}
        style={{
          paddingLeft: 8 + depth * 14 + 'px',
          background: isActive
            ? 'var(--reader-accent)'
            : isAncestor
              ? 'var(--reader-accent-weak, rgba(124,90,58,0.12))'
              : 'transparent',
          color: isActive ? '#fff' : 'var(--reader-fg)',
          borderLeft: isAncestor
            ? '2px solid var(--reader-accent)'
            : '2px solid transparent',
        }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="toc-chevron"
            onClick={handleChevron}
            onKeyDown={(e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') handleChevron(e);
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
            opacity: clickable || isActive || isAncestor ? 1 : 0.65,
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
              pathKey={pathKey + '>' + child.label}
              activeChapterId={activeChapterId}
              activeLabel={activeLabel}
              forceExpandedKeys={forceExpandedKeys}
              userCollapsed={userCollapsed}
              onToggle={onToggle}
              onPick={onPick}
              activeRef={activeRef}
            />
          ))}
        </div>
      )}
    </div>
  );
}
