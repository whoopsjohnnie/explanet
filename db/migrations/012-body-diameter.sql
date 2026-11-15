-- ===========================================================================
-- Migration 012 — bodies.diameter_km  (the body's real diameter, km)
-- ===========================================================================
-- The inverted terrain model (docs/terrain2.txt) makes the stored high-res
-- hexcells reproduce the document's surface EXACTLY ("agree by construction").
-- For the procedural small bodies (asteroids / comets) the surface's
-- lumpiness and cratering are banded by the body's DIAMETER
-- (docs/terrain2.txt §5.1, the potato builder):
--     lumpiness  diam >= 300 ? 0.07 : 0.15
--     craters    diam >= 200 ? 0.7  : 0.4
--
-- The document stores (frequency, scale) — and sizeGrid() maps a diameter onto
-- (frequency, scale) LOSSILY: when scale = 1 the true radius is only *within
-- 12 %* of the grid radius, so the 200 / 300 km threshold band is NOT
-- recoverable from (frequency, scale) alone (e.g. a 216 km and a 190 km body
-- both land on the same grid, on opposite sides of the 200 km craters cut).
--
-- So the diameter is STORED on the body: it is the exact, DB-reproducible
-- input the hexcells importer (scripts/import-hexcells.mjs) reads to rebuild
-- the same band the document was built with — no seed-table lookup, no
-- (frequency, scale) inversion, no drift. It is also simply real data about
-- the body. NULL for bodies whose terrain band does not depend on it
-- (planets, moons, dwarfs, generated bodies).
--
-- Apply:  PGPASSWORD=*** psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" \
--           -f db/migrations/012-body-diameter.sql
-- Idempotent. Fresh installs get the column from db/schema.sql directly.
-- ===========================================================================
BEGIN;

SET search_path = explanet;
SET LOCAL client_min_messages = warning;

ALTER TABLE bodies ADD COLUMN IF NOT EXISTS diameter_km double precision
  CHECK (diameter_km IS NULL OR diameter_km > 0);

COMMENT ON COLUMN bodies.diameter_km IS
  'The body''s real diameter, in KILOMETERS. Stored so the hexcells importer '
  'rebuilds the potato terrain''s size band (lumpiness / craters) EXACTLY as '
  'the document was built — (frequency, scale) is lossy (scale = 1 leaves the '
  'true radius within 12 % of the grid radius) and cannot recover the 200 / '
  '300 km thresholds. NULL for bodies whose terrain band is fixed (planets, '
  'moons, dwarfs, generated). docs/terrain2.txt §5.1.';

COMMIT;
