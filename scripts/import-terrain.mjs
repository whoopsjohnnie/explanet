#!/usr/bin/env node
/**
 * import-terrain.mjs — load the ETOPO2022 60s DEM into the terrain table.
 *
 * Reads the ETOPO2022 60s global grid (seed file, kept in S3 —
 * scripts/sol-real/data/etopo2022-60s.f32 after fetching — public domain;
 * 21,600 (lon) × 10,800 (lat) float32 values, land elevation AND seafloor
 * depth in METERS, sea level 0) and tiles it into `terrain`
 * (db/migrations/010-terrain.sql): one row per 2°×2° tile, the tile's
 * 120×120 elevations as SIGNED INT16 at 1 m steps (value = round(m),
 * little-endian, row-major north-first / west-first).
 *
 * The DEM is reference data, not world content: one transaction that replaces
 * ALL tiles of one catalog (idempotent — re-running refreshes in place, unlike
 * world imports which append a new world). A DO block re-checks the landed
 * tile count AND that every payload is exactly (tile_size/pixel_deg)² int16
 * values before COMMIT.
 *
 * The COPY rows are STREAMED to psql (one tile's ~28.8 KB of hex at a time) —
 * the whole 467 MB hex payload is never held in memory. The 933 MB source grid
 * is read once and sliced row-band by row-band (each 120-row lat-tile is
 * contiguous in the file, so every source row is read exactly once).
 *
 * Usage:
 *   node scripts/import-terrain.mjs [path/to/etopo2022-60s.f32]
 *
 * Requires psql on PATH; connection via standard libpq env vars / ~/.pgpass.
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { lookupPgpass } from '../server/db.mjs'
import { loadEtopo } from './sol-real/etopo.mjs'

// env vars REQUIRED (no infrastructure names in this repo — see DATA.md)
for (const k of ['PGHOST', 'PGDATABASE', 'PGUSER'])
  if (!process.env[k]) {
    console.error(`import-terrain: ${k} is required — set your world-database connection env vars (see README / DATA.md)`)
    process.exit(1)
  }
process.env.PGPORT ||= '5432'
if (!process.env.PGPASSWORD)
  process.env.PGPASSWORD =
    lookupPgpass(process.env.PGHOST, Number(process.env.PGPORT), process.env.PGDATABASE, process.env.PGUSER) || ''

const CATALOG = 'ETOP2022-60s'
const src = process.argv[2] || 'scripts/sol-real/data/etopo2022-60s.f32'

// tile geometry — derived from the DEM, not magic: 2°×2° tiles of 60 px/deg.
const TILE_DEG = 2
const PX_PER_DEG = 60
const TILE_PX = TILE_DEG * PX_PER_DEG  // 120 px per tile side

let buf
try {
  buf = readFileSync(src)
} catch {
  console.error(`\nSeed file not found: ${src}`)
  console.error('Seed data is not part of this repo — see DATA.md.')
  console.error('For this seed: scripts/sol-real/data/etopo2022-60s.f32 (NOAA ETOPO2022 60s; regenerate with scripts/sol-real/fetch-terrain.mjs).')
  process.exit(1)
}
const { W, H, data } = loadEtopo(buf)

// the grid is 60 px per degree in both axes by construction (21,600 over 360°,
// 10,800 over 180°); tile_size is whole degrees, so pixel_deg = 1/60.
if (W !== 360 * PX_PER_DEG || H !== 180 * PX_PER_DEG) {
  console.error(`${src}: grid ${W}×${H} is not the expected ${360 * PX_PER_DEG}×${180 * PX_PER_DEG} (60 px/deg) — refusing`)
  process.exit(1)
}
const PIXEL_DEG = 1 / PX_PER_DEG  // 1 arc-minute

// SW-corner lattice: tile_lat ∈ {88, 86, …, −90} (90), tile_lon ∈
// {178, 176, …, −180} (180) → 16,200 tiles.
const latTiles = []
for (let lat = 90 - TILE_DEG; lat >= -90; lat -= TILE_DEG) latTiles.push(lat)
const lonTiles = []
for (let lon = 180 - TILE_DEG; lon >= -180; lon -= TILE_DEG) lonTiles.push(lon)
const EXPECTED = latTiles.length * lonTiles.length   // 90 × 180 = 16,200
const PAYLOAD_BYTES = TILE_PX * TILE_PX * 2          // 14,400 px × 2 B = 28,800

console.error(
  `importing ${src}: ${EXPECTED} tiles (${latTiles.length} lat × ${lonTiles.length} lon) of ` +
  `${TILE_PX}×${TILE_PX} int16 as catalog '${CATALOG}' → $PGDATABASE`
)

// ---------------------------------------------------------------------------
// psql stream (server-side COPY FROM stdin): the header, then each tile row as
// int16 LE hex, then the "\." terminator + verification DO block + COMMIT.
// ---------------------------------------------------------------------------
const header = `BEGIN;
SET LOCAL search_path = explanet;
SET LOCAL client_min_messages = warning;
SET LOCAL statement_timeout = 0;

-- one transaction: replace this catalog's tiles in place (idempotent). The
-- payload is COPY'd as PLAIN HEX TEXT (no backslashes → no COPY text-format
-- bytea escape/encoding traps) and turned into bytea with decode(..., 'hex').
CREATE TEMP TABLE st_terrain (
  catalog text, tile_lat int, tile_lon int, tile_size int,
  pixel_deg double precision, payload_hex text
) ON COMMIT DROP;

COPY st_terrain (catalog, tile_lat, tile_lon, tile_size, pixel_deg, payload_hex) FROM stdin;
`

const footer = `\\.

-- move the staged tiles into the real table, decoding hex → bytea
DELETE FROM terrain WHERE catalog = '${CATALOG}';
INSERT INTO terrain (catalog, tile_lat, tile_lon, tile_size, pixel_deg, payload)
  SELECT catalog, tile_lat, tile_lon, tile_size, pixel_deg, decode(payload_hex, 'hex')
  FROM st_terrain;

-- every tile must have landed, each with exactly (tile_size/pixel_deg)² int16
DO $do$
DECLARE n bigint; bad bigint;
BEGIN
  SELECT count(*) INTO n FROM terrain WHERE catalog = '${CATALOG}';
  IF n <> ${EXPECTED} THEN
    RAISE EXCEPTION 'import aborted: catalog % has % tiles, expected %', '${CATALOG}', n, ${EXPECTED};
  END IF;
  SELECT count(*) INTO bad FROM terrain WHERE catalog = '${CATALOG}'
    AND octet_length(payload) <> ${PAYLOAD_BYTES};
  IF bad > 0 THEN
    RAISE EXCEPTION 'import aborted: % tile(s) in catalog % have a payload of the wrong size (want % bytes)', bad, '${CATALOG}', ${PAYLOAD_BYTES};
  END IF;
END
$do$;

COMMIT;
`

const psql = spawn('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] })
let errBuf = ''
psql.stderr.on('data', (d) => (errBuf += d))
psql.stdout.resume()
// a failed psql closes stdin mid-stream; swallow the EPIPE and let the exit
// handler report psql's own message instead of crashing the script
psql.stdin.on('error', () => {})

async function send(chunk) {
  if (psql.stdin.writableNeedDrain) await once(psql.stdin, 'drain')
  psql.stdin.write(chunk)
}

const tile = new Int16Array(TILE_PX * TILE_PX)  // reused across tiles
const t0 = Date.now()
try {
  await send(header)
  // row-band by row-band: each lat-tile is 120 contiguous rows, and within it
  // the 180 lon-tiles slice those rows — so every source row is read once.
  for (let i = 0; i < latTiles.length; i++) {
    const tileLat = latTiles[i]
    const topRow = (90 - (tileLat + TILE_DEG)) * PX_PER_DEG
    for (let j = 0; j < lonTiles.length; j++) {
      const tileLon = lonTiles[j]
      const leftCol = (tileLon + 180) * PX_PER_DEG
      for (let r = 0; r < TILE_PX; r++) {
        const rowOff = (topRow + r) * W + leftCol
        for (let c = 0; c < TILE_PX; c++)
          tile[r * TILE_PX + c] = Math.round(data[rowOff + c])
      }
      // toString('hex') copies the bytes into a fresh string, so `tile` may be
      // reused while send() is still draining. Plain hex text (no \x) — safe as
      // a COPY text field and decoded to bytea in the footer's INSERT.
      const hex = Buffer.from(tile.buffer).toString('hex')
      await send(`${CATALOG}\t${tileLat}\t${tileLon}\t${TILE_DEG}\t${PIXEL_DEG}\t${hex}\n`)
    }
    if (i % 10 === 0)
      console.error(`  ${i + 1}/${latTiles.length} lat bands (${((i + 1) / latTiles.length * 100).toFixed(0)}%)`)
  }
  await send(footer)
  psql.stdin.end()
  const [code] = await once(psql, 'exit')
  if (code !== 0) throw new Error(errBuf.trim() || `psql exited ${code}`)
} catch (err) {
  psql.kill()
  console.error(`✗ ${err.message}`)
  process.exit(1)
}

console.error(`✓ catalog ${CATALOG}: ${EXPECTED} tiles in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
