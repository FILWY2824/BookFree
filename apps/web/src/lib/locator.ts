/*
中文导读：
locator.ts 负责阅读位置定位相关逻辑。
阅读器需要知道用户看到哪里、选中了哪段文字、下次打开要恢复到什么位置，这些都依赖 locator。
不同格式的定位方式不一样：TXT 可以按章节和字符偏移，EPUB 可能依赖 CFI 或 spine，PDF 可能依赖页码。
这个文件的目标是把位置描述转换成前端和后端都能保存、恢复、比较的结构。
如果你要改阅读进度、书签、标注定位、跨设备同步，必须重点理解这里。
*/

// Stable text locators for highlights, notes, and reading progress.
//
// Why a custom format instead of EPUB CFI:
//   EPUB CFI is XPath-shaped: it walks the DOM by element index. Two
//   things make it unreliable for OUR storage model. (a) Our chapters
//   are ingested HTML (foliate-rewritten, then sanitised) — element
//   indices won't match the original epub. (b) Re-ingest of the same
//   book regenerates the chapter HTML in slightly different markup
//   (e.g. extra wrapper <div>s from a foliate update), which would
//   break every saved highlight. We need something tied to the *text*,
//   not the markup.
//
// The format we land on, internally called CFIv2:
//
//   cfiv2:<chapterId>:<paraHash>:<offsetInPara>:<lengthOrEnd>
//
//   • paraHash      — 32-bit FNV-1a hex digest of the paragraph's
//                     normalised plain text (whitespace collapsed,
//                     trimmed). Stable across HTML reflow because we
//                     hash text, not markup. Robust to incidental
//                     re-ingest because foliate's text extraction is
//                     deterministic for the same source.
//   • offsetInPara  — character offset INTO the matched paragraph.
//   • lengthOrEnd   — for highlights, this is the END offset (still
//                     within the paragraph if the selection didn't
//                     cross paragraph boundaries) or the offset where
//                     the selection's tail ends in the next-anchor
//                     paragraph. For progress, lengthOrEnd is 0
//                     (start = anchor point).
//
// Multi-paragraph highlights store a chain:
//
//   cfiv2:<cid>:<h1>:<o1>:<l1>;<h2>:<o2>:<l2>;…
//
// where h_i = hash of the i-th paragraph touched, o_i = char offset
// into that paragraph, l_i = number of characters of that paragraph
// included. The sequence is reconstructed walking paragraphs in
// document order.
//
// Backwards compat:
//   The previous codebase used `cr1:<chapterId>:<start>:<end>`. We
//   continue to accept that format on read paths via decodeLocator;
//   anything new written goes out as cfiv2. Both readers run side by
//   side until existing rows are naturally rewritten on user edits.
//
// Fallback strategy when paragraph-hash matching fails:
//   1. Try exact hash. Found → use offset directly.
//   2. Hash miss → look for a paragraph containing the highlight's
//      `selectedText` snippet (we get this from the highlights row).
//      Found → re-anchor offset by indexOf(snippet).
//   3. Still miss → highlight skipped (the chapter content has changed
//      enough that we can't safely place it). The drawer still shows
//      it in the notes list with the chapter title.

export interface CFIv2Step {
  paraHash: string;
  offset: number;
  length: number;
}

export interface CFIv2 {
  chapterId: string;
  steps: CFIv2Step[];
}

export const LOCATOR_VERSION = 'cfiv2';

// FNV-1a 32-bit. Tiny, deterministic, sufficient for our use:
// collisions inside one chapter's paragraphs are essentially never
// going to happen in practice (an average chapter has < 200
// paragraphs; FNV-32 collision probability over 200 inputs ≈ 2e-8).
export function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

export function normaliseParagraphText(s: string): string {
  // Collapse all whitespace to a single space, trim ends. Same
  // normalisation we use in both encoder and decoder so the hash is
  // platform-stable.
  return s.replace(/\s+/g, ' ').trim();
}

// Walk the rendered chapter HTML and yield each "paragraph"
// (block-level text container), its plain text, and the DOM range
// [start, end] in document order spanning that paragraph's text. The
// caller maps Range char-offsets relative to a paragraph instead of
// the whole chapter, which is what we need to anchor by paragraph.
export interface Paragraph {
  /** The block-level element that hosts this paragraph. */
  el: HTMLElement;
  /** Plain text of the paragraph, normalised. */
  text: string;
  /** FNV hash of the normalised text, used as the paragraph anchor. */
  hash: string;
}

const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, dt, dd, div';

// Collect "leaf" block-level paragraphs inside `root`. We define a
// leaf as a block-level element whose own descendants don't contain
// further block-level elements with text. This matches a human's
// notion of a paragraph (one logical chunk you'd hover-select) and
// avoids hashing wrapper <div>s twice.
export function collectParagraphs(root: HTMLElement): Paragraph[] {
  const out: Paragraph[] = [];
  const blocks = root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR);
  for (const el of Array.from(blocks)) {
    // A block is a leaf if no descendant block has non-whitespace text.
    let hasInnerBlock = false;
    const inner = el.querySelectorAll<HTMLElement>(BLOCK_SELECTOR);
    for (const ie of Array.from(inner)) {
      if ((ie.textContent ?? '').trim().length > 0) {
        hasInnerBlock = true;
        break;
      }
    }
    if (hasInnerBlock) continue;
    const raw = el.textContent ?? '';
    const norm = normaliseParagraphText(raw);
    if (norm.length === 0) continue;
    out.push({ el, text: norm, hash: fnv1a32(norm) });
  }
  return out;
}

// Map a DOM Range that lives inside `root` to one or more CFIv2 steps.
// We split the range at paragraph boundaries; each piece becomes one
// step recording (paraHash, offsetInPara, length).
export function rangeToCFIv2(root: HTMLElement, range: Range, chapterId: string): CFIv2 | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return null;
  }
  const paragraphs = collectParagraphs(root);
  const steps: CFIv2Step[] = [];

  for (const p of paragraphs) {
    if (!range.intersectsNode(p.el)) continue;
    // Compute offset inside this paragraph by walking text nodes and
    // accumulating, while also clipping at the range start/end.
    const paraRange = document.createRange();
    paraRange.selectNodeContents(p.el);

    // Effective range INSIDE this paragraph = intersection of `range`
    // with `paraRange`.
    const startNode = paraRange.compareBoundaryPoints(Range.START_TO_START, range) >= 0
      ? paraRange.startContainer
      : range.startContainer;
    const startOffset = paraRange.compareBoundaryPoints(Range.START_TO_START, range) >= 0
      ? paraRange.startOffset
      : range.startOffset;
    const endNode = paraRange.compareBoundaryPoints(Range.END_TO_END, range) <= 0
      ? paraRange.endContainer
      : range.endContainer;
    const endOffset = paraRange.compareBoundaryPoints(Range.END_TO_END, range) <= 0
      ? paraRange.endOffset
      : range.endOffset;

    // Translate (startNode/offset → char index relative to paragraph).
    // Use raw textContent walk (no normalisation here — we store the
    // RAW char offset; matching uses raw too).
    const charStart = textOffsetWithin(p.el, startNode, startOffset);
    const charEnd = textOffsetWithin(p.el, endNode, endOffset);
    if (charStart < 0 || charEnd < 0 || charEnd < charStart) continue;
    const length = charEnd - charStart;
    if (length <= 0 && steps.length === 0) {
      // Allow length=0 as the FIRST step (used for progress markers);
      // skip zero-width middle steps.
      steps.push({ paraHash: p.hash, offset: charStart, length: 0 });
      continue;
    }
    if (length > 0) {
      steps.push({ paraHash: p.hash, offset: charStart, length });
    }
  }

  if (steps.length === 0) return null;
  return { chapterId, steps };
}

// Resolve a CFIv2 back into a DOM Range. Tries the exact paragraph
// hash first; if that misses, falls back to substring matching using
// `selectedText` if provided.
export function cfiv2ToRange(
  root: HTMLElement,
  cfi: CFIv2,
  selectedText?: string,
): Range | null {
  const paragraphs = collectParagraphs(root);
  const byHash = new Map<string, Paragraph>();
  for (const p of paragraphs) byHash.set(p.hash, p);

  const ranges: Range[] = [];
  for (const step of cfi.steps) {
    let para = byHash.get(step.paraHash);
    let useOffset = step.offset;
    let useLength = step.length;
    if (!para && selectedText) {
      // Hash miss — try a substring match against the rendered text.
      const needle = selectedText.trim().slice(0, 80);
      if (needle) {
        for (const p of paragraphs) {
          const idx = p.el.textContent?.indexOf(needle) ?? -1;
          if (idx >= 0) {
            para = p;
            useOffset = idx;
            useLength = Math.min(selectedText.length, (p.el.textContent ?? '').length - idx);
            break;
          }
        }
      }
    }
    if (!para) continue;
    const r = charRangeWithin(para.el, useOffset, useOffset + Math.max(1, useLength));
    if (r) ranges.push(r);
  }
  if (ranges.length === 0) return null;
  // Merge into a single Range covering all segments. We clamp to the
  // first start and last end — readers that need per-paragraph
  // segmentation get it from the steps directly.
  const out = document.createRange();
  out.setStart(ranges[0].startContainer, ranges[0].startOffset);
  const last = ranges[ranges.length - 1];
  out.setEnd(last.endContainer, last.endOffset);
  return out;
}

// Walk text nodes inside `root` accumulating char positions, then
// return the text-node + offset corresponding to char index `target`.
function locateChar(root: HTMLElement, target: number): { node: Node; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let acc = 0;
  let n: Text | null = walker.nextNode() as Text | null;
  while (n) {
    const len = n.data.length;
    if (acc + len >= target) {
      return { node: n, offset: target - acc };
    }
    acc += len;
    n = walker.nextNode() as Text | null;
  }
  // Past the end — clamp to the last text node's end.
  const allTexts = root.querySelectorAll('*');
  void allTexts;
  return null;
}

function charRangeWithin(root: HTMLElement, start: number, end: number): Range | null {
  const s = locateChar(root, start);
  const e = locateChar(root, end);
  if (!s || !e) {
    // Fallback: if end is past content, anchor end at last text node end.
    if (s && !e) {
      const lastText = lastTextNode(root);
      if (lastText) {
        const r = document.createRange();
        r.setStart(s.node, s.offset);
        r.setEnd(lastText, (lastText as Text).data.length);
        return r;
      }
    }
    return null;
  }
  try {
    const r = document.createRange();
    r.setStart(s.node, s.offset);
    r.setEnd(e.node, e.offset);
    return r;
  } catch {
    return null;
  }
}

function lastTextNode(root: HTMLElement): Node | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let last: Node | null = null;
  let n: Node | null = walker.nextNode();
  while (n) { last = n; n = walker.nextNode(); }
  return last;
}

// textOffsetWithin walks all text nodes inside `el`, summing lengths
// in document order, until it reaches `(node, offset)`. Returns the
// char offset relative to `el` text content.
function textOffsetWithin(el: HTMLElement, node: Node, offset: number): number {
  let acc = 0;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  let n: Text | null = walker.nextNode() as Text | null;
  while (n) {
    if (n === node) return acc + Math.min(offset, n.data.length);
    if (node.nodeType !== Node.TEXT_NODE && (node as Element).contains(n)) {
      // The boundary is at an element; treat its position as the
      // start of `n` (close enough for our anchor purposes).
      return acc;
    }
    acc += n.data.length;
    n = walker.nextNode() as Text | null;
  }
  // The boundary is at the end of `el`. Return total length.
  return acc;
}

// Encode / decode the locator string. Multiple steps separated by ';'.
export function encodeLocatorV2(cfi: CFIv2): string {
  const steps = cfi.steps.map(s => `${s.paraHash}:${s.offset}:${s.length}`).join(';');
  return `${LOCATOR_VERSION}:${cfi.chapterId}:${steps}`;
}

export interface DecodedLocator {
  version: 'cfiv2' | 'cr1';
  chapterId: string | null;
  // CFIv2 fields (when version === 'cfiv2')
  steps?: CFIv2Step[];
  // CR1 fields (when version === 'cr1')
  charStart?: number;
  charEnd?: number;
}

export function decodeLocatorAny(locator: string): DecodedLocator | null {
  if (!locator) return null;
  if (locator.startsWith('cfiv2:')) {
    const rest = locator.slice('cfiv2:'.length);
    const colon = rest.indexOf(':');
    if (colon < 0) return null;
    const chapterId = rest.slice(0, colon);
    const stepsRaw = rest.slice(colon + 1);
    const steps: CFIv2Step[] = [];
    for (const seg of stepsRaw.split(';')) {
      const parts = seg.split(':');
      if (parts.length !== 3) continue;
      const offset = Number(parts[1]);
      const length = Number(parts[2]);
      if (!Number.isFinite(offset) || !Number.isFinite(length)) continue;
      steps.push({ paraHash: parts[0], offset, length });
    }
    if (steps.length === 0) return null;
    return { version: 'cfiv2', chapterId: chapterId || null, steps };
  }
  if (locator.startsWith('cr1:')) {
    const parts = locator.split(':');
    if (parts.length !== 4) return null;
    const start = Number(parts[2]);
    const end = Number(parts[3]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return {
      version: 'cr1',
      chapterId: parts[1] ? parts[1] : null,
      charStart: start,
      charEnd: end,
    };
  }
  return null;
}

// Resolve any locator (cfiv2 or cr1) to a DOM range inside root.
// `selectedText` is the original selection text from the highlights
// row — used as the substring fallback when a hash misses.
export function locatorToRange(
  root: HTMLElement,
  locator: string,
  selectedText?: string,
): Range | null {
  const dec = decodeLocatorAny(locator);
  if (!dec) return null;
  if (dec.version === 'cfiv2' && dec.steps) {
    return cfiv2ToRange(root, { chapterId: dec.chapterId ?? '', steps: dec.steps }, selectedText);
  }
  if (dec.version === 'cr1' && typeof dec.charStart === 'number' && typeof dec.charEnd === 'number') {
    // Legacy: walk text nodes counting chars.
    const s = locateChar(root, dec.charStart);
    const e = locateChar(root, dec.charEnd);
    if (!s || !e) return null;
    try {
      const r = document.createRange();
      r.setStart(s.node, s.offset);
      r.setEnd(e.node, e.offset);
      return r;
    } catch {
      return null;
    }
  }
  return null;
}

// Produce a "progress anchor" CFIv2 from the topmost visible
// paragraph in `root` — used by the reader to remember where the
// user was reading. Returns null if the chapter has no rendered
// paragraphs at all.
export function topVisibleAnchor(root: HTMLElement, chapterId: string): CFIv2 | null {
  const paragraphs = collectParagraphs(root);
  if (paragraphs.length === 0) return null;
  // Find the first paragraph whose top edge is below the chapter's
  // own top in viewport coordinates. In paginated mode, the visible
  // page is positioned at translateX(-pageIdx * 100%); since elements
  // are still in document order, getBoundingClientRect reports the
  // post-transform position for them. So the topmost paragraph whose
  // rect.top >= 0 is the first one currently on screen.
  for (const p of paragraphs) {
    const rect = p.el.getBoundingClientRect();
    if (rect.top >= 0 && rect.bottom > 0) {
      return {
        chapterId,
        steps: [{ paraHash: p.hash, offset: 0, length: 0 }],
      };
    }
  }
  // Fallback: first paragraph.
  return {
    chapterId,
    steps: [{ paraHash: paragraphs[0].hash, offset: 0, length: 0 }],
  };
}

// Find every heading (h1..h6) that lies at or before the topmost
// visible paragraph in document order, returning their trimmed text
// in document order. Used by the reader to surface "where in the
// section hierarchy am I right now" for the header chapter title and
// the TOC active highlight.
//
// Returning an array (rather than just the closest one as the
// previous version did) lets the parent walk DEEPEST-FIRST when
// matching against the TOC: a screen showing section "1.2.1 一致性
// 模型" inside a chapter whose TOC only goes two levels deep would
// previously fail to highlight anything; with the array, the parent
// can fall back to "1.2 一致性" (the next heading up) and highlight
// THAT, so the user always sees a real ancestor in the TOC dock.
//
// The returned list always contains at least one entry when the
// chapter has any non-empty heading; it is empty only when no
// headings exist at all. The LAST entry is the heading the reader
// is currently inside.
// 收集章节内所有"标题"元素。
//
// 颠覆式增强：不只检测 h1-h6，还检测：
//   - role="heading" 的元素
//   - aria-level 属性
//   - class 名包含 "heading" / "title" / "chapter" / "section" 的元素
//   - 字体明显大于正文的 p / div（基于 computed font-size）
//
// 原因：很多 EPUB 不使用语义化的 h1-h6，而用 <p class="hd1">、<div class="title">
// 之类的写法。如果 reader 只看 h1-h6，就检测不到这些"标题"，导致目录追踪失败。
function findHeadings(root: HTMLElement): { el: HTMLElement; level: number }[] {
  const out = new Map<HTMLElement, number>();

  // 1. 语义化标题
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))) {
    const lvl = parseInt(el.tagName.charAt(1), 10);
    if (lvl >= 1 && lvl <= 6) out.set(el, lvl);
  }

  // 2. ARIA 标题
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[role="heading"]'))) {
    const lvlAttr = el.getAttribute('aria-level');
    const lvl = lvlAttr ? parseInt(lvlAttr, 10) : 2;
    if (lvl >= 1 && lvl <= 6) {
      if (!out.has(el)) out.set(el, lvl);
    }
  }

  // 3. class 名包含标题相关关键字的元素
  const classQuery = '[class*="heading" i], [class*="title" i], [class*="chapter" i], [class*="section" i], [class*="hd" i]';
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(classQuery))) {
    if (out.has(el)) continue;
    const text = (el.textContent ?? '').trim();
    if (!text || text.length > 200) continue;
    // 排除明显不是标题的元素（链接、按钮、表单元素）
    const tag = el.tagName.toLowerCase();
    if (['a', 'button', 'input', 'select', 'textarea', 'span'].includes(tag)) continue;
    // 尝试从 class 名中提取层级
    const cls = el.className || '';
    let lvl = 0;
    const m = cls.match(/(?:h|hd|heading|title|level)[-_]?([1-6])\b/i);
    if (m) lvl = parseInt(m[1], 10);
    if (lvl < 1 || lvl > 6) {
      // 用 font-size 估计层级
      try {
        const fs = parseFloat(getComputedStyle(el).fontSize) || 16;
        if (fs >= 28) lvl = 1;
        else if (fs >= 22) lvl = 2;
        else if (fs >= 19) lvl = 3;
        else if (fs >= 17) lvl = 4;
        else lvl = 5;
      } catch {
        lvl = 3;
      }
    }
    out.set(el, lvl);
  }

  // 按文档顺序排序
  const arr = Array.from(out.entries()).map(([el, level]) => ({ el, level }));
  arr.sort((a, b) => {
    if (a.el === b.el) return 0;
    const pos = a.el.compareDocumentPosition(b.el);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
  return arr;
}

export function precedingHeadings(root: HTMLElement): string[] {
  const headings = findHeadings(root);
  if (headings.length === 0) return [];

  // 收集所有段落（块级文本元素），用于判断当前阅读到哪里。
  const paragraphs = collectParagraphs(root);

  // 确定"当前阅读位置的 y 坐标"：找到第一个在视口内可见的段落。
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const isVisible = (rect: DOMRect) =>
    rect.top >= 0 && rect.bottom > 0 &&
    rect.left < vw && rect.right > 0;
  let currentTop = 0;
  let foundVisible = false;
  for (const p of paragraphs) {
    const rect = p.el.getBoundingClientRect();
    if (isVisible(rect)) {
      currentTop = rect.top;
      foundVisible = true;
      break;
    }
  }

  // 如果没有任何可见段落，再用标题本身找：找到第一个可见标题，
  // 或退化为返回第一个非空标题。
  if (!foundVisible) {
    for (const h of headings) {
      const rect = h.el.getBoundingClientRect();
      if (isVisible(rect)) {
        currentTop = rect.top;
        foundVisible = true;
        break;
      }
    }
  }
  if (!foundVisible) {
    for (const h of headings) {
      const t = (h.el.textContent ?? '').trim();
      if (t) return [t];
    }
    return [];
  }

  // ── 第一步：收集当前位置之前的所有标题 ──
  const rawPreceding: Array<{ level: number; text: string }> = [];
  const TOL = 4;
  for (const h of headings) {
    const text = (h.el.textContent ?? '').trim();
    if (!text) continue;
    const rect = h.el.getBoundingClientRect();
    if (rect.left >= vw) break;
    if (rect.top > currentTop + TOL) {
      // 已超过当前阅读位置
      break;
    }
    rawPreceding.push({ level: h.level, text });
  }

  // ── 第二步：将扁平标题列表重建为层次化路径 ──
  const stack: Array<string | null> = [null, null, null, null, null, null];
  for (const { level, text } of rawPreceding) {
    const idx = Math.max(0, Math.min(5, level - 1));
    stack[idx] = text;
    for (let i = idx + 1; i < 6; i++) stack[i] = null;
  }
  const out = stack.filter((s): s is string => s !== null);

  if (out.length === 0) {
    for (const h of headings) {
      const t = (h.el.textContent ?? '').trim();
      if (t) { out.push(t); break; }
    }
  }
  return out;
}

/** @deprecated kept for any external callers still relying on the
 *  single-heading API; new code should use precedingHeadings instead. */
export function closestPrecedingHeading(root: HTMLElement): string | null {
  const all = precedingHeadings(root);
  return all.length > 0 ? all[all.length - 1] : null;
}

// Scroll / page-flip the reader so the paragraph in `cfi` becomes
// visible. Caller passes the scroll/page handler. Returns true if
// we found the anchor and asked the caller to navigate.
export interface NavigateOpts {
  /** True for paginated mode (translateY). */
  paginated: boolean;
  /** 视口高度（一页可见高度，像素）。 */
  pageHeight?: number;
  /** 每一页的 translateY 偏移列表。元素 0 为第 0 页起点 (=0)。 */
  pageBreaks?: number[];
  /** Reader-controlled callback to apply the chosen page index. */
  onPage?: (idx: number) => void;
  /** Reader-controlled callback to scroll to a paragraph. */
  onScroll?: (el: HTMLElement) => void;
}

export function navigateToCFIv2(
  root: HTMLElement,
  cfi: CFIv2,
  selectedText: string | undefined,
  opts: NavigateOpts,
): boolean {
  if (cfi.steps.length === 0) return false;
  const paragraphs = collectParagraphs(root);
  const byHash = new Map<string, Paragraph>();
  for (const p of paragraphs) byHash.set(p.hash, p);
  let para = byHash.get(cfi.steps[0].paraHash);
  if (!para && selectedText) {
    const needle = selectedText.trim().slice(0, 60);
    para = paragraphs.find(p => (p.el.textContent ?? '').includes(needle));
  }
  if (!para) return false;
  if (opts.paginated && opts.onPage) {
    // translateY 分页：找到目标段落的 offsetTop，再在 pageBreaks 中
    // 找最大的 break 值 ≤ offsetTop，对应的索引就是目标页。
    const top = (para.el as HTMLElement).offsetTop;
    const breaks = opts.pageBreaks;
    let target = 0;
    if (breaks && breaks.length > 0) {
      for (let i = breaks.length - 1; i >= 0; i--) {
        if (breaks[i] <= top) { target = i; break; }
      }
    } else if (opts.pageHeight && opts.pageHeight > 0) {
      target = Math.floor(top / opts.pageHeight);
    }
    opts.onPage(Math.max(0, target));
    return true;
  }
  if (opts.onScroll) {
    opts.onScroll(para.el);
    return true;
  }
  return false;
}
