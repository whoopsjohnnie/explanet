/**
 * hexlattice.js — the stored high-res grid (docs/terrain2.txt, Level F).
 * ---------------------------------------------------------------------------
 * The high-resolution surface is STORED in the world (the `hexcells` table),
 * keyed by POSITION. This module is the PURE MACHINERY of that grid —
 * framework-free (no three, no DOM) so node tests and the geometry worker
 * import it unmodified, exactly like the rest of core/.
 *
 * THE LATTICE — a latitude-row hex grid (NOT the gnomonic two-patch lattice)
 *
 *   The gnomonic lattice (fineTerrain.js) is a LOCAL tool: its tangent plane
 *   stretches without bound toward the patch horizon, so it cannot tile a whole
 *   sphere (the equator is the plane's infinity). The stored high-res needs a
 *   GLOBAL, area-uniform, position-addressable tiling, so it is a grid of
 *   latitude rows:
 *
 *     * rows run from the north pole to the south pole, spaced by the hex's
 *       vertical extent (1.5·a in arc, a = the hex edge in meters);
 *     * row i sits at latitude lat_i = π/2 − (i + ½)·dLat (its CENTER, half a
 *       row below the pole for row 0);
 *     * row i holds just enough columns to span the latitude circle at the
 *       hex's physical width √3·a: cols_i = round(2πR·cos(lat_i) / (√3·a)).
 *
 *   Every hex therefore has the SAME physical edge `a` (world-uniform — R1),
 *   the count is area-uniform (≈ 4πR²/hexArea — unbounded, R2/R7), and the grid
 *   is addressable by (lat_row, lon_col) with a derived (lat, lon) — the
 *   positional key the brief requires (never a global sequential index). A
 *   lat/lon TILE (a lat_row × lon_col rectangle) is the streaming unit, the
 *   same shape as the DEM tiles in the `terrain` table.
 *
 *   The RENDERER samples a stored hex by NEAREST POINT (exactly as it samples
 *   the DEM today — fineTerrain.js demElevationAt): the gnomonic cap's fine
 *   hexes read the stored hex under them. nearestCell() is that lookup.
 *
 * Coordinate convention (MUST match scripts/sol-real/terrain.js + fineTerrain.js):
 *   the body-local frame is right-handed with north = +y, so (lat, lon) sits at
 *       dir = (cos lat·cos lon, sin lat, -cos lat·sin lon)
 *   (the minus on z makes east run counterclockwise from the north pole).
 */

const SQRT3 = Math.sqrt(3)
const DEG = Math.PI / 180

/** Area of one regular hex of edge `a` (meters²). */
export function hexArea(a) {
  return (3 * SQRT3 / 2) * a * a
}

/** The expected high-res cell count for a body: 4πR²/hexArea (area-uniform). */
export function expectedCellCount(radiusM, hexMeters) {
  return (4 * Math.PI * radiusM * radiusM) / hexArea(hexMeters)
}

// ---------------------------------------------------------------------------
// The grid parameters (memoized per (radiusM, hexMeters))
// ---------------------------------------------------------------------------
const gridCache = new Map()

/**
 * Build (or fetch) the latitude-row grid for a body.
 * @param {number} radiusM   the body's true radius in METERS
 * @param {number} hexMeters the hex edge in METERS (worlds.hex_meters)
 * @returns {{radiusM:number, a:number, dLat:number, rows:number,
 *            lats:Float64Array, cols:Int32Array, total:number}}
 *   `lats[i]` is row i's center latitude (radians); `cols[i]` is row i's column
 *   count; `total` is the cell count.
 */
export function highResGrid(radiusM, hexMeters) {
  const key = radiusM + '|' + hexMeters
  const hit = gridCache.get(key)
  if (hit) return hit

  const a = hexMeters
  const dLat = (1.5 * a) / radiusM // row spacing (radians)
  const rows = Math.max(1, Math.round(Math.PI / dLat))
  const lats = new Float64Array(rows)
  const cols = new Int32Array(rows)
  let total = 0
  for (let i = 0; i < rows; i++) {
    let lat = Math.PI / 2 - (i + 0.5) * dLat
    // keep the polar rows strictly inside the poles (cos stays positive)
    if (lat > Math.PI / 2 - 1e-9) lat = Math.PI / 2 - 1e-9
    if (lat < -Math.PI / 2 + 1e-9) lat = -Math.PI / 2 + 1e-9
    lats[i] = lat
    const circumference = 2 * Math.PI * radiusM * Math.cos(lat)
    cols[i] = Math.max(1, Math.round(circumference / (SQRT3 * a)))
    total += cols[i]
  }
  const grid = { radiusM, a, dLat, rows, lats, cols, total }
  gridCache.set(key, grid)
  return grid
}

/** The total cell count of a grid. */
export function gridCellCount(grid) {
  return grid.total
}

// ---------------------------------------------------------------------------
// Cell (row, col) -> position (lat, lon, direction)
// ---------------------------------------------------------------------------

/** The center latitude (radians) of row `row`. */
export function rowLat(grid, row) {
  return grid.lats[row]
}

/** The center longitude (radians) of cell (row, col). */
export function colLon(grid, row, col) {
  const c = grid.cols[row]
  return (col + 0.5) * (2 * Math.PI / c) - Math.PI
}

/** { lat, lon } in RADIANS for cell (row, col). */
export function cellLatLon(grid, row, col) {
  return { lat: grid.lats[row], lon: colLon(grid, row, col) }
}

/** { latDeg, lonDeg } in DEGREES for cell (row, col) — the stored positioning. */
export function cellLatLonDeg(grid, row, col) {
  const { lat, lon } = cellLatLon(grid, row, col)
  return { latDeg: lat / DEG, lonDeg: lon / DEG }
}

/**
 * The body-local unit direction of cell (row, col) — the terrain.js handedness
 * (north = +y, east counterclockwise from the north pole).
 * @returns {number[]} [x, y, z]
 */
export function cellDir(grid, row, col) {
  const { lat, lon } = cellLatLon(grid, row, col)
  const cl = Math.cos(lat)
  return [cl * Math.cos(lon), Math.sin(lat), -cl * Math.sin(lon)]
}

// ---------------------------------------------------------------------------
// Position (lat, lon / direction) -> nearest cell   (the renderer's sample)
// ---------------------------------------------------------------------------

/** The row whose center latitude is nearest to `latRad`. */
export function rowForLat(grid, latRad) {
  // rows are uniform in latitude: row 0 center at π/2 − ½·dLat, spacing dLat
  let i = Math.round((Math.PI / 2 - latRad) / grid.dLat - 0.5)
  if (i < 0) i = 0
  if (i > grid.rows - 1) i = grid.rows - 1
  return i
}

/** The column in row `row` whose center longitude is nearest to `lonRad`. */
export function colForLon(grid, row, lonRad) {
  const c = grid.cols[row]
  let j = Math.round((lonRad + Math.PI) / (2 * Math.PI / c) - 0.5)
  if (j < 0) j = 0
  if (j > c - 1) j = c - 1
  return j
}

/**
 * The cell (row, col) whose center is nearest to the body-local unit `dir`
 * (the nearest-point sample the renderer uses). O(1): dir -> lat/lon, two
 * roundings, clamps.
 * @returns {{row:number, col:number}}
 */
export function nearestCell(grid, dir) {
  const lat = Math.asin(Math.max(-1, Math.min(1, dir[1])))
  const lon = Math.atan2(-dir[2], dir[0])
  return { row: rowForLat(grid, lat), col: colForLon(grid, rowForLat(grid, lat), lon) }
}

/**
 * The cell (row, col) nearest to (latDeg, lonDeg) in DEGREES — for callers that
 * already have geographic coordinates (the generator, the tile endpoint).
 * @returns {{row:number, col:number}}
 */
export function cellForLatLon(grid, latDeg, lonDeg) {
  return nearestCell(grid, [
    Math.cos(latDeg * DEG) * Math.cos(lonDeg * DEG),
    Math.sin(latDeg * DEG),
    -Math.cos(latDeg * DEG) * Math.sin(lonDeg * DEG),
  ])
}

// ---------------------------------------------------------------------------
// Tiles — the streaming unit (a lat_row × lon_col rectangle)
// ---------------------------------------------------------------------------

/**
 * The (row, col) ranges covering a lat/lon RECTANGLE: lat ∈ [lat0, lat1],
 * lon ∈ [lon0, lon1] (degrees, lat0 < lat1). The generator and the tile
 * endpoint use this to enumerate a tile's cells. lon wraps at ±180.
 * @returns {{row0:number, row1:number, col0:number, col1:number}} (inclusive)
 */
export function tileRange(grid, lat0Deg, lat1Deg, lon0Deg, lon1Deg) {
  let r0 = rowForLat(grid, lat1Deg * DEG) // larger lat = smaller row index
  let r1 = rowForLat(grid, lat0Deg * DEG)
  if (r0 > r1) {
    const t = r0
    r0 = r1
    r1 = t
  }
  // longitude: each row has its own column count; report the min/max col index
  // that overlaps [lon0, lon1] across the row band (the caller iterates per row)
  const c = grid.cols[r0]
  const toIdx = (lonDeg) => {
    let j = Math.floor((lonDeg + 180) / (360 / c))
    if (j < 0) j = 0
    if (j > c - 1) j = c - 1
    return j
  }
  return { row0: r0, row1: r1, col0: Math.min(toIdx(lon0Deg), toIdx(lon1Deg)), col1: Math.max(toIdx(lon0Deg), toIdx(lon1Deg)) }
}
