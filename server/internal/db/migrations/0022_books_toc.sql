-- Stage 22: persist hierarchical TOC alongside books.
--
-- Why a separate column instead of reusing book_chapters?
--   book_chapters represents the *spine* — the unit of rendering. One
--   row per readable section. The TOC, however, is a *navigation tree*
--   with arbitrary nesting (Part → Chapter → Section → Subsection in
--   well-produced EPUBs). Two TOC items often resolve to the same
--   spine entry (e.g. "Introduction" and "Definitions" both inside
--   chapter1.xhtml). The legacy ingest folded the TOC down to one
--   label per spine row, which is exactly the bug the user reported
--   ("the TOC isn't the book's real TOC").
--
--   Storing the full tree as JSON on the book row keeps reads cheap
--   (one extra column scan, no joins) and lets the parser preserve
--   hierarchy verbatim. The TocDrawer renders it directly; clicks
--   resolve to the chapterId we recorded for each TOC leaf, which is
--   what the reader uses for navigation.
--
-- Schema:
--   toc TEXT NULL — JSON array of TocItem, where:
--     interface TocItem {
--       label: string;          // visible label
--       chapterId?: string;     // FK into book_chapters.id (book-scoped)
--       depth?: number;         // 0-based, redundant with nesting
--       children?: TocItem[];   // sub-entries; arbitrary nesting
--     }
--   NULL toc means "no extracted TOC, fall back to flat chapter list",
--   which preserves the legacy behaviour for older books that haven't
--   been re-ingested.

ALTER TABLE books ADD COLUMN toc TEXT;

UPDATE _meta SET value = '22', updated_at = unixepoch() WHERE key = 'schema_version';
