#!/usr/bin/env node
/**
 * import-hexcells.mjs — generate + COPY the STORED high-res hexes (docs/terrain2.txt).
 * ---------------------------------------------------------------------------
 * This is the generation side of the inverted terrain model: it reads the
 * world document (for the world-level `hex_meters`, the per-body `highres`
 * opt-in, each body's radius, scale and seed) and the DEM catalog (the
 * ETOPO2022 60s seed file — the SAME source the document was built from, so
 * the document and the high-res share one datum), walks each highres body's
 * latitude-row grid (core/hexlattice.js), and EMITS one `hexcells` row per
 * stored hex:
 *
 *   (body_id, lat_row, lon_col)   the positional key (docs/terrain2.txt §5)
 *   lat, lon                      derived, stored for stream order (a pin, never
 *                                 authoritative over the lattice key)
 *   height                        the DEM sample at the hex, meters → world
 *                                 units (÷ world.scale) — the SAME datum the
 *                                 document uses
 *   material_id, color            the document's own color rules, shared via
 *                                 earthHex (a coastline hex is land or sea, not
 *                                 a blend)
 *
 * The rows are STREAMED to psql via COPY FROM stdin (one row at a time — the
 * tens of millions of rows are never held in memory, and never touch a JSON
 * world file: large worlds are DB-only). The COPY runs in ONE transaction that
 * first DELETEs the target bodies' existing hexcells (idempotent — a re-run
 * refreshes in place) and, before COMMIT, a DO block re-checks that the
 * landed row count equals the grid's exact cell count (a truncated stream
 * aborts the whole import).
 *
 * The hexes are the STORED SURFACE the app renders from. The DEM (`terrain`
 * table / this seed file) is only the GENERATION source — the rendered data
 * source is `hexcells` (docs/terrain2.txt §5.4), never the catalog.
 *
 * Usage (run AFTER import-db.mjs created the world row + bodies):
 *   PGHOST=... PGDATABASE=... PGUSER=... \
 *     node scripts/import-hexcells.mjs [world.json] [etopo2022-60s.f32]
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { lookupPgpass } from '../server/db.mjs'
import { loadEtopo } from './sol-real/etopo.mjs'
import { highResGrid } from '../src/core/hexlattice.js'
import { earthHex } from './sol-real/terrain.js'

// env vars REQUIRED (no infrastructure names in this repo — see DATA.md)
for (const k of ['PGHOST', 'PGDATABASE', 'PGUSER'])
  if (!process.env[k]) {
    console.error(`import-hexcells: ${k} is required — set your world-database connection env vars (see README / DATA.md)`)
    process.exit(1)
  }
process.env.PGPORT ||= '5432'
if (!process.env.PGPASSWORD)
  process.env.PGPASSWORD = lookupPgpass(process.env.PGHOST, Number(process.env.PGPORT), process.env.PGDATABASE, process.env.PGUSER) || ''

const docPath = process.argv[2] || 'public/sol-real.json'
const demPath = process.argv[3] || 'scripts/sol-real/data/etopo2022-60s.f32'
const qstr = (v) => `'${String(v).replace(/'/g, "''")}'`

// ---------------------------------------------------------------------------
// World document → the high-res bodies (position + grid parameters)
// ---------------------------------------------------------------------------
let world
try {
  world = JSON.parse(readFileSync(docPath, 'utf8'))
} catch (e) {
  console.error(`\nworld document not found: ${docPath}\n${e.message}`)
  console.error('Generate it first: node scripts/gen-sol-real.mjs --hex-meters 1850 --highres earth --out ../public/sol-real.json')
  process.exit(1)
}
if (!Number.isFinite(Number(world.hex_meters))) {
  console.error(`${docPath}: no hex_meters — generate with --hex-meters <m> (docs/terrain2.txt §4)`)
  process.exit(1)
}
const HEX_M = Number(world.hex_meters) // stored hex edge, METERS (world-uniform, R1)
const SCALE = Number(world.scale) // meters per world unit (height datum)
if (!Number.isFinite(SCALE) || !(SCALE > 0)) {
  console.error(`${docPath}: world has no valid scale (meters per unit) — required for the height datum`)
  process.exit(1)
}

const highresBodies = world.planets.filter((p) => p.highres)
if (!highresBodies.length) {
  console.error(`${docPath}: no highres bodies — generate with --highres <body>`)
  process.exit(1)
}

// build each highres body's grid (radius from its document frequency + scale)
let totalExpected = 0
for (const p of highresBodies) {
  const f = Math.round(Number(p.frequency) || 6)
  const bodyScale = Number(p.scale) || 1
  const cells = 10 * f * f + 2
  const radiusU = Math.sqrt(cells / (4 * Math.PI)) * bodyScale
  p.__radiusM = radiusU * SCALE
  p.__grid = highResGrid(p.__radiusM, HEX_M)
  p.__seed = Math.round(Number(p.seed) || 42)
  totalExpected += p.__grid.total
}

// the DEM (the generation source — same file the document was built from)
let dem
try {
  dem = loadEtopo(readFileSync(demPath))
} catch (e) {
  console.error(`\nDEM seed not found: ${demPath}`)
  console.error('Seed data is not part of this repo — see DATA.md.')
  console.error('For this seed: scripts/sol-real/data/etopo2022-60s.f32 (NOAA ETOPO2022 60s; regenerate with scripts/sol-real/fetch-terrain.mjs).')
  process.exit(1)
}
const { W, H, data } = dem

// the material keys the high-res will use are the document's own (earthHex
// shares the document's color rules) — confirm they all resolve first
const usedKeys = new Set()
for (const p of highresBodies) for (const e of p.elements || []) if (e.t) usedKeys.add(e.t)

// ---------------------------------------------------------------------------
// Resolve the world + body + material ids (the world import must have run)
// ---------------------------------------------------------------------------
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

// the world is the NEWEST row with the document's name (import-db appends one)
const nameRows = await query(`SET search_path = explanet; SELECT id FROM worlds WHERE name = ${qstr(world.name ?? 'Untitled World')} ORDER BY id DESC LIMIT 1`)
if (!nameRows.length) {
  console.error(`no world named "${world.name}" in $PGDATABASE — import it first:\n  node scripts/import-db.mjs ${docPath}`)
  process.exit(1)
}
const worldId = Number(nameRows[0])

const docIds = highresBodies.map((p) => String(p.id ?? ''))
const idRows = await query(
  `SET search_path = explanet; SELECT doc_id, id FROM bodies WHERE world_id = ${worldId} AND doc_id IN (${docIds.map(qstr).join(',')})`
)
const bodyId = new Map()
for (const r of idRows) {
  const tab = r.indexOf('\t')
  if (tab < 0) continue
  bodyId.set(r.slice(0, tab), Number(r.slice(tab + 1)))
}
for (const p of highresBodies) {
  if (!bodyId.has(String(p.id))) {
    console.error(`highres body "${p.name}" (doc_id "${p.id}") not found in world ${worldId} — import the world first`)
    process.exit(1)
  }
}

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

console.error(
  `importing high-res for world ${worldId} ("${world.name}"): hex_meters=${HEX_M}m, scale=${SCALE} m/u`
)
for (const p of highresBodies)
  console.error(`  ${p.name} (body ${bodyId.get(p.id)}): radius ${p.__radiusM.toFixed(1)} m → ${p.__grid.total.toLocaleString('en-US')} hexes`)

// ---------------------------------------------------------------------------
// COPY stream: header (one transaction: delete-then-copy), the rows, then the
// "\." terminator + a count-verification DO block + COMMIT.
// ---------------------------------------------------------------------------
const bodyIds = highresBodies.map((p) => bodyId.get(p.id))
const header = `BEGIN;
SET LOCAL search_path = explanet;
SET LOCAL client_min_messages = warning;
SET LOCAL statement_timeout = 0;

-- one transaction: replace the high-res rows of the target bodies in place
-- (idempotent), then COPY the fresh generation.
DELETE FROM hexcells WHERE body_id IN (${bodyIds.join(',')});

COPY hexcells (body_id, lat_row, lon_col, lat, lon, height, material_id, color) FROM stdin;
`

const footer = `\\.

-- every high-res row must have landed: the grid is walked exactly once, so the
-- count is the sum of the grid totals (a truncated stream aborts the import)
DO $do$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM hexcells WHERE body_id IN (${bodyIds.join(',')});
  IF n <> ${totalExpected} THEN
    RAISE EXCEPTION 'import aborted: % high-res rows landed, expected %', n, ${totalExpected};
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
// memory while the DEM + grid live on)
const lineBuf = []
const FLUSH = 200_000
async function flush() {
  if (!lineBuf.length) return
  await send(lineBuf.join('\n') + '\n')
  lineBuf.length = 0
}

const t0 = Date.now()
const step21600 = 21600 // (2π in degrees = 360) × 60 px/deg — the DEM's lon span
try {
  await send(header)
  for (const p of highresBodies) {
    const grid = p.__grid
    const bid = bodyId.get(p.id)
    const seed = p.__seed
    const rows = grid.rows
    const logEvery = Math.max(1, Math.floor(rows / 24))
    for (let r = 0; r < rows; r++) {
      const lat = grid.lats[r] // radians, constant for the row
      const latDeg = (lat * 180) / Math.PI
      const cosLat = Math.cos(lat)
      const sinLat = Math.sin(lat)
      const demRow = Math.max(0, Math.min(H - 1, Math.round((90 - latDeg) * 60)))
      const demBase = demRow * W
      const latStr = latDeg.toFixed(5)
      const cols = grid.cols[r]
      const step = step21600 / cols // DEM-col advance per hex (≈2.6 px/hex)
      for (let c = 0; c < cols; c++) {
        const lon = (c + 0.5) * ((2 * Math.PI) / cols) - Math.PI
        const lonDeg = (lon * 180) / Math.PI
        let demCol = Math.round((c + 0.5) * step)
        if (demCol < 0) demCol = 0
        else if (demCol > W - 1) demCol = W - 1
        const meters = data[demBase + demCol]
        const { t, c: color } = earthHex(latDeg, lonDeg, meters, [cosLat * Math.cos(lon), sinLat, -cosLat * Math.sin(lon)], seed)
        const mid = matId.get(t)
        if (mid == null) throw new Error(`material key "${t}" not resolved (should have been checked pre-flight)`)
        lineBuf.push(`${bid}\t${r}\t${c}\t${latStr}\t${lonDeg.toFixed(5)}\t${(meters / SCALE).toFixed(6)}\t${mid}\t${color}`)
      }
      await flush()
      if ((r + 1) % logEvery === 0)
        console.error(`  ${p.name}: row ${r + 1}/${rows} (${(((r + 1) / rows) * 100).toFixed(0)}%) — ${((Date.now() - t0) / 1000).toFixed(0)}s`)
    }
    console.error(`  ${p.name}: all ${grid.total.toLocaleString('en-US')} hexes emitted`)
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

console.error(`\n✓ high-res imported into world ${worldId}: ${totalExpected.toLocaleString('en-US')} hexcells in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.error('  the app renders these (GET /api/bodies/:id/hex/…) — the DEM catalog is only the generation source')
