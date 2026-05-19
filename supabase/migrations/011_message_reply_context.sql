-- ============================================================
-- 011_message_reply_context.sql
--
-- Stores WhatsApp "reply to" context message id on inbound messages
-- so the UI/reporting can attribute replies to the exact outbound
-- message (broadcast/template/etc.).
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE IF EXISTS messages
  ADD COLUMN IF NOT EXISTS context_message_id TEXT;

