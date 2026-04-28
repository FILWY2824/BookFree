// Annotation rendering helpers shared by every reader that lets the
// user highlight text. We solve four sub-problems here:
//
//   1. *locator serialisation*. We need a stable handle for "this
//      range of text" that survives:
//        – page resize / reflow
//        – chapter re-render
//        – font / theme change
//      We use a path expressed as `chapterId#startCharOffset:endCharOffset`,
//      where the offsets are character indices into the chapter's
//      flattened plain text. This is robust to formatting changes
//      because it doesn't reference DOM nodes by index. Restoration
//      walks the chapter's text nodes counting characters until it
//      reaches the recorded offsets.
//
//   2. *Range → CharOffset*. Given a Range relative to a root node,
//      compute the start/end character offsets by summing text-node
//      lengths in document order. We treat <br> as one character
//      ("\n") so block-level whitespace lines up with how the user
//      sees the text.
//
//   3. *CharOffset → Range*. The reverse — walk text nodes, count
//      characters, return a fresh Range targeting the right offsets.
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

export interface CharRange {
  start: number;
  end: number;
}

const ENCODING_VERSION = 'cr1';

// Serialise a CharRange into a locator string. We prefix with a
// version tag so a future scheme change can coexist with old rows.
export function encodeLocator(chapterId: string | null, range: CharRange): string {
  return `${ENCODING_VERSION}:${chapterId ?? ''}:${range.start}:${range.end}`;
}

export function decodeLocator(locator: string): { chapterId: string | null; range: CharRange } | null {
  const parts = locator.split(':');
  if (parts.length !== 4 || parts[0] !== ENCODING_VERSION) return null;
  const start = Number(parts[2]);
  const end   = Number(parts[3]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return {
    chapterId: parts[1] ? parts[1] : null,
    range: { start, end },
  };
}

// Walk all text nodes under root, in document order. <br> is
// reported as a synthetic node returning '\n'. Skipping the
// annotation wrappers is essential — without it, re-applying a
// highlight after a re-render double-counts the offsets.
export function* iterateTextNodes(root: Node): IterableIterator<{ node: Node; text: string }> {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(n: Node) {
      if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      if (n.nodeType === Node.ELEMENT_NODE) {
        const el = n as Element;
        if (el.tagName === 'BR') return NodeFilter.FILTER_ACCEPT;
        // Skip script/style entirely.
        if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_SKIP;
    },
  });
  let n: Node | null = walker.currentNode === root ? walker.nextNode() : walker.currentNode;
  while (n) {
    if (n.nodeType === Node.TEXT_NODE) {
      yield { node: n, text: (n as Text).data };
    } else if (n.nodeType === Node.ELEMENT_NODE && (n as Element).tagName === 'BR') {
      yield { node: n, text: '\n' };
    }
    n = walker.nextNode();
  }
}

// Convert a DOM Range relative to `root` into a character-offset
// range in the flattened text. Returns null when the range ends
// outside `root`.
export function rangeToCharRange(root: HTMLElement, range: Range): CharRange | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return null;
  }
  let chars = 0;
  let start = -1;
  let end = -1;

  for (const { node, text } of iterateTextNodes(root)) {
    const len = text.length;
    if (start < 0 && (node === range.startContainer || nodeContains(range.startContainer, node))) {
      // Text node case: range.startOffset is a char offset inside this text node.
      if (node === range.startContainer && node.nodeType === Node.TEXT_NODE) {
        start = chars + range.startOffset;
      } else {
        // BR start (rare). Treat as the boundary char.
        start = chars;
      }
    }
    if (end < 0 && (node === range.endContainer || nodeContains(range.endContainer, node))) {
      if (node === range.endContainer && node.nodeType === Node.TEXT_NODE) {
        end = chars + range.endOffset;
      } else {
        end = chars + len;
      }
    }
    chars += len;
    if (start >= 0 && end >= 0) break;
  }
  if (start < 0 || end < 0 || end < start) return null;
  return { start, end };
}

function nodeContains(parent: Node, child: Node): boolean {
  // Defensive contains() — DocumentFragment etc.
  return parent.nodeType === Node.ELEMENT_NODE && (parent as Element).contains(child);
}

// Convert a CharRange back into a DOM Range, walking text nodes
// in document order. Returns null if either end is past the end
// of the flattened text.
export function charRangeToRange(root: HTMLElement, cr: CharRange): Range | null {
  let chars = 0;
  let startNode: Node | null = null, startOffset = 0;
  let endNode:   Node | null = null, endOffset   = 0;

  for (const { node, text } of iterateTextNodes(root)) {
    const len = text.length;
    if (!startNode && cr.start <= chars + len) {
      if (node.nodeType === Node.TEXT_NODE) {
        startNode = node;
        startOffset = cr.start - chars;
      } else {
        // BR — anchor on the BR's parent at index = position of BR.
        startNode = node.parentNode!;
        startOffset = Array.prototype.indexOf.call(startNode.childNodes, node);
      }
    }
    if (!endNode && cr.end <= chars + len) {
      if (node.nodeType === Node.TEXT_NODE) {
        endNode = node;
        endOffset = cr.end - chars;
      } else {
        endNode = node.parentNode!;
        endOffset = Array.prototype.indexOf.call(endNode.childNodes, node);
      }
    }
    chars += len;
    if (startNode && endNode) break;
  }
  if (!startNode || !endNode) return null;
  try {
    const r = document.createRange();
    r.setStart(startNode, startOffset);
    r.setEnd(endNode, endOffset);
    return r;
  } catch {
    return null;
  }
}

// Wrap each text-node-only sub-range of `range` in a <span> styled
// for `highlight`. Returns the inserted spans so the caller can
// attach event handlers (the reader does this to know which highlight
// the user clicked on). Spans get data-hl-id and data-has-note.
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
      // surroundContents can fail when the range still partially crosses
      // element boundaries that we couldn't fully split. Skip silently —
      // partial wrap is better than a thrown exception.
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
        // Range starts inside an element wrapper — start at the first
        // text node within the start container at startOffset.
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
// whose locator can't be resolved (chapter content has changed).
export function applyAllHighlights(
  root: HTMLElement,
  highlights: Highlight[],
  notedSet: Set<string>,
): void {
  // Sort by start offset descending — applying from the end backward
  // keeps earlier offsets valid while DOM mutations move later ones.
  const decoded = highlights
    .map(h => ({ h, loc: decodeLocator(h.locator) }))
    .filter((x): x is { h: Highlight; loc: NonNullable<ReturnType<typeof decodeLocator>> } => x.loc !== null)
    .sort((a, b) => b.loc.range.start - a.loc.range.start);

  for (const { h, loc } of decoded) {
    const range = charRangeToRange(root, loc.range);
    if (!range) continue;
    wrapRange(range, h, notedSet.has(h.id));
  }
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
  // Adjacent text nodes can become siblings after stripping spans;
  // normalize so the next character-offset walk doesn't see fragmented
  // text nodes that confuse offset arithmetic in odd browsers.
  root.normalize();
}
