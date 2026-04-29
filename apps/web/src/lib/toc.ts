// Client wrapper for the hierarchical TOC endpoint.
//
// Why this is separate from chapters/list:
//   chapters/list returns the *spine* — one row per readable section,
//   used by the reader to navigate page-flips and by progress tracking.
//   The TOC is a *navigation tree* that may have arbitrary nesting and
//   may contain heading-only entries (no chapterId) that group child
//   nodes. Conflating them, like the legacy frontend did, was the
//   source of the "TOC isn't the real TOC" bug we're fixing here.
//
// Resilience:
//   The server's /toc endpoint synthesises a flat tree from chapters
//   when no real TOC is stored (pre-migration books, formats whose
//   parser couldn't extract one). So a successful response is always
//   non-empty for ready books. We treat HTTP failure as "no TOC" and
//   let the caller decide what to render — typically a single "目录
//   不可用" line in the drawer.

import { api } from './api';

export interface TocItem {
  label: string;
  /** Resolved chapter id when the TOC entry maps to a readable section.
   *  Heading-only entries (e.g. "Part I" wrappers) leave this undefined
   *  and the drawer renders them as non-clickable section dividers. */
  chapterId?: string;
  depth?: number;
  children?: TocItem[];
}

export interface TocResponse {
  items: TocItem[];
}

export function fetchToc(bookId: string): Promise<TocItem[]> {
  return api
    .get<TocResponse>(`/api/books/${bookId}/toc`)
    .then(d => Array.isArray(d.items) ? d.items : [])
    .catch(() => []);
}

/** Walk the tree depth-first and return the first item whose chapterId
 *  matches. Used by the drawer to derive "which TOC node is currently
 *  active" given the spine ord the reader exposes. */
export function findTocItemByChapterId(items: TocItem[], chapterId: string): TocItem | null {
  for (const it of items) {
    if (it.chapterId === chapterId) return it;
    if (it.children && it.children.length) {
      const sub = findTocItemByChapterId(it.children, chapterId);
      if (sub) return sub;
    }
  }
  return null;
}

/** Walk the tree depth-first and return the first item whose label
 *  contains or equals the given heading text. Used to match a section
 *  heading detected in the chapter DOM ("2.3.8 小结") against a TOC
 *  entry so the drawer's active-chapter highlight tracks the user's
 *  scroll position even when a single chapterId maps to many entries.
 *
 *  Matching is intentionally fuzzy: TOC labels often have leading
 *  numbering ("2.3.8 小结") that matches the heading exactly, but
 *  some EPUBs strip or rewrite numbering, so we accept either:
 *    • exact equal (whitespace-collapsed)
 *    • TOC label CONTAINS heading text (e.g. "2.3.8 小结 (节录)" vs "小结")
 *    • heading text CONTAINS TOC label (e.g. "Chapter 2 — 小结" vs "小结")
 */
export function findTocItemByHeading(items: TocItem[], heading: string): TocItem | null {
  const needle = collapseSpaces(heading);
  if (!needle) return null;
  // Try exact match first to avoid spurious substring hits — "1" would
  // otherwise match every TOC entry containing the digit.
  const exact = walk(items, lbl => collapseSpaces(lbl) === needle);
  if (exact) return exact;
  // Then look for a TOC label whose collapsed form starts with the
  // heading (the common case: heading "2.3.8 小结" matches TOC entry
  // "2.3.8 小结").
  const startsWith = walk(items, lbl => collapseSpaces(lbl).startsWith(needle));
  if (startsWith) return startsWith;
  // Final fallback — bidirectional substring. Keep this last; it's
  // the most permissive and most likely to false-positive.
  return walk(items, lbl => {
    const c = collapseSpaces(lbl);
    return c.includes(needle) || needle.includes(c);
  });
}

function walk(items: TocItem[], pred: (label: string) => boolean): TocItem | null {
  for (const it of items) {
    if (pred(it.label)) return it;
    if (it.children && it.children.length) {
      const sub = walk(it.children, pred);
      if (sub) return sub;
    }
  }
  return null;
}

function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
