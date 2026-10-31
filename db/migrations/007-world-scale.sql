-- ===========================================================================
-- Migration 007 — world scale annotation  (worlds.scale)
-- ===========================================================================
-- worlds.scale: the LENGTH OF ONE WORLD UNIT FOR THIS WORLD, in METERS —
-- the world document's `scale` field (src/core/worldSchema.js).
-- NULL = a game-scale world — the surface walker is one hex-tile tall
-- (core/surface.js SURFACE ratios). A positive value = a TRUE-SCALE world:
-- one world unit is that many metres and 1 document second is 1 real second
-- (Sol Real / Sol Trial ≈ 35181.6). The app then turns the surface walker
-- into a REAL human in meters (SURFACE_REAL) and skips the game-feel
-- gravityScale — the sim's softened law IS the physical gravity on such
-- worlds. Radius in meters = radius (units) × scale.
-- Distinct from bodies.scale (the per-body size factor, default 1).
--
-- Emitted verbatim by the skeleton (server/db.mjs worldSkeleton).
--
-- Apply:  PGPASSWORD=*** psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" \
--           -f db/migrations/007-world-scale.sql
-- Idempotent. Fresh installs get this from db/schema.sql directly.
-- ===========================================================================
BEGIN;

SET search_path = explanet;
SET LOCAL client_min_messages = warning;

ALTER TABLE worlds ADD COLUMN IF NOT EXISTS scale double precision;
ALTER TABLE worlds DROP CONSTRAINT IF EXISTS worlds_scale_positive;
ALTER TABLE worlds ADD CONSTRAINT worlds_scale_positive
  CHECK (scale IS NULL OR scale > 0);

COMMENT ON COLUMN worlds.scale IS
  'Length of one world unit for this world, in METERS (document field '
  '"scale"). NULL = game scale (tile-anchored walker). Positive = true '
  'scale: 1 unit is that many meters (and 1 doc second = 1 real second) — '
  'the surface walker is a real human in meters (core/surface.js '
  'SURFACE_REAL). Emitted verbatim by the skeleton.';

COMMIT;
