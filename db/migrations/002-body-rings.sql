-- ===========================================================================
-- Migration 002 — planetary rings  (Sol Real: Saturn, and any ringed body)
-- ===========================================================================
-- bodies.rings: NULL = no rings; a jsonb object mirroring the world-document
-- ring descriptor:
--   { inner, outer, tiltDeg, bands: [{ from, to, color, alpha }, ...] }
-- inner/outer are multiples of the body's radius (Saturn: ~1.2 → 2.3).
-- Purely presentational: no physics, no mass. src/three renders it.
--
-- Apply:  PGPASSWORD=*** psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" \
--           -f db/migrations/002-body-rings.sql
-- Idempotent. Fresh installs get this from db/schema.sql directly.
-- ===========================================================================
BEGIN;

SET search_path = explanet;
SET LOCAL client_min_messages = warning;

ALTER TABLE bodies DROP CONSTRAINT IF EXISTS bodies_rings_is_object;
ALTER TABLE bodies ADD COLUMN IF NOT EXISTS rings jsonb;
ALTER TABLE bodies ADD CONSTRAINT bodies_rings_is_object
  CHECK (rings IS NULL OR jsonb_typeof(rings) = 'object');

COMMENT ON COLUMN bodies.rings IS
  'NULL = no rings. {inner,outer,tiltDeg,bands[]} presentational ring system; '
  'radii are multiples of the body radius. Emitted verbatim by the skeleton.';

COMMIT;
