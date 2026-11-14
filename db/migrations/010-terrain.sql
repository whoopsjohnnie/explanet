-- ===========================================================================
-- Migration 010 — terrain catalog  (the DEM tiles for the fine-terrain layer)
-- ===========================================================================
-- Stage 2 of the fine-terrain design (docs/terrain.txt §9): a body's FINE
-- region streams local terrain at the DEM's native pixel size (1.85 km for
-- ETOPO2022 60s) around the player, feathered to the document mesh at the
-- cap's edge. The document grid stays the physical truth (f203 on Earth); the
-- fine layer is presentational — exactly like rings/atmosphere — and its data
-- is a TERRAIN CATALOG, not world content: one row per DEM tile, shared by
-- every body that names the catalog (bodies.terrain.{catalog}).
--
-- The catalog is the NOAA ETOPO2022 60s grid (mapping.txt): land elevation
-- AND seafloor depth in METERS, sea level 0, 21,600 (lon) × 10,800 (lat) px
-- at 1 arc-minute. It is tiled at 2°×2° (120×120 px) so the app streams only
-- the tiles under the fine cap (a 500 km cap touches ~20 tiles of 28.1 KiB),
-- exactly as it streams atoms.
--
-- Frame / layout (matches the DEM, mapping.txt §1):
--   * pixel_deg   = the DEM pixel size in degrees (1/60 = 1 arc-minute). The
--                   fine-hex edge is derived from it (a = pixel_deg × 111.32
--                   km at the equator), so it is a CATALOG property, not a dial.
--   * payload     = the tile's elevations as SIGNED INT16, 1 m steps
--                   (value = round(elevation_m)), LITTLE-ENDIAN, row-major
--                   (the tile's own rows, north-first; columns west-first).
--                   (tile_size / pixel_deg)² values. int16 at 1 m spans
--                   ±32 km — the DEM is −11…+9 km, 3× headroom. The draft's
--                   "mm" can't fit int16; 28.1 KiB/tile = 14,400 px × 2 B
--                   confirms the int16 payload.
--   * tile_lat / tile_lon = the tile's SOUTHWEST corner, in whole degrees.
--                   tile_lat ∈ {88, 86, …, −90} (90 tiles), tile_lon ∈
--                   {178, 176, …, −180} (180 tiles) → 16,200 tiles.
--
-- The app never reads this table directly: it fetches tiles through
-- /api/terrain (server/api.mjs), never raw postgres. A body names the catalog
-- it rides in bodies.terrain ({catalog}) — NULL = no fine layer, doc-only —
-- the same presentational-descriptor pattern as rings/atmosphere.
--
-- Seed: imported by `npm run db:terrain` (scripts/import-terrain.mjs) from the
-- etopo2022-60s.f32 S3 seed (DATA.md) — one-time ~0.5 GB, idempotent per
-- catalog (re-import replaces one catalog's tiles atomically).
--
-- Apply:  PGPASSWORD=*** psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" \
--           -f db/migrations/010-terrain.sql
-- Idempotent. Fresh installs get the table from db/schema.sql directly.
-- ===========================================================================
BEGIN;

SET search_path = explanet;
SET LOCAL client_min_messages = warning;

-- ---------------------------------------------------------------------------
-- terrain — DEM tiles, one row per 2°×2° tile of a catalog
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS terrain (
  catalog     text    NOT NULL,             -- 'ETOPO2022-60s' = NOAA ETOPO2022 60s
  tile_lat    integer NOT NULL,             -- SW corner latitude, whole degrees
  tile_lon    integer NOT NULL,             -- SW corner longitude, whole degrees
  tile_size   integer NOT NULL CHECK (tile_size > 0),  -- tile side, degrees (2)
  pixel_deg   double precision NOT NULL CHECK (pixel_deg > 0),  -- DEM px, degrees
  payload     bytea   NOT NULL,             -- int16 LE, 1 m steps, row-major (N-first, W-first)
  imported_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (catalog, tile_lat, tile_lon, tile_size)
);

-- the hot query is "this catalog, one tile" (the PK covers it); the summary
-- is "which catalogs exist + their extent/pixel" for GET /api/terrain
CREATE INDEX IF NOT EXISTS terrain_catalog_idx ON terrain (catalog);

COMMENT ON TABLE terrain IS
  'Terrain catalog (a DEM, not world content): one row per 2°×2° tile. '
  'payload is SIGNED INT16 at 1 m steps (value = round(elevation_m)), '
  'little-endian, row-major (N-first, W-first), (tile_size/pixel_deg)² values. '
  'Served read-only by GET /api/terrain* — the fine-terrain layer (docs/'
  'terrain.txt stage 2) streams these tiles around the player.';
COMMENT ON COLUMN terrain.catalog IS
  'Source catalog id, e.g. ETOPO2022-60s = NOAA ETOPO2022 60s (public domain). '
  'Bodies name it via bodies.terrain.{catalog}; groups tiles until other DEMs '
  '(LRO, MOLA) land beside it.';
COMMENT ON COLUMN terrain.payload IS
  'The tile''s elevations: (tile_size/pixel_deg)² SIGNED INT16 values at 1 m '
  'steps (value = round(elevation_m)), LITTLE-ENDIAN, row-major — the tile''s '
  'own rows north-first, columns west-first. Decode with new Int16Array(bytes).';

-- ---------------------------------------------------------------------------
-- bodies.terrain — the body's terrain-catalog descriptor (presentational)
-- ---------------------------------------------------------------------------
-- A body NAMES the DEM catalog its fine region streams (docs/terrain.txt
-- stage 2): { catalog: 'ETOPO2022-60s' }. NULL = no fine layer (the document
-- mesh is the surface, as today). The fine-hex edge is read from the
-- catalog's pixel size, so the descriptor carries only the catalog id. Same
-- shape/contract as rings/atmosphere: a presentational jsonb the skeleton
-- emits verbatim and normalizeWorld heals.
ALTER TABLE bodies ADD COLUMN IF NOT EXISTS terrain jsonb
  CHECK (terrain IS NULL OR jsonb_typeof(terrain) = 'object');

COMMENT ON COLUMN bodies.terrain IS
  'The body''s terrain-catalog descriptor (docs/terrain.txt stage 2): '
  '{catalog} names the DEM the fine region streams at the player; NULL = no '
  'fine layer (document mesh only). The fine-hex edge is the catalog''s pixel '
  'size, not a dial. Presentational — like rings/atmosphere.';

COMMIT;
