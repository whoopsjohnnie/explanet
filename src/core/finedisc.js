/**
 * finedisc.js — the fine-terrain region machinery (docs/terrain.txt).
 * ---------------------------------------------------------------------------
 * A body-fixed cap of radius `radius` (the visual horizon) around the player,
 * streamed in chunks and feathered to the document mesh at its outer edge.
 * This module is the PURE MACHINERY — framework-free (no three, no DOM), so
 * node tests and the geometry worker import it unmodified, exactly like the
 * rest of core/.
 *
 * STAGE 1 (done, pinned): the whole machinery ran at DOCUMENT frequency
 * (a visual no-op that isolated the mechanism from the data pipeline).
 *
 * STAGE 2 (this file, now): the fine cells are the DEM pixels — a regular
 * gnomonic lattice at the catalog's pixel size (fineTerrain.js supplies the
 * lattice math, the DEM sampling, the feather and the chord-fan geometry).
 * The projection / chunk / queue code here is reused verbatim; the cell
 * source, the heights and the fine->doc map are the DEM's.
 *
 * THE CHUNK LATTICE
 *   The sphere is covered by two antipodal gnomonic tangent patches, at the
 *   body's local +Z (patch 0) and -Z (patch 1). A body-local direction belongs
 *   to the patch of its z sign. Gnomonic projection maps the patch's
 *   hemisphere onto its tangent plane; a cap of radius <= ~1000 km (< 9 deg)
 *   sits near the patch pole, where the projection is ~equidistant (the ~1%
 *   edge distortion lives in the feather band). The fine hexes form a regular
 *   pointy-top lattice in that plane (edge `a` = the fine hex size, world
 *   units); a CHUNK is a `chunkSide` x `chunkSide` block of that lattice,
 *   keyed (patch, I, J). Chunks tile a patch seamlessly, so the fine surface
 *   has no seams inside the loaded set.
 *
 *   `chunkSide` is derived from the PHYSICAL chunk size (constants.json
 *   fineDisc.chunkKm) and the fine hex size: chunkSide = round(chunkKm/hexKm).
 *   That keeps a constant physical footprint across stages (64 fine hexes at
 *   stage 2's 1.85 km; ~5 doc cells at stage 1's 21.8 km — the 500 km cap
 *   holds only ~634 doc cells at f203, so a fixed cell count would be one
 *   unstreaming chunk).
 */

import { dotCenter } from './hexsphere.js'
import { cellAtDirection } from './surface.js'
import { buildPlanetGeometryData } from './geometry.js'
import { fineHexDirs, fineFanTables, fineFanRadius } from './fineTerrain.js'
import { C } from './constants.js'

const SQRT3 = Math.sqrt(3)

/** The visual-horizon cap radius in WORLD UNITS for a body: D_km -> D_u. */
export function capRadiusU(worldScale) {
  return (C.fineDisc.radius * 1000) / worldScale
}

/** The fine-hex count per chunk side, from the physical chunk size. */
export function chunkSideFor(hexKm) {
  return Math.max(1, Math.round(C.fineDisc.chunkKm / hexKm))
}

// ---------------------------------------------------------------------------
// The horizon gap (§3.2's precondition, quantified)
// ---------------------------------------------------------------------------
// The cap must sit WHOLLY inside one patch, and the §4.4 discard texture (the
// mounted set's bounding box) must stay bounded. Both fail at the patch
// horizon, where the gnomonic plane point diverges: a direction at horizon
// gap γ has plane radius tan(90° − γ) = 1/tan(γ), so a cap whose far edge is
// γ from the horizon makes the box span 2·(1/tan γ) in plane units —
// 2/(tan γ · chunkSide · a) texels. The smallest γ that keeps the texture
// within `maxTexSide` per side is atan(2/(maxTexSide · chunkSide · a)). A
// focus closer to the horizon than that (plus the cap's own radius) hosts NO
// region: the document surface renders there instead (stage 1: byte-identical;
// stage 2: the known cost of the two-patch scheme — §10.5's measurement
// decides the stage-2 encoding, which can lift the bound).

/** The required horizon gap (radians) for a bounded §4.4 texture. */
export function horizonGap(a, chunkSide, maxTexSide = 4096) {
  return Math.atan(2 / (maxTexSide * chunkSide * a))
}

/** The largest polar angle (radians, from the focus's patch pole) a focus may have. */
export function safeFocusAngle(capAngle, a, chunkSide, maxTexSide = 4096) {
  // TWO independent bounds on the focus's polar angle, both keeping the cap's
  // PLANE extent finite (the gnomonic plane point diverges at the patch
  // horizon), and the tighter one wins:
  //   (1) the §4.4 discard texture stays within maxTexSide² (horizonGap); and
  //   (2) the fine lattice's HEX COUNT stays bounded. The lattice is
  //       plane-uniform (edge a = the catalog pixel), so a fixed ANGLE cap
  //       covers a growing number of hexes as the focus drifts toward the
  //       horizon, where the plane stretches — the streaming work per focus
  //       move would diverge. Capping the cap's far-edge polar angle
  //       (focusPolar + capAngle <= maxCapPolarDeg) bounds the plane extent
  //       and thus the hex count, regardless of body or drive (constants.json
  //       fineDisc.maxCapPolarDeg). Beyond it the document surface renders —
  //       the gnomonic distortion is large there anyway.
  const maxCapPolar = (C.fineDisc.maxCapPolarDeg * Math.PI) / 180
  return Math.min(Math.PI / 2 - capAngle - horizonGap(a, chunkSide, maxTexSide), maxCapPolar - capAngle)
}

/** True if the cap around body-local `dir` can be streamed (see horizonGap). */
export function focusSafe(dir, capAngle, a, chunkSide, maxTexSide = 4096) {
  const polar = Math.acos(Math.min(1, Math.max(-1, Math.abs(dir[2]))))
  return polar <= safeFocusAngle(capAngle, a, chunkSide, maxTexSide)
}

// ---------------------------------------------------------------------------
// Gnomonic two-patch projection
// ---------------------------------------------------------------------------
// Patch 0: pole +Z, tangent plane z=1, basis e1=(1,0,0), e2=(0,1,0).
// Patch 1: pole -Z, tangent plane z=-1, basis e1=(1,0,0), e2=(0,-1,0) — the
// e2 flip keeps both patches right-handed, so the hex lattice orients the same
// way on either side of the body.

/** Which patch a body-local direction belongs to (the +Z hemisphere is patch 0). */
export function patchOf(dir) {
  return dir[2] >= 0 ? 0 : 1
}

/**
 * Gnomonic projection of a body-local direction to its patch's tangent plane.
 * Returns { patch, x, y } in world units. Near the patch horizon (z -> 0) the
 * plane point grows without bound; a tiny z clamp keeps the common case (the
 * cap, which is <= 9 deg from the focus) numerically safe.
 */
export function projectToPlane(dir) {
  let z = dir[2]
  const patch = z >= 0 ? 0 : 1
  if (z > -1e-9 && z < 1e-9) z = patch === 0 ? 1e-9 : -1e-9
  return patch === 0 ? { patch, x: dir[0] / z, y: dir[1] / z } : { patch, x: -dir[0] / z, y: dir[1] / z }
}

/** Inverse of projectToPlane: a patch plane point back to a body-local unit direction. */
export function dirFromPlane(patch, x, y) {
  const e2y = patch === 0 ? 1 : -1
  const nz = patch === 0 ? 1 : -1
  const py = y * e2y
  const pz = nz
  const l = Math.sqrt(x * x + py * py + pz * pz) || 1
  return [x / l, py / l, pz / l]
}

// ---------------------------------------------------------------------------
// The fine hex lattice (pointy-top, axial coordinates)
// ---------------------------------------------------------------------------

/** Plane position (world units) of fine hex (q, r) at lattice edge `a`. */
export function hexToPlane(a, q, r) {
  return { x: a * SQRT3 * (q + r / 2), y: a * 1.5 * r }
}

/** Nearest fine hex (axial) to a patch plane point. */
export function planeToHex(a, x, y) {
  const qf = (SQRT3 / 3 * x - 1 / 3 * y) / a
  const rf = (2 / 3 * y) / a
  // cube rounding
  const xf = qf
  const zf = rf
  const yf = -xf - zf
  let rx = Math.round(xf)
  let ry = Math.round(yf)
  let rz = Math.round(zf)
  const dx = Math.abs(rx - xf)
  const dy = Math.abs(ry - yf)
  const dz = Math.abs(rz - zf)
  if (dx > dy && dx > dz) rx = -ry - rz
  else if (dy > dz) ry = -rx - rz
  return { q: rx, r: rz }
}

/**
 * The fine hex edge in world units, from the grid's cell count and the body
 * radius. (The fine grid at stage 1 is the document grid; at stage 2 the fine
 * hex is the DEM pixel, whose edge is passed in directly.)
 */
export function fineHexEdge(grid, bodyRadiusU) {
  const N = grid.cellCount
  return Math.sqrt((8 * Math.PI * bodyRadiusU * bodyRadiusU) / (3 * SQRT3 * N))
}

// ---------------------------------------------------------------------------
// Chunk keys
// ---------------------------------------------------------------------------

/** Opaque chunk key for (patch, I, J). */
export function chunkKey(patch, I, J) {
  return patch + ':' + I + ':' + J
}

/** Parse a chunk key back to { patch, I, J }. */
export function parseChunkKey(key) {
  const p = key.split(':')
  return { patch: +p[0], I: +p[1], J: +p[2] }
}

/** The chunk containing fine hex (q, r) at chunk side `chunkSide`, in `patch`. */
export function chunkOfHex(patch, chunkSide, q, r) {
  return chunkKey(patch, Math.floor(q / chunkSide), Math.floor(r / chunkSide))
}

// ---------------------------------------------------------------------------
// The loaded set (stage 1: fine cells are the document cells)
// ---------------------------------------------------------------------------

/**
 * The chunks intersecting the cap of radius `capRadiusU` around `focusDir`.
 *
 * Stage 1: the fine cells ARE the document cells, so we walk the geodesic
 * document grid from the focus cell (a ring BFS bounded by the cap's cell
 * span) and group the in-cap cells by their gnomonic chunk. The focus cell's
 * chunk is always present; every in-cap cell is assigned to exactly one chunk.
 *
 * @returns {{ patch:number, focusCell:number, a:number,
 *   chunks:Array<{key,patch,I,J,cells:number[],fineToDoc:Uint32Array}>,
 *   byCell:Map<number,string> }} `a` is the PLANE cell edge (dimensionless) —
 *   feed it to hexToPlane/planeToHex and orderQueue.
 */
export function loadedSet(grid, focusDir, capRadiusU, bodyRadiusU, chunkSide) {
  const capAngle = capRadiusU / bodyRadiusU
  const cosCap = Math.cos(capAngle)
  // Two different lengths: the SPHERE cell edge (world units) bounds the BFS;
  // the PLANE cell edge (dimensionless, the gnomonic tangent plane sits at
  // unit radius) sizes the lattice. plane edge = sphere edge / R.
  const aU = fineHexEdge(grid, bodyRadiusU)
  const a = aU / bodyRadiusU
  const focusCell = cellAtDirection(grid, focusDir, -1)

  // Ring BFS bounded by the cap's cell span (+3 for the quasi-regular grid).
  const maxRings = Math.ceil(capRadiusU / aU) + 3
  const visited = new Uint8Array(grid.cellCount)
  visited[focusCell] = 1
  let ring = [focusCell]
  const cellsInCap = []
  for (let r = 0; r <= maxRings && ring.length; r++) {
    const next = []
    for (const idx of ring) {
      if (dotCenter(grid, idx, focusDir) >= cosCap) cellsInCap.push(idx)
      const b = idx * 6
      for (let k = 0, n = grid.sides[idx]; k < n; k++) {
        const nb = grid.neighbors[b + k]
        if (!visited[nb]) {
          visited[nb] = 1
          next.push(nb)
        }
      }
    }
    ring = next
  }

  // Group the in-cap cells by their gnomonic chunk.
  const byChunk = new Map()
  const byCell = new Map()
  for (const idx of cellsInCap) {
    const b = idx * 3
    const dir = [grid.centers[b], grid.centers[b + 1], grid.centers[b + 2]]
    const { patch, x, y } = projectToPlane(dir)
    const { q, r } = planeToHex(a, x, y)
    const key = chunkOfHex(patch, chunkSide, q, r)
    byCell.set(idx, key)
    let arr = byChunk.get(key)
    if (!arr) {
      arr = []
      byChunk.set(key, arr)
    }
    arr.push(idx)
  }

  const chunks = [...byChunk.entries()].map(([key, cells]) => {
    const { patch, I, J } = parseChunkKey(key)
    // Stage 1: the fine->doc map is the identity (the fine cells ARE the
    // document cells) — but it is BUILT and exercised, not just assumed.
    const fineToDoc = new Uint32Array(cells.length)
    for (let k = 0; k < cells.length; k++) fineToDoc[k] = cells[k]
    return { key, patch, I, J, cells, fineToDoc }
  })

  return { patch: patchOf(focusDir), focusCell, a, chunks, byCell }
}

// ---------------------------------------------------------------------------
// The ahead-of-velocity streaming queue
// ---------------------------------------------------------------------------

/**
 * Order a loaded set's chunks for streaming: chunks AHEAD of the velocity
 * vector first (the player is always looking where they are going), the rest
 * by distance, chunks BEHIND last. `velDir` is the focus's body-local velocity
 * (a zero vector degrades gracefully to a distance sort).
 * @param {Array} chunks the loaded chunks (from loadedSet)
 * @param {number[]} focusDir the focus body-local direction
 * @param {number[]} velDir the focus body-local velocity
 * @param {number} chunkSide the chunk side (fine hexes)
 * @param {number} a the fine hex edge (world units)
 */
export function orderQueue(chunks, focusDir, velDir, chunkSide, a) {
  const fp = projectToPlane(focusDir)
  // The ahead direction in the patch plane: where the focus is HEADING.
  let ax = 0
  let ay = 1
  const vlen = Math.sqrt(velDir[0] * velDir[0] + velDir[1] * velDir[1] + velDir[2] * velDir[2])
  if (vlen > 1e-12) {
    const eps = 1e-4
    const fx = focusDir[0] + eps * velDir[0]
    const fy = focusDir[1] + eps * velDir[1]
    const fz = focusDir[2] + eps * velDir[2]
    const fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1
    const fut = projectToPlane([fx / fl, fy / fl, fz / fl])
    const dx = fut.x - fp.x
    const dy = fut.y - fp.y
    const dl = Math.sqrt(dx * dx + dy * dy)
    if (dl > 1e-9) {
      ax = dx / dl
      ay = dy / dl
    }
  }
  const scored = chunks.map((c) => {
    const cp = hexToPlane(a, c.I * chunkSide + chunkSide / 2, c.J * chunkSide + chunkSide / 2)
    const dx = cp.x - fp.x
    const dy = cp.y - fp.y
    return { c, dist: Math.sqrt(dx * dx + dy * dy), ahead: dx * ax + dy * ay }
  })
  const ahead = scored.filter((s) => s.ahead > 0).sort((p, q) => p.dist - q.dist)
  const behind = scored.filter((s) => s.ahead <= 0).sort((p, q) => p.dist - q.dist)
  return [...ahead, ...behind].map((s) => s.c)
}

/**
 * The document cell that a fine cell of `chunk` maps to. Stage 1: identity —
 * the k-th fine cell is the k-th document cell in the chunk. Stage 2 replaces
 * this with the catalog's fine-hex -> enclosing-document-cell map.
 */
export function fineToDocOf(chunk, k) {
  return chunk.fineToDoc[k]
}

// ---------------------------------------------------------------------------
// Chunk geometry (the document's cell builder, applied to a lattice block)
// ---------------------------------------------------------------------------

/**
 * Render vertex data for ONE chunk: the document's cell builder run over just
 * the chunk's cells. Every in-chunk cell emits its own top fan and its walls;
 * a wall reads the NEIGHBOUR's height from the full document (the builder's
 * `cellSet` restriction only suppresses emission, never the lookup), so a
 * chunk's boundary closes correctly against out-of-chunk neighbours — the
 * higher cell owns the step, exactly as in the whole-planet build.
 *
 * `cellByTri` records the DOCUMENT cell index in every triangle (the inert
 * fallback, "as today"); the chunk's fine→doc map is the separate table the
 * dispatch remaps through (§6).
 *
 * Stage 1: the fine cells ARE the document cells, so a chunk's vertices are
 * byte-identical to the matching part of the document mesh — delete every
 * chunk and the body is exactly as it was (§11).
 *
 * @param {object} planet the full world-document planet (frequency, elements, scale)
 * @param {object} chunk  a loadedSet chunk ({ cells, fineToDoc, ... })
 * @returns {Map<string, {positions,colors,uvs,cellByTri,triangles}>} one batch per terrain type
 */
export function buildChunkGeometryData(planet, chunk) {
  return buildPlanetGeometryData(planet, new Set(chunk.cells))
}

// ---------------------------------------------------------------------------
// The edit overlay (§5) + the chunk patcher registry
// ---------------------------------------------------------------------------
// A paint stroke on the fine region does four things (§5): (1) applyBrush on
// the enclosing document cell — exactly as today; (2) record the stroke in the
// sparse EDIT OVERLAY; (3) patch the mounted chunk's vertices the same frame,
// so the weld invariant holds for the fine layer; (4) re-synthesize the chunk
// in the background (the backstop that keeps its stored bytes honest).
//
// This module is framework-free, so it holds the DATA (the overlay) and an
// opaque per-body PATCHER callback; the THREE logic that fills (3)/(4) lives in
// the component that owns the chunk geometries (FineRegion), which registers
// itself here. The store's paint path calls recordFineEdit + notifyFineEdit;
// it never touches three.js.

/** bodyId → (cellKey → { h, t, c }). Stage 1: cellKey is the DOCUMENT cell
 *  (the fine→doc map is the identity), so the overlay matches the stored
 *  element — the path is exercised, the data is a no-op. Stage 2 keys it by
 *  the fine lattice hex (the painted DEM pixel, which differs from the
 *  enclosing document average). */
const fineEdits = new Map()

/** Record one painted fine cell (§5 step 2). */
export function recordFineEdit(bodyId, cellKey, h, t, c) {
  let m = fineEdits.get(bodyId)
  if (!m) {
    m = new Map()
    fineEdits.set(bodyId, m)
  }
  m.set(cellKey, { h, t, c })
}

/** The recorded edit for a fine cell, or undefined. */
export function fineEditFor(bodyId, cellKey) {
  const m = fineEdits.get(bodyId)
  return m ? m.get(cellKey) : undefined
}

/** Drop a body's overlay (unmount / reload). */
export function clearFineEdits(bodyId) {
  fineEdits.delete(bodyId)
}

/** bodyId → patcher(cells, planet). The opaque THREE-aware closure FineRegion
 *  registers; core only invokes it, never inspects it. */
const finePatchers = new Map()

/** Register (or, with null, clear) a body's chunk patcher. */
export function setFinePatcher(bodyId, patcher) {
  if (patcher) finePatchers.set(bodyId, patcher)
  else finePatchers.delete(bodyId)
}

/**
 * Tell the body's mounted fine region that these DOCUMENT cells changed (§5
 * steps 3-4). No-op when no fine region is mounted on the body. `planet` is
 * the fresh world-document planet carrying the updated elements.
 */
export function notifyFineEdit(bodyId, cells, planet) {
  const p = finePatchers.get(bodyId)
  if (p) p(cells, planet)
}

// ---------------------------------------------------------------------------
// The §6 dispatch — surface(body, p): which surface is the RECORD at p
// ---------------------------------------------------------------------------
// "One surface = the rendered surface" needs one dispatch point: a body with
// fine chunks mounted resolves its surface of record for a position p — the
// fine hex under p if a chunk is mounted there, the document surface
// otherwise — and EVERY consumer (walk, pick, altitude, park r, launch) goes
// through it.
//
// The MOUNTED SET lives in the THREE-side FineRegion (it owns the chunk
// meshes). It publishes it here, imperatively, on mount/evict/unmount — the
// same 60 Hz rule as the patcher above (never React state, never zustand).
// The published region is the mounted chunks' FINE HEXES (the DEM pixel
// lattice, stage 2), each carrying its enclosing DOCUMENT cell (the fine→doc
// map, §3.4) and its composited height:
//
//   region = { a, patch, R, maxH, byHex, fanCache }
//     a, patch, R     the fine hex edge (plane units), the region's patch and
//                     the body radius — the lattice the byHex keys live in
//     byHex           Map `${q},${r}` → { q, r, docCell, h }
//     fanCache        Map `${q},${r}` → the hex's chord-fan table (lazy — a
//                     hex's fan planes are orientation-only, so the per-query
//                     radius is a rescale, the surface.js fanRadiusAt rule)
//
// The region object is MUTATED in place as chunks land/evict (the same object
// stays published); the dispatch reads it fresh on every query.

/** bodyId → the mounted fine region (see above) — the published mounted set. */
const fineRegions = new Map()

/**
 * Publish the body's mounted fine region (the mutated region object), or null
 * to clear it (the session left the body). FineRegion calls it when the
 * region (re)appears and on unmount; it then mutates the object on every
 * chunk land/evict, which the dispatch sees immediately.
 */
export function publishFineRegion(bodyId, region) {
  if (region == null) fineRegions.delete(bodyId)
  else fineRegions.set(bodyId, region)
}

/** The body's mounted region or null (no fine region mounted). */
export function fineRegionOf(bodyId) {
  return fineRegions.get(bodyId) || null
}

/**
 * The mounted fine hex under a body-LOCAL unit `dir`, or null (no chunk
 * mounted there — or the dir is on the other patch). O(1): the gnomonic
 * projection, the cube-round, one Map lookup.
 */
export function fineHexUnder(region, dir) {
  const p = projectToPlane(dir)
  if (p.patch !== region.patch) return null
  const h = planeToHex(region.a, p.x, p.y)
  return region.byHex.get(h.q + ',' + h.r) || null
}

/** Is a fine chunk mounted under body-LOCAL unit direction `dir` of `bodyId`? */
export function isFine(bodyId, dir) {
  const r = fineRegions.get(bodyId)
  return !!r && !!fineHexUnder(r, dir)
}

/** The fine hex's chord-fan table, cached on the region (orientation-only). */
function fanFor(region, e) {
  const k = e.q + ',' + e.r
  let fan = region.fanCache.get(k)
  if (!fan) {
    const d = fineHexDirs(region.patch, e.q, e.r, region.a)
    fan = fineFanTables(d.c3, d.corners)
    region.fanCache.set(k, fan)
  }
  return fan
}

/**
 * §6 dispatch: the composite surface of record for a body — the FINE surface
 * where a chunk is mounted under the queried direction, the document surface
 * elsewhere, continuous at the boundary by the feather (§4.3). Shape-
 * compatible with makeSurface: { hex, R, hs, maxH, metrics, heightAt } — and
 * `heightAt(dir, hint) → { cell, h, radius }` ALWAYS reports the DOCUMENT cell
 * (the fine→doc map is applied here), so every downstream consumer — the
 * brush, the selection, the HUD — takes a document cell, unchanged.
 */
export function makeFineSurface(docSurface, region) {
  const heightAt = (dir, hint) => {
    const e = fineHexUnder(region, dir)
    if (e) {
      return {
        cell: e.docCell,
        h: e.h,
        radius: fineFanRadius(fanFor(region, e), region.R + e.h, dir),
      }
    }
    return docSurface.heightAt(dir, hint)
  }
  return {
    hex: docSurface.hex,
    R: docSurface.R,
    hs: docSurface.hs,
    maxH: Math.max(docSurface.maxH, region.maxH),
    metrics: docSurface.metrics,
    heightAt,
    fine: true,
  }
}

/**
 * §6 dispatch, surface-object form: the surface of record at (body, dir),
 * where `dir` is the body-LOCAL unit direction of the position. A chunk
 * mounted under `dir` → the composite fine surface; otherwise the document
 * surface (the caller's own object — nothing is built on the doc path).
 *
 * @returns {{ surface: object|null, fine: boolean }}
 */
export function surfaceOfRecord(docSurface, bodyId, dir) {
  const region = fineRegions.get(bodyId)
  if (region && fineHexUnder(region, dir)) return { surface: makeFineSurface(docSurface, region), fine: true }
  return { surface: docSurface, fine: false }
}

/**
 * §6 dispatch, raw-height form: the surface radius (from the body's center)
 * along a body-LOCAL unit direction, from the surface of record. The raw-
 * height consumers (craft altitude, the park anchor's terrain-resolved r, the
 * launch pad) route through this. `docRadius` is the fan radius the caller
 * computed from the document grid; the fine branch returns the fine hex's
 * chord-fan radius (the composited height), which differs.
 *
 * @returns {{ radius: number, fine: boolean }}
 */
export function recordSurfaceRadius(docRadius, bodyId, dir) {
  const region = fineRegions.get(bodyId)
  if (region) {
    const e = fineHexUnder(region, dir)
    if (e) return { radius: fineFanRadius(fanFor(region, e), region.R + e.h, dir), fine: true }
  }
  return { radius: docRadius, fine: false }
}

/**
 * §6 pick remap — the single remap point the pick routes through. With the
 * stage-2 dispatch the hit's cell is ALREADY the document cell (the composite
 * surface applies the fine→doc map at the sample), so this passes through; it
 * stays as the named contract point so the pick code reads the same as it did
 * when the remap did the work.
 */
export function remapToDoc(bodyId, cell) {
  return cell
}
