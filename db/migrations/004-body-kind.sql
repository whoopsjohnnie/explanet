-- ===========================================================================
-- Migration 004 — body kind  (Sol Real: 1000-body catalogs need grouping)
-- ===========================================================================
-- bodies.kind: a coarse taxonomy that the UI groups the body list by and
-- that survives stubbing (a comet stub carries no elements, but it is still
-- a comet). One of 'star' | 'planet' | 'dwarf' | 'moon' | 'asteroid' |
-- 'comet'; NULL for hand-built worlds that never set one (the UI then just
-- groups by parent). NOT the preset (material/look) and NOT the parent link
-- — a moon is kind='moon' whether or not its parent_body_id is wired.
--
-- Apply:  PGPASSWORD=*** psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" \
--           -f db/migrations/004-body-kind.sql
-- Idempotent. Fresh installs get this from db/schema.sql directly.
-- ===========================================================================
BEGIN;

SET search_path = explanet;
SET LOCAL client_min_messages = warning;

ALTER TABLE bodies DROP CONSTRAINT IF EXISTS bodies_kind_check;
ALTER TABLE bodies ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE bodies ADD CONSTRAINT bodies_kind_check
  CHECK (kind IS NULL OR kind IN
    ('star', 'planet', 'dwarf', 'moon', 'asteroid', 'comet'));

COMMENT ON COLUMN bodies.kind IS
  'Coarse taxonomy for list grouping: star|planet|dwarf|moon|asteroid|comet. '
  'Independent of preset (look) and parent_body_id (hierarchy).';

COMMIT;
