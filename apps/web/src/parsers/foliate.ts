/*
中文导读：
foliate.ts 封装 foliate-js 相关逻辑，主要服务 EPUB 等电子书格式在浏览器里的解析和渲染。
Foliate 是外部库，所以这个文件相当于“适配层”：把外部库复杂 API 包装成 BookFree 自己更稳定的调用方式。
这样做的好处是：如果将来换 EPUB 渲染库，只需要尽量改适配层，不用让 ReaderPage 到处跟着改。
这里可能包含较多异步加载、章节定位、资源读取逻辑，修改时要注意浏览器兼容性和内存释放。
*/

// Unified parser that delegates to foliate-js for every format
// (https://github.com/johnfactotum/foliate-js, MIT). foliate-js powers
// the Foliate desktop reader, so its parsers handle the things we
// don't want to reimplement: encoding detection, NCX/nav TOCs,
// MOBI HUFF/CDIC and KF8, FB2 footnotes/binaries, ComicInfo metadata.
//
// Architecture:
//
//   parseBook(file)
//     ├── isMOBI(file)?              → mobi.MOBI(unzlib).open(file)
//     ├── zip + cbz extension?       → comic-book.makeComicBook(loader)
//     ├── zip + .fb2/.fbz?           → fb2.makeFB2(blob inside zip)
//     ├── zip otherwise?             → epub.EPUB(loader).init()
//     ├── plain XML / .fb2?          → fb2.makeFB2(file)
//     └── otherwise                   → throw (txt and pdf go elsewhere)
//
// All branches return a foliate "book" object with .metadata,
// .sections[], and .toc. We then walk sections, extract HTML+text,
// and convert into our IngestPayload (chapters + chunks).
//
// CBZ is special-cased: its sections are image pages, so we don't try
// to extract searchable text. Each page becomes one chapter with the
// zip-entry path stored in `href`, and CbzReader uses that path on
// playback to pull the page from the original file.

import { type IngestPayload, type ChapterIn, type ChunkIn, type TocItemIn, chunkText, htmlToText, shortId } from './index';
import { isMOBI, MOBI } from 'foliate-js/mobi.js';
import { makeFB2 } from 'foliate-js/fb2.js';
import { makeComicBook } from 'foliate-js/comic-book.js';
import { EPUB } from 'foliate-js/epub.js';
import {
  configure as zipConfigure,
  ZipReader,
  BlobReader,
  TextWriter,
  BlobWriter,
} from '@zip.js/zip.js';
import { unzlibSync } from 'fflate';

// foliate's mobi.js needs unzlib for KF8 fonts. Pass fflate's
// implementation; it works in browsers and is tiny.
const MOBI_OPTIONS = { unzlib: unzlibSync };

// ── format detection ─────────────────────────────────────────────────

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // 'PK\x03\x04'

async function isZip(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return head[0] === ZIP_MAGIC[0] && head[1] === ZIP_MAGIC[1] &&
         head[2] === ZIP_MAGIC[2] && head[3] === ZIP_MAGIC[3];
}

// ── zip loader ───────────────────────────────────────────────────────
// foliate's epub.js and comic-book.js take a `loader` shaped like:
//   { entries, loadText(name), loadBlob(name, type?), getSize(name), getComment() }
// We back it with @zip.js/zip.js because (per foliate's README)
// it's the only library that supports random access on a Blob — which
// is what EPUB rendering needs to fetch one resource at a time.

interface ZipLoader {
  entries: Array<{ filename: string }>;
  loadText: (name: string) => Promise<string | null>;
  loadBlob: (name: string, type?: string) => Promise<Blob | null>;
  getSize: (name: string) => number;
  getComment: () => Promise<string>;
}

// Loader is the lowest-common-denominator dependency the sanitize
// step needs from us. Right now both branches (zip-backed EPUB and
// plain MOBI) provide an object with loadBlob; for plain MOBI the
// loader will be null and we just skip image inlining (MOBI bundles
// images by recindex; foliate's mobi.js already rewrites those
// internally before the HTML reaches us, so there's nothing left to
// resolve in the markup).
type Loader = Pick<ZipLoader, 'loadBlob'>;

const NO_LOADER: Loader = { loadBlob: async () => null };

async function makeZipLoader(file: File): Promise<{ loader: ZipLoader; reader: ZipReader<Blob> }> {
  // useWebWorkers=false keeps the Vite dev server happy (no extra
  // worker chunk needed) and avoids a CSP wrinkle for production.
  zipConfigure({ useWebWorkers: false });
  const reader = new ZipReader(new BlobReader(file));
  const entries = await reader.getEntries();
  const map = new Map<string, (typeof entries)[number]>();
  for (const e of entries) map.set(e.filename, e);

  const comment = (() => {
    // zip.js exposes the archive comment on the reader as a Uint8Array.
    // Some CBZ producers tuck JSON metadata in there; foliate reads it.
    // Returning '' on absence is fine — foliate guards with try/catch.
    try {
      const c = (reader as unknown as { comment?: Uint8Array }).comment;
      if (!c || c.byteLength === 0) return '';
      return new TextDecoder('utf-8').decode(c);
    } catch {
      return '';
    }
  })();

  const loader: ZipLoader = {
    entries: entries.map(e => ({ filename: e.filename })),
    loadText: async (name) => {
      const e = map.get(name);
      // Skip directory entries (they have no getData) and missing names.
      if (!e || !('getData' in e) || typeof e.getData !== 'function') return null;
      return e.getData(new TextWriter()) as Promise<string>;
    },
    loadBlob: async (name, type) => {
      const e = map.get(name);
      if (!e || !('getData' in e) || typeof e.getData !== 'function') return null;
      return e.getData(new BlobWriter(type)) as Promise<Blob>;
    },
    getSize: (name) => {
      const e = map.get(name);
      return e && 'uncompressedSize' in e ? e.uncompressedSize : 0;
    },
    getComment: async () => comment,
  };

  return { loader, reader };
}

// ── public entry point ──────────────────────────────────────────────

export type ParserFormat = 'epub' | 'fb2' | 'fbz' | 'mobi' | 'azw' | 'azw3' | 'cbz';

export async function parseWithFoliate(file: File, format: ParserFormat): Promise<IngestPayload> {
  // We dispatch on extension first because the user-facing "format"
  // already came through the server's magic check; we use it to pick
  // the parser without re-sniffing the file. CBZ is special — its
  // ingest payload is structurally different (image pages, no text).
  if (format === 'cbz') return parseCbzInternal(file);
  if (format === 'mobi' || format === 'azw' || format === 'azw3') return parseMobiInternal(file);

  const fileIsZip = await isZip(file);
  if (format === 'fbz' || (format === 'fb2' && fileIsZip)) return parseFbzInternal(file);
  if (format === 'fb2') return parseFb2Internal(file);
  if (format === 'epub') return parseEpubInternal(file);

  throw new Error(`unsupported format: ${format}`);
}

// ── EPUB ─────────────────────────────────────────────────────────────

async function parseEpubInternal(file: File): Promise<IngestPayload> {
  const { loader, reader } = await makeZipLoader(file);
  try {
    const epub = new EPUB(loader);
    const book = await epub.init() as FoliateBook;
    return await collectBook(book, file.name, /*isComic=*/false, loader);
  } finally {
    await reader.close();
  }
}

// ── MOBI / AZW / AZW3 ────────────────────────────────────────────────

async function parseMobiInternal(file: File): Promise<IngestPayload> {
  if (!(await isMOBI(file))) {
    throw new Error('文件不是 MOBI/AZW/AZW3（缺少 BOOKMOBI 标识）');
  }
  const mobi = new MOBI(MOBI_OPTIONS);
  // `open` returns either a MOBI6 or KF8 wrapper, both of which expose
  // the same .sections / .toc / .metadata interface.
  const book = await mobi.open(file) as FoliateBook;
  // MOBI bundles images by recindex; foliate's mobi.js already
  // rewrites those to data URLs internally before we see the HTML,
  // so we don't need to resolve anything against the file at this
  // step. Pass NO_LOADER and the sanitize step short-circuits image
  // inlining for those (the data: src branch keeps them as-is).
  return await collectBook(book, file.name, /*isComic=*/false, NO_LOADER);
}

// ── FB2 / FBZ ────────────────────────────────────────────────────────

async function parseFb2Internal(file: File): Promise<IngestPayload> {
  const book = await makeFB2(file) as FoliateBook;
  return await collectBook(book, file.name, /*isComic=*/false, NO_LOADER);
}

async function parseFbzInternal(file: File): Promise<IngestPayload> {
  const { loader, reader } = await makeZipLoader(file);
  try {
    const fb2Entry = loader.entries.find(e => e.filename.toLowerCase().endsWith('.fb2'))
                  ?? loader.entries[0];
    if (!fb2Entry) throw new Error('FBZ 内未找到任何文件');
    const blob = await loader.loadBlob(fb2Entry.filename);
    if (!blob) throw new Error('FBZ 内 .fb2 文件读取失败');
    const book = await makeFB2(blob) as FoliateBook;
    return await collectBook(book, file.name, /*isComic=*/false, NO_LOADER);
  } finally {
    await reader.close();
  }
}

// ── CBZ ──────────────────────────────────────────────────────────────

async function parseCbzInternal(file: File): Promise<IngestPayload> {
  const { loader, reader } = await makeZipLoader(file);
  try {
    const book = await makeComicBook(loader, file) as FoliateBook;
    return await collectComicBook(book, file.name);
  } finally {
    await reader.close();
  }
}

// ── shared "book → IngestPayload" walker ─────────────────────────────
//
// Every foliate format returns the same shape: book.sections[], each
// with .createDocument(). We walk them, take the document body's
// HTML, extract a title from headings or TOC, derive plain text, and
// chunk it for FTS. Sections marked linear="no" (footnotes, etc.) are
// skipped — they're not part of the reading flow.

interface FoliateSection {
  id: unknown;
  load?: () => Promise<string> | string;
  createDocument?: () => Promise<Document> | Document;
  size?: number;
  linear?: string;
  href?: string;
}

interface FoliateTocItem {
  label?: string;
  href?: string;
  subitems?: FoliateTocItem[];
}

interface FoliateBook {
  sections: FoliateSection[];
  toc?: FoliateTocItem[];
  metadata?: {
    title?: string | { [k: string]: string };
    author?: unknown;
    language?: string | string[];
    publisher?: string | { [k: string]: string };
  };
  resolveHref?: (href: string) => { index: number; anchor?: unknown } | null;
}

async function collectBook(book: FoliateBook, filename: string, isComic: boolean, loader: Loader): Promise<IngestPayload> {
  const meta = extractMetadata(book, filename);
  const tocByIndex = buildTocIndex(book);

  const chapters: ChapterIn[] = [];
  const chunks: ChunkIn[] = [];
  let chunkOrd = 0;
  // Maps `spine index → chapter id we just inserted`. We need this in
  // a second pass to wire the TOC tree's hrefs to chapter ids.
  const chapterIdBySpineIndex = new Map<number, string>();

  for (let i = 0; i < book.sections.length; i++) {
    const sec = book.sections[i];
    if (!sec) continue;
    if (sec.linear === 'no' && !isComic) continue; // skip non-linear (footnotes etc.)
    if (!sec.createDocument) continue;

    let doc: Document;
    try {
      doc = await sec.createDocument();
    } catch (e) {
      console.warn(`section ${i} createDocument failed:`, e);
      continue;
    }

    const sectionHref = typeof sec.href === 'string' ? sec.href : '';
    const html = await sanitizeBodyHtml(doc, loader, sectionHref);
    const text = htmlToText(html);
    if (!isComic && text.trim().length === 0) continue;

    const title = pickChapterTitle(doc, tocByIndex.get(i)) || `第 ${chapters.length + 1} 章`;
    const cid = shortId('c');
    chapters.push({
      id: cid,
      ord: chapters.length,
      title,
      html,
      text,
    });
    chapterIdBySpineIndex.set(i, cid);

    for (const piece of chunkText(text)) {
      if (piece.length < 8) continue;
      chunks.push({
        id: shortId('k'),
        chapterId: cid,
        chapterOrd: chapters.length - 1,
        ord: chunkOrd++,
        text: piece,
      });
    }
  }

  if (chapters.length === 0) {
    throw new Error('未能提取出任何章节内容');
  }

  // Build the hierarchical TOC from book.toc, resolving each href to
  // a spine index → chapter id. Items whose href doesn't resolve
  // become heading-only (no chapterId) so we don't drop the label.
  const toc = buildHierarchicalToc(book, chapterIdBySpineIndex);

  return {
    title: meta.title,
    authors: meta.authors,
    language: meta.language,
    publisher: meta.publisher,
    chapters,
    chunks,
    toc,
  };
}

// CBZ produces image pages, not prose, so we don't try to extract
// searchable text. Each page becomes one chapter; CbzReader fetches
// the original .cbz at read time and renders the image at chapter.href.
async function collectComicBook(book: FoliateBook, filename: string): Promise<IngestPayload> {
  const meta = extractMetadata(book, filename);
  const chapters: ChapterIn[] = [];
  const chunks: ChunkIn[] = [];
  const toc: TocItemIn[] = [];

  // foliate's makeComicBook stores the page filename on section.id.
  // That's the same name used by the loader, so CbzReader can ask
  // JSZip (or any zip reader) for it directly.
  for (let i = 0; i < book.sections.length; i++) {
    const sec = book.sections[i];
    if (!sec) continue;
    const pageTitle = `第 ${i + 1} 页`;
    const filename = typeof sec.id === 'string' ? sec.id : '';
    const cid = shortId('c');
    chapters.push({
      id: cid,
      ord: i,
      title: pageTitle,
      href: filename,
      html: `<p class="cbz-placeholder">[${pageTitle}]</p>`,
      text: `[${pageTitle}]`,
    });
    chunks.push({
      id: shortId('k'),
      chapterId: cid,
      chapterOrd: i,
      ord: i,
      text: `${pageTitle}（图片页）`,
    });
    toc.push({ label: pageTitle, chapterId: cid, depth: 0 });
  }

  if (chapters.length === 0) throw new Error('CBZ 内未找到任何图片页');

  return {
    title: meta.title,
    authors: meta.authors,
    language: meta.language,
    publisher: meta.publisher,
    chapters,
    chunks,
    toc,
  };
}

// ── helpers ──────────────────────────────────────────────────────────

function extractMetadata(book: FoliateBook, filename: string) {
  const m = book.metadata ?? {};
  const title = pickLocalized(m.title) || stripExt(filename);
  const authors = normalizeAuthors(m.author);
  const language = Array.isArray(m.language) ? m.language[0] : m.language;
  const publisher = pickLocalized(m.publisher) || undefined;
  return { title, authors, language, publisher };
}

function pickLocalized(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object') {
    // foliate returns either a string or a {lang: string} map. Pick
    // the first non-empty value; we don't have a UI locale to honor.
    for (const k of Object.keys(v as Record<string, string>)) {
      const val = (v as Record<string, string>)[k];
      if (typeof val === 'string' && val.trim()) return val.trim();
    }
  }
  return '';
}

function normalizeAuthors(a: unknown): string[] {
  if (!a) return [];
  const arr = Array.isArray(a) ? a : [a];
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item === 'string') {
      const s = item.trim();
      if (s) out.push(s);
    } else if (item && typeof item === 'object') {
      // {name, sortAs} or a localized object
      const obj = item as Record<string, unknown>;
      const name = (typeof obj.name === 'string' ? obj.name : '')
                || pickLocalized(obj);
      if (name) out.push(name.trim());
    }
  }
  return out;
}

// Build a map from section index → preferred TOC label. We resolve
// each TOC href to a section index via the book's resolveHref, which
// knows about CFIs (EPUB), filepos URIs (MOBI), and section indices
// (others). If two TOC entries land on the same section, the first
// (most prominent) wins.
function buildTocIndex(book: FoliateBook): Map<number, string> {
  const out = new Map<number, string>();
  if (!book.toc || !book.resolveHref) return out;
  const walk = (items: FoliateTocItem[]) => {
    for (const it of items) {
      if (it.href && it.label) {
        try {
          const r = book.resolveHref!(it.href);
          if (r && typeof r.index === 'number' && !out.has(r.index)) {
            out.set(r.index, it.label.trim().slice(0, 120));
          }
        } catch {
          // resolveHref is best-effort; bad TOC hrefs are common in
          // the wild (broken toc.ncx, malformed CFIs).
        }
      }
      if (it.subitems) walk(it.subitems);
    }
  };
  walk(book.toc);
  return out;
}

// Build a hierarchical TOC tree by walking book.toc verbatim. This is
// what the user actually wants in the drawer: nested Part / Chapter /
// Section labels exactly as the book ships them.
//
// Resolution rules:
//   • If we can resolve href → spine index → chapter id, we attach
//     chapterId to the node so a click navigates the reader to it.
//   • If resolveHref fails or no chapter was emitted for that index
//     (linear="no", empty body), we keep the node as a heading-only
//     entry — useful for "Part I" wrappers that group children but
//     don't have body content of their own.
//   • Items lacking a label are dropped; their children are promoted
//     up so the hierarchy degrades gracefully.
function buildHierarchicalToc(
  book: FoliateBook,
  chapterIdBySpineIndex: Map<number, string>,
): TocItemIn[] {
  if (!book.toc || book.toc.length === 0) return [];
  const walk = (items: FoliateTocItem[], depth: number): TocItemIn[] => {
    const out: TocItemIn[] = [];
    for (const it of items) {
      const label = (it.label ?? '').trim();
      const children = it.subitems ? walk(it.subitems, depth + 1) : undefined;
      if (!label) {
        // Promote children to the parent level.
        if (children && children.length) out.push(...children);
        continue;
      }
      let chapterId: string | undefined;
      if (it.href && book.resolveHref) {
        try {
          const r = book.resolveHref(it.href);
          if (r && typeof r.index === 'number') {
            const cid = chapterIdBySpineIndex.get(r.index);
            if (cid) chapterId = cid;
          }
        } catch {
          // fall through — heading-only entry
        }
      }
      out.push({
        label: label.slice(0, 200),
        chapterId,
        depth,
        children: children && children.length > 0 ? children : undefined,
      });
    }
    return out;
  };
  return walk(book.toc, 0);
}

// Turn the foliate-loaded Document into a self-contained HTML string
// for storage. We keep the body's children verbatim — that preserves
// sanitizeBodyHtml strips dangerous bits (scripts, inline event
// handlers) AND inlines images. EPUB chapter HTML carries
// `<img src="../images/foo.jpg">` paths relative to the chapter
// document inside the zip; once the zip is gone those URLs resolve
// to nothing and the reader shows broken-image placeholders. We
// resolve each src against the zip via `loader.loadBlob`, then
// embed:
//   • images ≤ 256 KB         → as a data URL inline (no extra
//                                 disk cost; image lives in the
//                                 chapter HTML)
//   • images > 256 KB         → dropped silently with a console
//                                 warning. Inlining huge images
//                                 would explode the chapter row in
//                                 SQLite; we accept the trade-off
//                                 of "this big illustration won't
//                                 render" until we add a separate
//                                 book-asset table.
//
// Why not store images in a side table:
//   The user explicitly asked for the "smallest disk footprint"
//   route on RAG; matching that ethic here, inlining as data URLs
//   means we don't add a new table or new code path on the reader
//   side — and most EPUB images are well under 256 KB anyway.
//
// `basePath` is the chapter HTML's path inside the zip, used to
// resolve relative srcs like "../images/x.jpg".
const INLINE_IMAGE_MAX = 256 * 1024;

async function sanitizeBodyHtml(
  doc: Document,
  loader: Loader,
  basePath: string,
): Promise<string> {
  const body = doc.body ?? doc.documentElement;
  if (!body) return '';
  const clone = body.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('script, style, link, meta').forEach(n => n.remove());

  // Strip on* handlers + javascript:/data: in href on every element.
  for (const el of Array.from(clone.querySelectorAll('*'))) {
    for (const a of Array.from(el.attributes)) {
      if (a.name.toLowerCase().startsWith('on')) el.removeAttribute(a.name);
    }
  }

  // Inline images.
  const imgs = Array.from(clone.querySelectorAll('img'));
  for (const img of imgs) {
    const rawSrc = img.getAttribute('src') || img.getAttribute('xlink:href') || '';
    if (!rawSrc) {
      img.remove();
      continue;
    }
    if (rawSrc.startsWith('data:')) continue; // already inline
    if (/^https?:/.test(rawSrc)) {
      // Don't fetch external URLs at ingest — privacy + offline
      // concerns. Convert to a placeholder.
      img.removeAttribute('src');
      img.setAttribute('alt', img.getAttribute('alt') || '');
      continue;
    }
    const resolved = resolveZipPath(basePath, rawSrc);
    if (!resolved) {
      img.remove();
      continue;
    }
    try {
      const blob = await loader.loadBlob(resolved);
      if (!blob) {
        img.remove();
        continue;
      }
      if (blob.size > INLINE_IMAGE_MAX) {
        console.warn(`image ${resolved} is ${blob.size} B, larger than inline cap; dropped`);
        img.remove();
        continue;
      }
      const dataUrl = await blobToDataUrl(blob);
      img.setAttribute('src', dataUrl);
      img.removeAttribute('xlink:href');
      // Keep height auto so the page-flip math doesn't get confused
      // by absurdly tall images.
      const style = img.getAttribute('style') || '';
      img.setAttribute('style', style + ';max-width:100%;height:auto');
    } catch (e) {
      console.warn(`failed to inline image ${resolved}:`, e);
      img.remove();
    }
  }

  // Same for SVG <image href>.
  const svgImages = Array.from(clone.querySelectorAll('image'));
  for (const im of svgImages) {
    const href = im.getAttribute('href') || im.getAttribute('xlink:href') || '';
    if (!href || href.startsWith('data:') || /^https?:/.test(href)) continue;
    const resolved = resolveZipPath(basePath, href);
    if (!resolved) { im.remove(); continue; }
    try {
      const blob = await loader.loadBlob(resolved);
      if (!blob || blob.size > INLINE_IMAGE_MAX) { im.remove(); continue; }
      const dataUrl = await blobToDataUrl(blob);
      im.setAttribute('href', dataUrl);
      im.removeAttribute('xlink:href');
    } catch {
      im.remove();
    }
  }

  return clone.innerHTML;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsDataURL(blob);
  });
}

// Resolve a relative src against the chapter's base path inside the
// zip. Trims any "./" / "../" segments and the leading slash so the
// resulting key matches a zip entry filename.
function resolveZipPath(base: string, rel: string): string | null {
  if (!rel) return null;
  // Absolute zip path.
  if (rel.startsWith('/')) return rel.slice(1).split('#')[0].split('?')[0];
  const baseDir = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : '';
  let resolved = baseDir + rel;
  resolved = resolved.split('#')[0].split('?')[0];
  // Resolve "../" walks.
  const parts = resolved.split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') { out.pop(); continue; }
    out.push(p);
  }
  return out.join('/') || null;
}

function pickChapterTitle(doc: Document, tocLabel: string | undefined): string {
  if (tocLabel) return tocLabel;
  for (const tag of ['h1', 'h2', 'h3']) {
    const el = doc.querySelector(tag);
    const text = el?.textContent?.trim();
    if (text) return text.slice(0, 120);
  }
  const t = doc.querySelector('title')?.textContent?.trim();
  return t ? t.slice(0, 120) : '';
}

function stripExt(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name;
  return name.slice(0, dot);
}
