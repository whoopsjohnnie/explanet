/**
 * fineTerrain.js — the Stage 2 fine-terrain synthesis (docs/terrain.txt §4).
 * ---------------------------------------------------------------------------
 * The fine layer's math, in one framework-free module (no three, no DOM) so
 * node tests and the geometry worker import it unmodified, exactly like the
 * rest of core/. Stage 1 (finedisc.js) built the MACHINERY at document
 * frequency (a visual no-op); this module supplies the REAL fine grid:
 *
 *   * the fine hex is the DEM PIXEL. Its edge `a` is the catalog's pixel size
 *     in radians (plane units) — a CATALOG property, not a dial — so the fine
 *     hex edge equals one DEM pixel and the height sample is the identity
 *     (no interpolation): a wall is the DEM's true pixel-to-pixel step.
 *   * the fine hexes form a regular pointy-top lattice in the gnomonic patch
 *     plane (finedisc.js), unprojected back onto the sphere as chord-triangle
 *     fans — the SAME rendered-surface rule the document mesh and the walker
 *     use (surface.js fanRadiusAt), at fine scale.
 *   * the height of a fine hex is a PURE function of three inputs (§4.2):
 *       h_final = w * h_dem + (1 - w) * h_doc(enclosing)
 *     where h_dem is the catalog pixel under the hex (meters → world units via
 *     the world scale — the same datum that built the document) and h_doc is
 *     the enclosing document cell's height; `w` is the feather (§4.3) that
 *     fades the fine layer to the document across the region's outer edge so
 *     the seam is invisible. DEM + document + (the §5 edit overlay) are the
 *     ONLY inputs — chunks are reproducible, evictable and worker-safe.
 *
 * Coordinate convention (MUST match scripts/sol-real/terrain.js, which built
 * the document from the same DEM): the body-local frame is right-handed with
 * north = +y, so a geographic point (lat, lon) sits at
 *     dir = (cos lat·cos lon, sin lat, -cos lat·sin lon)
 * (the minus on z makes east run counterclockwise from the north pole). The
 * inverse — dir → {lat, lon} — is lat = asin(y), lon = atan2(-z, x). Every
 * lat/lon ↔ direction conversion here agrees on that sign, or the fine relief
 * renders mirrored against the document.
 */

import { hexToPlane, planeToHex, dirFromPlane, projectToPlane } from './finedisc.js'
import { cellAtDirection } from './surface.js'
import { terrainDefaults } from './terrain.js'

const SQRT3 = Math.sqrt(3)
const DEG = Math.PI / 180

// Pointy-top hex: the six corners sit at 30°, 90°, …, 330° (circumradius a).
const CORNER_ANG = [30, 90, 150, 210, 270, 330].map((d) => d * DEG)
const CORNER_DX = CORNER_ANG.map((a) => Math.cos(a))
const CORNER_DY = CORNER_ANG.map((a) => Math.sin(a))

// The lattice neighbour across side k (between corner k and corner k+1). Side
// k's outward bisector points at the neighbour's center:
//   k0 60°  (0,+1)   k1 120°  (−1,+1)  k2 180°  (−1,0)
//   k3 240° (0,−1)   k4 300°  (+1,−1)  k5 0°    (+1,0)
export const SIDE_OFFSET = [
  [0, 1],
  [-1, 1],
  [-1, 0],
  [0, -1],
  [1, -1],
  [1, 0],
]

// ---------------------------------------------------------------------------
// tiny vec helpers (arrays of 3)
// ---------------------------------------------------------------------------
const subv = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dotv = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const crossv = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm3 = (a) => {
  const l = Math.sqrt(dotv(a, a)) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

// ---------------------------------------------------------------------------
// The fine hex size — a catalog property (the DEM pixel), not a dial
// ---------------------------------------------------------------------------

/** The fine hex edge in PLANE units (dimensionless) = the catalog pixel size in radians. */
export function fineLatticeEdge(pixelDeg) {
  return pixelDeg * DEG
}

/** The fine hex edge in KM, from the pixel size (deg) and the body radius (m). */
export function fineHexKm(pixelDeg, radiusM) {
  return pixelDeg * DEG * radiusM / 1000
}

/**
 * The fine-hex count per chunk side, from the physical chunk size (km) and the
 * fine hex size (km). Keeps a constant physical footprint (docs/terrain.txt
 * §10.4): 64 fine hexes at stage 2's 1.85 km.
 */
export function fineChunkSide(chunkKm, pixelDeg, radiusM) {
  const hexKm = fineHexKm(pixelDeg, radiusM)
  return Math.max(1, Math.round(chunkKm / hexKm))
}

// ---------------------------------------------------------------------------
// dir ↔ lat/lon (the terrain.js handedness — see the file header)
// ---------------------------------------------------------------------------

/** Body-local unit direction → { latDeg, lonDeg } (degrees). */
export function dirToLatLon(dir) {
  const lat = Math.asin(Math.max(-1, Math.min(1, dir[1])))
  const lon = Math.atan2(-dir[2], dir[0])
  return { latDeg: lat / DEG, lonDeg: lon / DEG }
}

// ---------------------------------------------------------------------------
// The DEM tile lattice + sampling
// ---------------------------------------------------------------------------
// A catalog is tiled into (tileSize × tileSize)-pixel squares keyed by their
// SOUTH-WEST corner in whole degrees: tile (tileLat, tileLon) covers
// lat ∈ [tileLat, tileLat + tileSize·pixelDeg], lon ∈ [tileLon, tileLon + …].
// The payload is row-major, NORTH-first (row 0 = the tile's top/north edge) and
// WEST-first (col 0 = the tile's left/west edge) — the layout
// scripts/import-terrain.mjs writes and the DB stores (int16 LE, meters).

/** The (tileLat, tileLon) SW-corner key of the tile containing (lat, lon). */
export function tileKeyFor(latDeg, lonDeg, tileSize, pixelDeg) {
  const tileDeg = tileSize * pixelDeg
  let tl = Math.floor(latDeg / tileDeg) * tileDeg
  if (tl > 88) tl = 88
  else if (tl < -90) tl = -90
  let ln = Math.floor(lonDeg / tileDeg) * tileDeg
  if (ln < -180) ln = -180
  if (ln > 178) ln = 178
  return [tl, ln]
}

/**
 * Elevation in METERS at (lat, lon), from a tile Map (key `${lat},${lon}` →
 * Int16Array payload), or null when the tile is absent (not fetched) — the
 * caller falls back to the document height there.
 */
export function demElevationAt(latDeg, lonDeg, tiles, pixelDeg, tileSize) {
  const tileDeg = tileSize * pixelDeg
  const [tl, ln] = tileKeyFor(latDeg, lonDeg, tileSize, pixelDeg)
  const data = tiles.get(tl + ',' + ln)
  if (!data) return null
  // row 0 = the tile's north edge; the pixel center is half a pixel in.
  const r = Math.round((tl + tileDeg - latDeg) / pixelDeg - 0.5)
  const c = Math.round((lonDeg - ln) / pixelDeg - 0.5)
  if (r < 0 || r >= tileSize || c < 0 || c >= tileSize) return null
  return data[r * tileSize + c]
}

// ---------------------------------------------------------------------------
// Enumerating the fine hexes in the cap
// ---------------------------------------------------------------------------

/** A point `angle` (rad) from `focus`, at tangent `azimuth` (rad). */
function rotateDirAboutTangent(focus, azimuth, angle) {
  const fx = focus[0], fy = focus[1], fz = focus[2]
  const refX = Math.abs(fx) < 0.9 ? 0 : 1
  const refY = Math.abs(fx) < 0.9 ? 1 : 0
  // t1 = normalize(cross(focus, ref)); t2 = normalize(cross(focus, t1))
  let t1x = fy * 0 - fz * refY
  let t1y = fz * refX - fx * 0
  let t1z = fx * refY - fy * refX
  const l1 = Math.hypot(t1x, t1y, t1z) || 1
  t1x /= l1
  t1y /= l1
  t1z /= l1
  const t2x = fy * t1z - fz * t1y
  const t2y = fz * t1x - fx * t1z
  const t2z = fx * t1y - fy * t1x
  const c = Math.cos(angle), s = Math.sin(angle)
  const ca = Math.cos(azimuth), sa = Math.sin(azimuth)
  const ox = t1x * ca + t2x * sa
  const oy = t1y * ca + t2y * sa
  const oz = t1z * ca + t2z * sa
  return [fx * c + ox * s, fy * c + oy * s, fz * c + oz * s]
}

/**
 * The fine hexes (q, r) inside the cap of radius `capRadiusU` around
 * `focusDir`, in the focus's patch. A tight (q, r) bounding box — sampled from
 * the cap's geodesic boundary projected to the plane — is enumerated and each
 * hex kept only if it passes the EXACT angular test (dot ≥ cos capAngle).
 *
 * @returns {Array<{q:number, r:number, x:number, y:number, dir:number[]}>}
 */
export function enumerateFineHexes(a, patch, focusDir, capRadiusU, bodyRadiusU) {
  const capAngle = capRadiusU / bodyRadiusU
  const cosCap = Math.cos(capAngle)
  let qMin = Infinity, qMax = -Infinity, rMin = Infinity, rMax = -Infinity
  const N = 96
  for (let k = 0; k < N; k++) {
    const bd = rotateDirAboutTangent(focusDir, (k / N) * 2 * Math.PI, capAngle)
    const p = projectToPlane(bd)
    const h = planeToHex(a, p.x, p.y)
    if (h.q < qMin) qMin = h.q
    if (h.q > qMax) qMax = h.q
    if (h.r < rMin) rMin = h.r
    if (h.r > rMax) rMax = h.r
  }
  qMin -= 2
  qMax += 2
  rMin -= 2
  rMax += 2
  const out = []
  for (let r = rMin; r <= rMax; r++) {
    for (let q = qMin; q <= qMax; q++) {
      const pp = hexToPlane(a, q, r)
      const dir = dirFromPlane(patch, pp.x, pp.y)
      if (dotv(dir, focusDir) >= cosCap) out.push({ q, r, x: pp.x, y: pp.y, dir })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// The fine hex's chord-fan geometry (the rendered surface at fine scale)
// ---------------------------------------------------------------------------

/** The fine hex (q, r)'s center + 6 corner body-local unit directions. */
export function fineHexDirs(patch, q, r, a) {
  const p = hexToPlane(a, q, r)
  const c3 = dirFromPlane(patch, p.x, p.y)
  const corners = new Float64Array(18)
  for (let k = 0; k < 6; k++) {
    const d = dirFromPlane(patch, p.x + a * CORNER_DX[k], p.y + a * CORNER_DY[k])
    corners[k * 3] = d[0]
    corners[k * 3 + 1] = d[1]
    corners[k * 3 + 2] = d[2]
  }
  return { c3, corners }
}

/**
 * The fan's 6 chord-triangle plane normals + center cosines for a fine hex —
 * orientation-only (independent of the height), so it is cached once per hex
 * and the per-sample radius is a rescale (the surface.js fanRadiusAt rule).
 */
export function fineFanTables(c3, corners) {
  const normals = new Float64Array(18)
  const centerCos = new Float64Array(6)
  for (let k = 0; k < 6; k++) {
    const k1 = (k + 1) % 6
    const ax = corners[k1 * 3] - c3[0], ay = corners[k1 * 3 + 1] - c3[1], az = corners[k1 * 3 + 2] - c3[2]
    const bx = corners[k * 3] - c3[0], by = corners[k * 3 + 1] - c3[1], bz = corners[k * 3 + 2] - c3[2]
    let nx = ay * bz - az * by
    let ny = az * bx - ax * bz
    let nz = ax * by - ay * bx
    const l = Math.hypot(nx, ny, nz) || 1
    nx /= l
    ny /= l
    nz /= l
    let nc = nx * c3[0] + ny * c3[1] + nz * c3[2]
    if (nc < 0) {
      nx = -nx
      ny = -ny
      nz = -nz
      nc = -nc
    }
    normals[k * 3] = nx
    normals[k * 3 + 1] = ny
    normals[k * 3 + 2] = nz
    centerCos[k] = nc
  }
  return { normals, centerCos }
}

/**
 * Radius of the fine hex's rendered top (its chord-fan lower envelope) along
 * body-local unit `dir`, at vertex radius `rho` = R + h. Allocation-free —
 * the 60 Hz walker and the pick sweep call it hot.
 */
export function fineFanRadius(fan, rho, dir) {
  const { normals, centerCos } = fan
  let best = Infinity
  for (let k = 0; k < 6; k++) {
    const nd = normals[k * 3] * dir[0] + normals[k * 3 + 1] * dir[1] + normals[k * 3 + 2] * dir[2]
    if (nd > 0) {
      const r = (rho * centerCos[k]) / nd
      if (r < best) best = r
    }
  }
  return best === Infinity ? rho : best
}

// ---------------------------------------------------------------------------
// The feather (§4.3) — the seam killer
// ---------------------------------------------------------------------------

/**
 * The blend weight w(d) at angular distance `d` (rad) from the focus: 1 deep
 * inside the loaded set, fading smoothly (smoothstep) to 0 across the outer
 * `featherFrac` of the cap — at the cap edge w = 0 exactly, so the fine edge
 * sits on the document surface (the seam is invisible).
 */
export function featherWeight(d, capAngle, featherFrac) {
  const inner = (1 - featherFrac) * capAngle
  if (d <= inner) return 1
  if (d >= capAngle) return 0
  const t = (capAngle - d) / (featherFrac * capAngle)
  return t * t * (3 - 2 * t)
}

// ---------------------------------------------------------------------------
// The fine chunk geometry builder (the chord-fan cell builder, at fine scale)
// ---------------------------------------------------------------------------

/**
 * Render vertex data for ONE fine chunk: the chord-fan top + walls of each
 * fine hex, batched by terrain type (the same structure as
 * geometry.js buildPlanetGeometryData, over the fine lattice instead of the
 * document grid). Every triangle records the DOCUMENT cell index (the
 * fine→doc map value) in cellByTri — the inert fallback resolves to the
 * document, as today.
 *
 * Walls read the NEIGHBOUR's fine height through `hAt(q, r)` (the chunk's
 * hexes plus its one-hex halo — a boundary wall closes against the fine
 * height of the out-of-chunk neighbour, so the fine surface tiles seamlessly
 * inside the loaded set). `hAt` falls back to the document height outside the
 * halo (where the feather has already faded w → 0).
 *
 * @param {number} R body radius (world units)
 * @param {number} patch the patch index (0 = +Z, 1 = −Z)
 * @param {number} a the fine hex edge (plane units)
 * @param {Array<{q,r,c3,corners,h,type,rgb,docCell}>} hexes the chunk's fine hexes
 * @param {(q:number, r:number) => number} hAt the neighbour fine height (or doc fallback)
 * @returns {Map<string, {positions,colors,uvs,cellByTri,triangles}>}
 */
export function buildFineGeometryData(R, patch, a, hexes, hAt) {
  const batches = new Map()
  const batchFor = (type) => {
    let b = batches.get(type)
    if (!b) {
      b = { pos: [], col: [], uv: [], tri: [] }
      batches.set(type, b)
    }
    return b
  }

  // Tangent-space UV (mirrors the document builder): seamless per-hex texturing.
  const pushVert = (b, p, refDir, rgb) => {
    const up = Math.abs(refDir[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0]
    const t1 = norm3(crossv(refDir, up))
    const t2 = crossv(refDir, t1)
    b.pos.push(p[0], p[1], p[2])
    b.col.push(rgb[0], rgb[1], rgb[2])
    b.uv.push(dotv(p, t1) + 0.5, dotv(p, t2) + 0.5)
  }
  const pushTri = (b, p0, p1, p2, outward, refDir, rgb, cellIdx) => {
    const e1 = subv(p1, p0)
    const e2 = subv(p2, p0)
    const flipped = dotv(crossv(e1, e2), outward) < 0
    const order = flipped ? [p0, p2, p1] : [p0, p1, p2]
    for (const p of order) pushVert(b, p, refDir, rgb)
    b.tri.push(cellIdx)
  }

  for (const hx of hexes) {
    const b = batchFor(hx.type)
    const rho = R + hx.h
    const c3 = hx.c3
    const corners = hx.corners
    const top = new Array(6)
    for (let k = 0; k < 6; k++) top[k] = [corners[k * 3] * rho, corners[k * 3 + 1] * rho, corners[k * 3 + 2] * rho]
    const centerPoint = [c3[0] * rho, c3[1] * rho, c3[2] * rho]

    // ---- top polygon (fan) --------------------------------------------
    for (let k = 0; k < 6; k++) pushTri(b, centerPoint, top[(k + 1) % 6], top[k], c3, c3, hx.rgb, hx.docCell)

    // ---- walls ----------------------------------------------------------
    for (let k = 0; k < 6; k++) {
      const [dq, dr] = SIDE_OFFSET[k]
      const nH = hAt(hx.q + dq, hx.r + dr)
      const hb = Math.min(hx.h, nH)
      if (hx.h - hb < 1e-4) continue
      // The wall lies in the radial plane through the shared edge; its face
      // normal is tangential — flip toward the neighbour's center (downhill).
      const nd = fineHexDirs(patch, hx.q + dq, hx.r + dr, a).c3
      const wallOut = norm3(subv(nd, c3))
      const a0 = top[k]
      const a1 = top[(k + 1) % 6]
      const b0 = [corners[k * 3] * (R + hb), corners[k * 3 + 1] * (R + hb), corners[k * 3 + 2] * (R + hb)]
      const k1 = (k + 1) % 6
      const b1 = [corners[k1 * 3] * (R + hb), corners[k1 * 3 + 1] * (R + hb), corners[k1 * 3 + 2] * (R + hb)]
      pushTri(b, a0, a1, b1, wallOut, c3, hx.rgb, hx.docCell)
      pushTri(b, a0, b1, b0, wallOut, c3, hx.rgb, hx.docCell)
    }
  }

  const out = new Map()
  for (const [type, b] of batches) {
    out.set(type, {
      positions: new Float32Array(b.pos),
      colors: new Float32Array(b.col),
      uvs: new Float32Array(b.uv),
      cellByTri: new Uint32Array(b.tri),
      triangles: b.tri.length,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Terrain color (the fine layer shows the DEM's relief but keeps the
// document's look — §3.4): the element's own `c`, else the type default.
// ---------------------------------------------------------------------------

function defaultColor(type) {
  const def = terrainDefaults(type)
  const hex = def && def.color
  if (hex && typeof hex === 'string') {
    let s = hex.replace('#', '')
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2]
    const n = parseInt(s, 16)
    if (!Number.isNaN(n)) return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
  }
  return [1, 1, 1]
}

/**
 * Resolve a fine hex's terrain color from the enclosing document cell's PACKED
 * data (mirrors geometry.js: the element's own `c`, else the terrain type
 * default).
 * @returns {[number, number, number]} 0..1 rgb
 */
export function fineCellColor(packed, docCell) {
  const type = packed.materials[packed.t[docCell]] || 'grass'
  if (packed.hasC[docCell]) {
    const n = packed.rgb[docCell]
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
  }
  return defaultColor(type)
}

/** The terrain TYPE of a document element (the packed form's string index
 *  decoded) — the fine hex inherits its enclosing document cell's look. */
export function elementType(el) {
  return (el && el.t) || 'grass'
}

/** The terrain color of a document ELEMENT (the element-object form of
 *  fineCellColor — file worlds carry no packed mirror). */
export function elementColor(el) {
  if (el && el.c != null) {
    const n = el.c | 0
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
  }
  return defaultColor(elementType(el))
}

// ---------------------------------------------------------------------------
// The catalog / tile providers (the app fetches over /api; the headless
// harness swaps in synthetic DEMs — the providers are the seam, and the
// module stays framework-free: no DOM, fetch is resolved at call time)
// ---------------------------------------------------------------------------

let catalogProvider = async () => (await fetch('/api/terrain')).json()
let tileProvider = async (catalog, tileLat, tileLon) => {
  const res = await fetch(`/api/terrain/${encodeURIComponent(catalog)}/tile/${tileLat}/${tileLon}`)
  if (!res.ok) return null
  return new Int16Array(await res.arrayBuffer())
}

/** Swap the terrain data providers (partial — pass only what you replace).
 *  `catalogs` → Promise<{ catalogs: [...] }> (the GET /api/terrain shape);
 *  `tiles(catalog, tileLat, tileLon)` → Promise<Int16Array|null>. */
export function setTerrainProviders({ catalogs, tiles } = {}) {
  if (catalogs) catalogProvider = catalogs
  if (tiles) tileProvider = tiles
}

export const getTerrainCatalogProvider = () => catalogProvider
export const getTerrainTileProvider = () => tileProvider
