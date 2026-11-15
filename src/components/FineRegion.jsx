/**
 * FineRegion.jsx — the streamed fine-terrain region for ONE body
 * (docs/terrain.txt, stage 2: the fine grid IS the DEM-pixel grid).
 *
 * The fine hex is the terrain catalog's pixel (fineTerrain.js): a body-fixed
 * gnomonic lattice at the catalog's pixel size (1.85 km for Earth), chunked
 * on finedisc.js's chunk lattice (reused verbatim), streamed ahead of the
 * player and feathered to the document mesh at the cap's edge (§4.3).
 *
 * THE HEIGHT SOURCE (docs/terrain2.txt §6.2 — the inverted terrain model):
 * in a world that declares `hex_meters`, the fine hex's height is the
 * STORED hexcells row under it (nearest point — the same sampling rule as
 * the DEM), streamed in lat/lon rectangles from /api/bodies/:id/hex/tile.
 * The lattice, the chord-fan geometry, the feather, the §4.4 suppression,
 * the §6 dispatch, the worker jobs and the queue are ALL UNCHANGED — only
 * `demElevationAt` swaps to `hexHeightAt` (and the edge a = hexMeters/R
 * instead of the pixel size). Bodies without stored hexes (generated, or a
 * world without hex_meters) take the DEM path exactly as before.
 *
 * Ownership, by data:
 *   • the MAIN THREAD owns the §4.1 synthesis — per fine hex the final
 *     height h_final (overlay > feather blend > DEM > document), the fine→doc
 *     map (cellAtDirection) and the terrain look (the document cell's
 *     type/color). It sees the DEM tiles (it fetched them, LRU + dedupe) and
 *     the document grid, so the worker stays pure vertex math
 *     (fineTerrain.buildFineGeometryData — no DEM, no atoms in the payload).
 *   • the WORKER builds one chunk's chord-fan geometry (the 'finechunk' job,
 *     the same seq-supersede contract as the LOD chain and stage-1 chunks).
 *   • the MOUNTED SET is published to the core dispatch (finedisc §6): ONE
 *     region object, mutated in place as chunks land/evict (byHex → the
 *     landed hexes' {docCell, h} + the fan cache); the dispatch reads it
 *     fresh on every query. Never through React state or zustand (60 Hz).
 *
 * THE FEATHER MOVES WITH THE FOCUS. A chunk's blend weights are a function
 * of the focus at synthesis time, so when the focus crosses a chunk boundary
 * every mounted chunk is re-synthesized (re-requested; seq-supersede drops
 * the stale in-flight job, the old geometry stays visible until its
 * replacement lands — the seam stays continuous at all times, §4.3). A chunk
 * whose heights are focus-INDEPENDENT (fully inside the feather: h = h_dem;
 * fully outside: h = h_doc; painted cells are independent too) keeps its
 * build — only the feather-ring chunks re-synthesize on a focus move.
 *
 * The DOCUMENT mesh's suppression material is owned by the Planet component
 * (it applies it to TerrainMeshes); FineRegion only fills the handle's
 * uniforms and the mounted-chunk data texture. When the session leaves the
 * body the Planet drops the material and the unmount disposes every chunk +
 * zeroes the cap — the body is back to its LOD chain, byte-identical to a
 * world that never had chunks (§7, §11).
 */

import { useEffect, useRef, useSyncExternalStore } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useStore } from '../state/store.js'
import { registry } from '../core/physics.js'
import { getHexSphere } from '../core/hexsphere.js'
import { planetRadius } from '../core/planetMath.js'
import {
  capRadiusU,
  focusSafe,
  projectToPlane,
  hexToPlane,
  planeToHex,
  chunkOfHex,
  chunkKey,
  parseChunkKey,
  orderQueue,
  setFinePatcher,
  clearFineEdits,
  publishFineRegion,
  fineEditFor,
} from '../core/finedisc.js'
import {
  fineLatticeEdge,
  fineChunkSide,
  fineHexDirs,
  dirToLatLon,
  tileKeyFor,
  demElevationAt,
  enumerateFineHexes,
  featherWeight,
  buildFineGeometryData,
  elementType,
  elementColor,
  storesHexCells,
  hexLatticeEdge,
  hexChunkSide,
  hexHeightAt,
  getTerrainCatalogProvider,
  getTerrainTileProvider,
  getHexTileProvider,
} from '../core/fineTerrain.js'
import { highResGrid } from '../core/hexlattice.js'
import { cellAtDirection } from '../core/surface.js'
import { computeFaceNormals } from '../core/geometry.js'
import { buildFineChunkAsync } from '../three/geometryService.js'
import { getTerrainMaterials } from '../three/materials.js'
import { setMountedTexture } from '../three/fineMaterial.js'
import { walkerLocation } from '../core/surface.js'
import { craftRuntime, eva, flightFocus } from '../core/motion.js'
import { C } from '../core/constants.js'

/** The DEM tile LRU cap (~2.7 MB of 28 KiB int16 tiles) + the tile-range
 *  corner margin (deg) — the block spans ~1.9° and a tile is 2°, so the
 *  center tile alone is never guaranteed. */
const TILE_CACHE_MAX = 96
const TILE_MARGIN_DEG = 0.05

/**
 * The coarse focus fact: is `planet` the body the player's session is
 * associated with? Foot: the walker's body (the zustand session). Craft and
 * EVA: the motion.js FLIGHT FOCUS (motion.js) — the craft's anchor body while
 * parked, its dominant body in flight, the adrift astronaut's dominant body —
 * a mutable fact the step loops publish and that changes only on a real
 * association change (board, launch, park, a gravity-domain crossing), never
 * per frame, so it is safe as React state via useSyncExternalStore. The
 * per-frame PROXIMITY check is fineFocusFor below: a focused body that the
 * player is no longer close to (beyond the cap radius) streams nothing — its
 * region tears down on the first frame fineFocusFor returns null.
 */
export function useIsFocus(planet) {
  const player = useStore((s) => s.player)
  const focusId = useSyncExternalStore(flightFocus.subscribe, flightFocus.getSnapshot)
  if (!player || player.kind === 'freeCam') return false
  if (player.kind === 'foot') return player.bodyId === planet.id
  if (player.kind === 'craft' || player.kind === 'eva') return focusId === planet.id
  return false
}

/** The player's body-LOCAL focus (cap center + ahead velocity) or null. */
function fineFocusFor(planetId) {
  const s = useStore.getState()
  const player = s.player
  if (!player || player.kind === 'freeCam') return null

  if (player.kind === 'foot') {
    if (player.bodyId !== planetId) return null
    // the Walker's useFrame runs AFTER this one (Planet mounts before Walker),
    // so on the very first frame walkerLocation still holds its default dir —
    // [0,1,0], the +Z patch horizon, where the gnomonic projection blows up to
    // an absurd focus chunk. Wait until the walker has actually initialized
    // its location on this body before streaming.
    if (walkerLocation.bodyId !== planetId) return null
    return { dir: walkerLocation.dir.slice(), vel: [0, 0, 0] }
  }

  let pos = null
  if (player.kind === 'craft') {
    const rt = craftRuntime.get(player.craftId)
    if (!rt) return null
    if (rt.state.mode === 'park') {
      if (rt.state.bodyId !== planetId) return null
      return { dir: rt.state.dir.slice(), vel: [0, 0, 0] }
    }
    pos = rt.state.pos
  } else if (player.kind === 'eva') {
    if (!eva.state) return null
    pos = eva.state.pos
  }
  if (!pos) return null

  const body = registry.bodies.get(planetId)
  if (!body) return null
  const rel = [pos.x - body.pos.x, pos.y - body.pos.y, pos.z - body.pos.z]
  const d = Math.hypot(rel[0], rel[1], rel[2]) || 1
  if (d > body.radius + capRadiusU(s.world.scale)) return null
  const q = body.quat
  const rot = (v) => {
    const qx = -q.x, qy = -q.y, qz = -q.z, qw = q.w
    const vx = v[0], vy = v[1], vz = v[2]
    const tx = 2 * (qy * vz - qz * vy)
    const ty = 2 * (qz * vx - qx * vz)
    const tz = 2 * (qx * vy - qy * vx)
    return [
      vx + qw * tx + (qy * tz - qz * ty),
      vy + qw * ty + (qz * tx - qx * tz),
      vz + qw * tz + (qx * ty - qy * tx),
    ]
  }
  return { dir: rot([rel[0] / d, rel[1] / d, rel[2] / d]), vel: [0, 0, 0] }
}

export default function FineRegion({ planet, renderPlanet, supp }) {
  const groupRef = useRef(null)
  const mountedRef = useRef(new Map()) // chunk key → entry (see requestChunk)
  const regionRef = useRef(null) // the published region object (mutated in place)
  const lastFocusChunkRef = useRef(null)
  const focusRef = useRef(null) // the latest body-local focus {dir, vel}
  const ctxRef = useRef(null) // the latest synthesis context (useFrame refreshes it)
  const catalogRef = useRef(null) // { pixelDeg, tileSize } once the summary arrives
  const catalogFailedRef = useRef(false)
  const tilesRef = useRef(new Map()) // LRU: `${tileLat},${tileLon}` → Int16Array
  const inflightRef = useRef(new Map()) // tile key → in-flight Promise
  const hexTilesRef = useRef(new Map()) // LRU: rect key → Map<row,{col0,h}> (stored hexes)
  const hexInflightRef = useRef(new Map()) // rect key → in-flight Promise
  const hexGridRef = useRef(null) // the body's stored-hex grid (useFrame refreshes it)
  const genRef = useRef(0) // bumped per focus-chunk move (supersedes stale tile waits)
  const materials = getTerrainMaterials()

  // The derived rule (docs/terrain2.txt §5.1): the world declares hex_meters
  // and this body STORES its surface (generated giants are the exemption)
  // with a database identity to stream from. No per-body resolution flag.
  const world = useStore((s) => s.world)
  const hexMode = storesHexCells(planet, world)

  // ------------------------------------------------------------------ tiles
  /**
   * One DEM tile (int16 meters), from the LRU or the provider (deduped by
   * key; a failed/absent tile resolves to null — the synthesis falls back to
   * the document height there). The LRU persists across band exits (the
   * cache is per §7, not per region) and is cleared only on unmount.
   */
  const getTile = (tl, ln) => {
    const k = tl + ',' + ln
    let t = tilesRef.current.get(k)
    if (t) {
      tilesRef.current.delete(k)
      tilesRef.current.set(k, t) // refresh the LRU position
      return Promise.resolve(t)
    }
    let p = inflightRef.current.get(k)
    if (!p) {
      const catalog = planet.terrain.catalog
      p = getTerrainTileProvider()(catalog, tl, ln)
        .then((arr) => {
          if (arr) {
            tilesRef.current.set(k, arr)
            while (tilesRef.current.size > TILE_CACHE_MAX) tilesRef.current.delete(tilesRef.current.keys().next().value)
          }
          return arr
        })
        .catch(() => null)
        .finally(() => inflightRef.current.delete(k))
      inflightRef.current.set(k, p)
    }
    return p
  }

  /**
   * One stored-hex rectangle (Map<row,{col0,h}>, heights in world units),
   * from the LRU or the hex-tile provider (deduped by rect key; a failed
   * fetch resolves to null — the synthesis falls back to the document height
   * there, exactly as with an absent DEM tile). The LRU persists across band
   * exits (per §7, the cache is not per region) and is cleared on unmount.
   */
  const getHexTile = (rect) => {
    let t = hexTilesRef.current.get(rect.key)
    if (t) {
      hexTilesRef.current.delete(rect.key)
      hexTilesRef.current.set(rect.key, t) // refresh the LRU position
      return Promise.resolve(t)
    }
    let p = hexInflightRef.current.get(rect.key)
    if (!p) {
      p = getHexTileProvider()(planet.dbId, rect.lat0, rect.lat1, rect.lon0, rect.lon1)
        .then((tiles) => {
          if (tiles) {
            hexTilesRef.current.set(rect.key, tiles)
            while (hexTilesRef.current.size > TILE_CACHE_MAX) hexTilesRef.current.delete(hexTilesRef.current.keys().next().value)
          }
          return tiles
        })
        .catch(() => null)
        .finally(() => hexInflightRef.current.delete(rect.key))
      hexInflightRef.current.set(rect.key, p)
    }
    return p
  }

  // The catalog summary (GET /api/terrain shape, through the provider seam
  // the headless harness swaps for synthetic DEMs). Fetched once per session
  // mount; a failure (or a catalog absent from the DB) is remembered, so the
  // region simply never appears and the fetch is not spammed. In hex mode
  // there is no catalog: the stored-hex grid is built synchronously
  // (highResGrid) in useFrame.
  useEffect(() => {
    if (hexMode) return
    let alive = true
    // the getter returns the provider FUNCTION (the tile call below invokes it
    // the same way); invoke it here to get the catalog-summary Promise
    getTerrainCatalogProvider()()
      .then((summary) => {
        if (!alive) return
        const row = (summary.catalogs || []).find((c) => c.catalog === planet.terrain.catalog)
        if (row) catalogRef.current = { pixelDeg: row.pixelDeg, tileSize: row.tileSize }
        else catalogFailedRef.current = true
      })
      .catch(() => {
        if (alive) catalogFailedRef.current = true
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planet.id, hexMode])

  // --------------------------------------------------------------- synthesis
  /**
   * The §4.1 synthesis of one chunk: the FULL block (chunkSide² fine hexes)
   * plus its one-hex HALO ring — the neighbour heights a boundary wall closes
   * against. h_final is a pure function of (DEM, document, overlay, focus),
   * so adjacent chunks agree on the shared boundary, and a re-synthesis at a
   * new focus is the only thing that moves a chunk's bytes:
   *
   *     h_final = edit.h                       (the §5 overlay, where painted)
   *             = w · (elev_m / scale) + (1−w) · h_doc   (the feather blend)
   *             = h_doc                        (no DEM tile, or w = 0)
   *
   * The fine→doc map (docCell) is cellAtDirection with the hint carried
   * across the block (adjacent hexes → a 1-2 step greedy climb); the look
   * (type/rgb) is the document cell's own (§3.4 — the fine layer shows the
   * DEM's relief but keeps the document's look). `allIndep` marks a chunk
   * whose heights are focus-INDEPENDENT (no unpainted hex in the feather
   * band) — such a chunk keeps its build across focus moves (see useFrame).
   */
  const synthesizeChunk = (ctx, I, J) => {
    const n = ctx.chunkSide
    const q0 = I * n
    const r0 = J * n
    const hexes = []
    const halo = []
    const docCells = new Set()
    const haloDocCells = new Set()
    let maxH = -Infinity
    let allIndep = true
    let hint = -1
    for (let dr = -1; dr <= n; dr++) {
      for (let dq = -1; dq <= n; dq++) {
        const Q = q0 + dq
        const Rr = r0 + dr
        const c3 = fineHexDirs(ctx.patch, Q, Rr, ctx.a).c3
        const docCell = cellAtDirection(ctx.grid, c3, hint)
        hint = docCell
        const el = ctx.elements[docCell]
        const hDoc = el.h || 0
        const edit = fineEditFor(ctx.bodyId, docCell)
        let h
        if (edit) {
          h = edit.h
        } else {
          const cosD = c3[0] * ctx.focusDir[0] + c3[1] * ctx.focusDir[1] + c3[2] * ctx.focusDir[2]
          const w = featherWeight(Math.acos(Math.min(1, Math.max(-1, cosD))), ctx.capAngle, ctx.featherFrac)
          if (w > 0 && w < 1) allIndep = false
          // THE SOURCE SWAP (docs/terrain2.txt §6.2): stored hexcells (the
          // world's hex_meters) or the DEM — both nearest-point samples that
          // fall back to the document height when the data is absent. Stored
          // heights are already in WORLD UNITS (the stored datum); DEM
          // elevation is meters and divides by the world scale as before.
          let hFine = null
          if (w > 0) {
            if (ctx.gridHr) {
              hFine = hexHeightAt(c3, ctx.gridHr, ctx.hexTiles)
            } else {
              const { latDeg, lonDeg } = dirToLatLon(c3)
              const elev = demElevationAt(latDeg, lonDeg, ctx.tiles, ctx.pixelDeg, ctx.tileSize)
              if (elev != null) hFine = elev / ctx.scale
            }
          }
          h = hFine == null ? hDoc : w * hFine + (1 - w) * hDoc
        }
        if (dr >= 0 && dq >= 0 && dr < n && dq < n) {
          docCells.add(docCell)
          if (h > maxH) maxH = h
          // `e` is the object the dispatch's region.byHex holds — the patcher
          // mutates its .h in place, and the dispatch reads it fresh per query
          hexes.push({ q: Q, r: Rr, h, type: elementType(el), rgb: elementColor(el), docCell, e: { q: Q, r: Rr, docCell, h } })
        } else {
          haloDocCells.add(docCell)
          halo.push({ q: Q, r: Rr, h })
        }
      }
    }
    return { hexes, halo, docCells, haloDocCells, maxH, allIndep }
  }

  /**
   * The DEM tiles a chunk's block needs: the lat/lon of the block's four
   * corners + center (± TILE_MARGIN_DEG), expanded to whole tiles. The block
   * spans ~1.9° and a tile is 2°, so the corner range (not the center tile)
   * is what covers it; a wrap of the antimeridian is handled as two ranges.
   * A tile that is absent from the DB simply never arrives — the synthesis
   * falls back to the document height there (graceful, by design).
   */
  const tilesForChunk = (ctx, I, J) => {
    const n = ctx.chunkSide
    const q0 = I * n
    const r0 = J * n
    const c = n >> 1
    const pts = [
      [q0, r0],
      [q0 + n - 1, r0],
      [q0, r0 + n - 1],
      [q0 + n - 1, r0 + n - 1],
      [q0 + c, r0 + c],
    ]
    let latMin = 90
    let latMax = -90
    let lonMin = 180
    let lonMax = -180
    for (const [q, r] of pts) {
      const { latDeg, lonDeg } = dirToLatLon(fineHexDirs(ctx.patch, q, r, ctx.a).c3)
      if (latDeg < latMin) latMin = latDeg
      if (latDeg > latMax) latMax = latDeg
      if (lonDeg < lonMin) lonMin = lonDeg
      if (lonDeg > lonMax) lonMax = lonDeg
    }
    const tileDeg = ctx.tileSize * ctx.pixelDeg
    const out = new Set()
    // The tile keys MUST agree with tileKeyFor — the LOOKUP side of
    // demElevationAt — including its edge clamps. A raw floor lattice walks
    // past the edge (lat < 0 with a 120° tile → floor gives −120, but the
    // lookup pins to the −90 edge tile), so the fetch would land a tile the
    // lookup never reads and the synthesis would silently fall back to the
    // document. Deriving the range from tileKeyFor keeps both sides on the
    // same lattice by construction.
    const [latLo] = tileKeyFor(latMin - TILE_MARGIN_DEG, 0, ctx.tileSize, ctx.pixelDeg)
    const [latHi] = tileKeyFor(latMax + TILE_MARGIN_DEG, 0, ctx.tileSize, ctx.pixelDeg)
    const addRange = (l0, l1) => {
      // tileKeyFor returns [latTile, lonTile] — lat FIRST. With a 0 placeholder
      // in the other axis, take the component that was actually asked for.
      const [, loLo] = tileKeyFor(0, l0 - TILE_MARGIN_DEG, ctx.tileSize, ctx.pixelDeg)
      const [, loHi] = tileKeyFor(0, l1 + TILE_MARGIN_DEG, ctx.tileSize, ctx.pixelDeg)
      for (let la = latLo; la <= latHi; la += tileDeg)
        for (let lo = loLo; lo <= loHi; lo += tileDeg)
          out.add(Math.round(la) + ',' + Math.round(lo))
    }
    if (lonMax - lonMin <= 180) addRange(lonMin, lonMax)
    else {
      addRange(lonMin, 180)
      addRange(-180, lonMax)
    }
    return [...out]
  }

  /**
   * The stored-hex RECTANGLES a chunk's block + halo need (hex mode): the
   * block's four corners expanded by ONE fine hex (the halo ring a boundary
   * wall closes against) plus the center, their lat/lon bounds, then a
   * NEAREST-POINT margin of one stored hex (a fine hex at the edge maps to
   * the stored hex nearest its center — up to ~half a stored hex beyond the
   * exact corner). The antimeridian is split into two ranges, as above.
   * Each rect is fetched as a whole (the server packs its rows); the key is
   * the quantized bounds, so an adjacent chunk's overlapping rect is a
   * different key (the LRU holds both — the rects are small).
   */
  const hexRectsForChunk = (ctx, I, J) => {
    const grid = ctx.gridHr
    const n = ctx.chunkSide
    const q0 = I * n
    const r0 = J * n
    const c = n >> 1
    const pts = [
      [q0 - 1, r0 - 1],
      [q0 + n, r0 - 1],
      [q0 - 1, r0 + n],
      [q0 + n, r0 + n],
      [q0 + c, r0 + c],
    ]
    let latMin = 90
    let latMax = -90
    let lonMin = 180
    let lonMax = -180
    for (const [q, r] of pts) {
      const { latDeg, lonDeg } = dirToLatLon(fineHexDirs(ctx.patch, q, r, ctx.a).c3)
      if (latDeg < latMin) latMin = latDeg
      if (latDeg > latMax) latMax = latDeg
      if (lonDeg < lonMin) lonMin = lonDeg
      if (lonDeg > lonMax) lonMax = lonDeg
    }
    // one stored hex of slack (grid.dLat = the stored row spacing, radians)
    const DEG_INV = 180 / Math.PI
    const mLat = 2 * grid.dLat * DEG_INV
    const midLat = ((latMin + latMax) / 2) / DEG_INV
    const mLon = (2 * Math.sqrt(3) * ctx.a) / Math.max(0.05, Math.cos(midLat)) * DEG_INV
    const lat0 = Math.max(-90, latMin - mLat)
    const lat1 = Math.min(90, latMax + mLat)
    const rects = []
    const addRange = (g0, g1) =>
      rects.push({ lat0, lat1, lon0: g0, lon1: g1, key: `${lat0.toFixed(3)},${lat1.toFixed(3)},${g0.toFixed(3)},${g1.toFixed(3)}` })
    const m0 = lonMin - mLon
    const m1 = lonMax + mLon
    if (m1 - m0 <= 180) addRange(Math.max(-180, m0), Math.min(180, m1))
    else {
      addRange(Math.max(-180, m0), 180)
      addRange(-180, Math.min(180, m1))
    }
    return rects
  }

  // --------------------------------------------------------- chunk lifecycle
  /** Worker batches (assembled {type, geometry}) → mounted meshes. */
  const makeChunkMeshes = (batches) => {
    const meshes = []
    const geos = []
    for (const b of batches) {
      const mesh = new THREE.Mesh(b.geometry, materials[b.type] || materials.grass)
      mesh.raycast = () => null // the analytic pick owns picking, not these
      meshes.push(mesh)
      geos.push(b.geometry)
    }
    return { meshes, geos }
  }

  /** Raw builder batches → meshes, synchronously (the §5 same-frame patch). */
  const makeChunkMeshesFromBatches = (batches) => {
    const meshes = []
    const geos = []
    for (const [type, d] of batches) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(d.positions, 3))
      g.setAttribute('color', new THREE.BufferAttribute(d.colors, 3))
      g.setAttribute('uv', new THREE.BufferAttribute(d.uvs, 2))
      g.setAttribute('normal', new THREE.BufferAttribute(computeFaceNormals(d.positions), 3))
      g.userData.cellByTri = d.cellByTri
      const mesh = new THREE.Mesh(g, materials[type] || materials.grass)
      mesh.raycast = () => null
      meshes.push(mesh)
      geos.push(g)
    }
    return { meshes, geos }
  }

  /** §4.4: the document shader's discard texture = the MOUNTED (live) chunks. */
  const refreshSuppression = () => {
    if (!supp) return
    const chunks = [...mountedRef.current.values()].filter((c) => c.meshes)
    const box = setMountedTexture(supp, chunks)
    supp.uniforms.fdTexOffset.value.set(box.Imin, box.Jmin)
    supp.uniforms.fdTexSize.value.set(box.W, box.H)
  }

  /** The region's maxH = the max over the mounted chunks (O(#chunks)). */
  const computeMaxH = () => {
    let m = 0
    for (const c of mountedRef.current.values()) if (c.meshes && c.maxH > m) m = c.maxH
    return m
  }

  /**
   * Request (or RE-REQUEST) one chunk: fetch its tiles, run the §4.1
   * synthesis on the main thread, post the vertex math to the worker.
   * Re-requests are the norm — the feather moves with the focus (see
   * useFrame) — and the worker's seq-supersede plus the old-geometry-
   * stays-visible swap keep the surface continuous through the transition.
   */
  const requestChunk = (chunk, ctx) => {
    let entry = mountedRef.current.get(chunk.key)
    if (!entry) {
      entry = { key: chunk.key, I: chunk.I, J: chunk.J, meshes: null, geos: null, liveHexes: null, liveHalo: null, liveHaloMap: null, allIndep: false, cancel: null }
      mountedRef.current.set(chunk.key, entry)
    }
    const gen = genRef.current
    // the chunk's data, from whichever source this body streams (stored
    // hexcells in a hex_meters world, else the DEM tiles):
    const dataPromises = ctx.gridHr
      ? hexRectsForChunk(ctx, chunk.I, chunk.J).map((r) => getHexTile(r))
      : tilesForChunk(ctx, chunk.I, chunk.J).map((k) => {
          const [tl, ln] = k.split(',')
          return getTile(+tl, +ln)
        })
    Promise.all(dataPromises)
      .then(() => {
        if (gen !== genRef.current) return // a newer focus-chunk move superseded this
        const syn = synthesizeChunk(ctx, chunk.I, chunk.J)
        if (entry.cancel) entry.cancel() // drop the superseded in-flight build
        entry.cancel = buildFineChunkAsync(
          planet.id,
          chunk.key,
          {
            R: ctx.R,
            patch: ctx.patch,
            a: ctx.a,
            hexes: syn.hexes.map((hx) => ({ q: hx.q, r: hx.r, h: hx.h, type: hx.type, rgb: hx.rgb, docCell: hx.docCell })),
            halo: syn.halo,
            onBatches: (batches) => {
              const e = mountedRef.current.get(chunk.key)
              if (!e || !groupRef.current) return // unmounted mid-flight
              const { meshes, geos } = makeChunkMeshes(batches)
              for (const m of meshes) groupRef.current.add(m)
              if (e.meshes) {
                // a replacement: the old geometry is out, the new one in
                for (const m of e.meshes) groupRef.current.remove(m)
                for (const g of e.geos) g.dispose()
              }
              e.meshes = meshes
              e.geos = geos
              e.liveHexes = syn.hexes
              e.liveHalo = syn.halo
              e.liveHaloMap = new Map(syn.halo.map((h) => [h.q + ',' + h.r, h.h]))
              e.docCells = syn.docCells
              e.haloDocCells = syn.haloDocCells
              e.maxH = syn.maxH
              e.allIndep = syn.allIndep
              // the dispatch sees the landed hexes NOW (the published region
              // object is mutated in place — it was never re-published)
              const region = regionRef.current
              if (region) {
                for (const hx of syn.hexes) region.byHex.set(hx.q + ',' + hx.r, hx.e)
                region.maxH = computeMaxH()
              }
              refreshSuppression()
            },
            onError: () => {
              const e = mountedRef.current.get(chunk.key)
              if (!e) return
              if (!e.meshes) mountedRef.current.delete(chunk.key) // first build died
              refreshSuppression()
            },
          }
        )
      })
      .catch(() => {})
  }

  /** Evict one chunk: geometry disposed, the dispatch loses its hexes. */
  const evictChunk = (key) => {
    const c = mountedRef.current.get(key)
    if (!c) return
    if (c.cancel) c.cancel()
    if (c.meshes) {
      for (const m of c.meshes) if (groupRef.current) groupRef.current.remove(m)
      for (const g of c.geos) g.dispose()
    }
    const region = regionRef.current
    if (region && c.liveHexes) for (const hx of c.liveHexes) region.byHex.delete(hx.q + ',' + hx.r)
    mountedRef.current.delete(key)
    if (region) region.maxH = computeMaxH()
    refreshSuppression()
  }

  /** Full region teardown (the session left, or the focus is in the
   *  no-region band near a patch horizon): every chunk evicted, the §6
   *  dispatch falls back to the document, the suppression cap is zeroed.
   *  The tile LRU is KEPT (§7: the cache survives evictions). */
  const teardownRegion = () => {
    for (const key of [...mountedRef.current.keys()]) evictChunk(key)
    lastFocusChunkRef.current = null
    focusRef.current = null
    if (regionRef.current) {
      regionRef.current.byHex.clear()
      regionRef.current.fanCache.clear()
      regionRef.current.maxH = 0
      regionRef.current = null
    }
    publishFineRegion(planet.id, null)
    if (supp) {
      supp.uniforms.fdCapPlane.value = 0 // radius 0 → the discard is a no-op
      setMountedTexture(supp, [])
    }
  }

  // ---- §5 the stroke patcher: keep the mounted chunks honest on a doc edit
  // A paint changed these DOCUMENT cells (applyBrush did the rest). The
  // mounted chunks whose block OR halo covers a painted cell are re-
  // synthesized and rebuilt the SAME FRAME (the weld invariant for the fine
  // layer: the painted height is on the rendered surface and on the surface
  // of record before the next frame). The halo scope matters: a boundary
  // wall reads the NEIGHBOUR's fine height, so a stroke across a chunk edge
  // must also refresh the neighbour's walls (a stale neighbour wall would
  // leave a see-through step gap). Chunks whose heights come out unchanged
  // (re-painting the same value mid-drag) skip the geometry rebuild.
  const rebuildChunk = (entry, ctx) => {
    const syn = synthesizeChunk(ctx, entry.I, entry.J)
    if (entry.liveHexes) {
      let same = true
      for (let i = 0; i < syn.hexes.length; i++)
        if (syn.hexes[i].h !== entry.liveHexes[i].h) {
          same = false
          break
        }
      if (same && entry.liveHaloMap)
        for (const h of syn.halo)
          if (entry.liveHaloMap.get(h.q + ',' + h.r) !== h.h) {
            same = false
            break
          }
      if (same) return false
    }
    const hTable = new Map()
    for (const h of syn.halo) hTable.set(h.q + ',' + h.r, h.h)
    for (const h of syn.hexes) hTable.set(h.q + ',' + h.r, h.h)
    const built = syn.hexes.map((hx) => {
      const d = fineHexDirs(ctx.patch, hx.q, hx.r, ctx.a)
      return { q: hx.q, r: hx.r, c3: d.c3, corners: d.corners, h: hx.h, type: hx.type, rgb: hx.rgb, docCell: hx.docCell }
    })
    const batches = buildFineGeometryData(ctx.R, ctx.patch, ctx.a, built, (q, r) => hTable.get(q + ',' + r) ?? 0)
    const { meshes, geos } = makeChunkMeshesFromBatches(batches)
    for (const m of entry.meshes) if (groupRef.current) groupRef.current.remove(m)
    for (const g of entry.geos) g.dispose()
    for (const m of meshes) if (groupRef.current) groupRef.current.add(m)
    entry.meshes = meshes
    entry.geos = geos
    entry.liveHexes = syn.hexes
    entry.liveHalo = syn.halo
    entry.liveHaloMap = new Map(syn.halo.map((h) => [h.q + ',' + h.r, h.h]))
    entry.docCells = syn.docCells
    entry.haloDocCells = syn.haloDocCells
    entry.maxH = syn.maxH
    entry.allIndep = syn.allIndep
    const region = regionRef.current
    if (region) for (const hx of syn.hexes) region.byHex.set(hx.q + ',' + hx.r, hx.e)
    return true
  }

  const patcher = (cells, freshPlanet) => {
    const region = regionRef.current
    const base = ctxRef.current
    const focus = focusRef.current
    if (!region || !base || !focus) return
    const cellSet = new Set(cells)
    const ctx = { ...base, elements: freshPlanet.elements, focusDir: focus.dir }
    const touched = new Set()
    const consider = (entry) => {
      if (!entry || !entry.liveHexes || touched.has(entry.key)) return
      // cheap guard: does the stroke even reach this chunk (block or halo)?
      let reaches = false
      for (const c of cellSet)
        if (entry.docCells && (entry.docCells.has(c) || entry.haloDocCells.has(c))) {
          reaches = true
          break
        }
      if (!reaches) return
      touched.add(entry.key)
      if (rebuildChunk(entry, ctx)) region.maxH = computeMaxH()
    }
    for (const entry of mountedRef.current.values()) consider(entry)
    // the 8-neighbour ring of every touched chunk (halo consistency above)
    for (const key of [...touched]) {
      const { patch, I, J } = parseChunkKey(key)
      for (let dI = -1; dI <= 1; dI++)
        for (let dJ = -1; dJ <= 1; dJ++) {
          if (!dI && !dJ) continue
          consider(mountedRef.current.get(chunkKey(patch, I + dI, J + dJ)))
        }
    }
  }

  // Register the patcher for the body's lifetime (and clear its overlay on
  // teardown) — core/finedisc.js is framework-free and only invokes it.
  useEffect(() => {
    setFinePatcher(planet.id, patcher)
    return () => {
      setFinePatcher(planet.id, null)
      clearFineEdits(planet.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planet.id])

  // ---------------------------------------------------------------- the frame
  useFrame(() => {
    if (!renderPlanet) return
    const focus = fineFocusFor(planet.id)
    if (!focus) {
      // the session left the body: full unmount
      if (lastFocusChunkRef.current !== null) teardownRegion()
      return
    }
    focusRef.current = focus

    const world = useStore.getState().world
    const worldScale = world.scale
    const grid = getHexSphere(renderPlanet.frequency)
    const R = planetRadius(renderPlanet)
    const D = capRadiusU(worldScale)
    const capAngle = D / R
    const radiusM = R * worldScale

    // The fine height SOURCE (docs/terrain2.txt §6.2): the world's stored
    // hexcells when this body stores its surface (the derived rule —
    // hex_meters + !generated + a dbId to stream from; no per-body flag),
    // else the DEM catalog (stage 2). The lattice/chunk math is the same
    // shape either way — only the edge and the height lookup differ.
    let a, chunkSide
    let catalog = null
    if (storesHexCells(planet, world)) {
      a = hexLatticeEdge(world.hex_meters, radiusM)
      chunkSide = hexChunkSide(C.fineDisc.chunkKm, world.hex_meters)
      hexGridRef.current = highResGrid(radiusM, world.hex_meters)
    } else {
      hexGridRef.current = null
      catalog = catalogRef.current
      if (!catalog || catalogFailedRef.current) {
        // the summary has not arrived (or the catalog is not in the DB): no
        // region until it does — a failure is remembered, never retried
        if (lastFocusChunkRef.current !== null) teardownRegion()
        return
      }
      a = fineLatticeEdge(catalog.pixelDeg) // the fine hex edge (plane units) = the pixel
      chunkSide = fineChunkSide(C.fineDisc.chunkKm, catalog.pixelDeg, radiusM)
    }

    // §3.2: the cap must sit wholly inside one patch and the §4.4 texture
    // must stay bounded. Beyond the safe angle there is NO region: the
    // document surface renders there, and the dispatch publishes null (§6).
    if (!focusSafe(focus.dir, capAngle, a, chunkSide)) {
      if (lastFocusChunkRef.current !== null) teardownRegion()
      return
    }

    const focusPlane = projectToPlane(focus.dir)
    const fh = planeToHex(a, focusPlane.x, focusPlane.y)
    const focusChunkKey = chunkOfHex(focusPlane.patch, chunkSide, fh.q, fh.r)

    // §6 patch invariant: the region's lattice is bound to the patch it was
    // created on, and `region.patch` is never updated in place. A STALE focus
    // can only reach this point on the very first frame — `walkerLocation` is
    // module-global (it outlives a harness boot) and the Walker's own useFrame
    // runs AFTER this one, so a leftover dir from a previous session on the
    // same body can sit in the OTHER patch. Left alone, fineHexUnder would
    // compare the fresh dir's patch against the stale region patch and miss
    // every query for the rest of the session (isFine silently false). A
    // continuous move can NOT trigger this: focusSafe tears the region down at
    // 82.27° polar, well before the patch boundary (|z| → 0, 90°), so a live
    // region always shares its focus's patch. Tear down on a mismatch and let
    // the block below recreate the region under the current patch this frame.
    if (regionRef.current && regionRef.current.patch !== focusPlane.patch) teardownRegion()

    // the region (re)appears: publish it (ONE object, mutated in place from
    // here on — the dispatch reads it fresh on every query)
    if (!regionRef.current) {
      regionRef.current = { a, patch: focusPlane.patch, R, maxH: 0, byHex: new Map(), fanCache: new Map() }
      publishFineRegion(planet.id, regionRef.current)
    }

    ctxRef.current = {
      patch: focusPlane.patch,
      a,
      chunkSide,
      focusDir: focus.dir,
      capAngle,
      featherFrac: C.fineDisc.feather,
      grid,
      elements: renderPlanet.elements,
      tiles: tilesRef.current,
      // the stored-hex source (hex mode): the body's latitude-row grid + the
      // fetched rect tiles (null/absent → the synthesis falls back to the
      // document height, as with an absent DEM tile)
      gridHr: hexGridRef.current,
      hexTiles: hexTilesRef.current,
      pixelDeg: catalog ? catalog.pixelDeg : 0,
      tileSize: catalog ? catalog.tileSize : 0,
      R,
      scale: worldScale,
      bodyId: planet.id,
    }
    const ctx = ctxRef.current

    if (focusChunkKey !== lastFocusChunkRef.current) {
      lastFocusChunkRef.current = focusChunkKey
      genRef.current++ // stale tile waits from the previous move die here

      // §3.3: loaded = the chunks intersecting the cap (the cap's fine hexes,
      // grouped by their chunk). A requested chunk carries the FULL block,
      // not block ∩ cap — the §4.4 suppression is chunk-box granular, so the
      // fine surface must cover the whole block or boundary chunks leave
      // see-through gaps; the out-of-cap hexes are w = 0 exactly (the
      // feather) and sit on the document surface.
      const inCap = enumerateFineHexes(a, focusPlane.patch, focus.dir, D, R)
      const desired = new Set()
      for (const h of inCap) desired.add(chunkOfHex(focusPlane.patch, chunkSide, h.q, h.r))

      for (const key of [...mountedRef.current.keys()]) if (!desired.has(key)) evictChunk(key)

      // THE FEATHER MOVES WITH THE FOCUS: a chunk's blend weights were
      // synthesized at the previous focus, so every mounted chunk is
      // re-requested at the new one (seq-supersede; the old geometry stays
      // visible until its replacement lands — §4.3's "continuous at ALL
      // times, including mid-stream"). A chunk whose heights are focus-
      // independent (allIndep: fully inside the feather → h_dem, fully
      // outside → h_doc, painted cells always) keeps its build — only the
      // feather-ring chunks pay the re-synthesis. The bound is conservative
      // (plane distances bound the 3D angles), so a skipped chunk is ALWAYS
      // focus-independent at the new focus.
      const inner = (1 - C.fineDisc.feather) * capAngle
      const toRequest = []
      for (const key of desired) {
        const { patch, I, J } = parseChunkKey(key)
        const entry = mountedRef.current.get(key)
        let skip = false
        if (entry && entry.liveHexes && entry.allIndep) {
          const cp = hexToPlane(a, I * chunkSide + chunkSide / 2, J * chunkSide + chunkSide / 2)
          const dp = Math.hypot(cp.x - focusPlane.x, cp.y - focusPlane.y)
          const cr = 1.5 * chunkSide * a // the block's plane radius (conservative)
          skip = dp + cr <= inner || Math.max(0, dp - cr) >= capAngle
        }
        if (!skip) toRequest.push({ key, patch, I, J })
      }
      const ordered = orderQueue(toRequest, focus.dir, focus.vel, chunkSide, a)
      for (const chunk of ordered) requestChunk(chunk, ctx)

      // the suppression cap follows the focus (the Planet owns the material)
      if (supp) {
        supp.uniforms.fdFocusPlane.value.set(focusPlane.x, focusPlane.y)
        supp.uniforms.fdPatch.value = focusPlane.patch
        supp.uniforms.fdPlaneA.value = a
        supp.uniforms.fdChunkSide.value = chunkSide
        supp.uniforms.fdCapPlane.value = capAngle // the cap radius (plane units)
      }
    }
  })

  // clean teardown if the component unmounts while chunks are live
  useEffect(() => {
    return () => {
      for (const key of [...mountedRef.current.keys()]) evictChunk(key)
      tilesRef.current.clear()
      inflightRef.current.clear()
      hexTilesRef.current.clear()
      hexInflightRef.current.clear()
      publishFineRegion(planet.id, null) // §6: no region on this body any more
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <group ref={groupRef} />
}
