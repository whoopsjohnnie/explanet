-- ===========================================================================
-- Migration 011 — hexcells  (the stored high-res surface)
-- ===========================================================================
-- The inverted terrain model (docs/terrain2.txt): the high-resolution hexes
-- become the STORED data of a world's surface, and the coarsest bounded LOD
-- (the `atoms` document, ≤ MAX_FREQUENCY) is the mass/physics basis. This
-- migration adds the two pieces that model that:
--
--   * worlds.hex_meters — the WORLD's stored hex edge, in METERS. Resolution
--     is a WORLD property, not a per-body one: when set, EVERY body in the
--     world that stores its surface (generation IS NULL) stores its hexcells
--     at this same size (R1). There is no per-body flag and no per-body
--     override — the rule is derived (hex_meters + generation). Generated
--     bodies (generation IS NOT NULL, e.g. the gas giants) are the exemption:
--     they store no surface at all. NULL = the world stores no high-res
--     anywhere (the pre-inversion behavior).
--
--   * hexcells — the high-res surface, one row per stored hex, keyed by
--     POSITION in the latitude-row grid (docs/terrain2.txt §3/§5):
--       lat_row   0 = the north polar row (core/hexlattice.js)
--       lon_col   0 .. colCount(lat_row)-1
--     with the derived (lat, lon) stored for query/stream ORDER (the positional
--     key the design requires — never a global sequential index). A lat/lon
--     TILE (a lat_row × lon_col rectangle) is the streaming unit, the same
--     shape as the DEM tiles in `terrain` (migration 010).
--
-- What does NOT change: `bodies.frequency` CHECK 1..203 still bounds the
-- DOCUMENT (the mass basis, R7); `atoms` still holds the document; the mass /
-- radius / volume derivation is untouched (it reads only the document).
--
-- The app never reads hexcells directly: it streams tiles through
-- /api/bodies/:id/hex/... (server/api.mjs), never raw postgres — the standing
-- rule, exactly as atoms and terrain tiles are served.
--
-- Apply:  PGPASSWORD=*** psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" \
--           -f db/migrations/011-hexcells.sql
-- Idempotent. Fresh installs get these from db/schema.sql directly.
-- ===========================================================================
BEGIN;

SET search_path = explanet;
SET LOCAL client_min_messages = warning;

-- ---------------------------------------------------------------------------
-- worlds.hex_meters — the world's stored hex edge (meters)
-- ---------------------------------------------------------------------------
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS hex_meters double precision
  CHECK (hex_meters IS NULL OR hex_meters > 0);

COMMENT ON COLUMN worlds.hex_meters IS
  'The world''s stored high-res hex edge, in METERS (docs/terrain2.txt). '
  'Resolution is a WORLD property: when set, every body that stores its '
  'surface (generation IS NULL) stores hexcells at this same size (R1) — no '
  'per-body flag or override, the rule is derived. Generated bodies are the '
  'exemption (they store no surface). NULL = no high-res stored (the '
  'pre-inversion behavior). A body''s cell count is unbounded (4πR²/hexArea); '
  'MAX_FREQUENCY bounds only the document.';

-- ---------------------------------------------------------------------------
-- (Revised) no per-body highres flag.
-- ---------------------------------------------------------------------------
-- An earlier revision of this migration added bodies.highres (a per-body
-- opt-in). That was wrong: resolution is world-level and the stored-surface
-- rule is DERIVED (worlds.hex_meters set + body not generated). Drop the
-- column if a prior revision created it; fresh installs never had it.
ALTER TABLE bodies DROP COLUMN IF EXISTS highres;

-- ---------------------------------------------------------------------------
-- hexcells — the stored high-res surface, one row per hex
-- ---------------------------------------------------------------------------
-- Keyed by POSITION in the latitude-row grid (core/hexlattice.js):
--   (body_id, lat_row, lon_col) is the covering index for the hot path
--   "stream this tile's hexes", exactly as atoms' (body_id, cell_index) is
--   today. lat/lon are DERIVED from (lat_row, lon_col) + (radius, hex_meters);
--   they are stored for query/stream ORDER and as a sanity pin, never
--   authoritative over the positional key.
--
-- height is double precision for lossless world.json round-trips (world
-- units); material_id / color mirror atoms (per-hex appearance, the paint
-- brush writes the stored hex — docs/terrain2.txt §6.4).
--
-- Row-per-hex (docs/terrain2.txt §9.3) mirrors atoms: editable per cell,
-- per-hex FK to materials, partial updates. At the design's 1.85 km target a
-- body like Earth holds ~57 M rows (all of world 27's stored bodies hold
-- ~202 M) — COPY, never INSERT-per-row; the table can be PARTITION BY HASH
-- (body_id) if a single partition outgrows maintenance (the PK/FK syntax is
-- unchanged — see the schema NOTES).
CREATE TABLE IF NOT EXISTS hexcells (
  body_id     bigint NOT NULL REFERENCES bodies (id) ON DELETE CASCADE,
  lat_row     integer  NOT NULL CHECK (lat_row >= 0),
  lon_col     integer  NOT NULL CHECK (lon_col >= 0),

  lat         double precision,   -- derived, stored (deg) for stream order
  lon         double precision,   -- derived, stored (deg) for stream order

  height      double precision NOT NULL DEFAULT 0,   -- world units (relief above the core)
  material_id bigint REFERENCES materials (id) ON DELETE RESTRICT,
  color       text CHECK (color IS NULL OR color ~* '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$'),

  PRIMARY KEY (body_id, lat_row, lon_col)
);

-- the hot query is "this body, a tile (a lat_row × lon_col rectangle)"; the PK
-- covers the body-ordered scan. A partial index on edited colors mirrors atoms.
COMMENT ON TABLE hexcells IS
  'The stored high-res surface (docs/terrain2.txt, Level F): one row per '
  'hex of the latitude-row grid, keyed by POSITION (body_id, lat_row, '
  'lon_col). height is world units; material_id/color mirror atoms. The '
  'streaming unit is a lat/lon tile. Served by GET /api/bodies/:id/hex/... — '
  'the app never reads it directly. Every stored (non-generated) body of a '
  'world with worlds.hex_meters set has rows here — the rule is derived, '
  'there is no per-body flag.';
COMMENT ON COLUMN hexcells.lat IS
  'The hex''s center latitude in degrees, derived from (lat_row, lon_col) + '
  'the grid (body radius + worlds.hex_meters). Stored for query/stream ORDER; '
  'never authoritative over the positional key.';
COMMENT ON COLUMN hexcells.height IS
  'Relief above the core sphere, in WORLD UNITS (the same datum the document '
  'uses — the body''s scale converts meters to units at generation). The '
  'stored high-res is the surface the player walks; it is NOT the mass basis '
  '(that stays on the document, docs/terrain2.txt §2).';

COMMIT;
