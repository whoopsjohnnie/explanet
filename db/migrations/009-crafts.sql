-- ===========================================================================
-- Migration 009 — crafts in the world database  (models + craft)
-- ===========================================================================
-- P3 of the movement model (docs/flight.txt §10 / docs/movement.txt §15):
-- DB worlds carry the astronaut's vehicles. Bodies stay bodies; the craft
-- gets its own relational home, split CLASS vs INSTANCE the way the app
-- splits them (core/craftTypes.js picks the mover by `kind`, the mesh is
-- pure data):
--
--   models  — the CRAFT MODELS (classes): one row per kind. `kind` is the
--             mover identity (craftTypes.js key: 'shuttle', 'drive', …) and
--             `design` is the SERIALIZED MESH — a JSON document of
--             positioned/rotated primitives (core/craftDesigns.js shape:
--             { length, parts: [{shape, size, position, rotation,
--             material}] }). Editing a craft's look is a data edit: UPDATE
--             models SET design = … WHERE key = 'shuttle' — the next
--             skeleton streams it and the browser rebuilds the mesh.
--             No code change, no rebuild.
--   craft   — the INSTANCES: one row per vehicle of one world (a named
--             craft of a model). `pose` is the craft document pose jsonb
--             ({anchor:{bodyId,dir,r,heading?}} parked, or
--             {space:{pos,vel,yaw,pitch}} flying — anchor.bodyId is a
--             body doc_id, resolved within the world); `realism` is
--             per-instance (the same model can fly arcade or real).
--
-- The app consumes craft through the world skeleton (server/db.mjs emits a
-- `crafts[]` document field — kind from the model, design verbatim), so the
-- browser's code path is identical for file worlds and DB worlds. Read-only
-- introspection: GET /api/models, GET /api/models/:key.
--
-- Seed: the built-in designs (shuttle + rover), byte-identical to
-- DEFAULT_CRAFT_DESIGNS in src/core/craftDesigns.js (pinned by
-- scripts/test-motion.mjs — change one, change both). ON CONFLICT DO
-- NOTHING: re-running the migration (or scripts/import-db.mjs) never
-- clobbers a design you have customized.
--
-- Apply:  PGPASSWORD=*** psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" \
--           -f db/migrations/009-crafts.sql
-- Idempotent. Fresh installs get the tables from db/schema.sql directly.
-- ===========================================================================
BEGIN;

SET search_path = explanet;
SET LOCAL client_min_messages = warning;

-- ---------------------------------------------------------------------------
-- models — craft models (classes): mover identity + serialized mesh design
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS models (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key         text NOT NULL UNIQUE,       -- natural key: the kind ('shuttle', 'drive')
  label       text NOT NULL,              -- display name ('Shuttle', 'Rover')
  kind        text NOT NULL,              -- mover identity (core/craftTypes.js key)
  design      jsonb NOT NULL,             -- serialized mesh: { length, parts: [...] }
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT models_design_is_object CHECK (jsonb_typeof(design) = 'object')
);

DROP TRIGGER IF EXISTS models_set_updated_at ON models;
CREATE TRIGGER models_set_updated_at
  BEFORE UPDATE ON models
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE models IS
  'Craft models (classes): one row per craft kind. kind is the mover '
  'identity (core/craftTypes.js); design is the serialized mesh (JSON '
  '{length, parts:[{shape,size,position,rotation,material}]} — '
  'core/craftDesigns.js). Editing design in the DB changes how every '
  'instance of the model renders — the skeleton streams it verbatim.';

COMMENT ON COLUMN models.design IS
  'The mesh, as data: length = nose-to-tail span in model units (the mesh '
  'scales by sizeMeters/scale ÷ length); parts = one positioned, rotated '
  'primitive each (shape box|cylinder|cone|sphere, size = the geometry '
  'args, material color/metalness/roughness[/emissive]). Rebuild a design '
  'by UPDATEing this column; the browser maps parts to three primitives '
  '(src/components/Crafts.jsx).';

-- The built-in designs — byte-identical to DEFAULT_CRAFT_DESIGNS in
-- src/core/craftDesigns.js (test-motion.mjs keeps them in lockstep).
INSERT INTO models (key, label, kind, design) VALUES
  ('shuttle', 'Shuttle', 'shuttle', '{"length":1.345,"parts":[{"shape":"cylinder","size":[0.26,0.3,0.9,12],"position":[0,0,0.15],"rotation":[1.5707963267948966,0,0],"material":{"color":"#cdd6e4","metalness":0.55,"roughness":0.4}},{"shape":"cone","size":[0.3,0.45,12],"position":[0,0,0.82],"rotation":[1.5707963267948966,0,0],"material":{"color":"#9fb2cc","metalness":0.6,"roughness":0.35}},{"shape":"box","size":[0.5,0.05,0.5],"position":[-0.38,-0.02,-0.25],"rotation":[0,0,0.5],"material":{"color":"#7d8aa0","metalness":0.5,"roughness":0.5}},{"shape":"box","size":[0.5,0.05,0.5],"position":[0.38,-0.02,-0.25],"rotation":[0,0,-0.5],"material":{"color":"#7d8aa0","metalness":0.5,"roughness":0.5}}]}'::jsonb),
  ('drive', 'Rover', 'drive', '{"length":0.9,"parts":[{"shape":"box","size":[0.55,0.24,0.9],"position":[0,0.34,0],"rotation":[0,0,0],"material":{"color":"#c8a25e","metalness":0.45,"roughness":0.5}},{"shape":"cylinder","size":[0.02,0.02,0.34,6],"position":[0,0.51,0.12],"rotation":[0,0,0],"material":{"color":"#9aa4b2","metalness":0.6,"roughness":0.4}},{"shape":"box","size":[0.12,0.08,0.12],"position":[0,0.7,0.12],"rotation":[0,0,0],"material":{"color":"#3a3f47","metalness":0.4,"roughness":0.5}},{"shape":"cylinder","size":[0.16,0.16,0.12,12],"position":[-0.34,0.16,0.28],"rotation":[0,0,1.5707963267948966],"material":{"color":"#33373e","metalness":0.3,"roughness":0.75}},{"shape":"cylinder","size":[0.16,0.16,0.12,12],"position":[0.34,0.16,0.28],"rotation":[0,0,1.5707963267948966],"material":{"color":"#33373e","metalness":0.3,"roughness":0.75}},{"shape":"cylinder","size":[0.16,0.16,0.12,12],"position":[-0.34,0.16,-0.28],"rotation":[0,0,1.5707963267948966],"material":{"color":"#33373e","metalness":0.3,"roughness":0.75}},{"shape":"cylinder","size":[0.16,0.16,0.12,12],"position":[0.34,0.16,-0.28],"rotation":[0,0,1.5707963267948966],"material":{"color":"#33373e","metalness":0.3,"roughness":0.75}}]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- craft — craft instances: one row per vehicle of one world
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS craft (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  world_id    bigint NOT NULL REFERENCES worlds (id) ON DELETE CASCADE,

  doc_id      text,                       -- world.json craft id ("c-…"), kept for round-trips
  name        text NOT NULL DEFAULT 'Craft',
  model_id    bigint NOT NULL REFERENCES models (id) ON DELETE RESTRICT,

  -- per-instance mode: the SAME model can fly "arcade" (body-relative, no
  -- gravity) or "real" (Newtonian) — realism belongs to the vehicle, not the
  -- class (docs/flight.txt §4).
  realism     text NOT NULL DEFAULT 'arcade'
              CHECK (realism IN ('arcade', 'real')),

  -- the craft document pose, verbatim: {anchor:{bodyId,dir,r,heading?}}
  -- (parked — bodyId is a bodies.doc_id of THIS world) or
  -- {space:{pos,vel,yaw,pitch}} (a save-time snapshot). {} = unreadable in
  -- the source document; the app's normalizeCrafts re-anchors it.
  pose        jsonb NOT NULL,
              CONSTRAINT craft_pose_is_object CHECK (jsonb_typeof(pose) = 'object'),

  sort_order  integer NOT NULL DEFAULT 0,   -- preserves the JSON array order
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (world_id, doc_id)
);

CREATE INDEX IF NOT EXISTS craft_by_world_idx ON craft (world_id, sort_order);

DROP TRIGGER IF EXISTS craft_set_updated_at ON craft;
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

COMMIT;
