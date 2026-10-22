-- ===========================================================================
-- Migration 005 — atmospheres  (Sol Real: Earth…Pluto, Titan, Triton)
-- ===========================================================================
-- bodies.atmosphere: NULL = no atmosphere (a vacuum — black walk-mode sky);
-- a jsonb object mirroring the world-document atmosphere descriptor:
--   { top, scaleHeight, pressure, opacity, zenith, horizon, glow }
-- top / scaleHeight are multiples of the body radius (Earth: ≈ 600 km / R and
-- the 8.5 km density scale height), pressure is SURFACE pressure in atm —
-- how thick the air is (Venus 92, Mars 0.006) — and opacity is the 0..1
-- visual density the walk-mode sky renders with (core/atmospheres.js holds
-- the real-world catalog). Presentational: no physics, no mass.
--
-- Apply:  PGPASSWORD=*** psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" \
--           -f db/migrations/005-body-atmosphere.sql
-- Idempotent. Fresh installs get this from db/schema.sql directly.
-- ===========================================================================
BEGIN;

SET search_path = explanet;
SET LOCAL client_min_messages = warning;

ALTER TABLE bodies DROP CONSTRAINT IF EXISTS bodies_atmosphere_is_object;
ALTER TABLE bodies ADD COLUMN IF NOT EXISTS atmosphere jsonb;
ALTER TABLE bodies ADD CONSTRAINT bodies_atmosphere_is_object
  CHECK (atmosphere IS NULL OR jsonb_typeof(atmosphere) = 'object');

COMMENT ON COLUMN bodies.atmosphere IS
  'NULL = no atmosphere. {top,scaleHeight,pressure,opacity,zenith,horizon,glow}; '
  'heights are multiples of the body radius, pressure in atm. Emitted verbatim '
  'by the skeleton; drives the walk-mode sky (src/components/WalkSky.jsx).';

COMMIT;
