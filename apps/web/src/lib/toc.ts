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
