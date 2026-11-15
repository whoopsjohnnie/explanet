-- ===========================================================================
-- ExPlanet — PostgreSQL schema for world documents
-- ===========================================================================
-- Maps the `world.json` document (src/core/worldSchema.js) onto relational
-- tables so a world can scale far past what a single JSON file holds:
--
--   world.json                    this schema
--   ────────────────────────────  ───────────────────────────────────────────
--   { name, gravity,              worlds   (scale = length of one world
--     scale, version }                       unit, in meters; REQUIRED —
--                                            every world declares it)
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

  -- length of one world unit for this world, in METERS (migration 007,
  -- made REQUIRED by migration 008). Every world declares how long a meter
  -- is, so avatars and objects are sized in real meters through it — there
  -- is no "game vs real" split (a compact world just has a small scale).
  -- Positive: 1 unit is that many meters (and 1 document second = 1 real
  -- second); the surface walker is a real human in meters (world.scale;
  -- core/surface.js SURFACE_REAL). Distinct from bodies.scale (size factor).
  scale         double precision NOT NULL CHECK (scale > 0),

  -- The world's stored high-res hex edge, in METERS (migration 011,
  -- docs/terrain2.txt). Resolution is a WORLD property: when set, EVERY body
  -- in the world that stores its surface (generation IS NULL) stores its
  -- hexcells at this same size (R1) — there is no per-body flag or override.
  -- Generated bodies (generation IS NOT NULL) are the exemption: they store no
  -- surface at all. NULL = no high-res stored anywhere (the pre-inversion
  -- behavior). A body's cell count is unbounded (4πR²/hexArea);
  -- MAX_FREQUENCY bounds only the document.
  hex_meters    double precision
                CHECK (hex_meters IS NULL OR hex_meters > 0),

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

  -- Presentational ring system (migration 002). NULL = no rings.
  -- { inner, outer, tiltDeg, bands: [{from,to,color,alpha}] } — radii are
  -- multiples of the body radius; emitted verbatim by the skeleton.
  rings          jsonb
                 CHECK (rings IS NULL OR jsonb_typeof(rings) = 'object'),

  -- Atmosphere (migration 005). NULL = airless (vacuum sky).
  -- { top, scaleHeight, pressure, opacity, zenith, horizon, glow } — heights
  -- are multiples of the body radius, pressure in atm ("how thick the air
  -- is"); drives the walk-mode sky. Emitted verbatim by the skeleton.
  atmosphere     jsonb
                 CHECK (atmosphere IS NULL OR jsonb_typeof(atmosphere) = 'object'),

  -- Terrain catalog descriptor (migration 010). NULL = no fine layer (the
  -- document mesh is the surface, as today). { catalog } names the DEM the
  -- body's fine region streams at the player (docs/terrain.txt stage 2); the
  -- fine-hex edge is the catalog's pixel size, not a dial. Presentational —
  -- like rings/atmosphere.
  terrain        jsonb
                 CHECK (terrain IS NULL OR jsonb_typeof(terrain) = 'object'),

  -- Scripted test particle (migration 003). NULL = ordinary N-body body.
  -- { a, e, inc, node, peri, n, m0 } osculating elements in engine units:
  -- the app integrates it analytically (core/kepler.js), no cannon body.
  scripts        jsonb
                 CHECK (scripts IS NULL OR jsonb_typeof(scripts) = 'object'),

  -- Coarse taxonomy for list grouping (migration 004). Independent of the
  -- preset (look) and of parent_body_id (hierarchy). NULL for hand-built
  -- worlds; the UI then groups by parent only.
  kind           text
                 CHECK (kind IS NULL OR kind IN
                   ('star', 'planet', 'dwarf', 'moon', 'asteroid', 'comet')),

  -- Real diameter in KILOMETERS (migration 012). The exact input the hexcells
  -- importer reads to rebuild the potato terrain's size band (lumpiness /
  -- craters by 200 / 300 km) — (frequency, scale) is lossy (scale = 1 leaves
  -- the true radius within 12 % of the grid radius) and cannot recover those
  -- thresholds (docs/terrain2.txt §5.1). NULL where the band is fixed.
  diameter_km    double precision
                 CHECK (diameter_km IS NULL OR diameter_km > 0),

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
-- hexcells — the stored high-res surface (docs/terrain2.txt, Level F)
-- ---------------------------------------------------------------------------
-- The inverted terrain model (migration 011): the high-resolution hexes are
-- the STORED data of a body's surface, keyed by POSITION in the latitude-row
-- grid (core/hexlattice.js). This is the UNBOUNDED finest LOD; the document
-- (atoms, ≤ MAX_FREQUENCY) is the BOUNDED coarsest LOD / mass basis. Loading
-- or evicting a fine LOD never touches atoms (R5) — the mass derivation reads
-- only the document.
--
--   (body_id, lat_row, lon_col)  the positional key; lat/lon derived + stored
--                                for query/stream ORDER (never authoritative)
--   height                       world units (relief above the core)
--   material_id / color          mirror atoms (per-hex appearance)
--
-- Row-per-hex (like atoms): editable per cell, per-hex FK, partial updates.
-- At the 1.85 km target Earth holds ~57 M rows — COPY, never INSERT-per-row;
-- PARTITION BY HASH (body_id) if a single partition outgrows maintenance.
-- The streaming unit is a lat/lon tile; served by GET /api/bodies/:id/hex/...
-- (the app never reads it directly).
-- ---------------------------------------------------------------------------
CREATE TABLE hexcells (
  body_id     bigint NOT NULL REFERENCES bodies (id) ON DELETE CASCADE,
  lat_row     integer  NOT NULL CHECK (lat_row >= 0),
  lon_col     integer  NOT NULL CHECK (lon_col >= 0),

  lat         double precision,   -- derived, stored (deg) for stream order
  lon         double precision,   -- derived, stored (deg) for stream order

  height      double precision NOT NULL DEFAULT 0,   -- world units
  material_id bigint REFERENCES materials (id) ON DELETE RESTRICT,
  color       text CHECK (color IS NULL OR color ~* '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$'),

  PRIMARY KEY (body_id, lat_row, lon_col)
);

COMMENT ON TABLE hexcells IS
  'The stored high-res surface (docs/terrain2.txt, Level F): one row per hex '
  'of the latitude-row grid, keyed by POSITION (body_id, lat_row, lon_col). '
  'height is world units; material_id/color mirror atoms. The streaming unit '
  'is a lat/lon tile. Served by GET /api/bodies/:id/hex/... — never read '
  'directly. The unbounded finest LOD; the mass basis stays on atoms.';

-- ---------------------------------------------------------------------------
-- stars — the real-sky catalog (astronomy, NOT world content)
-- ---------------------------------------------------------------------------
-- Reference table for the sky backdrop (StarField.jsx / core/starsky.js),
-- deliberately kept OUTSIDE the world tables: a star here is a fact about our
-- galaxy, not a body inside a world document. `catalog` groups rows by source
-- catalog (the lightweight stand-in for a future star-map/galaxy model), so
-- richer surveys (Hipparcos, Gaia) can coexist with BSC5. Natural key
-- (catalog, hr); import replaces one catalog's rows atomically.
--
-- Positions are J2000 EQUATORIAL (the catalog's own frame). The engine's frame
-- is the ECLIPTIC (XZ plane, +Y north — see kepler.js), and StarField projects
-- ra/dec into it at load time; nothing bakes the sky. gal_/ecl_ columns are
-- derived at import with the app's own starsky.js so SQL can band-cut (stars
-- near the galactic plane) without redoing the astronomy — derivable, never
-- authoritative. Served read-only by GET /api/stars*.
-- ---------------------------------------------------------------------------
CREATE TABLE stars (
  catalog         text    NOT NULL,                -- 'BSC5' = Yale Bright Star Catalog v5
  hr              integer NOT NULL,                -- Harvard Revised number (the BSC id)

  ra_deg          double precision NOT NULL CHECK (ra_deg >= 0 AND ra_deg < 360),
  dec_deg         double precision NOT NULL CHECK (dec_deg BETWEEN -90 AND 90),
  epoch           double precision NOT NULL DEFAULT 2000,
  pm_ra           double precision,
  pm_dec          double precision,

  mag             double precision NOT NULL CHECK (mag BETWEEN -30 AND 30),
  mag_band        text NOT NULL DEFAULT 'V',
  b_v             double precision,

  spectral        text,
  spectral_class  text CHECK (spectral_class IS NULL OR spectral_class IN
                              ('O', 'B', 'A', 'F', 'G', 'K', 'M')),

  -- derived at import (starsky.js) — query convenience, never authoritative
  gal_l           double precision,
  gal_b           double precision,
  ecl_lon         double precision,
  ecl_lat         double precision,

  imported_at     timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (catalog, hr)
);

CREATE INDEX stars_by_mag_idx ON stars (catalog, mag);

COMMENT ON TABLE stars IS
  'Real-sky star catalog (astronomy, not world content): one row per star of '
  'a catalog. Positions J2000 equatorial; gal_/ecl_ derived at import via '
  'src/core/starsky.js. Served by GET /api/stars* — StarField projects ra/dec '
  'into the engine ecliptic frame at load time.';

-- ---------------------------------------------------------------------------
-- models — craft models (classes): mover identity + serialized mesh design
-- ---------------------------------------------------------------------------
-- P3 of the movement model (docs/flight.txt §10 / docs/movement.txt §15):
-- DB worlds carry the astronaut's vehicles. A craft is split CLASS vs
-- INSTANCE the way the app splits them: `models` is the class — one row per
-- kind, where `kind` is the mover identity (core/craftTypes.js key) and
-- `design` is the SERIALIZED MESH (a JSON document of positioned/rotated
-- primitives, core/craftDesigns.js shape). Editing a craft's look is a data
-- edit — UPDATE models SET design = … WHERE key = 'shuttle' — and the next
-- skeleton streams it; the browser rebuilds the mesh (Crafts.jsx).
-- ---------------------------------------------------------------------------
CREATE TABLE models (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key         text NOT NULL UNIQUE,       -- natural key: the kind ('shuttle', 'drive')
  label       text NOT NULL,              -- display name ('Shuttle', 'Rover')
  kind        text NOT NULL,              -- mover identity (core/craftTypes.js key)
  design      jsonb NOT NULL,             -- serialized mesh: { length, parts: [...] }
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT models_design_is_object CHECK (jsonb_typeof(design) = 'object')
);

CREATE TRIGGER models_set_updated_at
  BEFORE UPDATE ON models
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE models IS
  'Craft models (classes): one row per craft kind. kind is the mover '
  'identity (core/craftTypes.js); design is the serialized mesh (JSON '
  '{length, parts:[{shape,size,position,rotation,material}]} — '
  'core/craftDesigns.js). Editing design in the DB changes how every '
  'instance of the model renders — the skeleton streams it verbatim.';

-- The built-in designs — byte-identical to DEFAULT_CRAFT_DESIGNS in
-- src/core/craftDesigns.js (test-motion.mjs keeps them in lockstep).
INSERT INTO models (key, label, kind, design) VALUES
  ('shuttle', 'Shuttle', 'shuttle', '{"length":1.345,"parts":[{"shape":"cylinder","size":[0.26,0.3,0.9,12],"position":[0,0,0.15],"rotation":[1.5707963267948966,0,0],"material":{"color":"#cdd6e4","metalness":0.55,"roughness":0.4}},{"shape":"cone","size":[0.3,0.45,12],"position":[0,0,0.82],"rotation":[1.5707963267948966,0,0],"material":{"color":"#9fb2cc","metalness":0.6,"roughness":0.35}},{"shape":"box","size":[0.5,0.05,0.5],"position":[-0.38,-0.02,-0.25],"rotation":[0,0,0.5],"material":{"color":"#7d8aa0","metalness":0.5,"roughness":0.5}},{"shape":"box","size":[0.5,0.05,0.5],"position":[0.38,-0.02,-0.25],"rotation":[0,0,-0.5],"material":{"color":"#7d8aa0","metalness":0.5,"roughness":0.5}}]}'::jsonb),
  ('drive', 'Rover', 'drive', '{"length":0.9,"parts":[{"shape":"box","size":[0.55,0.24,0.9],"position":[0,0.34,0],"rotation":[0,0,0],"material":{"color":"#c8a25e","metalness":0.45,"roughness":0.5}},{"shape":"cylinder","size":[0.02,0.02,0.34,6],"position":[0,0.51,0.12],"rotation":[0,0,0],"material":{"color":"#9aa4b2","metalness":0.6,"roughness":0.4}},{"shape":"box","size":[0.12,0.08,0.12],"position":[0,0.7,0.12],"rotation":[0,0,0],"material":{"color":"#3a3f47","metalness":0.4,"roughness":0.5}},{"shape":"cylinder","size":[0.16,0.16,0.12,12],"position":[-0.34,0.16,0.28],"rotation":[0,0,1.5707963267948966],"material":{"color":"#33373e","metalness":0.3,"roughness":0.75}},{"shape":"cylinder","size":[0.16,0.16,0.12,12],"position":[0.34,0.16,0.28],"rotation":[0,0,1.5707963267948966],"material":{"color":"#33373e","metalness":0.3,"roughness":0.75}},{"shape":"cylinder","size":[0.16,0.16,0.12,12],"position":[-0.34,0.16,-0.28],"rotation":[0,0,1.5707963267948966],"material":{"color":"#33373e","metalness":0.3,"roughness":0.75}},{"shape":"cylinder","size":[0.16,0.16,0.12,12],"position":[0.34,0.16,-0.28],"rotation":[0,0,1.5707963267948966],"material":{"color":"#33373e","metalness":0.3,"roughness":0.75}}]}'::jsonb);

-- ---------------------------------------------------------------------------
-- craft — craft instances: one row per vehicle of one world
-- ---------------------------------------------------------------------------
-- The instances of the models: a named vehicle of a world. `pose` is the
-- craft document pose verbatim (docs/flight.txt §2): {anchor:{bodyId,dir,r,
-- heading?}} (parked — bodyId is a bodies.doc_id of THIS world) or
-- {space:{pos,vel,yaw,pitch}} (a save-time snapshot). `realism` is
-- per-instance: the SAME model can fly arcade or real. The skeleton streams
-- these as the world document's crafts[] field (server/db.mjs worldSkeleton).
-- ---------------------------------------------------------------------------
CREATE TABLE craft (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  world_id    bigint NOT NULL REFERENCES worlds (id) ON DELETE CASCADE,

  doc_id      text,                       -- world.json craft id ("c-…"), kept for round-trips
  name        text NOT NULL DEFAULT 'Craft',
  model_id    bigint NOT NULL REFERENCES models (id) ON DELETE RESTRICT,

  realism     text NOT NULL DEFAULT 'arcade'
              CHECK (realism IN ('arcade', 'real')),

  pose        jsonb NOT NULL,
              CONSTRAINT craft_pose_is_object CHECK (jsonb_typeof(pose) = 'object'),

  sort_order  integer NOT NULL DEFAULT 0,   -- preserves the JSON array order
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (world_id, doc_id)
);

CREATE INDEX craft_by_world_idx ON craft (world_id, sort_order);

CREATE TRIGGER craft_set_updated_at
  BEFORE UPDATE ON craft
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE craft IS
  'Craft instances: the astronaut''s vehicles of a world (docs/flight.txt). '
  'model_id → models (the class: kind + mesh design); pose is the document '
  'pose (anchor/space); realism is per-instance. The skeleton streams these '
  'as the world document''s crafts[] field (server/db.mjs worldSkeleton).';

COMMENT ON COLUMN craft.model_id IS
  'The craft class. ON DELETE RESTRICT: a model in use cannot be deleted — '
  'repoint its crafts first (same contract as atoms.material_id).';

-- ---------------------------------------------------------------------------
-- terrain — the DEM catalog (fine-terrain data, NOT world content)
-- ---------------------------------------------------------------------------
-- Stage 2 of the fine-terrain design (docs/terrain.txt §9): a body's FINE
-- region streams local terrain at the DEM's native pixel size around the
-- player (1.85 km for ETOPO2022 60s), feathered to the document mesh at the
-- cap's edge. The document grid stays the physical truth; the fine layer is
-- presentational — exactly like rings/atmosphere. A body NAMES the catalog it
-- rides in bodies.terrain ({catalog}); the tiles it streams live here.
--
-- Frame / layout (matches the DEM, mapping.txt):
--   * pixel_deg   = the DEM pixel size in degrees (1/60 = 1 arc-minute). The
--                   fine-hex edge is derived from it (a = pixel_deg × 111.32
--                   km at the equator), so it is a CATALOG property, not a dial.
--   * payload     = the tile's elevations as SIGNED INT16, 1 m steps
--                   (value = round(elevation_m)), LITTLE-ENDIAN, row-major
--                   (the tile's own rows, north-first; columns west-first).
--                   (tile_size / pixel_deg)² values. int16 at 1 m spans
--                   ±32 km — the DEM is −11…+9 km, 3× headroom.
--   * tile_lat / tile_lon = the tile's SOUTHWEST corner, in whole degrees.
--                   tile_lat ∈ {88, 86, …, −90} (90 tiles), tile_lon ∈
--                   {178, 176, …, −180} (180 tiles) → 16,200 tiles.
--
-- The app never reads this table directly: it fetches tiles through
-- /api/terrain (server/api.mjs), never raw postgres.
--
-- Loaded by `npm run db:terrain` (scripts/import-terrain.mjs) from the
-- etopo2022-60s.f32 S3 seed (DATA.md) — one-time ~0.5 GB, idempotent per
-- catalog (re-import replaces one catalog's tiles atomically).
-- ---------------------------------------------------------------------------
CREATE TABLE terrain (
  catalog     text    NOT NULL,             -- 'ETOP2022-60s' = NOAA ETOPO2022 60s
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
CREATE INDEX terrain_catalog_idx ON terrain (catalog);

COMMENT ON TABLE terrain IS
  'Terrain catalog (a DEM, not world content): one row per 2°×2° tile. '
  'payload is SIGNED INT16 at 1 m steps (value = round(elevation_m)), '
  'little-endian, row-major (N-first, W-first), (tile_size/pixel_deg)² values. '
  'Served read-only by GET /api/terrain* — the fine-terrain layer (docs/'
  'terrain.txt stage 2) streams these tiles around the player.';
COMMENT ON COLUMN terrain.catalog IS
  'Source catalog id, e.g. ETOP2022-60s = NOAA ETOPO2022 60s (public domain). '
  'Bodies name it via bodies.terrain.{catalog}; groups tiles until other DEMs '
  '(LRO, MOLA) land beside it.';
COMMENT ON COLUMN terrain.payload IS
  'The tile''s elevations: (tile_size/pixel_deg)² SIGNED INT16 values at 1 m '
  'steps (value = round(elevation_m)), LITTLE-ENDIAN, row-major — the tile''s '
  'own rows north-first, columns west-first. Decode with new Int16Array(bytes).';

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
