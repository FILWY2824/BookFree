// Format dispatcher for client-side parsing. Returns the structured
// payload the server's /api/books/{id}/ingest endpoint expects:
//
//   {
//     title, authors[], language?, publisher?,
//     chapters: [{ id, ord, title?, html?, text? }],
//     chunks:   [{ id, chapterId?, chapterOrd?, ord, text }],
//   }
//
// Implementation strategy:
// - TXT we parse ourselves (encoding sniff + chapter-marker regex).
// - PDF we don't ingest text — pdf.js renders the original file
//   directly and the search index stays empty for PDFs (this is the
//   same behavior as before). Search not finding text inside a PDF
//   is the lesser evil compared to a 200MB pdf.js text-extraction
//   pass for every upload.
// - EPUB / MOBI / AZW / AZW3 / FB2 / FBZ / CBZ all go through
//   foliate-js. It's the same library that powers the Foliate desktop
//   reader, so its parsers handle the things our hand-rolled code got
//   wrong: encoding detection, NCX/nav TOCs, KF8 HUFF/CDIC, FB2
//   footnotes, ComicInfo metadata.
//
// CHUNKING POLICY (shared across formats):
// We split each chapter's plain text into ~1000-char chunks, breaking
// at paragraph or sentence boundaries when possible. The chunk size is
// the granularity at which FTS5 returns matches in /api/search.

import { parseTxt } from './txt';
import { parseWithFoliate, type ParserFormat } from './foliate';

export interface ChapterIn {
  id: string;
  ord: number;
  title?: string;
  href?: string;
  html?: string;
  text?: string;
}

export interface ChunkIn {
  id: string;
  chapterId?: string;
  chapterOrd?: number;
  ord: number;
  text: string;
}

// One node in the hierarchical table of contents. The `chapterId`,
// when present, MUST match a `ChapterIn.id` in the same payload — the
// server resolves it to the scoped DB id during ingest. Heading-only
// entries (e.g. "Part I" wrappers) MAY omit chapterId; the TocDrawer
// still renders them as non-navigable section labels.
export interface TocItemIn {
  label: string;
  chapterId?: string;
  depth?: number;
  children?: TocItemIn[];
}

export interface IngestPayload {
  title?: string;
  authors?: string[];
  language?: string;
  publisher?: string;
  chapters: ChapterIn[];
  chunks: ChunkIn[];
  /** Hierarchical TOC. When omitted/empty, the server falls back to
   *  rendering chapters as a flat list. We always populate this for
   *  EPUB / MOBI / FB2 (the formats that carry a real TOC); TXT and
   *  CBZ leave it empty since their structure is already flat. */
  toc?: TocItemIn[];
}

// Formats that produce ingest payloads on the client. PDF skips this
// path entirely (pdf.js renders the original file, no chapters stored).
export type ParsedFormat = 'txt' | ParserFormat;

const FOLIATE_FORMATS: ParserFormat[] = ['epub', 'fb2', 'fbz', 'mobi', 'azw', 'azw3', 'cbz'];

export async function parseFile(file: File, format: ParsedFormat): Promise<IngestPayload> {
  if (format === 'txt') return parseTxt(file);
  if ((FOLIATE_FORMATS as string[]).includes(format)) {
    return parseWithFoliate(file, format as ParserFormat);
  }
  throw new Error(`unsupported format: ${format}`);
}

// ── shared helpers (used by parsers and the foliate adapter) ─────────

let counter = 0;
export function shortId(prefix: string): string {
  counter = (counter + 1) >>> 0;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

const CHUNK_TARGET = 1000;
const CHUNK_MAX = 1500;

/** Split a chapter's plain text into chunks, preferring paragraph
 *  breaks then sentence breaks. Returns text-only chunks; the caller
 *  attaches chapter metadata. */
export function chunkText(text: string): string[] {
  const out: string[] = [];
  const paragraphs = text
    .split(/\n\s*\n+/g)
    .map(p => p.trim())
    .filter(Boolean);

  let buf = '';
  for (const p of paragraphs) {
    if ((buf + '\n\n' + p).length > CHUNK_TARGET && buf) {
      out.push(buf);
      buf = p;
    } else {
      buf = buf ? buf + '\n\n' + p : p;
    }
    while (buf.length > CHUNK_MAX) {
      // Hard split on sentence boundary if we blew past the cap.
      const cut = bestSentenceCut(buf, CHUNK_TARGET);
      out.push(buf.slice(0, cut).trim());
      buf = buf.slice(cut).trim();
    }
  }
  if (buf) out.push(buf);
  return out.filter(c => c.length > 0);
}

function bestSentenceCut(s: string, around: number): number {
  // Prefer Chinese punctuation 。 ！ ？ then English . ! ?
  const seps = /[。！？.!?][”"」』）)]?/g;
  let last = -1;
  let m: RegExpExecArray | null;
  while ((m = seps.exec(s))) {
    const idx = m.index + m[0].length;
    if (idx > around) break;
    last = idx;
  }
  if (last > 0) return last;
  // No sentence boundary in range — fall back to a hard cut at `around`.
  return Math.min(around, s.length);
}

/** Strip HTML and collapse whitespace to plain text. */
export function htmlToText(html: string): string {
  // Remove scripts/styles wholesale before stripping.
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  // Decode the handful of entities that matter for readability.
  const dec = cleaned
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return dec
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
