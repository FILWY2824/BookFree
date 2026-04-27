// EPUB parser. We use JSZip directly rather than epubjs for the parse
// step because epubjs is geared toward rendering and pulls in a stack
// of HTML iframe + CFI machinery we don't need for ingest.
//
// What we do:
//  1. Open the .epub as a zip.
//  2. Find META-INF/container.xml → it points to the OPF file.
//  3. Read the OPF: title, language, creator, manifest items, spine.
//  4. For each spine item, fetch its HTML, normalise <a href=> /
//     <img src=> against the OPF's base path, strip junk, and emit
//     it as a chapter. We collect plain text alongside for chunking.
//  5. Build the chunk list from the chapters' plain text.
//
// We don't decrypt encrypted EPUBs (EAdobe DRM, etc.). Those throw
// from this function and the caller surfaces a "解析失败" toast.

import JSZip from 'jszip';
import { type ChapterIn, type ChunkIn, type IngestPayload, chunkText, htmlToText, shortId } from './index';

export async function parseEpub(file: File): Promise<IngestPayload> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  if (zip.files['META-INF/encryption.xml']) {
    // Many publishers ship font-mangling tokens here too — that's OK.
    // The hard fail is the ContentEncryption variety.
    const enc = await zip.files['META-INF/encryption.xml'].async('string') as string;
    if (/ContentEncryption|PRH-EBC/i.test(enc)) {
      throw new Error('EPUB 受 DRM 保护，无法解析');
    }
  }

  const containerXML = await readText(zip, 'META-INF/container.xml');
  if (!containerXML) throw new Error('EPUB 缺少 container.xml');
  const opfPath = matchAttr(containerXML, /<rootfile[^>]+full-path="([^"]+)"/);
  if (!opfPath) throw new Error('EPUB container.xml 无 rootfile');

  const opfXML = await readText(zip, opfPath);
  if (!opfXML) throw new Error('EPUB 缺少 OPF 文件：' + opfPath);

  const basePath = opfPath.includes('/') ? opfPath.replace(/\/[^/]+$/, '/') : '';

  const meta = parseOPFMeta(opfXML);
  const manifest = parseManifest(opfXML);
  const spine = parseSpine(opfXML);

  const chapterIns: ChapterIn[] = [];
  const chunkIns: ChunkIn[] = [];
  let chunkOrd = 0;

  for (let i = 0; i < spine.length; i++) {
    const idref = spine[i];
    const item = manifest[idref];
    if (!item) continue;
    if (!item.mediaType.includes('html') && !item.mediaType.includes('xml')) continue;

    const path = normalizePath(basePath + item.href);
    const html = await readText(zip, path);
    if (!html) continue;

    const cleaned = sanitizeHTML(html);
    const text = htmlToText(html);
    const title = guessChapterTitle(html) || `第 ${i + 1} 章`;

    const cid = shortId('c');
    chapterIns.push({
      id: cid,
      ord: i,
      title,
      href: item.href,
      html: cleaned,
      text,
    });
    for (const piece of chunkText(text)) {
      if (piece.length < 8) continue; // skip tiny chunks (e.g. cover-only pages)
      chunkIns.push({
        id: shortId('k'),
        chapterId: cid,
        chapterOrd: i,
        ord: chunkOrd++,
        text: piece,
      });
    }
  }

  return {
    title: meta.title,
    authors: meta.authors,
    language: meta.language,
    publisher: meta.publisher,
    chapters: chapterIns,
    chunks: chunkIns,
  };
}

// ── helpers ──────────────────────────────────────────────────────────

async function readText(zip: JSZip, path: string): Promise<string> {
  const f = zip.file(path);
  if (!f) return '';
  return (await f.async('string')) as string;
}

function matchAttr(xml: string, re: RegExp): string {
  const m = re.exec(xml);
  return m ? m[1] : '';
}

interface OPFMeta {
  title: string;
  authors: string[];
  language?: string;
  publisher?: string;
}

function parseOPFMeta(opfXML: string): OPFMeta {
  const title = textOfFirstTag(opfXML, 'dc:title') ||
                textOfFirstTag(opfXML, 'title') || '';
  const language = textOfFirstTag(opfXML, 'dc:language') ||
                   textOfFirstTag(opfXML, 'language') || undefined;
  const publisher = textOfFirstTag(opfXML, 'dc:publisher') ||
                    textOfFirstTag(opfXML, 'publisher') || undefined;
  // <dc:creator>Author Name</dc:creator> can appear multiple times.
  const authors: string[] = [];
  const re = /<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(opfXML))) {
    const a = htmlToText(m[1]).trim();
    if (a) authors.push(a);
  }
  return { title: title.trim(), authors, language, publisher };
}

function textOfFirstTag(xml: string, tag: string): string {
  const re = new RegExp('<' + escapeRe(tag) + '\\b[^>]*>([\\s\\S]*?)</' + escapeRe(tag) + '>', 'i');
  const m = re.exec(xml);
  return m ? htmlToText(m[1]) : '';
}

interface ManifestItem {
  href: string;
  mediaType: string;
}

function parseManifest(opfXML: string): Record<string, ManifestItem> {
  const out: Record<string, ManifestItem> = {};
  const re = /<item\s+([^>]+?)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(opfXML))) {
    const attrs = m[1];
    const id = matchAttr(attrs, /\bid="([^"]+)"/);
    const href = matchAttr(attrs, /\bhref="([^"]+)"/);
    const mt = matchAttr(attrs, /\bmedia-type="([^"]+)"/);
    if (id && href) out[id] = { href, mediaType: mt };
  }
  return out;
}

function parseSpine(opfXML: string): string[] {
  const spineMatch = /<spine\b[^>]*>([\s\S]*?)<\/spine>/i.exec(opfXML);
  if (!spineMatch) return [];
  const re = /<itemref\s+([^>]+?)\/?>/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(spineMatch[1]))) {
    const idref = matchAttr(m[1], /\bidref="([^"]+)"/);
    if (idref) out.push(idref);
  }
  return out;
}

function normalizePath(p: string): string {
  // Resolve ../ segments.
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

// Strip <script>, <link rel="stylesheet">, inline <style>, <meta http-equiv>.
// Leave the rest alone — the reader's .reader-prose CSS handles styling.
function sanitizeHTML(html: string): string {
  return html
    .replace(/<\?xml[^?]*\?>/g, '')
    .replace(/<!DOCTYPE[^>]+>/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<link[^>]*>/gi, '')
    .replace(/<meta[^>]*>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\son\w+='[^']*'/gi, '');
}

function guessChapterTitle(html: string): string {
  // Prefer <h1>/<h2>/<title>.
  for (const tag of ['h1', 'h2', 'h3', 'title']) {
    const t = textOfFirstTag(html, tag);
    if (t) return t.slice(0, 80);
  }
  return '';
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
