-- ============================================================
-- 009_template_media_storage.sql
--
-- Creates the `template_media` Supabase Storage bucket and RLS
-- policies for WhatsApp template header attachments (PDF/image/video).
--
-- Files are stored under:
--   template_media/{auth.uid()}/...
--
-- Bucket is public so Meta can fetch media by URL.
-- Idempotent — safe to re-run.
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'template_media',
  'template_media',
  TRUE,
  26214400, -- 25 MB
  ARRAY[
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'video/mp4',
    'video/quicktime',
    'video/3gpp'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Template media is publicly readable" ON storage.objects;
CREATE POLICY "Template media is publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'template_media');

DROP POLICY IF EXISTS "Users can upload their own template media" ON storage.objects;
CREATE POLICY "Users can upload their own template media"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'template_media'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Users can update their own template media" ON storage.objects;
CREATE POLICY "Users can update their own template media"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'template_media'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Users can delete their own template media" ON storage.objects;
CREATE POLICY "Users can delete their own template media"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'template_media'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

