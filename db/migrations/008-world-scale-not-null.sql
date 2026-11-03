-- ===========================================================================
-- Migration 008 — world scale becomes REQUIRED  (worlds.scale NOT NULL)
-- ===========================================================================
-- Every world must declare how long ONE WORLD UNIT is, in METERS
-- (worlds.scale): avatars and objects are sized in real meters through it,
-- and there is no "game vs real" split — a compact world just has a small
-- scale, a life-like one a large one (core/worldSchema.js normalizeWorld
-- REJECTS a scale-less document; scripts/import-db.mjs requires it).
--
-- This migration backfills the shipped worlds, which were imported before
-- scale was required:
--   "Sol Real" / "Sol Trial" anchor the largest atom grid to Earth
--     (6371.009 km), so both carry
--       1000 · 6371.009 / radiusForFrequency(203)  ≈  35181.638256567356 m/u;
--   "Sol System" is the generated STARTER world (core/starter.js) — strict
--     atoms with Jupiter (69911 km) on the top grid, so it carries the atom
--     default ATOM_M_PER_UNIT = 386058.70940613654 m/u (core/planetMath.js).
-- ANY OTHER scale-less row must be re-imported with a scale or deleted
-- before this migration will apply (the guard below lists the offenders).
--
-- Apply:  PGPASSWORD=*** psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" \
--           -f db/migrations/008-world-scale-not-null.sql
-- Idempotent. Fresh installs get the NOT NULL column from db/schema.sql.
-- ===========================================================================
BEGIN;

SET search_path = explanet;
SET LOCAL client_min_messages = warning;

-- Backfill the shipped worlds (imported before scale was required).
UPDATE worlds SET scale = 35181.638256567356
  WHERE scale IS NULL AND name IN ('Sol Real', 'Sol Trial');

-- The generated starter world: atom default (Jupiter anchor).
UPDATE worlds SET scale = 386058.70940613654
  WHERE scale IS NULL AND name = 'Sol System';

-- Fail clearly if any other scale-less world remains: it can't be walked or
-- filled with objects, so it must be re-imported with a scale or deleted.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM worlds WHERE scale IS NULL) THEN
    RAISE EXCEPTION 'worlds without a scale remain: % — re-import each with a "scale" (meters per unit) or delete it, then re-apply db/migrations/008-world-scale-not-null.sql',
      (SELECT string_agg(name, ', ') FROM worlds WHERE scale IS NULL);
  END IF;
END $$;

-- Now that every row carries a positive scale, require it.
ALTER TABLE worlds DROP CONSTRAINT IF EXISTS worlds_scale_positive;
ALTER TABLE worlds ALTER COLUMN scale SET NOT NULL;
ALTER TABLE worlds ADD CONSTRAINT worlds_scale_positive CHECK (scale > 0);

COMMENT ON COLUMN worlds.scale IS
  'Length of one world unit for this world, in METERS (document field '
  '"scale"). REQUIRED (NOT NULL): every world declares how long a meter is, '
  'so avatars and objects are sized in real meters through it. Positive: 1 '
  'unit is that many meters (and 1 doc second = 1 real second) — the surface '
  'walker is a real human in meters (core/surface.js SURFACE_REAL). '
  'Migration 008 backfilled the shipped worlds (Sol Real / Sol Trial / Sol System).';

COMMIT;
