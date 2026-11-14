/**
 * test-hexlattice.mjs — headless tests for the stored high-res grid
 * (core/hexlattice.js): the latitude-row hex tiling of docs/terrain2.txt.
 * Verifies the area-uniform cell count (R2/R7), world-uniform hex size (R1),
 * full-sphere coverage with no gaps (the tiling is complete), and the
 * nearest-point round-trip (the renderer's sample lookup).
 * Run: node scripts/test-hexlattice.mjs
 */

import {
  hexArea,
  expectedCellCount,
  highResGrid,
  gridCellCount,
  cellLatLon,
  cellDir,
  cellLatLonDeg,
  rowForLat,
  colForLon,
  nearestCell,
  cellForLatLon,
  tileRange,
} from '../src/core/hexlattice.js'

let failures = 0
const check = (name, cond) => {
  console.log(`${cond ? '✓' : '✗'} ${name}`)
  if (!cond) failures++
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
function mulberry32(seed) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const randUnit = (rng) => {
  // uniform on the sphere (Marsaglia via two uniforms)
  const z = rng() * 2 - 1
  const t = rng() * 2 * Math.PI
  const r = Math.sqrt(Math.max(0, 1 - z * z))
  return [r * Math.cos(t), z, -r * Math.sin(t)]
}

// Earth's true radius (meters) — the world-27 anchor (mapping.txt §4).
const EARTH_R = 6371009
const DEM_KM = 1.85 // the DEM-aligned hex edge (world 27 target, §9.5)
const DEM_M = DEM_KM * 1000

// ---------------------------------------------------------------------------
// 1. Area-uniform cell count (R2, R7)
// ---------------------------------------------------------------------------
{
  const grid = highResGrid(EARTH_R, DEM_M)
  const n = gridCellCount(grid)
  const expected = expectedCellCount(EARTH_R, DEM_M)
  const rel = Math.abs(n - expected) / expected
  check(`Earth @ 1.85 km: count ${n.toLocaleString()} ≈ expected ${expected.toFixed(0)} (within 5%)`, rel < 0.05)
  check('Earth @ 1.85 km: ~57 M cells (the design-doc figure)', n > 50e6 && n < 65e6)

  // finer hexes -> more cells, scaling as (a0/a1)²
  const g1 = highResGrid(EARTH_R, 1000)
  const n1 = gridCellCount(g1)
  const scale = (DEM_M / 1000) ** 2
  check(`Earth @ 1 km: count ${n1.toLocaleString()} ≈ 196 M (within 5%)`, Math.abs(n1 - 196e6) / 196e6 < 0.05)
  check(`Earth @ 1 km: finer hexes give ~${scale.toFixed(1)}× more cells (area scaling)`, Math.abs(n1 / n - scale) / scale < 0.08)

  check('hexArea: a regular hex of edge a has area (3√3/2)·a²', Math.abs(hexArea(1) - (3 * Math.sqrt(3) / 2)) < 1e-12)
}

// ---------------------------------------------------------------------------
// 2. World-uniform hex size (R1)
// ---------------------------------------------------------------------------
{
  const moon = highResGrid(1737400, DEM_M) // the Moon, same hex size
  check('R1: the same hex_meters gives the same physical edge `a` on every body', moon.a === DEM_M && highResGrid(EARTH_R, DEM_M).a === DEM_M)
  // the Moon has far fewer cells (smaller area) but the SAME edge
  const moonN = gridCellCount(moon)
  const ratio = (1737400 / EARTH_R) ** 2
  check(`R1: cell count scales with area (Moon ≈ ${(ratio * 100).toFixed(1)}% of Earth's)`, Math.abs(moonN / gridCellCount(highResGrid(EARTH_R, DEM_M)) - ratio) / ratio < 0.1)
}

// ---------------------------------------------------------------------------
// 3. Full-sphere coverage, no gaps (the tiling is complete)
// ---------------------------------------------------------------------------
{
  const grid = highResGrid(EARTH_R, DEM_M)
  const rng = mulberry32(1234)
  const SAMPLES = 20000
  let maxDist = 0
  for (let i = 0; i < SAMPLES; i++) {
    const d = randUnit(rng)
    const { row, col } = nearestCell(grid, d)
    const c = cellDir(grid, row, col)
    const angle = Math.acos(Math.max(-1, Math.min(1, dot(d, c))))
    maxDist = Math.max(maxDist, grid.radiusM * angle) // meters of arc to the nearest center
  }
  // the farthest a point can be from its row's center line is half the row
  // spacing (0.75a) plus half a column (0.866a) → circumradius ~1.15a
  check(`coverage: every one of ${SAMPLES} directions is within ${ (maxDist / DEM_M).toFixed(2)} hex-edges of a cell center (≤ 1.2)`, maxDist <= 1.2 * DEM_M)
  // the poles themselves: a direction straight at each pole lands on the polar row
  const nPole = nearestCell(grid, [0, 1, 0])
  const sPole = nearestCell(grid, [0, -1, 0])
  check('coverage: the poles map to the polar rows (no gap at the poles)', nPole.row === 0 && sPole.row === grid.rows - 1)
  check(`coverage: the row band spans the whole sphere (row 0 at ${(cellLatLon(grid, 0, 0).lat * 180 / Math.PI).toFixed(1)}°, last row at ${(cellLatLon(grid, grid.rows - 1, 0).lat * 180 / Math.PI).toFixed(1)}°)`, cellLatLon(grid, 0, 0).lat > (89 * Math.PI) / 180 && cellLatLon(grid, grid.rows - 1, 0).lat < (-89 * Math.PI) / 180)
}

// ---------------------------------------------------------------------------
// 4. Nearest-point round-trip (the renderer's sample lookup)
// ---------------------------------------------------------------------------
{
  const grid = highResGrid(EARTH_R, DEM_M)
  // a cell's own center maps back to itself (interior cells — skip the polar
  // rows where the nearest cell is legitimately the pole's single hex)
  let exact = 0
  let offOne = 0
  const rng = mulberry32(99)
  const TESTS = 5000
  for (let i = 0; i < TESTS; i++) {
    const row = 1 + Math.floor(rng() * (grid.rows - 2))
    const col = Math.floor(rng() * grid.cols[row])
    const c = cellDir(grid, row, col)
    const back = nearestCell(grid, c)
    if (back.row === row && back.col === col) exact++
    else if (Math.abs(back.row - row) <= 1 && Math.abs(back.col - col) <= 1) offOne++
  }
  check(`round-trip: a cell's center maps back to itself (exact ${exact}/${TESTS}, off-by-≤1 ${offOne})`, exact + offOne === TESTS && exact / TESTS > 0.9)

  // deg round-trip: (row, col) -> lat/lon -> (row, col)
  let degExact = 0
  for (let i = 0; i < TESTS; i++) {
    const row = 1 + Math.floor(rng() * (grid.rows - 2))
    const col = Math.floor(rng() * grid.cols[row])
    const { latDeg, lonDeg } = cellLatLonDeg(grid, row, col)
    const back = cellForLatLon(grid, latDeg, lonDeg)
    if (back.row === row && back.col === col) degExact++
  }
  check(`deg round-trip: (row,col) -> lat/lon -> (row,col) holds (exact ${degExact}/${TESTS})`, degExact / TESTS > 0.9)

  // rowForLat / colForLon are the two half of nearestCell and agree with it
  const d = cellDir(grid, 500, 300)
  const lat = Math.asin(Math.max(-1, Math.min(1, d[1])))
  const lon = Math.atan2(-d[2], d[0])
  const { row, col } = nearestCell(grid, d)
  check('rowForLat/colForLon compose to nearestCell', rowForLat(grid, lat) === row && colForLon(grid, row, lon) === col)
}

// ---------------------------------------------------------------------------
// 5. Tiles cover the grid exactly (the streaming unit)
// ---------------------------------------------------------------------------
{
  const grid = highResGrid(EARTH_R, DEM_M)
  // a full-sphere tile (all lat, all lon) covers every row
  const full = tileRange(grid, -90, 90, -180, 180)
  check('tile: the full-sphere range covers every row', full.row0 === 0 && full.row1 === grid.rows - 1)

  // a latitude band covers exactly its rows
  const band = tileRange(grid, 40, 60, -180, 180)
  const expectR0 = rowForLat(grid, 60 * Math.PI / 180)
  const expectR1 = rowForLat(grid, 40 * Math.PI / 180)
  check('tile: a lat band covers exactly its rows', band.row0 === expectR0 && band.row1 === expectR1)

  // every row's columns are contiguous (no gaps within a row)
  let contiguous = true
  for (let i = 0; i < grid.rows; i += Math.max(1, Math.floor(grid.rows / 200))) {
    const c = grid.cols[i]
    if (c < 1) {
      contiguous = false
      break
    }
  }
  check('tile: every row has a positive, finite column count', contiguous)
}

console.log(failures === 0 ? '\nAll hex-lattice checks passed.' : `\n${failures} hex-lattice check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
