/**
 * test-finedisc.mjs — headless tests for the fine-terrain region machinery
 * (core/finedisc.js): gnomonic projection round-trip, the fine hex lattice,
 * chunk keys, the cap loaded set (exact coverage), the ahead-of-velocity
 * streaming queue, the horizon-gap no-region guard, and the stage-1 identity
 * fine->doc map.
 * Run: node scripts/test-finedisc.mjs
 */

import { getHexSphere } from '../src/core/hexsphere.js'
import { C } from '../src/core/constants.js'
import { radiusForFrequency, planetRadius } from '../src/core/planetMath.js'
import { buildPlanetGeometryData } from '../src/core/geometry.js'
import { makeStarterWorld } from '../src/core/starter.js'
import {
  patchOf,
  projectToPlane,
  dirFromPlane,
  hexToPlane,
  planeToHex,
  fineHexEdge,
  chunkKey,
  parseChunkKey,
  chunkOfHex,
  loadedSet,
  orderQueue,
  fineToDocOf,
  capRadiusU,
  chunkSideFor,
  horizonGap,
  safeFocusAngle,
  focusSafe,
  buildChunkGeometryData,
  publishFineRegion,
  fineRegionOf,
  isFine,
  surfaceOfRecord,
  recordSurfaceRadius,
  remapToDoc,
} from '../src/core/finedisc.js'

let failures = 0
const check = (name, cond) => {
  console.log(`${cond ? '✓' : '✗'} ${name}`)
  if (!cond) failures++
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const nrm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}
function mulberry32(seed) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// 1. gnomonic projection round-trip (both patches)
// ---------------------------------------------------------------------------
{
  let ok = true
  const rand = mulberry32(11)
  for (let i = 0; i < 6000; i++) {
    let dir = nrm([rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1])
    if (Math.abs(dir[2]) < 1e-6) dir[2] = dir[2] < 0 ? -1e-6 : 1e-6 // avoid the z=0 singularity
    const { patch, x, y } = projectToPlane(dir)
    if (patchOf(dir) !== patch) ok = false
    if (dot(dirFromPlane(patch, x, y), dir) < 1 - 1e-6) ok = false
  }
  check('gnomonic projection round-trip (6000 dirs, both patches)', ok)
}

// ---------------------------------------------------------------------------
// 2. hex lattice: axial <-> plane round-trip (integer block)
// ---------------------------------------------------------------------------
{
  const a = 0.62
  let ok = true
  for (let q = -12; q <= 12; q++)
    for (let r = -12; r <= 12; r++) {
      const p = hexToPlane(a, q, r)
      const back = planeToHex(a, p.x, p.y)
      if (back.q !== q || back.r !== r) ok = false
    }
  check('hex lattice axial round-trip (25x25 block)', ok)
}

// ---------------------------------------------------------------------------
// 3. chunk keys: encode/parse + deep-in-chunk stability + boundary split
// ---------------------------------------------------------------------------
{
  const p = parseChunkKey(chunkKey(1, -3, 7))
  const okParse = p.patch === 1 && p.I === -3 && p.J === 7
  // deep inside chunk (I=2, J=-2) for chunkSide 5: q in [10,15), r in [-10,-5)
  const okDeep = chunkOfHex(0, 5, 12, -8) === chunkKey(0, 2, -2)
  // neighbouring hexes across the q=10 boundary fall in different chunks
  const okEdge = chunkOfHex(0, 5, 9, -8) !== chunkOfHex(0, 5, 10, -8)
  check('chunk keys: parse, deep-in-chunk stability, boundary split', okParse && okDeep && okEdge)
}

// ---------------------------------------------------------------------------
// 4. loaded set: EXACT cap coverage, focus chunk present, identity map
// ---------------------------------------------------------------------------
{
  const freq = 24
  const grid = getHexSphere(freq)
  const R = radiusForFrequency(freq)
  const a = fineHexEdge(grid, R)
  const chunkSide = 4
  const focus = [0, 0, 1] // +Z pole — deep in patch 0, far from the horizon
  const capRadiusU = 12 * a
  const ls = loadedSet(grid, focus, capRadiusU, R, chunkSide)

  // the exact in-cap cell set (geodesic test), independent of the BFS
  const cosCap = Math.cos(capRadiusU / R)
  const inCap = new Set()
  for (let i = 0; i < grid.cellCount; i++) {
    const b = i * 3
    if (grid.centers[b] * focus[0] + grid.centers[b + 1] * focus[1] + grid.centers[b + 2] * focus[2] >= cosCap)
      inCap.add(i)
  }

  // every in-cap cell is assigned, and only in-cap cells are assigned
  const okCover = [...inCap].every((i) => ls.byCell.has(i))
  const okOnly = [...ls.byCell.keys()].every((i) => inCap.has(i))

  // the assigned chunks really do contain their cells
  const okContain = [...inCap].every((i) => {
    const c = ls.chunks.find((cc) => cc.key === ls.byCell.get(i))
    return c && c.cells.includes(i)
  })

  // the focus cell is in the loaded set
  const okFocus = ls.byCell.has(ls.focusCell) && ls.chunks.some((c) => c.cells.includes(ls.focusCell))

  // the stage-1 fine->doc map is the identity
  const okIdentity = ls.chunks.every((c) => c.cells.every((cell, k) => fineToDocOf(c, k) === cell))

  check(`loaded set: covers the cap exactly (${ls.chunks.length} chunks, ${inCap.size} cells)`, okCover && okOnly)
  check('loaded set: assigned chunks contain their cells', okContain)
  check('loaded set: focus cell is mounted', okFocus)
  check('loaded set: stage-1 fine->doc map is the identity', okIdentity)
}

// ---------------------------------------------------------------------------
// 5. ahead-of-velocity queue: the +x chunk streams before the -x chunk
// ---------------------------------------------------------------------------
{
  const freq = 24
  const grid = getHexSphere(freq)
  const R = radiusForFrequency(freq)
  const a = fineHexEdge(grid, R)
  const chunkSide = 4
  const focus = [0, 0, 1]
  const ls = loadedSet(grid, focus, 14 * a, R, chunkSide)
  const ap = ls.a // the PLANE cell edge (dimensionless)
  const fp = projectToPlane(focus)
  const xOff = (c) => hexToPlane(ap, c.I * chunkSide + chunkSide / 2, c.J * chunkSide + chunkSide / 2).x - fp.x

  const vel = [1, 0, 0] // +x is a valid tangent direction at the +Z pole
  const ordered = orderQueue(ls.chunks, focus, vel, chunkSide, a)
  const aheadChunk = ls.chunks.reduce((b, c) => (xOff(c) > xOff(b) ? c : b))
  const behindChunk = ls.chunks.reduce((b, c) => (xOff(c) < xOff(b) ? c : b))
  const okSplit = xOff(aheadChunk) > 0 && xOff(behindChunk) < 0
  const okOrder = ordered.indexOf(aheadChunk) < ordered.indexOf(behindChunk)

  // a zero velocity degrades to a plain distance sort (no crash, all present)
  const calm = orderQueue(ls.chunks, focus, [0, 0, 0], chunkSide, a)
  const okCalm = calm.length === ls.chunks.length

  check(`queue: ahead-of-velocity order (${ls.chunks.length} chunks)`, okSplit && okOrder)
  check('queue: zero-velocity degrades to distance sort', okCalm)
}

// ---------------------------------------------------------------------------
// 6. the constants resolve to the design values
// ---------------------------------------------------------------------------
{
  const okR = Math.abs(capRadiusU(35182) - 500000 / 35182) < 1e-6
  const okS = chunkSideFor(1.85) === 64 && chunkSideFor(21.8) === 5
  check('constants: capRadiusU(35182)=14.21u, chunkSideFor(1.85)=64 / (21.8)=5', okR && okS)
}

// ---------------------------------------------------------------------------
// 7. chunk geometry: byte-identical to the document mesh's matching cells
// ---------------------------------------------------------------------------
// The chunk builder is the document's cell builder restricted to a lattice
// block. For stage 1 (fine cells ARE document cells) a chunk's vertices must
// be EXACTLY the document's vertices for those cells — so deleting every chunk
// leaves the body byte-identical (§11). Walls read their neighbour's height
// from the full document, so the restriction only suppresses emission, never
// the lookup: the filtered document batch and the chunk batch agree to the byte.
{
  const world = makeStarterWorld()
  const earth = world.planets.find((p) => p.name === 'Earth')
  const grid = getHexSphere(earth.frequency)
  const R = planetRadius(earth)
  const aU = fineHexEdge(grid, R)
  const chunkSide = 4
  const focus = [0, 0, 1]
  const capRadiusU = 6 * aU // a small cap → a handful of chunks
  const ls = loadedSet(grid, focus, capRadiusU, R, chunkSide)
  const focusChunk = ls.chunks.find((c) => c.key === ls.byCell.get(ls.focusCell))
  const cellSet = new Set(focusChunk.cells)

  const docData = buildPlanetGeometryData(earth)
  const chunkData = buildChunkGeometryData(earth, focusChunk)

  // a chunk emits exactly the document's triangles for its cells, in order
  const filterField = (batch, field, per) => {
    const out = []
    for (let t = 0; t < batch.triangles; t++) {
      if (!cellSet.has(batch.cellByTri[t])) continue
      const off = t * per
      for (let k = 0; k < per; k++) out.push(batch[field][off + k])
    }
    return out
  }
  let byteIdentical = true
  let chunkTris = 0
  for (const [type, cb] of chunkData) {
    const db = docData.get(type)
    if (!db) { byteIdentical = false; continue }
    chunkTris += cb.triangles
    for (const [field, per] of [['positions', 9], ['colors', 9], ['uvs', 6]]) {
      const exp = filterField(db, field, per)
      if (exp.length !== cb[field].length) { byteIdentical = false; continue }
      for (let i = 0; i < exp.length; i++) if (exp[i] !== cb[field][i]) { byteIdentical = false; break }
    }
    // cellByTri: the document cell index, restricted to the chunk's cells
    const expCell = filterField(db, 'cellByTri', 1)
    if (expCell.length !== cb.cellByTri.length) byteIdentical = false
    else for (let i = 0; i < expCell.length; i++) if (expCell[i] !== cb.cellByTri[i]) { byteIdentical = false; break }
  }
  check(
    `chunk geometry is byte-identical to the document's matching cells (${focusChunk.cells.length} cells, ${chunkTris} tris)`,
    byteIdentical && chunkTris > 0
  )
}

// ---------------------------------------------------------------------------
// 8. the §6 dispatch: surface(body, p) + pick remap (stage 1 = the identity,
//    but the branch is real — it consults the published mounted set)
// ---------------------------------------------------------------------------
{
  const freq = 24
  const grid = getHexSphere(freq)
  const R = radiusForFrequency(freq)
  const aU = fineHexEdge(grid, R)
  const ls = loadedSet(grid, [0, 0, 1], 8 * aU, R, 4)
  // the mounted set's fine→doc map, flattened (stage 1: the identity)
  const byCell = new Map()
  for (const i of ls.byCell.keys()) byCell.set(i, i)
  const inCell = ls.focusCell // a cell index, in the cap
  // a cell guaranteed OUTSIDE the cap: the one whose center is nearest the
  // -Z pole (the cap sits at the +Z pole, far from the far hemisphere)
  let outCell = 0
  let minDot = Infinity
  for (let i = 0; i < grid.cellCount; i++) {
    const d = grid.centers[i * 3 + 2] // z component: nearest the -Z pole
    if (d < minDot) { minDot = d; outCell = i }
  }
  if (ls.byCell.has(outCell)) throw new Error('test setup: outCell unexpectedly in the cap')
  const docSurface = { sentinel: 'doc' }
  const bodyId = 'body-A'

  // no region yet: every query is the document, nothing is fine
  const okNoRegion =
    fineRegionOf(bodyId) === null &&
    !isFine(bodyId, inCell) &&
    surfaceOfRecord(docSurface, bodyId, inCell).fine === false &&
    surfaceOfRecord(docSurface, bodyId, inCell).surface === docSurface &&
    remapToDoc(bodyId, inCell) === inCell

  // publish the region: the mounted set is the record
  publishFineRegion(bodyId, byCell)
  const recIn = surfaceOfRecord(docSurface, bodyId, inCell)
  const recOut = surfaceOfRecord(docSurface, bodyId, outCell)
  const radIn = recordSurfaceRadius(42.5, bodyId, inCell)
  const radOut = recordSurfaceRadius(42.5, bodyId, outCell)
  const okRegion =
    fineRegionOf(bodyId) !== null &&
    isFine(bodyId, inCell) &&
    !isFine(bodyId, outCell) &&
    recIn.fine === true &&
    recIn.surface === docSurface && // stage 1: fine == doc, same object
    recOut.fine === false &&
    radIn.fine === true &&
    radIn.radius === 42.5 &&
    radOut.fine === false &&
    radOut.radius === 42.5 &&
    remapToDoc(bodyId, inCell) === inCell && // stage 1: the identity
    remapToDoc(bodyId, outCell) === outCell // passes through outside the region

  // clear the region: back to the document, nothing fine
  publishFineRegion(bodyId, null)
  const okCleared =
    fineRegionOf(bodyId) === null &&
    !isFine(bodyId, inCell) &&
    surfaceOfRecord(docSurface, bodyId, inCell).fine === false &&
    remapToDoc(bodyId, inCell) === inCell

  check('dispatch: no region → document, not fine', okNoRegion)
  check('dispatch: published region → fine branch, identity surface (stage 1)', okRegion)
  check('dispatch: cleared region → document again', okCleared)
}

// ---------------------------------------------------------------------------
// 9. the horizon gap: the cap must sit inside its patch with a bounded §4.4
//    texture — near a patch horizon the gnomonic plane point diverges
//    (chunk I/J ~ 1/z, texture box ~ 1/z²), so the region must not mount
// ---------------------------------------------------------------------------
{
  const freq = 12 // the testball grid
  const grid = getHexSphere(freq)
  const R = radiusForFrequency(freq)
  const aU = fineHexEdge(grid, R)
  const a = aU / R // the PLANE cell edge (dimensionless)
  const chunkSide = 1 // testball: one doc cell per chunk
  const capAngle = (10 * aU) / R // a cap ten hex edges across
  const gap = horizonGap(a, chunkSide)
  const safe = safeFocusAngle(capAngle, a, chunkSide)

  // safe = the TIGHTER of two bounds, both keeping the cap's plane extent
  // finite (the gnomonic plane point diverges at the patch horizon): the §4.4
  // texture bound (90° − capAngle − gap) and the fine lattice's HEX-COUNT
  // bound (maxCapPolarDeg − capAngle — a plane-uniform lattice makes a fixed
  // ANGLE cap cover a growing hex count toward the horizon). The hex-count
  // bound is always tighter (maxCapPolarDeg < 90°), so it is the one that wins.
  const safeTexture = Math.PI / 2 - capAngle - gap
  const safeHex = (C.fineDisc.maxCapPolarDeg * Math.PI) / 180 - capAngle
  const okFormula =
    Math.abs(gap - Math.atan(2 / (4096 * chunkSide * a))) < 1e-12 &&
    Math.abs(safe - Math.min(safeTexture, safeHex)) < 1e-12

  // a body-local direction at polar angle φ from the +Z pole
  const dirAt = (phi) => [Math.sin(phi), 0, Math.cos(phi)]

  const okPole = focusSafe([0, 0, 1], capAngle, a, chunkSide)
  const okMid = focusSafe(dirAt(Math.PI / 4), capAngle, a, chunkSide)
  const okHorizon = !focusSafe(dirAt(Math.PI / 2 - 0.001), capAngle, a, chunkSide)
  const okBand =
    focusSafe(dirAt(safe - 0.01), capAngle, a, chunkSide) &&
    !focusSafe(dirAt(safe + 0.01), capAngle, a, chunkSide)

  // a focus at the safe boundary: the cap's far edge sits at (90° − gap), so
  // every in-cap cell projects inside 1/tan(gap) and the mounted set's
  // bounding box fits the 4096² texture — the exact invariant the crash broke
  const ls = loadedSet(grid, dirAt(safe - 1e-3), capAngle * R, R, chunkSide)
  let maxPlane = 0
  for (const i of ls.byCell.keys()) {
    const b = i * 3
    const { x, y } = projectToPlane([grid.centers[b], grid.centers[b + 1], grid.centers[b + 2]])
    maxPlane = Math.max(maxPlane, Math.abs(x), Math.abs(y))
  }
  let Imin = Infinity, Jmin = Infinity, Imax = -Infinity, Jmax = -Infinity
  for (const c of ls.chunks) {
    Imin = Math.min(Imin, c.I)
    Imax = Math.max(Imax, c.I)
    Jmin = Math.min(Jmin, c.J)
    Jmax = Math.max(Jmax, c.J)
  }
  const texels = (Imax - Imin + 1) * (Jmax - Jmin + 1)
  const okBounded = maxPlane <= 1 / Math.tan(gap) + 1e-6 && texels <= 4096 * 4096

  check(`horizon gap: safe = 90° − capAngle − gap (gap ${(gap * 180) / Math.PI}° at this grid)`, okFormula)
  check('horizon gap: pole/mid-latitudes safe, the horizon band is no-region', okPole && okMid && okHorizon && okBand)
  check(`horizon gap: at the safe boundary the cap projects bounded (${texels} texels ≤ 4096²)`, okBounded)
}

console.log(failures === 0 ? '\nAll fine-disc checks passed.' : `\n${failures} fine-disc check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
