/**
 * geometry.js
 * ---------------------------------------------------------------------------
 * Turns a planet document (list of hex elements) into render-ready vertex
 * data, one batch per terrain type. Pure math & arrays — THREE is not
 * imported here; the React components wrap the output in BufferGeometry.
 *
 * Each cell renders as:
 *   • a top polygon (triangle fan) at radius R + h, with corners inset
 *     slightly so hexagon borders read as grooves,
 *   • wall quads down to the lower of the two neighbouring heights (minus a
 *     small delta) so cliffs and mortar lines always close.
 *
 * Every emitted triangle records the index of the cell that produced it, so
 * raycast hits can be mapped straight back to `planet.elements[i]`.
 */

import { getHexSphere } from './hexsphere.js'
import { planetRadius, radiusForFrequency } from './planetMath.js'
import { sampleLodElements } from './lod.js'
import { TERRAIN_TYPES, terrainDefaults } from './terrain.js'
import { hexToInt } from './atoms.js'

const INSET = 0.08 // fraction corners are pulled toward the cell center
const GROOVE = 0.05 // extra wall depth for equal-height neighbours

// ---------------------------------------------------------------------------
// tiny vec helpers
// ---------------------------------------------------------------------------
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s]
const addv = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const dotv = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const crossv = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const norm3 = (a) => {
  const l = Math.sqrt(dotv(a, a)) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

function hexToRgb(hex) {
  const n = hexToInt(hex)
  if (n === null) return null
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/**
 * Vertex normals for the non-indexed batches this module emits: per-face
 * unit normals (three's computeVertexNormals on unshared vertices), computed
 * as raw math so the geometry worker never needs three. Matches
 * BufferGeometry.computeVertexNormals to float32 rounding.
 * @param {Float32Array} positions
 * @returns {Float32Array}
 */
export function computeFaceNormals(positions) {
  const n = new Float32Array(positions.length)
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const e1x = positions[i + 3] - positions[i]
    const e1y = positions[i + 4] - positions[i + 1]
    const e1z = positions[i + 5] - positions[i + 2]
    const e2x = positions[i + 6] - positions[i]
    const e2y = positions[i + 7] - positions[i + 1]
    const e2z = positions[i + 8] - positions[i + 2]
    let nx = e1y * e2z - e1z * e2y
    let ny = e1z * e2x - e1x * e2z
    let nz = e1x * e2y - e1y * e2x
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
    nx /= l
    ny /= l
    nz /= l
    n[i] = n[i + 3] = n[i + 6] = nx
    n[i + 1] = n[i + 4] = n[i + 7] = ny
    n[i + 2] = n[i + 5] = n[i + 8] = nz
  }
  return n
}

/**
 * Build one vertex batch per terrain type present on the planet.
 * @param {object} planet world-document planet
 * @returns {Map<string, {positions: Float32Array, colors: Float32Array, uvs: Float32Array, cellByTri: Uint32Array, triangles: number}>}
 */
export function buildPlanetGeometryData(planet) {
  const hex = getHexSphere(planet.frequency)
  const elements = planet.elements
  const R = planetRadius(planet)

  const batches = new Map()
  const batchFor = (type) => {
    let b = batches.get(type)
    if (!b) {
      b = { pos: [], col: [], uv: [], tri: [] }
      batches.set(type, b)
    }
    return b
  }

  const pushVert = (b, p, refDir, rgb) => {
    // Tangent-space UV: project the vertex onto the plane tangent to the
    // cell center. Seamless per-hex texturing, no global UV seam issues.
    const up = Math.abs(refDir[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0]
    const t1 = norm3(crossv(refDir, up))
    const t2 = crossv(refDir, t1)
    b.pos.push(p[0], p[1], p[2])
    b.col.push(rgb[0], rgb[1], rgb[2])
    b.uv.push(dotv(p, t1) + 0.5, dotv(p, t2) + 0.5)
  }

  // Adds a triangle, auto-winding so the face normal points along `outward`.
  const pushTri = (b, p0, p1, p2, outward, refDir, rgb, cellIdx) => {
    const e1 = addv(p1, p0.map((x) => -x))
    const e2 = addv(p2, p0.map((x) => -x))
    const flipped = dotv(crossv(e1, e2), outward) < 0
    const order = flipped ? [p0, p2, p1] : [p0, p1, p2]
    for (const p of order) pushVert(b, p, refDir, rgb)
    b.tri.push(cellIdx)
  }

  for (let i = 0; i < hex.cellCount; i++) {
    const el = elements[i]
    if (!el) continue
    const type = TERRAIN_TYPES[el.t] ? el.t : 'grass'
    const def = terrainDefaults(type)
    const b = batchFor(type)
    const rgb = hexToRgb(el.c) || hexToRgb(def.color) || [1, 1, 1]

    const h = el.h || 0
    const r = R + h
    const c3 = i * 3
    const centerDir = [hex.centers[c3], hex.centers[c3 + 1], hex.centers[c3 + 2]]
    const n = hex.sides[i]

    // Inset corner directions so adjacent hexes leave a thin groove.
    const corners = new Array(n)
    for (let k = 0; k < n; k++) {
      const k3 = (i * 6 + k) * 3
      const dir = [hex.corners[k3], hex.corners[k3 + 1], hex.corners[k3 + 2]]
      corners[k] = norm3(addv(mul(dir, 1 - INSET), mul(centerDir, INSET)))
    }
    const top = corners.map((dir) => mul(dir, r))
    const centerPoint = mul(centerDir, r)

    // ---- top polygon (fan) --------------------------------------------
    for (let k = 0; k < n; k++) {
      pushTri(b, centerPoint, top[(k + 1) % n], top[k], centerDir, centerDir, rgb, i)
    }

    // ---- walls ----------------------------------------------------------
    for (let k = 0; k < n; k++) {
      const nIdx = hex.neighbors[i * 6 + k]
      const nEl = elements[nIdx]
      const nH = nEl ? nEl.h || 0 : h
      const equal = Math.abs(h - nH) < 1e-4
      const hb = Math.min(h, nH) - (equal ? GROOVE : 0)
      if (h - hb < 1e-4) continue
      const a0 = top[k]
      const a1 = top[(k + 1) % n]
      const wallDir = norm3(addv(corners[k], corners[(k + 1) % n]))
      const b0 = mul(corners[k], R + hb)
      const b1 = mul(corners[(k + 1) % n], R + hb)
      pushTri(b, a0, a1, b1, wallDir, centerDir, rgb, i)
      pushTri(b, a0, b1, b0, wallDir, centerDir, rgb, i)
    }
  }

  // ---- pack ------------------------------------------------------------
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

/**
 * Geometry for one LOD level of a planet: the same batching as
 * buildPlanetGeometryData but built from a coarser grid sampled from the
 * document, with cellByTri remapped to the FINE (document) cell indices —
 * painting a distant planet edits the cells that produced the texel you see.
 *
 * A coarse level is the SAME planet seen at lower resolution, not a smaller
 * atom planet: build from a size factor that holds the base radius at the
 * document radius, so hexes grow to cover the cells they replaced and the
 * silhouette never changes with LOD. (Heights are absolute world units and
 * ride along unchanged — same convention as the stub preview rescale.)
 * @param {object} planet world-document planet
 * @param {number} frequency render frequency (>= planet.frequency → full res)
 */
export function buildLodGeometryData(planet, frequency) {
  if (!(frequency < planet.frequency)) return buildPlanetGeometryData(planet)
  const { elements, fineIndex } = sampleLodElements(planet, frequency)
  const scale = planetRadius(planet) / radiusForFrequency(frequency)
  const data = buildPlanetGeometryData({ frequency, elements, scale })
  for (const [, b] of data) {
    const cbt = b.cellByTri
    for (let i = 0; i < cbt.length; i++) cbt[i] = fineIndex[cbt[i]]
  }
  return data
}
