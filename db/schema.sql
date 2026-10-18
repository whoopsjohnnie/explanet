-- ===========================================================================
-- ExPlanet — PostgreSQL schema for world documents
-- ===========================================================================
-- Maps the `world.json` document (src/core/worldSchema.js) onto relational
-- tables so a world can scale far past what a single JSON file holds:
--
--   world.json                    this schema
--   ────────────────────────────  ───────────────────────────────────────────
--   { name, gravity, version }    worlds
--   planets[]                     bodies        (stars AND planets — the
--                                                document's `preset` says
--                                                which; no separate table)
--   planets[].elements[i]         atoms         (i = cell_index)
--   elements[].t  (terrain key)   atoms.material_id → materials
--   elements[].h                  atoms.height
--   elements[].c  (color override) atoms.color
--   TERRAIN_TYPES (terrain.js)    materials rows seeded per install
--
-- Invariants carried over from the app (violating these corrupts worlds):
--
--   * Element identity is POSITIONAL: atoms.cell_index is the hex cell index
--     of getHexSphere(body.frequency), i.e. 0 … cell_count_for_frequency(n)-1
--     with cells = 10n² + 2. A body's atom count MUST equal that count; the
--     "validate" query at the bottom of this file checks it after import.
--   * Radius / mass / volume stay DERIVED (core/planetMath.js) — only scale
--     and density are stored. The v_body_stats view mirrors the sphere-
--     approximation helpers for dashboards; the app remains the source of
--     exact numbers (they integrate per-cell areas, see planetVolume()).
--   * Hex centers are deterministic from (frequency, cell_index). The cx/cy/cz
--     cache columns are optional query convenience (neighbourhood / distance
--     SQL without pulling the grid); they are NEVER authoritative. Leave them
--     NULL and derive, or populate once on import.
--   * A body either STORES its surface (generation IS NULL — exactly
--     cell_count_for_frequency(frequency) atom rows) or GENERATES it
--     (generation = {fn,preset,seed?,relief,avgHeight?} — ZERO atom rows;
--     server/db.mjs synthesizes atoms on demand, see docs/scaling.txt §5).
--
-- Scale notes (why this shape, see NOTES at the end for the alternative):
--   MAX_FREQUENCY = 203 → 412 092 atoms per body, ~90 B/row → ~36 MB per
--   max-size planet. Row-per-atom stays comfortable into the tens of millions
--   of atoms; load with COPY, never row-by-row INSERTs.
--
-- Requires PostgreSQL 15+ (UNIQUE NULLS NOT DISTINCT on materials).
-- ===========================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS explanet;
SET search_path = explanet;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

/** Geodesic cell count for a frequency: 10n² + 2 (hexsphere.js). */
CREATE FUNCTION cell_count_for_frequency(frequency integer)
RETURNS bigint
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN 10::bigint * frequency * frequency + 2;

/** Generic updated_at maintainer. */
CREATE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- worlds — one row per world document; carries the solar-system properties
-- ---------------------------------------------------------------------------
CREATE TABLE worlds (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text         NOT NULL DEFAULT 'Untitled World',

  -- solar-system / physics settings (document top level)
  gravity       double precision NOT NULL DEFAULT 40 CHECK (gravity >= 0),

  -- document bookkeeping
  doc_version   integer      NOT NULL DEFAULT 1,   -- mirrors "version" in world.json
  is_public     boolean      NOT NULL DEFAULT false,

  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now()
);

CREATE TRIGGER worlds_set_updated_at
  BEFORE UPDATE ON worlds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE worlds IS
  'A world document: a solar system under one gravitational constant.';

-- ---------------------------------------------------------------------------
-- bodies — stars, planets, moons, asteroids … (was "planets")
-- ---------------------------------------------------------------------------
-- One row per body in a world. `preset` stays free text on purpose: the app
-- heals unknown presets (normalizeWorld) instead of rejecting them, and the
-- preset list (earthlike / rocky / star / …) grows over time.
--
-- `parent_body_id` is an OPTIONAL hierarchy hint (moon → planet, planet →
-- star). The simulation is N-body and ignores it; it exists for UI grouping
-- and future orbital helpers. NULL = top-level body.
-- ---------------------------------------------------------------------------
CREATE TABLE bodies (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  world_id       bigint NOT NULL REFERENCES worlds (id) ON DELETE CASCADE,

  doc_id         text,                       -- world.json planet id ("p-…"), kept for round-trips
  name           text   NOT NULL DEFAULT 'Planet',
  preset         text   NOT NULL DEFAULT 'earthlike',

  -- grid / atom model
  seed           bigint NOT NULL DEFAULT 1,
  frequency      integer NOT NULL DEFAULT 6
                 CHECK (frequency BETWEEN 1 AND 203),   -- MAX_FREQUENCY in planetMath.js
  scale          double precision NOT NULL DEFAULT 1
                 CHECK (scale > 0),                     -- legacy escape hatch, 1 = strict atom

  -- kinematics (document vec3s)
  center_x       double precision NOT NULL DEFAULT 0,
  center_y       double precision NOT NULL DEFAULT 0,
  center_z       double precision NOT NULL DEFAULT 0,
  velocity_x     double precision NOT NULL DEFAULT 0,
  velocity_y     double precision NOT NULL DEFAULT 0,
  velocity_z     double precision NOT NULL DEFAULT 0,
  spin_x         double precision NOT NULL DEFAULT 0,
  spin_y         double precision NOT NULL DEFAULT 0,
  spin_z         double precision NOT NULL DEFAULT 0,

  density        double precision NOT NULL DEFAULT 0.05 CHECK (density > 0),

  -- ← document `isStatic`. Solver flag only: pairwise gravity never applies
  -- force to this body (the pair-mate still accelerates away from it), while
  -- its velocity and spin integrate normally. It is an integration anchor,
  -- NOT a claim of motionlessness — a binary system simply sets false for
  -- both stars. "Standing still" is a property of the observer's frame
  -- (worlds.reference_body_id), never of a body.
  gravity_immune boolean NOT NULL DEFAULT false,

  parent_body_id bigint REFERENCES bodies (id) ON DELETE SET NULL
                 CHECK (parent_body_id IS NULL OR parent_body_id <> id),

  -- Generated ("functional") bodies — docs/scaling.txt §5. NULL = the atoms
  -- table stores the surface (every ordinary body). A jsonb object
  --   { fn: 'preset', preset, seed?, relief, avgHeight? }
  -- means ZERO atom rows: server/db.mjs synthesizes the surface on demand
  -- with the app's own core/generators.js (generateElements(preset,
  -- frequency, seed), h × relief), and the browser hydrates the body through
  -- the ordinary stub path — generated is a storage property, invisible to
  -- the app. Frequency (+scale) must describe the TRUE size; avgHeight is
  -- the generator's mean relief, the stub's mass input (radius/mass stay
  -- DERIVED — generation stores no size or mass).
  generation     jsonb
                 CHECK (generation IS NULL OR jsonb_typeof(generation) = 'object'),

  sort_order     integer NOT NULL DEFAULT 0,   -- preserves the JSON array order
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (world_id, doc_id)
);

CREATE INDEX bodies_by_world_idx ON bodies (world_id, sort_order);

CREATE TRIGGER bodies_set_updated_at
  BEFORE UPDATE ON bodies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE bodies IS
  'Celestial bodies of a world (stars, planets, moons…). Radius/mass are '
  'derived from frequency + scale + atom heights, never stored.';

-- The observer frame: the body the world view anchors to (typically a star).
-- Nothing in an N-body world is static — the only fixed point is the player's
-- pose relative to the world, so the "anchor" pointer belongs to the world,
-- not to a body. FK is circular (bodies.world_id → worlds.id), hence added
-- here once both tables exist. NULL = free camera.
ALTER TABLE worlds
  ADD COLUMN reference_body_id bigint REFERENCES bodies (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- materials — hex colour + surface appearance
-- ---------------------------------------------------------------------------
-- Shared appearance records, seeded from TERRAIN_TYPES (terrain.js) and
-- extendable per world (custom terrain added by the editor). A body's atoms
-- reference these; a per-hex color override from the document (elements[].c)
-- lives on the ATOM, not here — the material is the palette entry.
--
-- world_id NULL  → built-in material available to every world.
-- world_id NOT NULL → private material of that world.
-- ---------------------------------------------------------------------------
CREATE TABLE materials (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  world_id           bigint REFERENCES worlds (id) ON DELETE CASCADE,

  key                text NOT NULL,            -- 'grass', 'lava', custom slugs…
  label              text NOT NULL,
  color              text NOT NULL
                     CHECK (color ~* '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$'),
  accent             text
                     CHECK (accent IS NULL OR accent ~* '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$'),
  texture            text NOT NULL DEFAULT 'speckle'
                     CHECK (texture IN ('speckle', 'crack', 'wave')),
  roughness          real CHECK (roughness BETWEEN 0 AND 1),
  metalness          real CHECK (metalness BETWEEN 0 AND 1),
  emissive           text
                     CHECK (emissive IS NULL OR emissive ~* '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$'),
  emissive_intensity real CHECK (emissive_intensity >= 0),
  transparent        boolean NOT NULL DEFAULT false,
  opacity            real    CHECK (opacity BETWEEN 0 AND 1),
  created_at         timestamptz NOT NULL DEFAULT now(),

  -- one row per (world, key); NULL-world built-ins get their own namespace
  UNIQUE NULLS NOT DISTINCT (world_id, key)
);

-- Built-in palette, straight from core/terrain.js TERRAIN_TYPES.
INSERT INTO materials
  (key, label, color, accent, texture, roughness, metalness, emissive, emissive_intensity, transparent, opacity)
VALUES
  ('grass', 'Grass', '#5aa15d', '#4a8c4e', 'speckle', 0.95, NULL , NULL     , NULL, false, NULL),
  ('dirt' , 'Dirt' , '#8a6a45', '#755738', 'speckle', 0.98, NULL , NULL     , NULL, false, NULL),
  ('rock' , 'Rock' , '#8d8d93', '#6f6f76', 'crack'  , 0.90, NULL , NULL     , NULL, false, NULL),
  ('sand' , 'Sand' , '#dcc481', '#cbb26e', 'speckle', 0.95, NULL , NULL     , NULL, false, NULL),
  ('snow' , 'Snow' , '#eef3f7', '#d6e2ec', 'speckle', 0.75, NULL , NULL     , NULL, false, NULL),
  ('water', 'Water', '#2f7fd4', '#2669b0', 'wave'   , 0.15, 0.05 , NULL     , NULL, true , 0.82),
  ('lava' , 'Lava' , '#e05a1e', '#a33a10', 'crack'  , NULL, NULL , '#ff3c00', 1.6 , false, NULL),
  ('void' , 'Void' , '#3a3548', '#2c2837', 'speckle', 1.00, NULL , NULL     , NULL, false, NULL),
  ('star' , 'Star' , '#ffd977', '#ff9a2e', 'speckle', 1.00, NULL , '#ffb13d', 2.4 , false, NULL);

COMMENT ON TABLE materials IS
  'Hex appearance palette: colour + PBR/emissive details, seeded from '
  'TERRAIN_TYPES. Atoms point here; per-hex colour overrides live on atoms.';

-- ---------------------------------------------------------------------------
-- atoms — the hex cells themselves
-- ---------------------------------------------------------------------------
-- One row per hex of the body's geodesic grid, addressed positionally:
-- PRIMARY KEY (body_id, cell_index) doubles as the covering index for the
-- hot path ("stream body X's atoms in cell order"), which matches both the
-- document order and getHexSphere()'s centre order.
--
--   height      ← elements[].h   relief above the core sphere, world units
--   material_id → materials       (document `t`, resolved through the palette)
--   color       ← elements[].c   per-hex override of the material colour
--   cx/cy/cz    cached unit-sphere centre from getHexSphere(frequency) —
--               OPTIONAL, derivable, never authoritative (see header).
--
-- Height is double precision for lossless world.json round-trips; switch to
-- `real` (float4) if you can trade exactness for ~4 B/atom — the renderer
-- converts to float32 anyway.
-- ---------------------------------------------------------------------------
CREATE TABLE atoms (
  body_id     bigint NOT NULL REFERENCES bodies (id) ON DELETE CASCADE,
  cell_index  integer NOT NULL CHECK (cell_index >= 0),

  height      double precision NOT NULL DEFAULT 0,
  material_id bigint REFERENCES materials (id) ON DELETE RESTRICT,
  color       text CHECK (color IS NULL OR color ~* '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$'),

  cx double precision,
  cy double precision,
  cz double precision,

  PRIMARY KEY (body_id, cell_index)
);

-- Optional reverse lookups; skip on atom-catalogue-heavy installs where the
-- extra ~10 B/atom of index storage isn't worth it:
--   "which hexes use material M" (bulk repaints):
-- CREATE INDEX atoms_material_idx ON atoms (material_id, body_id);
--   "find edited colours" (palette migration):
-- CREATE INDEX atoms_color_override_idx ON atoms (body_id) WHERE color IS NOT NULL;

COMMENT ON TABLE atoms IS
  'Hex cells, one row per cell of getHexSphere(body.frequency). '
  'cell_index is positional identity: a body needs exactly '
  'cell_count_for_frequency(frequency) rows.';

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------

-- Document skeleton without atoms: one row per body with derived size stats
-- (sphere approximation — exact values stay in JS; see planetVolume()).
-- atoms_complete = does the row count cover the whole grid? (import health)
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

CREATE VIEW v_material_usage AS
SELECT
  a.body_id,
  a.material_id,
  m.key          AS material_key,
  m.label        AS material_label,
  count(*)       AS atoms,
  min(a.height)  AS min_height,
  max(a.height)  AS max_height
FROM atoms a
JOIN materials m ON m.id = a.material_id
GROUP BY a.body_id, a.material_id, m.key, m.label;

COMMIT;

-- ===========================================================================
-- Import / export cheat-sheet
-- ===========================================================================
--
-- Bulk-load atoms per body with COPY (never INSERT-per-row):
--
--   CREATE TEMP TABLE atoms_tmp (LIKE atoms INCLUDING DEFAULTS);
--   \copy atoms_tmp (body_id, cell_index, height, material_id, color)
--     FROM 'planet-42.csv' (FORMAT csv, NULL '');
--
--   INSERT INTO atoms SELECT * FROM atoms_tmp
--     ON CONFLICT (body_id, cell_index) DO UPDATE
--       SET height      = EXCLUDED.height,
--           material_id = EXCLUDED.material_id,
--           color       = EXCLUDED.color;
--
--   Export counterpart:
--   \copy (SELECT body_id, cell_index, height, material_id, color
--          FROM atoms WHERE body_id = 42 ORDER BY cell_index)
--     TO 'planet-42.csv' (FORMAT csv, NULL '');
--
-- Import health check — every body must cover its whole grid:
--
--   SELECT body_id, body_name, atom_rows, cell_count
--   FROM v_body_stats WHERE NOT atoms_complete;
--
-- Load one body document (stream in cell order; PK gives a cheap index scan):
--
--   SELECT cell_index, height, material_id, color
--   FROM atoms WHERE body_id = $1 ORDER BY cell_index;
--
-- Resolve material keys when exporting back to world.json:
--   SELECT a.cell_index, a.height, coalesce(m.key, 'grass') AS t, a.color
--   FROM atoms a LEFT JOIN materials m ON m.id = a.material_id
--   WHERE a.body_id = $1 ORDER BY a.cell_index;
--
-- ===========================================================================
-- NOTES — trade-offs at the next order of magnitude
-- ===========================================================================
--
-- * Row-per-atom is worth it while hexes are EDITED (terrain brushes,
--   selection, partial updates, per-atom FK to materials). If bodies ever
--   become mostly write-once scenery, the cheaper layout is chunked blobs:
--   one row per 1 024-cell chunk with height[]/material[] arrays (2 B/atom
--   quantised) — an order of magnitude smaller, but whole-chunk updates only.
--   Keep the four-table shape above as the logical model either way.
-- * The atoms table can be PARTITION BY HASH (body_id) (e.g. 8 partitions)
--   if a single partition-boundary-free table outgrows maintenance windows;
--   PK and FK syntax are unchanged, CREATE TABLE atoms … PARTITION BY is the
--   only edit plus creating the partitions.
-- * ON DELETE RESTRICT on atoms.material_id means a material in use cannot be
--   deleted; repoint or drop atoms first. Deleting a body (or world) cascades
--   through atoms automatically.
-- ===========================================================================
