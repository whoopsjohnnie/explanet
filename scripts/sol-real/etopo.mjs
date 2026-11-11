/**
 * etopo.mjs — reader for the ETOPO2022 60s global grid in its pipeline form.
 *
 * Seed file: scripts/sol-real/data/etopo2022-60s.f32 — a plain row-major
 * float32 grid, 21600 × 10800 values (933,120,000 bytes), produced once
 * from NOAA's ETOPO2022 60s GeoTIFF by scripts/sol-real/fetch-terrain.mjs.
 * (PIL is the reference decoder; the NOAA file's internal tile layout is
 * non-standard and is deliberately NOT re-decoded here — the .f32 IS the
 * pipeline, read with trivial indexing.)
 *
 * Grid: 1 px = 1 arc-minute; row 0 = 90 N, col 0 = 180 W. Values are METERS
 * above/below sea level: land elevation AND seafloor depth (negative),
 * ice-sheet surface included. Sea level is exactly 0 — the same convention
 * this world's `h` field uses (negative h = depth).
 */

const W = 21600
const H = 10800

/**
 * Load the grid from a node Buffer (readSeedBinary) or ArrayBuffer.
 * Returns { W, H, data: Float32Array }.
 */
export function loadEtopo(buf) {
  const bytes = buf.buffer ? buf.byteLength : buf.length
  if (bytes !== W * H * 4)
    throw new Error(`ETOP2022 grid: ${bytes} bytes, expected ${W * H * 4} (21600 × 10800 float32)`)
  return { W, H, data: new Float32Array(buf.buffer ?? buf, buf.byteOffset || 0, W * H) }
}

/**
 * Elevation in meters at a lat/lon (degrees), clamped to the grid.
 */
export function sampleAt(geo, latDeg, lonDeg) {
  let row = Math.round((90 - latDeg) * 60)
  let col = Math.round((lonDeg + 180) * 60)
  if (row < 0) row = 0
  else if (row >= H) row = H - 1
  if (col < 0) col = 0
  else if (col >= W) col = W - 1
  return geo.data[row * W + col]
}

/**
 * Per-geo trig tables: cos/sin of every pixel-center latitude and longitude,
 * so a per-hex pixel scan does zero transcendentals inside the inner loop.
 * (Memoized per grid identity.)
 */
const _trig = new WeakMap()
export function trigTables(geo) {
  let t = _trig.get(geo)
  if (!t) {
    const clat = new Float64Array(H)
    const slat = new Float64Array(H)
    for (let r = 0; r < H; r++) {
      const lat = ((90 - (r + 0.5) / 60) * Math.PI) / 180
      clat[r] = Math.cos(lat)
      slat[r] = Math.sin(lat)
    }
    const clon = new Float64Array(W)
    const slon = new Float64Array(W)
    for (let c = 0; c < W; c++) {
      const lon = (((c + 0.5) / 60 - 180) * Math.PI) / 180
      clon[c] = Math.cos(lon)
      slon[c] = Math.sin(lon)
    }
    t = { clat, slat, clon, slon }
    _trig.set(geo, t)
  }
  return t
}
