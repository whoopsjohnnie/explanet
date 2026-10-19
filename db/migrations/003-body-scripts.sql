-- ===========================================================================
-- Migration 003 — scripted orbits  (Sol Real: 900-body catalog)
-- ===========================================================================
-- bodies.scripts: NULL = ordinary N-body body (cannon + pairwise gravity).
-- A jsonb object { a, e, inc, node, peri, n, m0 } — osculating Kepler
-- elements in ENGINE units — marks a TEST PARTICLE: the app integrates it
-- analytically (src/core/kepler.js) and gives it no cannon body at all.
-- center/velocity columns then describe the SAME state at t = 0 (redundant
-- on purpose: editors, previews and the walking spawner keep working).
--
-- Motivation: pairwise gravity costs one applyForce round-trip per pair per
-- frame. A real-catalog world (≈450 moons, ≈350 asteroids, ≈70 comets) is
-- 900 bodies — but every one of those small bodies has negligible mass, so
-- analytic two-body motion is both cheaper AND more accurate. The sun, the
-- planets and the dwarf planets stay fully simulated.
--
-- Apply:  PGPASSWORD=*** psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" \
--           -f db/migrations/003-body-scripts.sql
-- Idempotent. Fresh installs get this from db/schema.sql directly.
-- ===========================================================================
BEGIN;

SET search_path = explanet;
SET LOCAL client_min_messages = warning;

ALTER TABLE bodies DROP CONSTRAINT IF EXISTS bodies_scripts_is_object;
ALTER TABLE bodies ADD COLUMN IF NOT EXISTS scripts jsonb;
ALTER TABLE bodies ADD CONSTRAINT bodies_scripts_is_object
  CHECK (scripts IS NULL OR jsonb_typeof(scripts) = 'object');

COMMENT ON COLUMN bodies.scripts IS
  'NULL = N-body (cannon). {a,e,inc,node,peri,n,m0} engine-unit osculating '
  'elements: analytic test particle (core/kepler.js), no cannon body.';

COMMIT;
