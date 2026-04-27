-- 0019_highlight_styles.sql
-- ─────────────────────────────────────────────────────────────────────
-- Adds the `style` column to the `highlights` table so a single row can
-- represent any of several annotation styles the user wants:
--   • 'highlight' — the classic filled translucent rectangle (existing)
--   • 'underline' — a single line along the baseline of the selection
--   • 'wavy'      — a wavy/squiggly line below the selection
--   • 'strike'    — a horizontal line through the middle (strikethrough)
--
-- User ask: "需要在阅读页增加一个功能 (对所有格式都需要支持): 增加
-- 下划线、波浪线、删除线, 这些也可以支持选择颜色, 跟高亮与笔记类似".
--
-- Default is 'highlight' so all existing rows continue to render
-- exactly as they did before. The `color` column continues to drive
-- the annotation's tint regardless of style.
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE highlights ADD COLUMN style TEXT NOT NULL DEFAULT 'highlight';

-- Explicit index on (user_id, book_id, style) not strictly needed —
-- per-book queries already hit idx_hl_user_book and the style column
-- is small enough to be filter-after-fetch on the app side.
