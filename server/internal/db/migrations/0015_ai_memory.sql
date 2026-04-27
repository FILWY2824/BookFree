-- ─────────────────────────────────────────────────────────────────────────
-- 0015_ai_memory.sql — AI memory system (v12_12 follow-up)
-- ─────────────────────────────────────────────────────────────────────────
--
-- This migration introduces two new tables for the AI memory subsystem:
--
--   chat_session_summaries  — L2: per-session running summary of older
--                             messages, used when the model's context
--                             window can't hold the whole conversation.
--
--   user_memory             — L3: per-user long-term profile describing
--                             the user's reading habits, question style,
--                             and response preferences. Updated
--                             asynchronously every few user messages.
--
-- Design notes:
--   • Both tables are scoped per user (user_id fk) and participate in
--     the standard cascade-on-user-delete behaviour used elsewhere.
--   • All memory fields are plain TEXT, not encrypted — the user MUST
--     be able to read, edit, and wipe their own memory from the
--     Settings UI. Encrypting would defeat that purpose. Audit logs
--     capture *when* memory is updated, never *what*.
--   • `user_memory.enabled` lets the user fully opt out without
--     losing existing memory contents (toggle it back on to resume).
--
-- Rollback: `DROP TABLE chat_session_summaries; DROP TABLE user_memory;`
-- No data in either table is ever depended on by other migrations; they
-- are safe to recreate.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chat_session_summaries (
  session_id         TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  -- The generated summary text. A single paragraph (300–600 chars) that
  -- recaps the covered portion of the conversation.
  summary            TEXT NOT NULL,
  -- How many messages from the head of the session the summary covers.
  -- When the tail grows past its threshold we regenerate, bumping this.
  covers_msg_count   INTEGER NOT NULL,
  -- Loose token estimate for budget-planning on the next request.
  token_estimate     INTEGER,
  updated_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  created_at         INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_session_summaries_user
  ON chat_session_summaries (user_id);


CREATE TABLE IF NOT EXISTS user_memory (
  user_id                 TEXT PRIMARY KEY,

  -- ── Structured dimensions ────────────────────────────────────────────
  -- Each field is free-text (1–3 sentences). We use separate columns
  -- instead of one big JSON blob so the Settings UI can render and let
  -- the user edit each dimension independently. The extractor prompt
  -- is instructed to keep every field reading-related (see §6).

  -- 阅读口味 — genres, authors, eras, styles the user gravitates toward.
  reading_taste           TEXT,
  -- 关注主题 — recurring concepts, themes, questions.
  recurring_topics        TEXT,
  -- 提问风格 — technical vs experiential, depth vs breadth, tone.
  question_style          TEXT,
  -- 回答偏好 — preferred length, structure, use of examples, markdown.
  response_preferences    TEXT,
  -- 知识水平 — perceived expertise per topic (beginner / intermediate / expert).
  knowledge_level         TEXT,
  -- 阅读习惯 — pacing, depth-over-breadth, note-taking frequency.
  reading_habits          TEXT,
  -- 阅读目标 — stated or inferred long-term goals (learn X, finish Y).
  goals                   TEXT,
  -- 相关专业背景 — domains the user seems to have prior grounding in.
  background_context      TEXT,
  -- 语言偏好 — Chinese / English / mixed, formal vs casual.
  language_preference     TEXT,
  -- 其他观察 — freeform catch-all for notes that don't fit elsewhere.
  other_notes             TEXT,

  -- ── Control & bookkeeping ────────────────────────────────────────────
  -- Master on/off switch. When 0, the memory is NEVER injected into
  -- prompts and is NEVER updated — it's fully inert but preserved.
  enabled                 INTEGER NOT NULL DEFAULT 1,
  -- Counter driving §4-A's update cadence. Incremented on each
  -- user-role message; reset to 0 after each successful update.
  messages_since_update   INTEGER NOT NULL DEFAULT 0,
  -- Lifetime count of successful profile regenerations.
  total_updates           INTEGER NOT NULL DEFAULT 0,
  -- When the structured fields were last regenerated.
  last_updated_at         INTEGER,
  created_at              INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_user_memory_enabled
  ON user_memory (enabled) WHERE enabled = 1;
