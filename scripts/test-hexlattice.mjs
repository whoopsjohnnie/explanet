/**
 * test-hexlattice.mjs — headless tests for the stored high-res grid
 * (core/hexlattice.js): the latitude-row hex tiling of docs/terrain2.txt.
 * Verifies the area-uniform cell count (R2/R7), world-uniform hex size (R1),
 * full-sphere coverage with no gaps (the tiling is complete), the
 * nearest-point round-trip (the renderer's sample lookup), the per-row tile
 * selection (the /api/bodies/:id/hex/tile endpoint's SQL range), and the
 * app-side seam (fineTerrain.js §6.2: the derived storesHexCells rule, the
 * plane edge, the chunk side, and the nearest-stored-hex height lookup).
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
  rowLonRange,
} from '../src/core/hexlattice.js'
import { storesHexCells, hexLatticeEdge, hexChunkSide, hexHeightAt } from '../src/core/fineTerrain.js'

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

// ---------------------------------------------------------------------------
// 6. rowLonRange — the per-row column span (the tile endpoint's selection)
// ---------------------------------------------------------------------------
{
  const grid = highResGrid(EARTH_R, DEM_M)
  // brute force: cell j covers lon ∈ [j·360/c − 180, (j+1)·360/c − 180); the
  // row's selected columns must be EXACTLY the cells whose coverage
  // intersects [l0, l1] — per row (each row's column count differs).
  const rng = mulberry32(777)
  let tested = 0
  let ok = true
  for (let t = 0; t < 300 && ok; t++) {
    const row = Math.floor(rng() * grid.rows)
    const c = grid.cols[row]
    const spanDeg = 0.2 + rng() * 3
    const l1 = -180 + rng() * (360 - spanDeg)
    const l0 = l1 - spanDeg
    const span = rowLonRange(grid, row, l0, l1)
    const brute = []
    for (let j = 0; j < c; j++) {
      const cov0 = (j * 360) / c - 180
      const cov1 = ((j + 1) * 360) / c - 180
      if (cov1 > l0 && cov0 < l1) brute.push(j)
    }
    tested++
    if (!span && brute.length) ok = false
    else if (span && (span.j0 !== brute[0] || span.j1 !== brute[brute.length - 1] || brute.length !== span.j1 - span.j0 + 1)) ok = false
  }
  check(`rowLonRange: per-row span = EXACTLY the cells overlapping the lon range (${tested} rows × random ranges)`, ok)
}

// ---------------------------------------------------------------------------
// 7. The app-side seam (core/fineTerrain.js, docs/terrain2.txt §6.2)
// ---------------------------------------------------------------------------
{
  const world = { hex_meters: 1850, scale: 35181.6 }
  // the derived rule (no per-body flag): world hex_meters + a stored body
  check('storesHexCells: world hex_meters + a stored body (dbId) → true', storesHexCells({ dbId: 1 }, world) === true)
  check('storesHexCells: a GENERATED body is the exemption → false', storesHexCells({ dbId: 1, generated: true }, world) === false)
  check('storesHexCells: no dbId (a file world has no stream) → false', storesHexCells({ id: 'p-1' }, world) === false)
  check('storesHexCells: a world without hex_meters → false', storesHexCells({ dbId: 1 }, { scale: 1 }) === false)

  // the fine edge (plane units) and the chunk side (constant physical footprint)
  check('hexLatticeEdge: the fine edge = hexMeters / radiusM (plane units)', Math.abs(hexLatticeEdge(1850, EARTH_R) - 1850 / EARTH_R) < 1e-15)
  check(`hexChunkSide: ${hexChunkSide(118, 1850)} fine hexes per 118 km chunk side at 1.85 km (the §10.4 footprint)`, hexChunkSide(118, 1850) === 64)

  // hexHeightAt: the nearest stored hex, from a tile set (Map<row,{col0,h}>).
  // Full-sphere tile set: the lookup must equal the nearestCell height.
  const grid = highResGrid(EARTH_R, 1850)
  const H = (row, col) => (row * 7919 + col * 104729) % 997
  const full = new Map()
  for (let r = 0; r < grid.rows; r++) full.set(r, { col0: 0, h: Float64Array.from({ length: grid.cols[r] }, (_, c) => H(r, c)) })
  const rng = mulberry32(4242)
  let ok = 0
  const N = 5000
  for (let i = 0; i < N; i++) {
    const d = randUnit(rng)
    const { row, col } = nearestCell(grid, d)
    if (hexHeightAt(d, grid, full) === H(row, col)) ok++
  }
  check(`hexHeightAt: a full tile set returns the nearest stored hex (${ok}/${N})`, ok === N)

  // a partial tile: inside its [col0, col0+n) → the value; an absent row or a
  // col outside the span → null (the synthesis's document fallback).
  const partial = new Map([[500, { col0: 100, h: Float64Array.from({ length: 50 }, (_, c) => H(500, 100 + c)) }]])
  const probe = (row, col) => {
    for (let t = 0; t < 200; t++) {
      const d = cellDir(grid, row, col)
      const back = nearestCell(grid, d)
      if (back.row === row && back.col === col) return d
    }
    return null
  }
  const dIn = probe(500, 120)
  const dOutRow = probe(501, 120)
  const dOutCol = probe(500, 160)
  check('hexHeightAt: inside a partial tile span → the stored value', !!dIn && hexHeightAt(dIn, grid, partial) === H(500, 120))
  check('hexHeightAt: an absent row → null (the document fallback)', !!dOutRow && hexHeightAt(dOutRow, grid, partial) === null)
  check('hexHeightAt: a col outside the tile span → null', !!dOutCol && hexHeightAt(dOutCol, grid, partial) === null)
}

console.log(failures === 0 ? '\nAll hex-lattice checks passed.' : `\n${failures} hex-lattice check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
