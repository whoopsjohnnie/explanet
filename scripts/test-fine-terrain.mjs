/**
 * test-fine-terrain.mjs — headless tests for the Stage 2 fine-terrain synthesis
 * (core/fineTerrain.js): the catalog-derived fine hex size, the dir↔lat/lon
 * handedness, the DEM tile sampling, the cap enumeration (exact coverage),
 * the feather, the fine chord-fan radius, and the fine chunk geometry builder.
 * Run: node scripts/test-fine-terrain.mjs
 */

import {
  fineLatticeEdge,
  fineHexKm,
  fineChunkSide,
  dirToLatLon,
  tileKeyFor,
  demElevationAt,
  enumerateFineHexes,
  fineHexDirs,
  fineFanTables,
  fineFanRadius,
  featherWeight,
  buildFineGeometryData,
  fineCellColor,
  elementColor,
  SIDE_OFFSET,
} from '../src/core/fineTerrain.js'
import { hexToPlane, planeToHex, dirFromPlane } from '../src/core/finedisc.js'
import { elementsFromPacked } from '../src/core/atoms.js'

let failures = 0
const check = (name, cond) => {
  console.log(`${cond ? '✓' : '✗'} ${name}`)
  if (!cond) failures++
}
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const nrm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

// Earth anchors (docs/terrain.txt §1.1): R = 6371.009 km, 1 u = 35,181.6 m.
const R_EARTH_KM = 6371.009
const M_PER_U = 35181.6
const PIXEL_DEG = 1 / 60 // ETOP2022-60s

// ---------------------------------------------------------------------------
// 1. the fine hex size is the catalog's pixel (1.85 km on Earth), chunkSide 64
// ---------------------------------------------------------------------------
{
  const a = fineLatticeEdge(PIXEL_DEG) // plane units (radians)
  const hexKm = fineHexKm(PIXEL_DEG, R_EARTH_KM * 1000)
  const side = fineChunkSide(118, PIXEL_DEG, R_EARTH_KM * 1000)
  // plane edge × R_m / 1000 = the arc of one pixel = 1.85 km
  const okEdge = approx(a, (PIXEL_DEG * Math.PI) / 180) && approx(hexKm, 1.85, 0.01)
  const okSide = side === 64
  check(`fine hex = the DEM pixel: a=${a.toExponential(3)} rad, ${hexKm.toFixed(3)} km, chunkSide=${side}`, okEdge && okSide)
}

// ---------------------------------------------------------------------------
// 2. dir ↔ lat/lon: the terrain.js handedness (round-trip + a known point)
// ---------------------------------------------------------------------------
{
  // a body-local direction at (lat, lon) under the scene convention
  const dirAt = (latDeg, lonDeg) => {
    const la = (latDeg * Math.PI) / 180
    const lo = (lonDeg * Math.PI) / 180
    return nrm([Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)])
  }
  // round-trip over a spread of points
  let ok = true
  for (let lat = -80; lat <= 80; lat += 7)
    for (let lon = -170; lon <= 170; lon += 11) {
      const { latDeg, lonDeg } = dirToLatLon(dirAt(lat, lon))
      const lonWrap = ((lon + 180) % 360 + 360) % 360 - 180
      if (!approx(latDeg, lat, 1e-6) || !approx(lonDeg, lonWrap, 1e-6)) ok = false
    }
  // the Sierra crest (~37.7 N, 119.5 W) must come back un-mirrored
  const sierra = dirToLatLon(dirAt(37.7, -119.5))
  const okSierra = approx(sierra.latDeg, 37.7, 1e-6) && approx(sierra.lonDeg, -119.5, 1e-6)
  check('dir ↔ lat/lon: round-trip (both hemispheres) + the Sierra crest un-mirrored', ok && okSierra)
}

// ---------------------------------------------------------------------------
// 3. DEM tile sampling: the right pixel, the right value, the tile key
// ---------------------------------------------------------------------------
{
  const tileSize = 120
  const pixelDeg = 1 / 60
  // a synthetic tile (0,0) covering lat [0,2], lon [0,2]: value = f(r, c)
  const data = new Int16Array(tileSize * tileSize)
  for (let r = 0; r < tileSize; r++)
    for (let c = 0; c < tileSize; c++) data[r * tileSize + c] = 1000 + r * 10 + c
  const tiles = new Map()
  tiles.set('0,0', data)

  // the tile key for points across the tile
  const okKeys =
    tileKeyFor(1.0, 1.0, tileSize, pixelDeg).join(',') === '0,0' &&
    tileKeyFor(1.999, 1.999, tileSize, pixelDeg).join(',') === '0,0' &&
    tileKeyFor(0.001, 0.001, tileSize, pixelDeg).join(',') === '0,0' &&
    tileKeyFor(-0.5, 5.0, tileSize, pixelDeg).join(',') === '-2,4'

  // the center pixel (r=60, c=60) and the north-east corner pixel (r=0, c=119)
  const center = demElevationAt(1.0, 1.0, tiles, pixelDeg, tileSize)
  const corner = demElevationAt(1.999, 1.999, tiles, pixelDeg, tileSize)
  const okVals = center === 1000 + 60 * 10 + 60 && corner === 1000 + 0 * 10 + 119

  // a missing tile falls back to null (the caller uses the document height)
  const missing = demElevationAt(45, 45, tiles, pixelDeg, tileSize)

  check('DEM sampling: tile keys', okKeys)
  check(`DEM sampling: center=${center} (want 1660), NE-corner=${corner} (want 1119)`, okVals)
  check('DEM sampling: missing tile → null (document fallback)', missing === null)
}

// ---------------------------------------------------------------------------
// 4. cap enumeration: exact coverage, focus hex present, no duplicates
// ---------------------------------------------------------------------------
{
  const a = 0.01 // plane units (a small hex, so the cap holds a handful)
  const patch = 0
  const focus = [0, 0, 1] // the +Z pole — deep in patch 0
  const R = 1
  const capRadiusU = 0.05 // capAngle = 0.05 rad
  const hexes = enumerateFineHexes(a, patch, focus, capRadiusU, R)

  const cosCap = Math.cos(capRadiusU / R)
  const keys = new Set()
  let allInCap = true
  for (const h of hexes) {
    if (keys.has(h.q + ':' + h.r)) allInCap = false // duplicate
    keys.add(h.q + ':' + h.r)
    if (dot(h.dir, focus) < cosCap - 1e-12) allInCap = false // outside the cap
  }
  // the focus hex (the one nearest the +Z pole) is present
  let focusHex = null
  let bestDot = -Infinity
  for (const h of hexes) {
    const d = dot(h.dir, focus)
    if (d > bestDot) {
      bestDot = d
      focusHex = h
    }
  }
  const okFocus = focusHex && bestDot > 0.9999

  // the count matches the theory: cap disc area / hex area (within the margin)
  const capArea = Math.PI * Math.pow(Math.tan(capRadiusU / R), 2) // gnomonic, near the pole
  const hexArea = (3 * Math.sqrt(3) / 2) * a * a
  const expect = capArea / hexArea
  const okCount = hexes.length > expect * 0.7 && hexes.length < expect * 1.6

  check(`cap enumeration: exact coverage, no duplicates (${hexes.length} hexes, ~${Math.round(expect)} expected)`, allInCap && okFocus && okCount)
}

// ---------------------------------------------------------------------------
// 5. the feather: 1 inside, 0 at the edge, smooth + monotone in between
// ---------------------------------------------------------------------------
{
  const capAngle = 0.08
  const f = 0.2
  const inside = featherWeight(0, capAngle, f)
  const atEdge = featherWeight(capAngle, capAngle, f)
  const innerEdge = featherWeight((1 - f) * capAngle, capAngle, f)
  // monotone decreasing across the band
  let mono = true
  let prev = Infinity
  for (let i = 0; i <= 20; i++) {
    const w = featherWeight((1 - f) * capAngle + (f * capAngle * i) / 20, capAngle, f)
    if (w > prev + 1e-12) mono = false
    prev = w
  }
  const ok = approx(inside, 1) && approx(atEdge, 0) && approx(innerEdge, 1) && mono
  check(`feather: 1 inside (w=${inside}), 0 at the edge (w=${atEdge}), monotone`, ok)
}

// ---------------------------------------------------------------------------
// 6. the fine chord fan: radius at the center ≈ rho, ≤ rho elsewhere, sag
// ---------------------------------------------------------------------------
{
  const a = 0.0003
  const { c3, corners } = fineHexDirs(0, 0, 0, a) // the pole hex
  const fan = fineFanTables(c3, corners)
  const rho = 100
  // at the exact center the fan meets the center vertex → radius = rho
  const atCenter = fineFanRadius(fan, rho, c3)
  // toward a corner (on the sphere) the radius returns to rho; toward the side
  // midpoint (the sag) it is below rho. corners is FLAT (k at (k*3..k*3+2)).
  const corner0 = [corners[0], corners[1], corners[2]]
  const corner1 = [corners[3], corners[4], corners[5]]
  const atCorner = fineFanRadius(fan, rho, corner0)
  const sideMid = nrm([corner0[0] + corner1[0], corner0[1] + corner1[1], corner0[2] + corner1[2]])
  const atSide = fineFanRadius(fan, rho, sideMid)
  // the sag ≈ rho·a²/8 (chord mid vs sphere) — sanity-check its scale
  const sag = rho - atSide
  const ok =
    approx(atCenter, rho, 1e-6) && // the center vertex
    atCorner < rho + 1e-6 && // a corner sits on the sphere
    atSide < atCorner && // the side midpoint sags below the sphere
    sag > 1e-7 && sag < 1e-5 // the sag is the real chord sag ~ rho·a²/8
  check(
    `fine chord fan: center=${atCenter.toFixed(6)}=rho, side-mid sags (${sag.toExponential(2)} below)`,
    ok
  )
}

// ---------------------------------------------------------------------------
// 7. the fine chunk geometry builder: tops + walls, valid batches
// ---------------------------------------------------------------------------
{
  const a = 0.0003
  const R = 100
  const patch = 0
  // a 3x3 flat block (q, r in -1..1), all h = 0 → tops only, no walls
  const hexes = []
  for (let r = -1; r <= 1; r++)
    for (let q = -1; q <= 1; q++) {
      const { c3, corners } = fineHexDirs(patch, q, r, a)
      // docCell plays the document cell index — non-negative, as in the real grid
      hexes.push({ q, r, c3, corners, h: 0, type: 'grass', rgb: [0.2, 0.6, 0.2], docCell: (q + 1) * 10 + (r + 1) })
    }
  const flatHAt = () => 0
  const flat = buildFineGeometryData(R, patch, a, hexes, flatHAt)
  let flatTris = 0
  for (const [, b] of flat) flatTris += b.triangles
  const okFlat = flatTris === 9 * 6 && [...flat.values()].every((b) => b.positions.length === b.triangles * 9)

  // now raise the center hex: its walls appear against the flat neighbours
  const raised = hexes.map((h) => (h.q === 0 && h.r === 0 ? { ...h, h: 5 } : h))
  const hTable = new Map(hexes.map((h) => [h.q + ':' + h.r, h.h]))
  const hAt = (q, r) => hTable.get(q + ':' + r) ?? 0
  const bumpy = buildFineGeometryData(R, patch, a, raised, hAt)
  let bumpTris = 0
  for (const [, b] of bumpy) bumpTris += b.triangles
  // the raised hex owns 6 walls (2 tris each) on top of its 6 top tris
  const okWalls = bumpTris === flatTris + 6 * 2

  // cellByTri records the DOCUMENT cell (the fine→doc value) in every triangle
  const docCells = new Set(hexes.map((h) => h.docCell))
  const okCellByTri = [...bumpy.values()].every((b) => [...b.cellByTri].every((c) => docCells.has(c)))

  check(`fine geometry: flat 3x3 = ${flatTris} top tris; raised center adds 12 wall tris`, okFlat && okWalls && okCellByTri)
}

// ---------------------------------------------------------------------------
// 8. the side-offset table: each side faces the correct lattice neighbour
// ---------------------------------------------------------------------------
{
  // the neighbour across side k is (q, r) + SIDE_OFFSET[k]; the vector from the
  // hex center to that neighbour's center must point along the side's outward
  // bisector (angle 60° + 60°·k).
  let ok = true
  for (let k = 0; k < 6; k++) {
    const p0 = hexToPlane(1, 0, 0)
    const [dq, dr] = SIDE_OFFSET[k]
    const p1 = hexToPlane(1, dq, dr)
    const dx = p1.x - p0.x
    const dy = p1.y - p0.y
    const ang = Math.atan2(dy, dx)
    const want = ((60 + 60 * k) * Math.PI) / 180
    // angles match modulo 2π
    let diff = Math.abs(ang - want) % (2 * Math.PI)
    if (diff > Math.PI) diff = 2 * Math.PI - diff
    if (diff > 1e-9) ok = false
  }
  check('side-offset table: each side faces its lattice neighbour (6/6)', ok)
}

// ---------------------------------------------------------------------------
// 9. fineCellColor: the element color, else the terrain default
// ---------------------------------------------------------------------------
{
  const packed = {
    materials: ['grass', 'snow'],
    t: new Uint16Array([0, 1]),
    h: new Float64Array(2),
    rgb: new Uint32Array([0x2f6d2a, 0]),
    hasC: new Uint8Array([1, 0]),
  }
  const withC = fineCellColor(packed, 0)
  const withoutC = fineCellColor(packed, 1)
  const okC = approx(withC[0], 0x2f / 255) && approx(withC[1], 0x6d / 255) && approx(withC[2], 0x2a / 255)
  const okDef = withoutC.length === 3 && withoutC.every((v) => v >= 0 && v <= 1)
  check('fineCellColor: element color + the terrain-default fallback', okC && okDef)
}

// ---------------------------------------------------------------------------
// 9b. elementColor: the element-object form — the hex STRING `c` must parse
//     (a bitwise '| 0' on a string is 0 and painted every stored-atom chunk
//     black under the vertexColors material; the regression for that).
// ---------------------------------------------------------------------------
{
  const withC = elementColor({ t: 'rock', h: 0, c: '#969188' })
  const okC = approx(withC[0], 0x96 / 255) && approx(withC[1], 0x91 / 255) && approx(withC[2], 0x88 / 255)
  const notBlack = withC.some((v) => v > 0)
  const noC = elementColor({ t: 'rock', h: 0 })
  const okDef = noC.length === 3 && noC.every((v) => v >= 0 && v <= 1) && noC.some((v) => v > 0)
  check('elementColor: string hex parses (not black) + the type-default fallback', okC && notBlack && okDef)
}

// keep the imports referenced (the module graph is exercised, not just the API)
void elementsFromPacked
void planeToHex
void dirFromPlane

console.log(failures === 0 ? '\nAll fine-terrain checks passed.' : `\n${failures} fine-terrain check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
