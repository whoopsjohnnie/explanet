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
 * For every cell we store:
 *   center      – unit direction of the cell center (the primal vertex)
 *   corners     – unit directions of the polygon corners (face centroids),
 *                 ordered counter-clockwise seen from outside
 *   neighbors   – index of the neighbouring cell across each edge,
 *                 aligned so that edge k (corner k -> corner k+1) faces
 *                 neighbors[k]
 *   area        – exact spherical polygon area on the unit sphere
 */

const EPS = 1e-9

// ---------------------------------------------------------------------------
// Small vector helpers (arrays of 3)
// ---------------------------------------------------------------------------
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const len = (a) => Math.sqrt(dot(a, a))
function norm(a) {
  const l = len(a) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s]

// ---------------------------------------------------------------------------
// Icosphere construction
// ---------------------------------------------------------------------------
function createIcosphere(frequency) {
  const t = (1 + Math.sqrt(5)) / 2
  const vertices = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(norm)
  const baseFaces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ]

  const n = frequency
  const faces = []
  if (n === 1) return { vertices, faces: baseFaces }

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
    const pf = vertices[vFrom]
    const pt = vertices[vTo]
    const t01 = k / n
    vertices.push(norm([pf[0] + (pt[0] - pf[0]) * t01, pf[1] + (pt[1] - pf[1]) * t01, pf[2] + (pt[2] - pf[2]) * t01]))
    edgeDedupe.set(key, vertices.length - 1)
    return vertices.length - 1
  }

  for (const [a, b, c] of baseFaces) {
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
        const pa = vertices[a]
        const pb = vertices[b]
        const pc = vertices[c]
        vertices.push(
          norm([
            pa[0] * wA * s + pb[0] * i * s + pc[0] * j * s,
            pa[1] * wA * s + pb[1] * i * s + pc[1] * j * s,
            pa[2] * wA * s + pb[2] * i * s + pc[2] * j * s,
          ])
        )
        idx = vertices.length - 1
      }
      cache2.set(key, idx)
      return idx
    }
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        if (i + j <= n - 1) faces.push([gv(i, j), gv(i + 1, j), gv(i, j + 1)])
        if (i + j <= n - 2) faces.push([gv(i + 1, j), gv(i + 1, j + 1), gv(i, j + 1)])
      }
    }
  }
  return { vertices, faces }
}

// ---------------------------------------------------------------------------
// Spherical polygon area (Oosterom–Strackee fan triangulation)
// ---------------------------------------------------------------------------
function sphericalTriangleArea(a, b, c) {
  const numerator = Math.abs(
    a[0] * (b[1] * c[2] - b[2] * c[1]) -
      a[1] * (b[0] * c[2] - b[2] * c[0]) +
      a[2] * (b[0] * c[1] - b[1] * c[0])
  )
  const denominator =
    1 + dot(a, b) + dot(b, c) + dot(c, a)
  return 2 * Math.atan2(numerator, denominator)
}

function sphericalPolygonArea(points) {
  let area = 0
  for (let i = 1; i < points.length - 1; i++) {
    area += sphericalTriangleArea(points[0], points[i], points[i + 1])
  }
  return area
}

// ---------------------------------------------------------------------------
// Dual construction: vertex cells
// ---------------------------------------------------------------------------
const cache = new Map()

/**
 * Build (or fetch from cache) the hexagonal cell structure for a sphere of
 * the given geodesic frequency.
 * @param {number} frequency subdivision frequency (>= 1)
 */
export function getHexSphere(frequency) {
  const key = Math.max(1, Math.round(frequency))
  const hit = cache.get(key)
  if (hit) return hit

  const { vertices, faces } = createIcosphere(key)
  const V = vertices.length

  // directed edge -> face lookup. A face [a,b,c] (CCW from outside) owns the
  // directed edges a->b, b->c, c->a.
  const faceAt = new Map()
  const ekey = (a, b) => a * V + b
  for (let fi = 0; fi < faces.length; fi++) {
    const [a, b, c] = faces[fi]
    faceAt.set(ekey(a, b), fi)
    faceAt.set(ekey(b, c), fi)
    faceAt.set(ekey(c, a), fi)
  }

  const vertexFaces = Array.from({ length: V }, () => [])
  for (let fi = 0; fi < faces.length; fi++) {
    const [a, b, c] = faces[fi]
    vertexFaces[a].push(fi)
    vertexFaces[b].push(fi)
    vertexFaces[c].push(fi)
  }

  // For every primal vertex, walk the ring of faces around it and use their
  // centroids as the corners of the dual cell. The walk follows directed
  // edges (v -> q): face (v, p, q) is followed by the face owning (v, q),
  // which circles v exactly once on a closed manifold.
  const cells = new Array(V)
  for (let v = 0; v < V; v++) {
    const ring = vertexFaces[v]
    const ordered = []
    const seen = new Set()
    let f = faces[ring[0]]
    for (let i = 0; i <= ring.length; i++) {
      if (seen.has(f)) break
      seen.add(f)
      ordered.push(f)
      const [x, y, z] = f
      // rotate so v is first: (v, p, q)
      const q = x === v ? z : y === v ? x : y
      const fi = faceAt.get(ekey(v, q))
      if (fi === undefined) break
      f = faces[fi]
    }

    const corners = ordered.map((fc) =>
      norm(scale(add(add(vertices[fc[0]], vertices[fc[1]]), vertices[fc[2]]), 1 / 3))
    )

    // Edge k of the polygon (corner k -> corner k+1) is shared with the cell
    // of the primal vertex common to faces ordered[k] and ordered[k+1]
    // (besides v). Neighbour indices are referenced through the face->cell
    // identity: cell index === primal vertex index.
    const edgeNeighbors = []
    for (let k = 0; k < ordered.length; k++) {
      const fa = ordered[k]
      const fb = ordered[(k + 1) % ordered.length]
      edgeNeighbors.push(findSharedEdgeVertex(fa, fb, v))
    }

    cells[v] = {
      index: v,
      center: vertices[v],
      corners,
      neighbors: edgeNeighbors,
      area: sphericalPolygonArea(corners),
      sides: corners.length,
    }
  }

  const result = {
    frequency: key,
    cellCount: V,
    cells,
    averageArea: cells.reduce((s, c) => s + c.area, 0) / V,
  }
  cache.set(key, result)
  return result
}

/** Given two adjacent triangles fa, fb around vertex v, return the third
 *  vertex (the primal vertex of the neighbouring cell across their shared
 *  dual edge). */
function findSharedEdgeVertex(fa, fb, v) {
  const inBoth = fa.filter((x) => x !== v && fb.includes(x))
  return inBoth[0]
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
      for (const n of hex.cells[idx].neighbors) {
        if (!result.has(n)) {
          result.add(n)
          next.push(n)
        }
      }
    }
    frontier = next
  }
  return result
}
