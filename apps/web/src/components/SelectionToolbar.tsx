// SelectionToolbar — pops above (or below, when there's no room
// above) the current text selection and lets the user attach a
// highlight, underline, wavy line, or strikethrough to the range,
// optionally with a note. Also exposes "copy" for users who just
// want to get the text out without annotating it.
//
// Three operating modes:
//   • 'create' — user selected fresh text. We show the full grid:
//                style picker + colour picker + note + copy.
//   • 'edit'   — user clicked an existing annotation. We show the
//                style/colour pickers (so they can recolour or
//                change shape) plus the note button and a delete
//                action.
//   • 'note'   — the note editor is open. The toolbar collapses
//                into a compact textarea + save/cancel/delete.
//
// We deliberately keep this component "presentational": it doesn't
// know about the API, just emits onApplyHighlight / onAttachNote /
// onDelete callbacks. The reader wires those to the highlights API.

import { useEffect, useRef, useState } from 'react';
import {
  COLORS, STYLES,
  type Highlight, type HighlightColor, type HighlightStyle,
} from '../lib/highlights';

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
  /** True if there's a saved Note row attached to this highlight. Lets
   *  us render the "delete note" button only when it's relevant. */
  hasNote?: boolean;

  onApplyHighlight: (style: HighlightStyle, color: HighlightColor) => void;
  onOpenNote: () => void;
  onSaveNote: (body: string) => void;
  onDeleteNote: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onClose: () => void;
}

const DEFAULT_COLOR: HighlightColor = 'yellow';
const DEFAULT_STYLE: HighlightStyle = 'highlight';

export default function SelectionToolbar({
  anchor, containerRect, mode, current,
  noteBody = '', hasNote = false,
  onApplyHighlight, onOpenNote, onSaveNote, onDeleteNote,
  onCopy, onDelete, onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [draftNote, setDraftNote] = useState(noteBody);

  // Keep the draft in sync when noteBody flips (e.g. user clicks a
  // different highlight that already has a note).
  useEffect(() => { setDraftNote(noteBody); }, [noteBody, mode]);

  // Recompute position when anchor or container changes. We measure
  // the toolbar's actual size so we can clamp.
  useEffect(() => {
    if (!anchor || !containerRect || !ref.current) {
      setPos(null);
      return;
    }
    const tb = ref.current.getBoundingClientRect();
    const PAD = 8;

    // Prefer above the selection; fall back to below if there's no
    // room. Coordinates are relative to the container.
    const wouldBeTopAbove = anchor.top - containerRect.top - tb.height - PAD;
    const wouldBeTopBelow = anchor.bottom - containerRect.top + PAD;

    let top = wouldBeTopAbove >= 0 ? wouldBeTopAbove : wouldBeTopBelow;
    // If even below doesn't fit, pin to the container bottom edge.
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

  const activeStyle = current?.style ?? DEFAULT_STYLE;
  const activeColor = current?.color ?? DEFAULT_COLOR;

  if (mode === 'note') {
    return (
      <div
        ref={ref}
        className="note-editor"
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

  return (
    <div
      ref={ref}
      className="selection-toolbar"
      style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
      onMouseDown={(e: React.MouseEvent) => {
        // Prevent the click from collapsing the user's selection.
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div className="row style-row">
        <span className="label">样式</span>
        {STYLES.map(s => (
          <button
            key={s}
            type="button"
            className={'style-pill ' + (s === activeStyle ? 'active' : '')}
            onClick={() => onApplyHighlight(s, activeColor)}
            title={styleLabel(s)}
          >
            {styleLabel(s)}
          </button>
        ))}
      </div>
      <div className="row color-row">
        <span className="label">颜色</span>
        {COLORS.map(c => (
          <button
            key={c}
            type="button"
            className={'color-swatch ' + (c === activeColor ? 'active' : '')}
            style={{ background: swatchBg(c) }}
            onClick={() => onApplyHighlight(activeStyle, c)}
            aria-label={c}
            title={colorLabel(c)}
          />
        ))}
      </div>
      <div className="actions">
        <button type="button" className="action-btn" onClick={onOpenNote}>
          📝 笔记
        </button>
        <button type="button" className="action-btn" onClick={onCopy}>
          复制
        </button>
        {mode === 'edit' && (
          <button type="button" className="action-btn" onClick={onDelete} style={{ color: '#c93a3a' }}>
            删除
          </button>
        )}
      </div>
    </div>
  );
}

function styleLabel(s: HighlightStyle): string {
  switch (s) {
    case 'highlight': return '高亮';
    case 'underline': return '下划';
    case 'wavy':      return '波浪';
    case 'strike':    return '删除';
  }
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
