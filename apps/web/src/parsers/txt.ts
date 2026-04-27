// TXT parser. Reads the file, autodetects encoding (UTF-8 vs GB18030
// for Chinese text), and slices the text into chapters using the
// common table-of-contents markers seen in zh/en text dumps:
//
//   第一章 / 第1章 / 第 1 章 / 第一回 / Chapter 1 / CHAPTER ONE
//
// If no markers match we treat the whole file as one chapter — still
// readable, still ingests cleanly into FTS5, just no TOC.

import { type ChapterIn, type ChunkIn, type IngestPayload, chunkText, shortId } from './index';

export async function parseTxt(file: File): Promise<IngestPayload> {
  const buf = await file.arrayBuffer();
  const text = decodeTxt(new Uint8Array(buf));
  const title = stripExt(file.name);

  const chapters = splitChapters(text);
  const chapterIns: ChapterIn[] = [];
  const chunkIns: ChunkIn[] = [];
  let chunkOrd = 0;

  chapters.forEach((c, idx) => {
    const cid = shortId('c');
    chapterIns.push({
      id: cid,
      ord: idx,
      title: c.title || `第 ${idx + 1} 章`,
      text: c.body,
      // We synthesize a tiny HTML version for the reader so it can
      // share the same .reader-prose CSS as EPUB content.
      html: textToBasicHTML(c.body),
    });
    for (const piece of chunkText(c.body)) {
      chunkIns.push({
        id: shortId('k'),
        chapterId: cid,
        chapterOrd: idx,
        ord: chunkOrd++,
        text: piece,
      });
    }
  });

  return {
    title,
    chapters: chapterIns,
    chunks: chunkIns,
  };
}

// ── encoding detection ──────────────────────────────────────────────

function decodeTxt(bytes: Uint8Array): string {
  // BOM cases first.
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return new TextDecoder('utf-8').decode(bytes.slice(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    return new TextDecoder('utf-16le').decode(bytes.slice(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    return new TextDecoder('utf-16be').decode(bytes.slice(2));
  }
  // Heuristic: try UTF-8 strict; if it fails, fall back to GB18030
  // (most Chinese .txt downloads are GB18030 / GBK).
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    /* fall through */
  }
  try {
    return new TextDecoder('gb18030').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes); // best effort
  }
}

// ── chapter splitting ───────────────────────────────────────────────

interface RawChapter {
  title: string;
  body: string;
}

const CN_NUM = '零一二三四五六七八九十百千万0-9';
const CHAPTER_RE = new RegExp(
  '^(?:' +
  // 第X章 / 第X回 / 第X节 / 第X部分
  '第[' + CN_NUM + ']{1,12}\\s*[章回节卷篇部]' +
  '|' +
  // Chapter 1 / CHAPTER ONE / Section 1
  '(?:Chapter|CHAPTER|Section|Part)\\s+[\\d零一二三四五六七八九十百千万OneTwoThreeFourFiveSixSevenEightNineTen]+' +
  // Optional trailing colon / dash
  ')(?:[\\s:：—\\-—\\u3000.\\u300A\\u300B、]+.+)?\\s*$',
);

function splitChapters(text: string): RawChapter[] {
  const lines = text.split(/\r?\n/);
  const chapters: RawChapter[] = [];
  let curTitle = '';
  let buf: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && trimmed.length <= 40 && CHAPTER_RE.test(trimmed)) {
      if (buf.length || curTitle) {
        chapters.push({ title: curTitle, body: buf.join('\n').trim() });
      }
      curTitle = trimmed;
      buf = [];
    } else {
      buf.push(line);
    }
  }
  if (buf.length || curTitle) {
    chapters.push({ title: curTitle, body: buf.join('\n').trim() });
  }

  // Drop "preamble" entries with no useful body.
  const filtered = chapters.filter(c => c.body.length > 0 || c.title);
  if (filtered.length === 0) {
    return [{ title: '', body: text.trim() }];
  }
  // If we got just one chapter and it's huge with no detected title,
  // return it as the whole-file chapter.
  return filtered;
}

function textToBasicHTML(text: string): string {
  // Convert paragraph-separated text to a stack of <p> tags. We escape
  // the few HTML metacharacters since the source might contain them.
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .split(/\n\s*\n+/g)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${p.replace(/\n/g, '<br/>')}</p>`)
    .join('\n');
}

function stripExt(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name;
  return name.slice(0, dot);
}
