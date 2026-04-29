// Tiny self-contained Markdown renderer used by the AI chat panel.
//
// We deliberately don't ship a full library (markdown-it / remark) —
// they're 60–100 KB minified and we need maybe 10% of their feature
// surface. The model emits plain prose plus occasional headings,
// emphasis, lists, code, and links; this renderer covers exactly that
// and produces safe HTML (no raw HTML pass-through, all user-visible
// strings are escaped before any inline rules run).
//
// Supported block syntax:
//   • # / ## / ### / #### / ##### / ###### headings
//   • blank-line-separated paragraphs
//   • `>` quoted block (single line, supports inline marks)
//   • ``` fenced code (language label optional, kept for CSS hooks)
//   • `- ` / `* ` / `+ ` unordered list items (single level)
//   • `<digits>. ` ordered list items (single level)
//   • `---` / `***` horizontal rule
//
// Supported inline syntax:
//   • **bold**          ~ <strong>
//   • *italic* / _italic_   ~ <em>
//   • `code`            ~ <code>
//   • [text](url)       ~ <a> with rel/target hardening
//   • ~~strike~~        ~ <s>
//
// Anything else (HTML tags, attribute injection, raw script) is
// neutralised by escaping at the start. The renderer is pure — give
// it a string, get a string back — so callers can stick the output
// straight into a dangerouslySetInnerHTML.

export function renderMarkdown(src: string): string {
  if (!src) return '';
  // Normalise line endings up front.
  const lines = src.replace(/\r\n?/g, '\n').split('\n');

  const out: string[] = [];
  let i = 0;
  let listKind: 'ul' | 'ol' | null = null;

  const closeList = () => {
    if (listKind) {
      out.push(`</${listKind}>`);
      listKind = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block: collect everything until the matching fence.
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      closeList();
      const lang = fence[1] ?? '';
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      // Skip the closing fence if we found one.
      if (i < lines.length) i += 1;
      const langClass = lang ? ` class="lang-${escapeAttr(lang)}"` : '';
      out.push(`<pre><code${langClass}>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // Horizontal rule.
    if (/^\s*(\*\s*\*\s*\*[\s*]*|-\s*-\s*-[\s-]*|_\s*_\s*_[\s_]*)$/.test(line)) {
      closeList();
      out.push('<hr/>');
      i += 1;
      continue;
    }

    // Headings.
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    // Blockquote (single line — model rarely emits multi-line quotes).
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      closeList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      i += 1;
      continue;
    }

    // Unordered list item.
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      if (listKind !== 'ul') {
        closeList();
        out.push('<ul>');
        listKind = 'ul';
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      i += 1;
      continue;
    }

    // Ordered list item.
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (listKind !== 'ol') {
        closeList();
        out.push('<ol>');
        listKind = 'ol';
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      i += 1;
      continue;
    }

    // Blank line — terminates any in-progress list.
    if (line.trim() === '') {
      closeList();
      i += 1;
      continue;
    }

    // Plain paragraph. Coalesce consecutive non-empty / non-block lines.
    closeList();
    const para: string[] = [line];
    let j = i + 1;
    while (
      j < lines.length &&
      lines[j].trim() !== '' &&
      !/^(#{1,6})\s+/.test(lines[j]) &&
      !/^>\s?/.test(lines[j]) &&
      !/^\s*[-*+]\s+/.test(lines[j]) &&
      !/^\s*\d+\.\s+/.test(lines[j]) &&
      !/^```/.test(lines[j])
    ) {
      para.push(lines[j]);
      j += 1;
    }
    out.push(`<p>${inline(para.join(' ').trim())}</p>`);
    i = j;
  }

  closeList();
  return out.join('');
}

// Inline rules. Order matters — code spans are extracted first so the
// emphasis/link rules don't wreck their literal contents. We use a
// placeholder swap (rare-codepoint markers) to round-trip code spans
// through the rest of the inline pipeline.
function inline(raw: string): string {
  if (!raw) return '';
  const codeStash: string[] = [];
  // Pull out `code` spans before escaping — this lets us keep the code
  // text verbatim (still escaped) without inline rules touching it.
  let s = raw.replace(/`([^`]+)`/g, (_m, c: string) => {
    codeStash.push(`<code>${escapeHtml(c)}</code>`);
    return `\u0000C${codeStash.length - 1}\u0000`;
  });
  // Escape everything else.
  s = escapeHtml(s);
  // Links — [text](url). The url is restricted to http(s) / mailto /
  // relative paths to keep `javascript:` payloads out.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, txt: string, url: string) => {
    const safe = sanitiseUrl(url);
    return safe
      ? `<a href="${escapeAttr(safe)}" target="_blank" rel="noopener noreferrer">${txt}</a>`
      : txt;
  });
  // Bold / italic / strike. We accept ** for bold, * or _ for italic,
  // and ~~ for strikethrough. Bold is tested first so ** doesn't match
  // as two italics.
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  // Restore code spans.
  s = s.replace(/\u0000C(\d+)\u0000/g, (_m, idx: string) => codeStash[Number(idx)] ?? '');
  return s;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function sanitiseUrl(u: string): string | null {
  const trimmed = u.trim();
  if (!trimmed) return null;
  // Block javascript:/data:/vbscript: while accepting normal URL forms.
  if (/^\s*(javascript|data|vbscript):/i.test(trimmed)) return null;
  // Allow http(s), mailto, and relative paths.
  if (/^(https?:|mailto:|\/|#|\.{0,2}\/)/i.test(trimmed)) return trimmed;
  // Bare host without scheme — let the browser prepend http:// rather
  // than risk an unintended scheme; we'd rather reject here.
  if (/^[a-zA-Z][\w+.-]*:/.test(trimmed)) return null;
  return trimmed;
}
