/**
 * finedisc.js — the fine-terrain region machinery (docs/terrain.txt).
 * ---------------------------------------------------------------------------
 * A body-fixed cap of radius `radius` (the visual horizon) around the player,
 * streamed in chunks and feathered to the document mesh at its outer edge.
 * This module is the PURE MACHINERY — framework-free (no three, no DOM), so
 * node tests and the geometry worker import it unmodified, exactly like the
 * rest of core/.
 *
 * STAGE 1 (this file, today): the fine grid IS the document grid. Every
 * mechanism below is real and exercised, but the heights are the document's —
 * a visual no-op. That isolates the mechanism from the data pipeline, so
 * stage 2 cannot hide a machinery bug behind a terrain reveal.
 *
 * STAGE 2 (later): the fine cells become the DEM pixels — a regular gnomonic
 * lattice at the catalog's pixel size. The projection / chunk / queue code
 * here is reused verbatim; only the cell source and the fine->doc map change.
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
  return Math.PI / 2 - capAngle - horizonGap(a, chunkSide, maxTexSide)
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
// fine chunk under p if a chunk is mounted there, the document surface
// otherwise — and EVERY consumer (walk, pick, altitude, park r, launch) goes
// through it.
//
// The MOUNTED SET lives in the THREE-side FineRegion (it owns the chunk
// meshes). It publishes it here, imperatively, on mount/evict/unmount — the
// same 60 Hz rule as the patcher above (never React state, never zustand).
// The published value is the region's FINE→DOC map (§3.4) flattened over the
// loaded set: a Map from each mounted chunk's fine cell to its enclosing
// document cell. Stage 1 the fine grid IS the document grid, so the map is
// the IDENTITY (cell -> cell) — but it is built and consulted for real, and
// the dispatch below branches on it. Stage 2 keys the map by the fine lattice
// hex and the branches return genuinely different values.

/** bodyId → { byCell: Map<fineCell, docCell> } — the mounted region's fine→doc map. */
const fineRegions = new Map()

/**
 * Publish the body's mounted fine region (the flattened fine→doc map over its
 * mounted chunks), or null to clear it (the session left the body). Called by
 * FineRegion on every mount, evict and unmount.
 */
export function publishFineRegion(bodyId, byCell) {
  if (byCell == null) fineRegions.delete(bodyId)
  else fineRegions.set(bodyId, { byCell })
}

/** The body's mounted region ({ byCell }) or null (no fine region mounted). */
export function fineRegionOf(bodyId) {
  return fineRegions.get(bodyId) || null
}

/** Is a fine chunk mounted at fine cell `cell` of body `bodyId`? */
export function isFine(bodyId, cell) {
  const r = fineRegions.get(bodyId)
  return !!r && r.byCell.has(cell)
}

/**
 * §6 dispatch, surface-object form: the surface of record at (body, position).
 * `docSurface` is the caller's memoized document surface (makeSurface result);
 * `cell` is the cell under the position (the caller's Voronoi lookup).
 *
 * Stage 1: the fine cells ARE the document cells and the heights agree exactly
 * (the fine grid is the document grid), so BOTH branches resolve to the SAME
 * `docSurface` object — the branch is real (checked against the published
 * mounted set) and the value is the identity. Stage 2: the fine branch returns
 * the chunk's fine surface (DEM blend + overlay heights), a different object.
 *
 * @returns {{ surface: object|null, fine: boolean }}
 */
export function surfaceOfRecord(docSurface, bodyId, cell) {
  const fine = isFine(bodyId, cell)
  // Stage 1: one object serves both branches (fine == doc). Stage 2: the fine
  // branch returns the per-chunk fine surface from the region.
  return { surface: docSurface, fine }
}

/**
 * §6 dispatch, raw-height form: the surface radius (from the body's center)
 * along a body-LOCAL direction, from the surface of record. The raw-height
 * consumers (craft altitude, the park anchor's terrain-resolved r, the launch
 * pad) route through this. `docRadius` is the fan radius the caller computed
 * from the document grid; `cell` is the cell under the direction.
 *
 * Stage 1: the fine surface's heights agree with the document's exactly, so
 * the fine and document branches return the SAME value — `docRadius` — and the
 * region check is real. Stage 2: the fine branch returns the chunk's fine fan
 * radius (DEM blend + overlay), which differs.
 *
 * @returns {{ radius: number, fine: boolean }}
 */
export function recordSurfaceRadius(docRadius, bodyId, cell) {
  const fine = isFine(bodyId, cell)
  return { radius: docRadius, fine }
}

/**
 * §6 pick remap: a fine-region hit → the DOCUMENT cell BEFORE anything
 * downstream (applyBrush, the selection, the brush preview) sees it — they all
 * take a document cell, unchanged. Routes through the published region's
 * byCell (the fine→doc map): Stage 1 the identity (a hit's cell is already a
 * document cell), Stage 2 the enclosing document cell. A cell outside the
 * region (or on a body with no region) is already a document cell and passes
 * through.
 */
export function remapToDoc(bodyId, cell) {
  const r = fineRegions.get(bodyId)
  if (r) {
    const doc = r.byCell.get(cell)
    if (doc !== undefined) return doc
  }
  return cell
}
