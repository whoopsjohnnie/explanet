-- ===========================================================================
-- Migration 001 — generated bodies  (docs/scaling.txt §5 "functional bodies")
-- ===========================================================================
-- bodies.generation: NULL  → stored body; the atoms table is authoritative
-- (every existing row stays exactly as it is).
-- a jsonb object → GENERATED body: zero atom rows. The descriptor
--   { fn: 'preset', preset, seed?, relief, avgHeight? }
-- tells server/db.mjs to synthesize the surface on demand with the app's own
-- core/generators.js (generateElements(preset, frequency, seed), h × relief).
-- The browser hydrates such a body through the ordinary stub path and never
-- learns the difference — that is the point of the trial.
--
-- Radius/mass stay DERIVED: frequency (+scale) sizes the body; avgHeight is
-- the generator's mean relief (the stub's mass input), precomputed by the
-- importing script so skeleton building never synthesizes just to average.
--
-- v_body_stats.atoms_complete relaxes accordingly: a generated body with 0
-- rows is COMPLETE (its atoms arrive synthesized, never from the table).
--
-- Apply:  PGPASSWORD=*** psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" \
--           -f db/migrations/001-body-generation.sql
-- Idempotent. Fresh installs get this from db/schema.sql directly.
-- ===========================================================================
BEGIN;

SET search_path = explanet;
SET LOCAL client_min_messages = warning;

ALTER TABLE bodies DROP CONSTRAINT IF EXISTS bodies_generation_is_object;
ALTER TABLE bodies ADD COLUMN IF NOT EXISTS generation jsonb;
ALTER TABLE bodies ADD CONSTRAINT bodies_generation_is_object
  CHECK (generation IS NULL OR jsonb_typeof(generation) = 'object');

COMMENT ON COLUMN bodies.generation IS
  'NULL = stored atoms (atoms table authoritative). {fn,preset,seed?,relief,avgHeight?} '
  '= generated body: no atom rows, server synthesizes elements from '
  'generateElements(preset, frequency, seed) x relief on demand. Frequency '
  '(+scale) must describe the TRUE size; f must exceed the preview frequency.';

DROP VIEW IF EXISTS v_body_stats;
CREATE VIEW v_body_stats AS
SELECT
  b.world_id,
  b.id            AS body_id,
  b.doc_id,
  b.name          AS body_name,
  b.preset,
  b.frequency,
  b.scale,
  b.generation,
  b.gravity_immune,
  b.parent_body_id,
  cell_count_for_frequency(b.frequency)                              AS cell_count,
  sqrt(cell_count_for_frequency(b.frequency) / (4 * pi())) * b.scale AS radius,
  (4.0 / 3.0) * pi() *
    pow(sqrt(cell_count_for_frequency(b.frequency) / (4 * pi())) * b.scale, 2) *
    (sqrt(cell_count_for_frequency(b.frequency) / (4 * pi())) * b.scale
     + coalesce(s.avg_height, 0))                                    AS approx_volume,
  b.density *
    (4.0 / 3.0) * pi() *
    pow(sqrt(cell_count_for_frequency(b.frequency) / (4 * pi())) * b.scale, 2) *
    (sqrt(cell_count_for_frequency(b.frequency) / (4 * pi())) * b.scale
     + coalesce(s.avg_height, 0))                                    AS approx_mass,
  s.atom_rows,
  -- a generated body is COMPLETE with zero rows: its atoms are synthesized
  s.atoms_complete OR b.generation IS NOT NULL                       AS atoms_complete
FROM bodies b
LEFT JOIN LATERAL (
  SELECT
    count(*)                                         AS atom_rows,
    avg(a.height)                                    AS avg_height,
    count(*) = cell_count_for_frequency(b.frequency) AS atoms_complete
  FROM atoms a
  WHERE a.body_id = b.id
) s ON true;

COMMIT;
