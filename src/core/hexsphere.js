/**
 * hexsphere.js
 * ---------------------------------------------------------------------------
 * Generates hexagonal grids on a sphere using the dual of a geodesic
 * icosphere. This is the classic construction behind "hex planets": every
 * cell is a hexagon except for exactly 12 pentagons (located at the vertices
 * of the base icosahedron). Because the underlying triangulation is nearly
 * regular, all cells have (near) identical surface area.
 *
 * A planet with subdivision frequency `n` contains:
 *   cells      = 10n² + 2      (2 pentagons + (10n² - 10) hexagons... plus
 *                               12 pentagons total, rest hexagons)
 *   radius     = sqrt(cells / 4π)   (when every cell covers 1 area unit)
 *
 * STORAGE — flat typed arrays indexed by cell (cell index === primal vertex
 * index), NOT per-cell objects. One atom world's grid reaches ~400k cells
 * (frequency 203), where a per-cell object graph would cost ~1.4 KB per
 * cell (hundreds of MB) instead of ~130 B:
 *
 *   centers    Float64Array  3V     unit direction of the cell center (the primal vertex)
 *   corners    Float32Array  18V    unit directions of the polygon corners (face
 *                                   centroids), CCW seen from outside, sides[i] used;
 *                                   read corner k of cell i at (i*6 + k)*3
 *   sides      Uint8Array   V       5 (pentagon) or 6 (hexagon)
 *   neighbors  Int32Array   6V      neighbouring cell index across each edge,
 *                                   aligned so edge k (corner k -> corner k+1)
 *                                   faces neighbors[i*6 + k]; slots >= sides[i] are -1
 *   areas      Float64Array V       exact spherical polygon area on the unit sphere
 *
 * (Centers stay Float64: the surface walker's Voronoi funnel compares cell
 * center dots with a 1e-12 epsilon and would misfire on Float32 noise.
 * Corners feed render geometry, where Float32 is invisible.)
 */

// ---------------------------------------------------------------------------
// Small vector helpers (arrays of 3)
// ---------------------------------------------------------------------------
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
function norm(a) {
  const l = Math.sqrt(dot3(a, a)) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

// ---------------------------------------------------------------------------
// Icosphere construction (flat: vertices into preallocated Float64, faces
// into Int32 — counts are exact: V = 10n²+2, F = 20n²)
// ---------------------------------------------------------------------------
const BASE_VERTICES = [
  [-1, (1 + Math.sqrt(5)) / 2, 0], [1, (1 + Math.sqrt(5)) / 2, 0],
  [-1, -(1 + Math.sqrt(5)) / 2, 0], [1, -(1 + Math.sqrt(5)) / 2, 0],
  [0, -1, (1 + Math.sqrt(5)) / 2], [0, 1, (1 + Math.sqrt(5)) / 2],
  [0, -1, -(1 + Math.sqrt(5)) / 2], [0, 1, -(1 + Math.sqrt(5)) / 2],
  [(1 + Math.sqrt(5)) / 2, 0, -1], [(1 + Math.sqrt(5)) / 2, 0, 1],
  [-(1 + Math.sqrt(5)) / 2, 0, -1], [-(1 + Math.sqrt(5)) / 2, 0, 1],
]
const BASE_FACES = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
]

function createIcosphere(n) {
  const V = 10 * n * n + 2
  const F = 20 * n * n
  const vertices = new Float64Array(3 * V)
  const faces = new Int32Array(3 * F)
  for (let v = 0; v < 12; v++) {
    const p = norm(BASE_VERTICES[v])
    vertices[v * 3] = p[0]
    vertices[v * 3 + 1] = p[1]
    vertices[v * 3 + 2] = p[2]
  }
  let vc = 12
  let fc = 0
  const pushFace = (a, b, c) => {
    faces[fc * 3] = a
    faces[fc * 3 + 1] = b
    faces[fc * 3 + 2] = c
    fc++
  }

  if (n === 1) {
    for (const [a, b, c] of BASE_FACES) pushFace(a, b, c)
    return { vertices, faces, V, F }
  }

  // Class-I geodesic subdivision: sample each icosahedron face on an n×n
  // barycentric grid and project every sample back onto the unit sphere.
  // Produces exactly 20n² triangles and 10n² + 2 vertices. Points on shared
  // base edges are merged via canonical keys (k measured from the lower
  // vertex index so both faces agree regardless of winding).
  const edgeDedupe = new Map()
  const pointOnEdge = (vFrom, vTo, k) => {
    const lo = Math.min(vFrom, vTo)
    const hi = Math.max(vFrom, vTo)
    const kk = vFrom < vTo ? k : n - k
    const key = `${lo}_${hi}_${kk}`
    const hit = edgeDedupe.get(key)
    if (hit !== undefined) return hit
    const b = vc * 3
    const f = vFrom * 3
    const t = vTo * 3
    const t01 = k / n
    const x = vertices[f] + (vertices[t] - vertices[f]) * t01
    const y = vertices[f + 1] + (vertices[t + 1] - vertices[f + 1]) * t01
    const z = vertices[f + 2] + (vertices[t + 2] - vertices[f + 2]) * t01
    const l = Math.sqrt(x * x + y * y + z * z) || 1
    vertices[b] = x / l
    vertices[b + 1] = y / l
    vertices[b + 2] = z / l
    edgeDedupe.set(key, vc)
    vc++
    return vc - 1
  }

  for (const [a, b, c] of BASE_FACES) {
    const cache2 = new Map()
    const gv = (i, j) => {
      const key = i * (n + 1) + j
      const hit = cache2.get(key)
      if (hit !== undefined) return hit
      const wA = n - i - j
      let idx
      if (i === 0 && j === 0) idx = a
      else if (i === n) idx = b
      else if (j === n) idx = c
      else if (j === 0) idx = pointOnEdge(a, b, i)
      else if (i === 0) idx = pointOnEdge(a, c, j)
      // on edge B→C the weights are (B=i, C=j): fraction measured from B is j/n
      else if (wA === 0) idx = pointOnEdge(b, c, j)
      else {
        const s = 1 / n
        const pa = a * 3
        const pb = b * 3
        const pc = c * 3
        const b3 = vc * 3
        const x = vertices[pa] * wA * s + vertices[pb] * i * s + vertices[pc] * j * s
        const y = vertices[pa + 1] * wA * s + vertices[pb + 1] * i * s + vertices[pc + 1] * j * s
        const z = vertices[pa + 2] * wA * s + vertices[pb + 2] * i * s + vertices[pc + 2] * j * s
        const l = Math.sqrt(x * x + y * y + z * z) || 1
        vertices[b3] = x / l
        vertices[b3 + 1] = y / l
        vertices[b3 + 2] = z / l
        idx = vc
        vc++
      }
      cache2.set(key, idx)
      return idx
    }
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        if (i + j <= n - 1) pushFace(gv(i, j), gv(i + 1, j), gv(i, j + 1))
        if (i + j <= n - 2) pushFace(gv(i + 1, j), gv(i + 1, j + 1), gv(i, j + 1))
      }
    }
  }
  if (vc !== V || fc !== F) throw new Error(`hexsphere build drift: ${vc}/${V} verts, ${fc}/${F} faces`)
  return { vertices, faces, V, F }
}

// ---------------------------------------------------------------------------
// Spherical polygon area (Oosterom–Strackee fan triangulation) — reads
// corner directions straight out of the scratch buffer (6 × [x,y,z])
// ---------------------------------------------------------------------------
function sphericalTriangleAreaS(s, i0, i1, i2) {
  const a0 = s[i0], a1 = s[i0 + 1], a2 = s[i0 + 2]
  const b0 = s[i1], b1 = s[i1 + 1], b2 = s[i1 + 2]
  const c0 = s[i2], c1 = s[i2 + 1], c2 = s[i2 + 2]
  const numerator = Math.abs(
    a0 * (b1 * c2 - b2 * c1) - a1 * (b0 * c2 - b2 * c0) + a2 * (b0 * c1 - b1 * c0)
  )
  const denominator =
    1 +
    (a0 * b0 + a1 * b1 + a2 * b2) +
    (b0 * c0 + b1 * c1 + b2 * c2) +
    (c0 * a0 + c1 * a1 + c2 * a2)
  return 2 * Math.atan2(numerator, denominator)
}

// ---------------------------------------------------------------------------
// Dual construction: vertex cells
// ---------------------------------------------------------------------------
const cache = new Map()

/**
 * Build (or fetch from cache) the hexagonal cell structure for a sphere of
 * the given geodesic frequency. See the module header for the flat storage
 * layout of the returned grid.
 * @param {number} frequency subdivision frequency (>= 1)
 */
export function getHexSphere(frequency) {
  const key = Math.max(1, Math.round(frequency))
  const hit = cache.get(key)
  if (hit) return hit

  const { vertices, faces, V, F } = createIcosphere(key)

  // Directed edge -> face lookup. A face [a,b,c] (CCW from outside) owns the
  // directed edges a->b, b->c, c->a. Every vertex has at most 6 outgoing
  // directed edges (its cell degree), so a fixed 6-slot table per vertex is
  // exact — no hashing, and lookups scan at most 6 slots.
  const heTarget = new Int32Array(6 * V).fill(-1)
  const heFace = new Int32Array(6 * V).fill(-1)
  const addDir = (from, to, fi) => {
    const b = from * 6
    for (let s = 0; s < 6; s++) {
      if (heTarget[b + s] === -1) {
        heTarget[b + s] = to
        heFace[b + s] = fi
        return
      }
    }
  }
  // one seed face per vertex (starts the ring walk)
  const seedFace = new Int32Array(V).fill(-1)
  for (let fi = 0; fi < F; fi++) {
    const a = faces[fi * 3]
    const b = faces[fi * 3 + 1]
    const c = faces[fi * 3 + 2]
    addDir(a, b, fi)
    addDir(b, c, fi)
    addDir(c, a, fi)
    if (seedFace[a] === -1) seedFace[a] = fi
    if (seedFace[b] === -1) seedFace[b] = fi
    if (seedFace[c] === -1) seedFace[c] = fi
  }
  const faceAt = (from, to) => {
    const b = from * 6
    for (let s = 0; s < 6; s++) {
      if (heTarget[b + s] === -1) return -1
      if (heTarget[b + s] === to) return heFace[b + s]
    }
    return -1
  }

  // For every primal vertex, walk the ring of faces around it and use their
  // centroids as the corners of the dual cell. The walk follows directed
  // edges (v -> q): face (v, p, q) is followed by the face owning (v, q),
  // which circles v exactly once on a closed manifold.
  const corners = new Float32Array(18 * V)
  const sides = new Uint8Array(V)
  const neighbors = new Int32Array(6 * V).fill(-1)
  const areas = new Float64Array(V)
  let areaSum = 0
  const scratch = new Float64Array(18) // ≤ 6 corner directions (float64 for exact areas)
  const ring = new Int32Array(7) // ≤ 6 face indices + count in ringUsed

  for (let v = 0; v < V; v++) {
    let ringUsed = 0
    let f = seedFace[v]
    for (let i = 0; i < 6; i++) {
      let dup = false
      for (let k = 0; k < ringUsed; k++) if (ring[k] === f) { dup = true; break }
      if (dup) break
      ring[ringUsed++] = f
      const x = faces[f * 3]
      const y = faces[f * 3 + 1]
      const z = faces[f * 3 + 2]
      const q = x === v ? z : y === v ? x : y
      const fi = faceAt(v, q)
      if (fi === -1) break
      f = fi
    }

    // corners + exact area from the ring's face centroids
    let area = 0
    for (let k = 0; k < ringUsed; k++) {
      const fc = ring[k]
      const fa = faces[fc * 3] * 3
      const fb = faces[fc * 3 + 1] * 3
      const fcv = faces[fc * 3 + 2] * 3
      let cx = vertices[fa] + vertices[fb] + vertices[fcv]
      let cy = vertices[fa + 1] + vertices[fb + 1] + vertices[fcv + 1]
      let cz = vertices[fa + 2] + vertices[fb + 2] + vertices[fcv + 2]
      const l = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1
      const s3 = k * 3
      scratch[s3] = cx / l
      scratch[s3 + 1] = cy / l
      scratch[s3 + 2] = cz / l
      corners[v * 18 + s3] = scratch[s3]
      corners[v * 18 + s3 + 1] = scratch[s3 + 1]
      corners[v * 18 + s3 + 2] = scratch[s3 + 2]
    }
    for (let k = 1; k < ringUsed - 1; k++) {
      area += sphericalTriangleAreaS(scratch, 0, k * 3, (k + 1) * 3)
    }
    sides[v] = ringUsed
    areas[v] = area
    areaSum += area

    // Edge k of the polygon (corner k -> corner k+1) is shared with the cell
    // of the primal vertex common to faces ring[k] and ring[k+1] (besides
    // v). Neighbour indices are referenced through the face->cell identity:
    // cell index === primal vertex index.
    for (let k = 0; k < ringUsed; k++) {
      const fa = ring[k]
      const fb = ring[(k + 1) % ringUsed]
      let shared = -1
      for (let t = 0; t < 3; t++) {
        const x = faces[fa * 3 + t]
        if (x === v) continue
        if (faces[fb * 3] === x || faces[fb * 3 + 1] === x || faces[fb * 3 + 2] === x) {
          shared = x
          break
        }
      }
      neighbors[v * 6 + k] = shared
    }
  }

  const result = {
    frequency: key,
    cellCount: V,
    centers: vertices, // Float64Array: cell i center at i*3
    corners, // Float32Array: cell i corner k at (i*6+k)*3
    sides,
    neighbors,
    areas,
    averageArea: areaSum / V,
  }
  cache.set(key, result)
  return result
}

// ---------------------------------------------------------------------------
// Derived quantities
// ---------------------------------------------------------------------------

/**
 * Planet radius for a given cell count, choosing the scale so each cell
 * covers exactly 1 world area unit (cells lie on a sphere of total area =
 * cellCount, so 4πR² = cellCount).
 */
export function radiusFromCellCount(cellCount) {
  return Math.sqrt(cellCount / (4 * Math.PI))
}

/** Number of cells for a geodesic frequency. */
export function cellCountForFrequency(frequency) {
  return 10 * frequency * frequency + 2
}

/** dot(cell i center, dir) — the hot comparison of the Voronoi funnel. */
export function dotCenter(hex, i, dir) {
  const b = i * 3
  return hex.centers[b] * dir[0] + hex.centers[b + 1] * dir[1] + hex.centers[b + 2] * dir[2]
}

/** true if cell j is a neighbour of cell i. */
export function hasNeighbor(hex, i, j) {
  const b = i * 6
  for (let k = 0, n = hex.sides[i]; k < n; k++) if (hex.neighbors[b + k] === j) return true
  return false
}

/**
 * BFS ring expansion: returns the set of cell indices within `radius` steps
 * of `start` (inclusive). radius 0 => just the start cell.
 */
export function getNeighborhood(hex, start, radius) {
  const result = new Set([start])
  if (radius <= 0) return result
  let frontier = [start]
  for (let r = 0; r < radius; r++) {
    const next = []
    for (const idx of frontier) {
      const b = idx * 6
      for (let k = 0, n = hex.sides[idx]; k < n; k++) {
        const nb = hex.neighbors[b + k]
        if (!result.has(nb)) {
          result.add(nb)
          next.push(nb)
        }
      }
    }
    frontier = next
  }
  return result
}
