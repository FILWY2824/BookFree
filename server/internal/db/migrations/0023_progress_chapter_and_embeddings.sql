-- Stage 23: progress.chapter_id + RAG embedding cache.
--
-- Two related changes that together let us implement (a) precise
-- per-paragraph reading-progress restore and (b) the lightweight
-- vector-rerank step in the RAG retrieval stack.
--
-- 1. reading_progress.chapter_id
--    The pre-existing `locator` column was always intended to be an
--    opaque per-format pointer. With the CFIv2 client-side format
--    (paragraph hash + char offset; see apps/web/src/lib/locator.ts)
--    we need to know WHICH chapter the locator applies to so we can
--    decide whether to consume it on chapter mount. We could pack the
--    chapter id into the locator string but storing it explicitly is
--    cheaper at read time and lets us index by it later if needed.
--
-- 2. book_chunk_embeddings
--    Lightweight per-chunk vectors used to re-rank FTS5 candidates
--    during RAG retrieval. We deliberately store the vectors as a
--    BLOB (Float32Array little-endian) keyed by chunk_id so we don't
--    pay the JSON overhead at query time. Dim is fixed (96) so the
--    BLOB length is predictable (96 * 4 = 384 bytes/chunk). At ~1000
--    chars per chunk and a typical book of ~500-1000 chunks, this
--    works out to ~200-400 KB per book — well under the 1 MB target
--    we set as the disk-cost ceiling.
--
--    `model_tag` lets us re-embed with a future, better model
--    without confusing fresh and stale rows: the retrieval path only
--    accepts vectors whose tag matches the currently-active model.
--    Old rows are pruned in a follow-up migration once we migrate.

ALTER TABLE reading_progress ADD COLUMN chapter_id TEXT;

CREATE TABLE IF NOT EXISTS book_chunk_embeddings (
  chunk_id   TEXT PRIMARY KEY REFERENCES book_chunks(id) ON DELETE CASCADE,
  book_id    TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_tag  TEXT NOT NULL,
  -- Float32 little-endian, dim = 96. Length must equal 96*4 = 384.
  vector     BLOB NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_chunk_emb_book ON book_chunk_embeddings(book_id);

UPDATE _meta SET value = '23', updated_at = unixepoch() WHERE key = 'schema_version';
