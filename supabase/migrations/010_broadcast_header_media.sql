-- ============================================================
-- 010_broadcast_header_media.sql
--
-- Adds optional header attachment metadata to broadcasts so
-- template header media (PDF/image/video) can be stored for
-- draft/sent campaigns.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE IF EXISTS broadcasts
  ADD COLUMN IF NOT EXISTS header_media_url TEXT,
  ADD COLUMN IF NOT EXISTS header_media_type TEXT CHECK (header_media_type IN ('image', 'video', 'document')),
  ADD COLUMN IF NOT EXISTS header_media_filename TEXT;

