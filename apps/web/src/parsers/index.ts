// Format dispatcher for client-side parsing. Returns the structured
// payload the server's /api/books/{id}/ingest endpoint expects:
//
//   {
//     title, authors[], language?, publisher?,
//     chapters: [{ id, ord, title?, html?, text? }],
//     chunks:   [{ id, chapterId?, chapterOrd?, ord, text }],
//   }
//
// `id` values are short UUID-ish strings — the server doesn't care what
// format they take, it just needs them to be unique within the book
// and stable enough that chunk → chapter cross-refs survive a round
// trip.
//
// CHUNKING POLICY (shared across formats):
// We split each chapter's plain text into ~1000-char chunks, breaking
// at paragraph or sentence boundaries when possible. The chunk size is
// the granularity at which FTS5 returns matches in /api/search, so we
// want chunks small enough to give the user precise hits but large
// enough that highly relevant text isn't fragmented across many rows.

import { parseTxt } from './txt';
import { parseEpub } from './epub';

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

export interface IngestPayload {
  title?: string;
  authors?: string[];
  language?: string;
  publisher?: string;
  chapters: ChapterIn[];
  chunks: ChunkIn[];
}

export async function parseFile(file: File, format: 'txt' | 'epub'): Promise<IngestPayload> {
  if (format === 'txt') return parseTxt(file);
  if (format === 'epub') return parseEpub(file);
  throw new Error(`unsupported format: ${format}`);
}

// ── shared helpers (used by both txt and epub parsers) ───────────────

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
