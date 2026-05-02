/*
中文导读：
annotations.ts 负责批注/标注相关的前端数据处理。
“高亮”和“笔记”通常都可以理解为 annotation：它们绑定在书籍、章节、文本范围或阅读位置上。
这个文件帮助阅读器把用户选择的位置转换成可保存、可恢复、可渲染的数据结构。
如果你以后要做更多标注类型，例如下划线、波浪线、颜色标签、批注回复，可以优先理解这个文件。
*/

// Annotation rendering helpers shared by every reader that lets the
// user highlight text. We solve four sub-problems here:
//
//   1. *locator serialisation*. We need a stable handle for "this
//      range of text" that survives:
//        – page resize / reflow
//        – chapter re-render
//        – font / theme change
//        – RE-INGEST of the same source file
//      Locators are now CFIv2-style (paragraph hash + char offset).
//      See lib/locator.ts for the full design rationale; the short
//      version is "we hash the paragraph text, not the markup". The
//      old `cr1:<chapterId>:<start>:<end>` format is still accepted
//      on the read path so existing rows keep working — anything
//      written after this change goes out as cfiv2.
//
//   2. *Range → locator string*. Given a Range relative to the
//      chapter's content root, walk paragraphs and produce a CFIv2.
//
//   3. *Locator string → Range*. The reverse — find the paragraph by
//      hash (or substring fallback), then place a Range using the
//      stored offset.
//
//   4. *Wrap a Range in span markers*. We can't simply wrap because
//      the range often crosses element boundaries. We split it into
//      the maximal set of TEXT-NODE-ONLY sub-ranges and wrap each
//      in a <span class="hl …" data-hl-id="…">.
//
// All four functions are pure DOM — they assume there's a `root`
// element you trust (the chapter content container) and never look
// outside of it. If the locator references content the chapter
// doesn't have any more (because the body was edited externally),
// the apply step is a no-op rather than throwing.

import type { Highlight } from './highlights';
import {
  rangeToCFIv2,
  encodeLocatorV2,
  locatorToRange,
} from './locator';

// Build a CFIv2 locator string from a live Range. This is what
// TxtReader calls when persisting a fresh selection.
export function encodeLocatorFromRange(
  root: HTMLElement,
  chapterId: string,
  range: Range,
): string | null {
  const cfi = rangeToCFIv2(root, range, chapterId);
  if (!cfi) return null;
  return encodeLocatorV2(cfi);
}

// Resolve a saved highlight to a DOM range on the rendered chapter.
// `selectedText` from the highlight row is used as a substring
// fallback when the paragraph hash misses (e.g. after re-ingest).
export function locatorToRangeForHighlight(root: HTMLElement, h: Highlight): Range | null {
  return locatorToRange(root, h.locator, h.selectedText);
}

// ─── Range wrapping ────────────────────────────────────────────────

// Wrap each text-node-only sub-range of `range` in a <span> styled
// for `highlight`. Returns the inserted spans so the caller can
// attach event handlers (the reader does this to know which highlight
// the user clicked on). Spans get data-hl-id and data-has-note.
//
// 健壮性增强：当 surroundContents 失败时（通常因为 Range 跨越了元素边界），
// 回退到手动包裹策略：用 extractContents 取出内容，手动包入 span 后放回。
// 这比之前的静默跳过更可靠，确保批注 DOM 不会被丢弃。
export function wrapRange(range: Range, highlight: Highlight, hasNote: boolean): HTMLSpanElement[] {
  const spans: HTMLSpanElement[] = [];
  const fragments = collectTextRanges(range);
  for (const r of fragments) {
    try {
      const span = document.createElement('span');
      span.className = highlightClassName(highlight, hasNote);
      span.setAttribute('data-hl-id', highlight.id);
      if (hasNote) span.setAttribute('data-has-note', '1');
      r.surroundContents(span);
      spans.push(span);
    } catch {
      // surroundContents 失败时的回退策略：
      // extractContents 把所有片段内容移出 → 包入 span → 放回原位。
      try {
        const span = document.createElement('span');
        span.className = highlightClassName(highlight, hasNote);
        span.setAttribute('data-hl-id', highlight.id);
        if (hasNote) span.setAttribute('data-has-note', '1');
        const frag = r.extractContents();
        span.appendChild(frag);
        r.insertNode(span);
        spans.push(span);
      } catch {
        // 两次尝试均失败，跳过此片段（部分包裹总有比没有好）。
      }
    }
  }
  return spans;
}

export function highlightClassName(h: Highlight, hasNote: boolean): string {
  const style = h.style ?? 'highlight';
  return [
    'hl',
    'hl-' + style,
    'hl-color-' + h.color,
    hasNote ? 'hl-has-note' : '',
  ].filter(Boolean).join(' ');
}

// Split a Range into one Range per text-node it contains. We slice
// the range at element boundaries so every result is "purely textual"
// and surroundContents() will succeed.
function collectTextRanges(range: Range): Range[] {
  const out: Range[] = [];
  const startC = range.startContainer;
  const endC   = range.endContainer;
  if (startC === endC && startC.nodeType === Node.TEXT_NODE) {
    out.push(range.cloneRange());
    return out;
  }

  // Walk text nodes between start and end inclusive.
  const root = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
    ? range.commonAncestorContainer.parentNode!
    : range.commonAncestorContainer;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let started = false;
  let n: Text | null = walker.nextNode() as Text | null;
  while (n) {
    if (!started) {
      if (n === startC) {
        const r = document.createRange();
        r.setStart(n, range.startOffset);
        if (startC === endC) {
          r.setEnd(n, range.endOffset);
          out.push(r);
          return out;
        }
        r.setEnd(n, n.data.length);
        if (r.toString().length > 0) out.push(r);
        started = true;
      } else if (startC.nodeType !== Node.TEXT_NODE && (startC as Element).contains(n)) {
        const r = document.createRange();
        r.setStart(n, 0);
        r.setEnd(n, n.data.length);
        if (r.toString().length > 0) out.push(r);
        started = true;
      }
    } else if (n === endC) {
      const r = document.createRange();
      r.setStart(n, 0);
      r.setEnd(n, range.endOffset);
      if (r.toString().length > 0) out.push(r);
      return out;
    } else if (range.intersectsNode(n)) {
      const r = document.createRange();
      r.selectNodeContents(n);
      if (r.toString().length > 0) out.push(r);
    }
    n = walker.nextNode() as Text | null;
  }
  return out;
}

// Apply a list of saved highlights to `root`. Skips any highlight
// whose locator can't be resolved (chapter content has changed
// beyond what the substring fallback can recover).
//
// We resolve every range first, then sort by document order, and
// wrap from the LAST highlight backwards. This guarantees the DOM
// mutations from wrapping don't shift offsets for later highlights.
export function applyAllHighlights(
  root: HTMLElement,
  highlights: Highlight[],
  notedSet: Set<string>,
): number {
  type Entry = { h: Highlight; r: Range };
  const entries: Entry[] = [];
  for (const h of highlights) {
    const r = locatorToRangeForHighlight(root, h);
    if (r) entries.push({ h, r });
  }
  // Sort: later in document order first.
  entries.sort((a, b) => {
    try {
      return b.r.compareBoundaryPoints(Range.START_TO_START, a.r);
    } catch {
      return 0;
    }
  });
  for (const { h, r } of entries) {
    wrapRange(r, h, notedSet.has(h.id));
  }
  return entries.length;
}

// Strip every <span data-hl-id> wrapper without touching the text inside.
// Used before re-applying highlights after a chapter re-render so we
// don't double-wrap.
export function clearHighlights(root: HTMLElement): void {
  const spans = root.querySelectorAll<HTMLSpanElement>('span[data-hl-id]');
  spans.forEach(s => {
    const parent = s.parentNode;
    if (!parent) return;
    while (s.firstChild) parent.insertBefore(s.firstChild, s);
    parent.removeChild(s);
  });
  root.normalize();
}
