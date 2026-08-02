-- Demo store ("تصفح المتجر التجريبي"): each visitor signs into an ephemeral
-- tenant cloned from a single seeded template. Full page refresh wipes their
-- clone and re-clones from the template, so edits never persist. Visitors
-- never see each other's data because the clone is per-cookie.
--
-- Columns:
--   is_demo            — true on the template AND on every clone. Flag is what
--                        middleware reads (via JWT) to enable the refresh-reset
--                        hook and the in-app banner.
--   demo_template_id   — NULL on the template; set to the template's id on
--                        every clone. Cleanup cron deletes clones (not the
--                        template) older than the idle TTL.
--   demo_last_active_at — bumped on each demo request; cleanup cron uses it
--                        as the idle clock.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS demo_template_id UUID
  REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS demo_last_active_at TIMESTAMPTZ;

-- Partial index — only demo clones need fast cleanup scans.
CREATE INDEX IF NOT EXISTS tenants_demo_cleanup_idx
  ON tenants (demo_last_active_at)
  WHERE demo_template_id IS NOT NULL;
