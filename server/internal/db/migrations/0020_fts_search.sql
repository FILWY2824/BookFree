-- 0020_fts_search.sql — replace per-request MiniSearch with SQLite FTS5
--
-- Adds:
--   • search_text columns on book_chunks and notes (bigram-tokenized,
--     written by the application layer — see internal/search/tokenize.go).
--   • Two FTS5 virtual tables that index those columns. Every other
--     useful column (text, locator, page_no, …) rides along as
--     UNINDEXED so search results can return without a JOIN.
--   • Triggers that keep the FTS tables in sync on INSERT/UPDATE/DELETE.
--
-- This migration is additive: existing rows still need their
-- search_text backfilled. Run `./bookfree-server backfill-fts` after
-- migration to populate the FTS tables.
--
-- WHY FTS5 SHADOW COLUMNS NOT CONTENTLESS:
-- We could declare these as `content='book_chunks', content_rowid='id'`
-- contentless tables, but then the FTS would only see book_chunks.text,
-- which is the original Chinese text — and unicode61 doesn't tokenize
-- CJK usefully. By introducing search_text and indexing IT, we keep
-- the FTS tokenizer's hands off the raw CJK text and feed it our
-- pre-bigrammed token stream.

ALTER TABLE book_chunks ADD COLUMN search_text TEXT;
ALTER TABLE notes ADD COLUMN search_text TEXT;

CREATE VIRTUAL TABLE IF NOT EXISTS book_chunks_fts USING fts5(
  search_text,
  text         UNINDEXED,
  user_id      UNINDEXED,
  book_id      UNINDEXED,
  chapter_id   UNINDEXED,
  chapter_ord  UNINDEXED,
  page_no      UNINDEXED,
  chunk_id     UNINDEXED,
  locator      UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  search_text,
  body          UNINDEXED,
  selected_text UNINDEXED,
  user_id       UNINDEXED,
  book_id       UNINDEXED,
  note_id       UNINDEXED,
  chapter_id    UNINDEXED,
  locator       UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Sync triggers. Note book_chunks doesn't have a `locator` column in
-- the legacy schema — we synthesize one from chapter_id + ord so
-- search results can carry an opaque pointer. Same for notes_fts which
-- can use the existing locator column directly.

CREATE TRIGGER IF NOT EXISTS book_chunks_fts_ai
  AFTER INSERT ON book_chunks
  WHEN NEW.search_text IS NOT NULL
BEGIN
  INSERT INTO book_chunks_fts (
    search_text, text, user_id, book_id, chapter_id, chapter_ord, page_no, chunk_id, locator
  ) VALUES (
    NEW.search_text, NEW.text, NEW.user_id, NEW.book_id,
    NEW.chapter_id, NEW.chapter_ord, NEW.page_no, NEW.id,
    COALESCE(NEW.chapter_id, '') || '#' || NEW.ord
  );
END;

CREATE TRIGGER IF NOT EXISTS book_chunks_fts_ad
  AFTER DELETE ON book_chunks
BEGIN
  DELETE FROM book_chunks_fts WHERE chunk_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS book_chunks_fts_au
  AFTER UPDATE ON book_chunks
  WHEN NEW.search_text IS NOT NULL
BEGIN
  DELETE FROM book_chunks_fts WHERE chunk_id = OLD.id;
  INSERT INTO book_chunks_fts (
    search_text, text, user_id, book_id, chapter_id, chapter_ord, page_no, chunk_id, locator
  ) VALUES (
    NEW.search_text, NEW.text, NEW.user_id, NEW.book_id,
    NEW.chapter_id, NEW.chapter_ord, NEW.page_no, NEW.id,
    COALESCE(NEW.chapter_id, '') || '#' || NEW.ord
  );
END;

CREATE TRIGGER IF NOT EXISTS notes_fts_ai
  AFTER INSERT ON notes
  WHEN NEW.search_text IS NOT NULL AND NEW.deleted_at IS NULL
BEGIN
  INSERT INTO notes_fts (
    search_text, body, selected_text, user_id, book_id, note_id, chapter_id, locator
  ) VALUES (
    NEW.search_text, NEW.body, NEW.selected_text, NEW.user_id, NEW.book_id, NEW.id, NEW.chapter_id, NEW.locator
  );
END;

CREATE TRIGGER IF NOT EXISTS notes_fts_ad
  AFTER DELETE ON notes
BEGIN
  DELETE FROM notes_fts WHERE note_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS notes_fts_au
  AFTER UPDATE ON notes
BEGIN
  DELETE FROM notes_fts WHERE note_id = OLD.id;
  -- Re-insert only if the row is "live" and has a search_text.
  -- Soft-deleted rows (deleted_at NOT NULL) should NOT appear in search.
  INSERT INTO notes_fts (
    search_text, body, selected_text, user_id, book_id, note_id, chapter_id, locator
  )
  SELECT NEW.search_text, NEW.body, NEW.selected_text, NEW.user_id, NEW.book_id, NEW.id, NEW.chapter_id, NEW.locator
  WHERE NEW.search_text IS NOT NULL AND NEW.deleted_at IS NULL;
END;

UPDATE _meta SET value = '20', updated_at = unixepoch() WHERE key = 'schema_version';
