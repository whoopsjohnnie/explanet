#!/usr/bin/env node
/**
 * import-db.mjs
 * ---------------------------------------------------------------------------
 * Import a world.json document into the PostgreSQL schema (db/schema.sql).
 *
 *   world.json →  worlds   (name, gravity, scale [meters per world unit], doc version)
 *                 bodies   (planets[] rows; isStatic → gravity_immune;
 *                          planets[].generation → bodies.generation jsonb —
 *                          a GENERATED body carries no elements and gets no
 *                          atom rows; the server synthesizes its surface)
 *                 atoms    (elements[i] → cell_index i, positional identity)
 *                 materials(terrain key `t` resolved through the palette;
 *                          unknown keys become private materials of the world)
 *
 * Everything runs in ONE transaction: either the whole world lands or nothing
 * does. Before COMMIT a DO block re-checks every body against
 * cell_count_for_frequency(frequency) — a truncated/corrupt stream aborts.
 *
 * Usage:
 *   PGHOST=<host> PGDATABASE=<db> PGUSER=<user> node scripts/import-db.mjs [path/to/world.json]
 *
 * Requires psql on PATH (data streams to it via COPY FROM STDIN); connection
 * settings are standard libpq env vars / ~/.pgpass. Re-running imports the
 * document again as a NEW world row (worlds have no natural key).
 */
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { lookupPgpass } from '../server/db.mjs'

// psql connection: env vars REQUIRED (no infrastructure names in this repo —
// see DATA.md). psql matches hostnames EXACTLY, so a ~/.pgpass entry must be
// written for the host exactly as PGHOST gives it.
for (const k of ['PGHOST', 'PGDATABASE', 'PGUSER'])
  if (!process.env[k]) {
    console.error(`import-db: ${k} is required — set your world-database connection env vars (see README / DATA.md)`)
    process.exit(1)
  }
process.env.PGPORT ||= '5432'
if (!process.env.PGPASSWORD)
  process.env.PGPASSWORD =
    lookupPgpass(process.env.PGHOST, Number(process.env.PGPORT), process.env.PGDATABASE, process.env.PGUSER) || ''

const src = process.argv[2] || 'public/world.json'
const world = JSON.parse(readFileSync(src, 'utf8'))
if (!world || !Array.isArray(world.planets)) {
  console.error(`${src}: not a world document`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Helpers: SQL literals and COPY text-format escaping
// ---------------------------------------------------------------------------
const q = (v) => `'${String(v).replace(/'/g, "''")}'`
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? String(Number(v)) : String(d))
const cop = (v) => String(v).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n')
const copNum = (v, d = 0) => (Number.isFinite(Number(v)) ? String(Number(v)) : String(d))

const vec = (v, px) => [num(v?.x), num(v?.y), num(v?.z)].map((n, i) => `${px}_${'xyz'[i]}`)

const totalAtoms = world.planets.reduce((s, p) => s + (p.elements?.length || 0), 0)
const genCount = world.planets.filter((p) => p.generation).length
console.error(`importing ${src}: "${world.name ?? 'Untitled World'}", ` +
  `${world.planets.length} bodies (${genCount} generated), ${totalAtoms.toLocaleString('en-US')} atoms → $PGDATABASE`)

// ---------------------------------------------------------------------------
// SQL + COPY payload (one stream; psql reads COPY data after each
// "COPY ... FROM stdin;" line until a lone "\.")
// ---------------------------------------------------------------------------
const bodyCols = `doc_id, name, preset, kind, seed, frequency, scale,
  center_x, center_y, center_z, velocity_x, velocity_y, velocity_z,
  spin_x, spin_y, spin_z, density, gravity_immune, sort_order`

const bodyRows = world.planets.map((p, i) => {
  p.__docId = p.id ?? `p-import-${i}`
  const c = p.center || {}
  const v = p.velocity || {}
  const s = p.spin || {}
  return [
    cop(p.__docId), cop(p.name ?? 'Planet'), cop(p.preset ?? 'earthlike'),
    p.kind ? cop(String(p.kind)) : '\\N',
    Math.round(Number(p.seed) || 1), Math.round(Number(p.frequency) || 6), num(p.scale, 1),
    num(c.x), num(c.y), num(c.z), num(v.x), num(v.y), num(v.z), num(s.x), num(s.y), num(s.z),
    num(p.density, 0.05), p.isStatic ? 't' : 'f', i,
    p.generation ? cop(JSON.stringify(p.generation)) : '\\N',
    p.rings ? cop(JSON.stringify(p.rings)) : '\\N',
    p.atmosphere ? cop(JSON.stringify(p.atmosphere)) : '\\N',
    p.scriptsOrbit ? cop(JSON.stringify(p.scriptsOrbit)) : '\\N',
    p.parent ? cop(String(p.parent)) : '\\N',
  ].join('\t')
}).join('\n')

const staging = `BEGIN;
SET LOCAL search_path = explanet;
SET LOCAL client_min_messages = warning;
SET LOCAL statement_timeout = 0;

CREATE TEMP TABLE st_bodies (
  doc_id text, name text, preset text, kind text, seed bigint, frequency integer,
  scale double precision,
  center_x double precision, center_y double precision, center_z double precision,
  velocity_x double precision, velocity_y double precision, velocity_z double precision,
  spin_x double precision, spin_y double precision, spin_z double precision,
  density double precision, gravity_immune boolean, sort_order integer,
  generation text, rings text, atmosphere text, scripts text, parent text
) ON COMMIT DROP;

CREATE TEMP TABLE st_atoms (
  body_doc_id text, cell_index integer, height double precision,
  material_key text, color text
) ON COMMIT DROP;

COPY st_bodies (${bodyCols}, generation, rings, atmosphere, scripts, parent) FROM stdin;
${bodyRows}
\\.

WITH w AS (
  INSERT INTO worlds (name, gravity, doc_version, scale)
  VALUES (${q(world.name ?? 'Untitled World')}, ${num(world.gravity, 40)}, ${num(world.version, 1)},
    ${Number.isFinite(Number(world.scale)) && Number(world.scale) > 0 ? num(world.scale) : 'NULL'})
  RETURNING id
)
INSERT INTO bodies (world_id, ${bodyCols}, generation, rings, atmosphere, scripts, parent_body_id)
SELECT w.id, ${bodyCols.split(',').map((c) => `s.${c.trim()}`).join(', ')},
       NULLIF(s.generation, '')::jsonb, NULLIF(s.rings, '')::jsonb,
       NULLIF(s.atmosphere, '')::jsonb, NULLIF(s.scripts, '')::jsonb, NULL
FROM st_bodies s, w;

-- moons → parents: resolve doc_id references inserted by the generator
-- (two passes: parents first, then children — parents never reference children)
UPDATE bodies b
   SET parent_body_id = p.id
  FROM st_bodies s
  JOIN bodies p ON p.doc_id = NULLIF(s.parent, '') AND p.world_id = currval('worlds_id_seq')
 WHERE b.doc_id = s.doc_id AND b.world_id = currval('worlds_id_seq');

-- terrain keys the built-in palette doesn't know become this world's materials
INSERT INTO materials (world_id, key, label)
SELECT currval('worlds_id_seq'), u.k, u.k
FROM (
  SELECT DISTINCT a.material_key AS k FROM st_atoms a
  WHERE a.material_key IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM materials m WHERE m.key = a.material_key AND m.world_id IS NULL)
) u;
`

const atomsInsert = `
INSERT INTO atoms (body_id, cell_index, height, material_id, color)
SELECT b.id, a.cell_index, a.height, m.id, a.color
FROM st_atoms a
-- doc_id is only unique WITHIN a world — scope to the world just inserted,
-- or a repeat doc_id from an older world would double-insert atoms
JOIN bodies b ON b.doc_id = a.body_doc_id AND b.world_id = currval('worlds_id_seq')
LEFT JOIN LATERAL (
  SELECT id FROM materials
  WHERE key = a.material_key AND (world_id = b.world_id OR world_id IS NULL)
  ORDER BY world_id NULLS LAST LIMIT 1
) m ON true;

-- observer frame: anchor the world view on its first star (no-op if none)
UPDATE worlds SET reference_body_id = s.id
FROM (SELECT id FROM bodies
      WHERE world_id = currval('worlds_id_seq') AND preset = 'star'
      ORDER BY sort_order LIMIT 1) s
WHERE worlds.id = currval('worlds_id_seq');

-- every body must cover its whole grid before we dare commit
DO $do$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT body_name, atom_rows, cell_count FROM v_body_stats
            WHERE NOT atoms_complete
  LOOP
    RAISE EXCEPTION 'import aborted: % carries % atoms, grid needs %',
      r.body_name, r.atom_rows, r.cell_count;
  END LOOP;
END
$do$;

COMMIT;
`

// ---------------------------------------------------------------------------
// Stream it to psql
// ---------------------------------------------------------------------------
const psql = spawn('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1'], {
  stdio: ['pipe', 'pipe', 'pipe'],
})
let errBuf = ''
psql.stderr.on('data', (d) => (errBuf += d))
psql.stdout.resume()

async function send(chunk) {
  if (psql.stdin.writableNeedDrain) await once(psql.stdin, 'drain')
  psql.stdin.write(chunk)
}

const t0 = Date.now()
try {
  await send(staging + 'COPY st_atoms (body_doc_id, cell_index, height, material_key, color) FROM stdin;\n')
  for (const p of world.planets) {
    const docId = cop(p.__docId ?? '')
    const lines = new Array((p.elements || []).length)
    for (let i = 0; i < lines.length; i++) {
      const e = p.elements[i] || {}
      lines[i] = `${docId}\t${i}\t${copNum(e.h)}\t${cop(e.t)}\t${e.c ? cop(e.c) : '\\N'}`
    }
    if (lines.length) await send(lines.join('\n') + '\n') // generated bodies stream nothing
  }
  await send('\\.\n' + atomsInsert)
  psql.stdin.end()
  const code = await once(psql, 'exit')
  if (code[0] !== 0) {
    console.error('import FAILED (rolled back):\n' + errBuf)
    process.exit(1)
  }
} catch (e) {
  psql.stdin.destroy()
  const code = await Promise.race([
    once(psql, 'exit'),
    new Promise((r) => setTimeout(() => r(['<still running>']), 3000)),
  ])
  console.error('import FAILED (rolled back):', e.message, '| psql exit:', code[0])
  if (errBuf) console.error('psql said:\n' + errBuf)
  process.exit(1)
}
console.error(`imported in ${((Date.now() - t0) / 1000).toFixed(1)}s — verifying…`)

// ---------------------------------------------------------------------------
// Post-import report
// ---------------------------------------------------------------------------
const report = spawn('psql', ['-X', '-q', '-A', '-F', ' | ', '-c', `
  SET search_path = explanet;
  SELECT 'world "' || name || '" (id ' || id || ', G ' || gravity || ', anchor '
         || coalesce((SELECT name FROM bodies WHERE id = worlds.reference_body_id), '—') || ')'
  FROM worlds WHERE id = (SELECT max(id) FROM worlds WHERE name = ${q(world.name ?? 'Untitled World')});
  SELECT '  ' || body_name || CASE WHEN generation IS NOT NULL THEN ' (generated)' ELSE '' END
         || ': freq ' || frequency || ', ' || coalesce(atom_rows, 0) || '/' || cell_count
         || ' atoms, radius ' || round(radius::numeric, 2) || ', mass ~'
         || to_char(approx_mass::numeric, '9.999EEEE')
  FROM v_body_stats
  WHERE world_id = (SELECT max(id) FROM worlds WHERE name = ${q(world.name ?? 'Untitled World')})
  ORDER BY body_id;
`], { stdio: ['ignore', 'inherit', 'inherit'] })
const rc = await once(report, 'exit')
process.exit(rc[0] === 0 ? 0 : 1)
