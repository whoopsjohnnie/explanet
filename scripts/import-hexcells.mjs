#!/usr/bin/env node
/**
 * import-hexcells.mjs — generate + COPY the STORED high-res hexes (docs/terrain2.txt).
 * ---------------------------------------------------------------------------
 * The generation side of the inverted terrain model. DB-DRIVEN: it reads the
 * world row and its bodies straight from postgres (NEVER the world.json
 * document — a large world is DB-only, and the document is only the app's save
 * format). For EVERY stored body of a world with `hex_meters` set — the rule
 * is derived, `generation IS NULL` (docs/terrain2.txt §5.1) — it walks the
 * body's latitude-row grid (core/hexlattice.js) and emits ONE `hexcells` row
 * per stored hex:
 *
 *   (body_id, lat_row, lon_col)   the positional key (docs/terrain2.txt §5)
 *   lat, lon                      derived, stored for stream order (a pin, never
 *                                 authoritative over the lattice key)
 *   height                        relief above the core, in WORLD UNITS — the
 *                                 same datum the document uses
 *   material_id, color            the body's own color rules (the SAME per-hex
 *                                 fn the document was built with)
 *
 * Two terrain sources, ONE shared dispatch (scripts/sol-real/bodyTerrain.mjs):
 *
 *   • Earth — the only DEM-sourced body (terrainFor → { kind: 'earth' }): the
 *     ETOPO2022 60s catalog (the SAME seed file the document was built from, so
 *     document and high-res share one datum). height = the DEM sample
 *     (meters ÷ world.scale); material/color via earthHex (a coastline hex is
 *     land or sea, not a blend).
 *   • every other stored body — the procedural per-hex fn (terrainFor →
 *     { kind: 'hex', fn, unit }) evaluated at the fine-grid centers: the SAME
 *     bound fn the document was built with, so the document and the stored
 *     hexes agree by construction (one function, two grids). unit 'km' →
 *     height = h·1000/SCALE (≡ h·KM2U, the document's datum); 'u' → h as-is
 *     (the potato builder, already in engine units).
 *
 * The DIAMETER (bodies.diameter_km, migration 012) is read from the DB — it is
 * the exact input the potato band (lumpiness / craters) needs, so there is no
 * seed-table inversion and no drift. The seed table (orbits.json) is read ONLY
 * for the small bodies' COLOR (sbClass / semi-major axis), which is not stored
 * on the body.
 *
 * The rows STREAM to psql via COPY FROM stdin (a bounded buffer — the ~200 M
 * rows are never held in memory). ONE transaction: DELETE the target bodies'
 * existing hexcells (idempotent — a re-run refreshes in place) → COPY → a DO
 * block re-checks that the landed row count equals the sum of the grid totals
 * (a truncated stream aborts the whole import).
 *
 * Usage (run AFTER import-db.mjs created the world row + bodies):
 *   PGHOST=... PGDATABASE=... PGUSER=... node scripts/import-hexcells.mjs [world-id | world-name]
 *   (no arg = the newest world with hex_meters set)
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { lookupPgpass } from '../server/db.mjs'
import { loadEtopo } from './sol-real/etopo.mjs'
import { highResGrid, cellLatLonDeg } from '../src/core/hexlattice.js'
import { earthHex } from './sol-real/terrain.js'
import { terrainFor } from './sol-real/bodyTerrain.mjs'

// env vars REQUIRED (no infrastructure names in this repo — see DATA.md)
for (const k of ['PGHOST', 'PGDATABASE', 'PGUSER'])
  if (!process.env[k]) {
    console.error(`import-hexcells: ${k} is required — set your world-database connection env vars (see README / DATA.md)`)
    process.exit(1)
  }
process.env.PGPORT ||= '5432'
if (!process.env.PGPASSWORD)
  process.env.PGPASSWORD = lookupPgpass(process.env.PGHOST, Number(process.env.PGPORT), process.env.PGDATABASE, process.env.PGUSER) || ''

const qstr = (v) => `'${String(v).replace(/'/g, "''")}'`

async function query(sql) {
  const p = spawn('psql', ['-X', '-q', '-A', '-t', '-F', '\t', '-c', sql], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  p.stdout.on('data', (d) => (out += d))
  p.stderr.on('data', (d) => (err += d))
  const [code] = await once(p, 'exit')
  if (code !== 0) throw new Error('query failed: ' + (err.trim() || `psql exited ${code}`))
  return out.split('\n').filter(Boolean)
}

// ---------------------------------------------------------------------------
// Resolve the target world (arg = world id, world name, or the newest with
// hex_meters set)
// ---------------------------------------------------------------------------
const arg = process.argv[2]
let worldSel
if (arg && /^\d+$/.test(arg)) worldSel = `id = ${arg}`
else if (arg) worldSel = `name = ${qstr(arg)}`
else worldSel = `hex_meters IS NOT NULL`

const worldRows = await query(
  `SET search_path = explanet; SELECT id, name, hex_meters, scale FROM worlds WHERE ${worldSel} ORDER BY id DESC LIMIT 1`
)
if (!worldRows.length) {
  console.error(`no ${arg && !/^\d+$/.test(arg) ? `world named "${arg}"` : arg ? `world id ${arg}` : 'world with hex_meters set'} in $PGDATABASE`)
  console.error('Import it first:  node scripts/import-db.mjs <world.json>')
  process.exit(1)
}
const W = worldRows[0].split('\t')
const worldId = Number(W[0])
const worldName = W[1]
const HEX_M = Number(W[2]) // stored hex edge, METERS (world-uniform, R1)
const SCALE = Number(W[3]) // meters per world unit (height datum)
if (!Number.isFinite(HEX_M) || !(HEX_M > 0)) {
  console.error(`world ${worldId} ("${worldName}"): no hex_meters — generate with --hex-meters <m> (docs/terrain2.txt §4)`)
  process.exit(1)
}
if (!Number.isFinite(SCALE) || !(SCALE > 0)) {
  console.error(`world ${worldId}: world has no valid scale (meters per unit) — required for the height datum`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// The target bodies: every stored (non-generated) body of the world. The
// parent NAME is joined in (the moon family palette keys off it).
// ---------------------------------------------------------------------------
const bodyRows = await query(`
  SET search_path = explanet;
  SELECT b.id, b.name, b.kind, b.seed, b.frequency, b.scale, b.diameter_km, p.name
  FROM bodies b
  LEFT JOIN bodies p ON p.id = b.parent_body_id
  WHERE b.world_id = ${worldId} AND b.generation IS NULL
  ORDER BY b.sort_order
`)
if (!bodyRows.length) {
  console.error(`world ${worldId} ("${worldName}"): no stored (non-generated) bodies — nothing to import`)
  process.exit(1)
}
const bodies = bodyRows.map((r) => {
  const [id, name, kind, seed, frequency, scale, diameterKm, parentName] = r.split('\t')
  return {
    id: Number(id),
    name,
    kind: kind || null,
    seed: Number(seed) || 0,
    frequency: Number(frequency) || 6,
    scale: Number(scale) || 1,
    diameterKm: diameterKm === '' ? null : Number(diameterKm),
    parent: parentName === '' ? null : parentName,
  }
})

// the seed table — read ONLY for the small bodies' color (sbClass / a); the
// diameter (the band input) comes from the DB, not here.
const orbitsPath = 'scripts/sol-real/data/orbits.json'
let small
try {
  const orbits = JSON.parse(readFileSync(orbitsPath, 'utf8'))
  small = new Map()
  for (const a of orbits.asteroids || []) small.set(a.name, a)
  for (const c of orbits.comets || []) small.set(c.name, c)
} catch (e) {
  console.error(`\nseed table not found: ${orbitsPath} (needed for the small bodies' color)`)
  console.error('Seed data is not part of this repo — see DATA.md.')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Per body: build the grid (radius from the document frequency + scale — the
// derived, mass-basis radius the high-res surface sits on) + the terrain
// source (the shared dispatch). Pre-flight every material key the fns can emit.
// ---------------------------------------------------------------------------
let totalExpected = 0
const usedKeys = new Set()
for (const b of bodies) {
  const f = Math.round(b.frequency)
  const cells = 10 * f * f + 2
  const radiusU = Math.sqrt(cells / (4 * Math.PI)) * b.scale
  b.__radiusM = radiusU * SCALE
  b.__grid = highResGrid(b.__radiusM, HEX_M)
  b.__tf = terrainFor(b, { small }) // { kind:'earth' } | { kind:'hex', fn, unit, keys }
  for (const k of b.__tf.keys) usedKeys.add(k)
  totalExpected += b.__grid.total
}
const hasEarth = bodies.some((b) => b.__tf.kind === 'earth')

// the DEM (Earth's generation source — the same file the document was built
// from); loaded only when the world has an Earth body.
let dem
if (hasEarth) {
  const demPath = 'scripts/sol-real/data/etopo2022-60s.f32'
  try {
    dem = loadEtopo(readFileSync(demPath))
  } catch (e) {
    console.error(`\nDEM seed not found: ${demPath}`)
    console.error('Seed data is not part of this repo — see DATA.md.')
    console.error('For this seed: scripts/sol-real/data/etopo2022-60s.f32 (NOAA ETOPO2022 60s; regenerate with scripts/sol-real/fetch-terrain.mjs).')
    process.exit(1)
  }
}
const { W: demW, H: demH, data: demData } = dem || { W: 0, H: 0, data: null }
const step21600 = 21600 // (360° × 60 px/deg) — the DEM's lon span

// material key → id (world-specific preferred, then the global built-ins)
const matRows = await query(
  `SET search_path = explanet; SELECT key, id FROM materials WHERE world_id IS NULL OR world_id = ${worldId} ORDER BY (world_id IS NULL) ASC, id ASC`
)
const matId = new Map()
for (const r of matRows) {
  const tab = r.indexOf('\t')
  if (tab < 0) continue
  const key = r.slice(0, tab)
  if (!matId.has(key)) matId.set(key, Number(r.slice(tab + 1)))
}
const missing = [...usedKeys].filter((k) => !matId.has(k))
if (missing.length) {
  console.error(`materials missing for world ${worldId}: ${missing.join(', ')} — import the world (its atoms create these) first`)
  process.exit(1)
}

console.error(`importing high-res for world ${worldId} ("${worldName}"): hex_meters=${HEX_M}m, scale=${SCALE} m/u`)
console.error(`  ${bodies.length} stored bodies → ${totalExpected.toLocaleString('en-US')} hexes expected`)

// ---------------------------------------------------------------------------
// COPY stream: header (one transaction: delete-then-copy), the rows, then the
// "\." terminator + a count-verification DO block + COMMIT.
// ---------------------------------------------------------------------------
const bodyIds = bodies.map((b) => b.id)
const header = `BEGIN;
SET LOCAL search_path = explanet;
SET LOCAL client_min_messages = warning;
SET LOCAL statement_timeout = 0;

-- one transaction: replace the stored hexcells of the target bodies in place
-- (idempotent), then COPY the fresh generation.
DELETE FROM hexcells WHERE body_id IN (${bodyIds.join(',')});

COPY hexcells (body_id, lat_row, lon_col, lat, lon, height, material_id, color) FROM stdin;
`

const footer = `\\.

-- every hex must have landed: each grid is walked exactly once, so the count
-- is the sum of the grid totals (a truncated stream aborts the import)
DO $do$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM hexcells WHERE body_id IN (${bodyIds.join(',')});
  IF n <> ${totalExpected} THEN
    RAISE EXCEPTION 'import aborted: % hexcells landed, expected %', n, ${totalExpected};
  END IF;
END
$do$;

COMMIT;
`

const psql = spawn('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] })
let errBuf = ''
psql.stderr.on('data', (d) => (errBuf += d))
psql.stdout.resume()
psql.stdin.on('error', () => {}) // a failed psql closes stdin; swallow EPIPE
async function send(chunk) {
  if (psql.stdin.writableNeedDrain) await once(psql.stdin, 'drain')
  psql.stdin.write(chunk)
}

// a bounded buffer of COPY rows, flushed in chunks (keeps a bounded amount in
// memory while the DEM + grids live on)
const lineBuf = []
const FLUSH = 200_000
async function flush() {
  if (!lineBuf.length) return
  await send(lineBuf.join('\n') + '\n')
  lineBuf.length = 0
}

const t0 = Date.now()
try {
  await send(header)
  for (const b of bodies) {
    const grid = b.__grid
    const bid = b.id
    const isEarth = b.__tf.kind === 'earth'
    const tf = b.__tf
    const rows = grid.rows
    const logEvery = Math.max(1, Math.floor(rows / 24))
    for (let r = 0; r < rows; r++) {
      const lat = grid.lats[r] // radians, constant for the row
      const latDeg = (lat * 180) / Math.PI
      const cosLat = Math.cos(lat)
      const sinLat = Math.sin(lat)
      const latStr = latDeg.toFixed(5)
      const cols = grid.cols[r]
      const latStep = (2 * Math.PI) / cols
      if (isEarth) {
        // Earth: the DEM sample at the hex (meters → world units) + earthHex
        // color rules (the document's own).
        const demRow = Math.max(0, Math.min(demH - 1, Math.round((90 - latDeg) * 60)))
        const demBase = demRow * demW
        const step = step21600 / cols // DEM-col advance per hex (≈2.6 px/hex)
        for (let c = 0; c < cols; c++) {
          const lon = (c + 0.5) * latStep - Math.PI
          const lonDeg = (lon * 180) / Math.PI
          let demCol = Math.round((c + 0.5) * step)
          if (demCol < 0) demCol = 0
          else if (demCol > demW - 1) demCol = demW - 1
          const meters = demData[demBase + demCol]
          const { t, c: color } = earthHex(latDeg, lonDeg, meters, [cosLat * Math.cos(lon), sinLat, -cosLat * Math.sin(lon)], b.seed)
          const mid = matId.get(t)
          if (mid == null) throw new Error(`material key "${t}" not resolved (should have been checked pre-flight)`)
          lineBuf.push(`${bid}\t${r}\t${c}\t${latStr}\t${lonDeg.toFixed(5)}\t${(meters / SCALE)}\t${mid}\t${color}`)
        }
      } else {
        // procedural: the shared per-hex fn at the fine-grid centers (the SAME
        // fn the document was built with — they agree by construction).
        const fn = tf.fn
        const km = tf.unit === 'km'
        for (let c = 0; c < cols; c++) {
          const lon = (c + 0.5) * latStep - Math.PI
          const cosLon = Math.cos(lon)
          const sinLon = Math.sin(lon)
          const dir = [cosLat * cosLon, sinLat, -cosLat * sinLon]
          const res = fn(dir, latDeg, (lon * 180) / Math.PI)
          const mid = matId.get(res.t)
          if (mid == null) throw new Error(`material key "${res.t}" not resolved (should have been checked pre-flight)`)
          const height = km ? (res.h * 1000) / SCALE : res.h
          lineBuf.push(`${bid}\t${r}\t${c}\t${latStr}\t${((lon * 180) / Math.PI).toFixed(5)}\t${height}\t${mid}\t${res.c}`)
        }
      }
      if (lineBuf.length >= FLUSH) await flush()
      if ((r + 1) % logEvery === 0)
        console.error(`  ${b.name}: row ${r + 1}/${rows} (${(((r + 1) / rows) * 100).toFixed(0)}%) — ${((Date.now() - t0) / 1000).toFixed(0)}s`)
    }
    await flush()
    console.error(`  ${b.name}: all ${grid.total.toLocaleString('en-US')} hexes emitted`)
  }
  await flush()
  await send(footer)
  psql.stdin.end()
  const [code] = await once(psql, 'exit')
  if (code !== 0) throw new Error(errBuf.trim() || `psql exited ${code}`)
} catch (err) {
  psql.kill()
  console.error(`✗ ${err.message}`)
  if (errBuf.trim()) console.error('psql said:\n' + errBuf.trim())
  process.exit(1)
}

console.error(`\n✓ high-res imported into world ${worldId} ("${worldName}"): ${totalExpected.toLocaleString('en-US')} hexcells in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.error('  the app renders these (GET /api/bodies/:id/hex/…) — the DEM catalog is only the generation source')
