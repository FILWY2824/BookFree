/*
中文导读：
SelectionToolbar 是阅读器中文字选中后的浮动工具栏。
用户选中一段文字后，可能会看到“高亮、写笔记、复制、问 AI、解释”等操作入口。
这个组件主要负责根据选区位置显示工具栏，并把按钮点击传给上层逻辑。
它不应该直接保存笔记或调用所有业务接口，而应通过 props 回调让 ReaderPage 或相关模块处理。
如果你想新增“选中文本后问 AI”或“添加到摘录”的按钮，通常会改这里和上层回调。
*/

// SelectionToolbar — the small popover that appears next to the
// user's selection (or next to an existing annotation when they click
// it in edit mode).
//
// Design rewrite (per user request):
//   The previous version showed a multi-row picker — choose a style,
//   choose a colour, click 应用. Users found this overkill: most of
//   the time they already know they want a highlight or a note, and
//   their preferred colour for each style is set in the header. We
//   now show one row of action chips instead, where each chip is a
//   one-tap action that creates an annotation of that style using
//   the colour the user has set in their per-style preferences.
//   The header chips own colour selection; this toolbar just acts.
//
// Buttons by mode:
//   • 'create' — fresh selection. We render: 高亮 / 下划 / 波浪 / 删除 / 笔记
//                Each chip applies that style at the user's saved
//                per-style colour and closes the toolbar. The 笔记 chip
//                opens the note editor (still using the per-style note
//                colour for the underlying highlight wrap).
//                NO 复制 button — Ctrl/Cmd+C handles that case.
//   • 'edit'   — user clicked an existing annotation. We render:
//                colour swatches + 笔记 button + 删除 button. The colour
//                swatches swap the existing annotation's colour
//                without touching its style.
//   • 'note'   — note editor mode. Big textarea, save/cancel/delete.

import { useEffect, useRef, useState } from 'react';
import {
  COLORS,
  type Highlight, type HighlightColor, type HighlightStyle,
} from '../lib/highlights';
import type { ReaderPrefs } from '../lib/prefs';

export type SelectionToolbarMode = 'create' | 'edit' | 'note';

interface Props {
  /** Anchor rect in **viewport** coordinates of the current selection
   *  or the highlight that's being edited. We position relative to it. */
  anchor: DOMRect | null;
  /** Bounds of the reader surface that contains the toolbar. We use
   *  this to clamp the toolbar's left/top so it never escapes off-edge. */
  containerRect: DOMRect | null;
  mode: SelectionToolbarMode;
  /** Existing annotation when in 'edit' / 'note' mode. */
  current?: Highlight | null;
  /** Existing note body if any (used only in 'note' mode). */
  noteBody?: string;
  /** True if there's a saved Note row attached to this highlight. */
  hasNote?: boolean;
  /** Per-style remembered colour from prefs.styleColors. Used to seed
   *  the colour each style chip applies, plus the underlying highlight
   *  colour when creating a note from a fresh selection. */
  styleColors: ReaderPrefs['styleColors'];

  onApplyHighlight: (style: HighlightStyle, color: HighlightColor) => void;
  /** Recolour an existing annotation in place. Only fires in 'edit'
   *  mode; the parent updates the row in the DB and re-wraps the DOM. */
  onRecolor?: (color: HighlightColor) => void;
  onOpenNote: () => void;
  onSaveNote: (body: string) => void;
  onDeleteNote: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export default function SelectionToolbar({
  anchor, containerRect, mode, current,
  noteBody = '', hasNote = false, styleColors,
  onApplyHighlight, onRecolor, onOpenNote, onSaveNote, onDeleteNote,
  onDelete, onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [draftNote, setDraftNote] = useState(noteBody);

  // Keep the draft in sync when noteBody flips (e.g. switching from
  // "edit highlight" to "edit note for this highlight").
  useEffect(() => { setDraftNote(noteBody); }, [noteBody, mode]);

  // Recompute position when anchor or container changes.
  useEffect(() => {
    if (!anchor || !containerRect || !ref.current) {
      setPos(null);
      return;
    }
    const tb = ref.current.getBoundingClientRect();
    const PAD = 8;

    const wouldBeTopAbove = anchor.top - containerRect.top - tb.height - PAD;
    const wouldBeTopBelow = anchor.bottom - containerRect.top + PAD;

    let top = wouldBeTopAbove >= 0 ? wouldBeTopAbove : wouldBeTopBelow;
    if (top + tb.height > containerRect.height) {
      top = Math.max(0, containerRect.height - tb.height - PAD);
    }

    let left = anchor.left + (anchor.width / 2) - containerRect.left - (tb.width / 2);
    if (left < PAD) left = PAD;
    if (left + tb.width > containerRect.width - PAD) {
      left = containerRect.width - tb.width - PAD;
    }
    setPos({ left, top });
  }, [anchor, containerRect, mode]);

  // Esc dismisses.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!anchor) return null;

  // ── Note editor mode ────────────────────────────────────────────
  if (mode === 'note') {
    return (
      <div
        ref={ref}
        className="note-editor"
        data-selection-toolbar="1"
        style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
        onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <textarea
          autoFocus
          value={draftNote}
          onChange={e => setDraftNote(e.target.value)}
          placeholder="写下你的笔记…（Cmd/Ctrl + Enter 保存）"
          onKeyDown={e => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              onSaveNote(draftNote.trim());
            }
          }}
        />
        <div className="note-buttons">
          {hasNote && (
            <button type="button" className="danger" onClick={onDeleteNote}>
              删除
            </button>
          )}
          <button type="button" onClick={onClose}>取消</button>
          <button
            type="button"
            className="primary"
            disabled={!draftNote.trim()}
            onClick={() => onSaveNote(draftNote.trim())}
          >
            保存
          </button>
        </div>
      </div>
    );
  }

  // ── Edit mode (clicked existing annotation) ─────────────────────
  if (mode === 'edit' && current) {
    return (
      <div
        ref={ref}
        className="mini-toolbar"
        data-selection-toolbar="1"
        style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
        onMouseDown={(e: React.MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {/* Colour swatches inline so editing colour stays one tap. */}
        {COLORS.map(c => (
          <button
            key={c}
            type="button"
            className="mini-toolbar-btn"
            onClick={() => onRecolor?.(c)}
            title={`改为 ${colorLabel(c)}色`}
            aria-label={`改为 ${colorLabel(c)}色`}
            style={c === current.color ? {
              background: 'rgba(0,0,0,0.06)',
            } : undefined}
          >
            <span
              className="swatch-dot"
              style={{ background: swatchBg(c) }}
            />
          </button>
        ))}
        <span style={{ width: 1, background: 'var(--reader-border)', margin: '4px 2px' }} />
        <button
          type="button"
          className="mini-toolbar-btn"
          onClick={onOpenNote}
          title={hasNote ? '编辑笔记' : '添加笔记'}
        >
          <NoteIcon />
          <span>{hasNote ? '编辑' : '笔记'}</span>
        </button>
        <button
          type="button"
          className="mini-toolbar-btn mini-toolbar-btn-danger"
          onClick={onDelete}
          title="删除批注"
        >
          删除
        </button>
      </div>
    );
  }

  // ── Create mode (fresh selection) ───────────────────────────────
  return (
    <div
      ref={ref}
      className="mini-toolbar"
      data-selection-toolbar="1"
      style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
      onMouseDown={(e: React.MouseEvent) => {
        // Prevent the click from collapsing the user's selection.
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <ChipButton
        label="高亮"
        renderIcon={() => <HighlightIcon color={swatchBg(styleColors.highlight)} />}
        onClick={() => onApplyHighlight('highlight', styleColors.highlight)}
      />
      <ChipButton
        label="下划"
        renderIcon={() => <UnderlineIcon color={swatchBg(styleColors.underline)} />}
        onClick={() => onApplyHighlight('underline', styleColors.underline)}
      />
      <ChipButton
        label="波浪"
        renderIcon={() => <WavyIcon color={swatchBg(styleColors.wavy)} />}
        onClick={() => onApplyHighlight('wavy', styleColors.wavy)}
      />
      <ChipButton
        label="删除"
        renderIcon={() => <StrikeIcon color={swatchBg(styleColors.strike)} />}
        onClick={() => onApplyHighlight('strike', styleColors.strike)}
      />
      <span style={{ width: 1, background: 'var(--reader-border)', margin: '4px 2px' }} />
      <ChipButton
        label="笔记"
        renderIcon={() => <NoteIcon color={swatchBg(styleColors.note)} />}
        onClick={onOpenNote}
      />
    </div>
  );
}

// ─── Building blocks ─────────────────────────────────────────────

function ChipButton({
  label, renderIcon, onClick,
}: {
  label: string;
  renderIcon: () => React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="mini-toolbar-btn"
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      {renderIcon()}
      <span>{label}</span>
    </button>
  );
}

// Tiny inline icons that pick up the user's per-style colour. We keep
// them small and SVG so they scale with the surrounding text and stay
// crisp at any zoom.

function HighlightIcon({ color }: { color: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="3" width="12" height="9" rx="1" fill={color} opacity="0.55" />
      <line x1="2" y1="13.5" x2="14" y2="13.5" stroke="currentColor" strokeWidth="1" opacity="0.6" />
    </svg>
  );
}
function UnderlineIcon({ color }: { color: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <text x="8" y="11" textAnchor="middle" fontSize="9.5" fontWeight="600" fill="currentColor">A</text>
      <line x1="3" y1="13.2" x2="13" y2="13.2" stroke={color} strokeWidth="1.6" />
    </svg>
  );
}
function WavyIcon({ color }: { color: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <text x="8" y="10" textAnchor="middle" fontSize="9" fontWeight="600" fill="currentColor">A</text>
      <path d="M2 13 q1.5 -1.4 3 0 t 3 0 t 3 0 t 3 0" fill="none" stroke={color} strokeWidth="1.4" />
    </svg>
  );
}
function StrikeIcon({ color }: { color: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <text x="8" y="10.5" textAnchor="middle" fontSize="9.5" fontWeight="600" fill="currentColor">A</text>
      <line x1="2.5" y1="8" x2="13.5" y2="8" stroke={color} strokeWidth="1.6" />
    </svg>
  );
}
function NoteIcon({ color = 'currentColor' }: { color?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3 3 H11 L13 5 V13 H3 Z"
        fill="none"
        stroke={color}
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <line x1="5" y1="7"  x2="11" y2="7"  stroke={color} strokeWidth="1.1" />
      <line x1="5" y1="9.4" x2="10" y2="9.4" stroke={color} strokeWidth="1.1" />
    </svg>
  );
}

function colorLabel(c: HighlightColor): string {
  switch (c) {
    case 'yellow': return '黄';
    case 'red':    return '红';
    case 'green':  return '绿';
    case 'blue':   return '蓝';
    case 'purple': return '紫';
    case 'orange': return '橙';
  }
}
function swatchBg(c: HighlightColor): string {
  switch (c) {
    case 'yellow': return '#FFD900';
    case 'red':    return '#FF6363';
    case 'green':  return '#5FC86E';
    case 'blue':   return '#63A5FF';
    case 'purple': return '#BA82EB';
    case 'orange': return '#FF9F50';
  }
}
