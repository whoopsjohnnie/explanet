/**
 * FineRegion.jsx — the streamed fine-terrain region for ONE body
 * (docs/terrain.txt, stage 1: the fine grid IS the document grid).
 *
 * Two collaborators, split by ownership:
 *   • useIsFocus(planet)  — the coarse "is this the body the player is ON"
 *     fact, derived from the zustand session (changes only when the session
 *     changes bodies, so it is safe as React state).
 *   • <FineRegion>        — the fine-grained streaming: while focused it
 *     streams the cap's chunks (ahead-first, behind-last), mounts/evicts their
 *     meshes in a spin-frame group, and mutates the shared suppression handle
 *     (the §4.4 cap + mounted-chunk texture). All of this is IMPERATIVE (60 Hz
 *     rule) — never through React state or zustand.
 *
 * The DOCUMENT mesh's suppression material is owned by PlanetSim (it applies
 * it to TerrainMeshes); FineRegion only fills the handle's uniforms. When the
 * session leaves the body, PlanetSim drops the material and FineRegion's
 * unmount disposes every chunk + zeroes the cap — the body is back to its LOD
 * chain, byte-identical to a world that never had chunks (§7, §11).
 */

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useStore } from '../state/store.js'
import { registry } from '../core/physics.js'
import { getHexSphere } from '../core/hexsphere.js'
import { planetRadius } from '../core/planetMath.js'
import {
  capRadiusU,
  chunkSideFor,
  fineHexEdge,
  loadedSet,
  orderQueue,
  projectToPlane,
  planeToHex,
  chunkOfHex,
  buildChunkGeometryData,
  setFinePatcher,
  clearFineEdits,
  publishFineRegion,
} from '../core/finedisc.js'
import { computeFaceNormals } from '../core/geometry.js'
import { buildChunkAsync } from '../three/geometryService.js'
import { getTerrainMaterials } from '../three/materials.js'
import { setMountedTexture } from '../three/fineMaterial.js'
import { walkerLocation } from '../core/surface.js'
import { craftRuntime, eva } from '../core/motion.js'

/**
 * The coarse focus fact: is `planet` the body the player is currently ON?
 * Derived from the zustand session (foot: the walker's body; craft: a craft
 * anchored to it). Changes only when the session changes bodies — safe as
 * React state. Adrift craft/EVA (dominant-body-within-D) is a refinement; the
 * stage-1 pins exercise the on-foot walker.
 */
export function useIsFocus(planet) {
  const player = useStore((s) => s.player)
  if (!player || player.kind === 'freeCam') return false
  if (player.kind === 'foot') return player.bodyId === planet.id
  if (player.kind === 'craft') {
    const world = useStore.getState().world
    const craft = (world.crafts || []).find((c) => c.id === player.craftId)
    return !!craft && craft.pose?.anchor?.bodyId === planet.id
  }
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
  const mountedRef = useRef(new Map()) // chunk key → { meshes, geos, cancel, I, J, pending }
  const pendingRef = useRef(new Set())
  const lastFocusChunkRef = useRef(null)
  const materials = getTerrainMaterials()

  // `batches` are ASSEMBLED { type, geometry } meshes (geometryService's
  // assembleMesh — the same path the LOD levels take): each geometry already
  // carries position/color/uv/normal + cellByTri + its build frequency.
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

  const refreshSuppression = () => {
    if (!supp) return
    const chunks = [...mountedRef.current.values()].filter((c) => !c.pending)
    const box = setMountedTexture(supp.mountedTexture, chunks)
    supp.uniforms.fdTexOffset.value.set(box.Imin, box.Jmin)
    supp.uniforms.fdTexSize.value.set(box.W, box.H)
  }

  // §6: publish the mounted set to the core dispatch (surface.js/motion.js
  // route walk/pick/altitude/park-r through it). The value is the region's
  // fine→doc map flattened over the loaded set — stage 1 the fine cells ARE
  // the document cells, so it is the identity. Runs on every mount/evict;
  // never through React state (the 60 Hz rule).
  const publishRegion = () => {
    const byCell = new Map()
    for (const c of mountedRef.current.values()) {
      if (c.pending || !c.cells) continue
      for (const cell of c.cells) byCell.set(cell, cell)
    }
    publishFineRegion(planet.id, byCell)
  }

  const requestChunk = (chunk) => {
    if (mountedRef.current.has(chunk.key) || pendingRef.current.has(chunk.key)) return
    pendingRef.current.add(chunk.key)
    // `cells` (the chunk's document cells) is kept on the entry so the §5
    // stroke patcher can find which mounted chunks a painted cell falls in.
    mountedRef.current.set(chunk.key, { pending: true, I: chunk.I, J: chunk.J, cells: chunk.cells })
    const packed = planet.atomsPacked || null
    buildChunkAsync(planet.id, chunk.key, renderPlanet, {
      atomsPacked: packed,
      cells: chunk.cells,
      onBatches: (batches) => {
        pendingRef.current.delete(chunk.key)
        const entry = mountedRef.current.get(chunk.key)
        if (!entry || !groupRef.current) return // unmounted mid-flight
        const { meshes, geos } = makeChunkMeshes(batches)
        for (const m of meshes) groupRef.current.add(m)
        entry.meshes = meshes
        entry.geos = geos
        entry.pending = false
        refreshSuppression()
        publishRegion()
      },
      onError: () => {
        pendingRef.current.delete(chunk.key)
        const entry = mountedRef.current.get(chunk.key)
        if (entry) mountedRef.current.delete(chunk.key)
      },
    })
  }

  const evictChunk = (key) => {
    const c = mountedRef.current.get(key)
    if (!c) return
    pendingRef.current.delete(key)
    if (c.meshes) {
      for (const m of c.meshes) if (groupRef.current) groupRef.current.remove(m)
      for (const g of c.geos) g.dispose()
    }
    mountedRef.current.delete(key)
    publishRegion()
  }

  // ---- §5 the stroke patcher: keep mounted chunks honest on a doc edit ------
  // Assembles raw builder batches into THREE meshes (the worker path does this
  // off-thread; the §5 same-frame patch does it here, on the main thread, so
  // the painted cell is on the rendered fine surface before the next frame).
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

  /**
   * The §5 stroke patcher (registered with core/finedisc.js): a paint changed
   * these document cells; rebuild the mounted chunks that cover them.
   *  - step 3 (same frame): a synchronous rebuild of the affected chunk's
   *    geometry, swapped in place — the weld invariant holds for the fine
   *    layer exactly as for the document (mesh + surface re-derive from the
   *    new elements in the same frame). At stage 1 a chunk is small (a doc
   *    lattice block), so the main-thread cost is negligible; stage 2 turns
   *    this into a direct vertex patch for DEM-sized chunks.
   *  - step 4 (background): the re-synthesis backstop — a no-op at stage 1,
   *    because the synchronous rebuild already made the chunk's bytes honest
   *    (there are no stored fine heights to re-derive); it is where stage 2
   *    re-runs the §4.1 synthesis (DEM + document + overlay) off-thread.
   */
  const patcher = (cells, planet) => {
    const cellSet = new Set(cells)
    for (const entry of mountedRef.current.values()) {
      if (entry.pending || !entry.meshes) continue
      if (!entry.cells.some((c) => cellSet.has(c))) continue
      const batches = buildChunkGeometryData(planet, { cells: entry.cells })
      for (const m of entry.meshes) if (groupRef.current) groupRef.current.remove(m)
      for (const g of entry.geos) g.dispose()
      const { meshes, geos } = makeChunkMeshesFromBatches(batches)
      if (groupRef.current) for (const m of meshes) groupRef.current.add(m)
      entry.meshes = meshes
      entry.geos = geos
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

  useFrame(() => {
    if (!renderPlanet) return
    const focus = fineFocusFor(planet.id)
    if (!focus) {
      // the session left the body: full unmount
      if (lastFocusChunkRef.current !== null) {
        for (const key of [...mountedRef.current.keys()]) evictChunk(key)
        pendingRef.current.clear()
        lastFocusChunkRef.current = null
        publishFineRegion(planet.id, null) // §6: the dispatch falls back to the document
        if (supp) {
          supp.uniforms.fdCapPlane.value = 0 // radius 0 → the discard is a no-op
          setMountedTexture(supp.mountedTexture, [])
        }
      }
      return
    }

    const grid = getHexSphere(renderPlanet.frequency)
    const R = planetRadius(renderPlanet)
    const aU = fineHexEdge(grid, R)
    const a = aU / R // the PLANE cell edge (dimensionless)
    const focusPlane = projectToPlane(focus.dir)
    const fh = planeToHex(a, focusPlane.x, focusPlane.y)
    const hexKm = (aU * useStore.getState().world.scale) / 1000
    const chunkSide = chunkSideFor(hexKm)
    const focusChunkKey = chunkOfHex(focusPlane.patch, chunkSide, fh.q, fh.r)

    if (focusChunkKey !== lastFocusChunkRef.current) {
      lastFocusChunkRef.current = focusChunkKey
      const D = capRadiusU(useStore.getState().world.scale)
      const ls = loadedSet(grid, focus.dir, D, R, chunkSide)
      const desired = new Set(ls.chunks.map((c) => c.key))

      for (const key of [...mountedRef.current.keys()]) {
        if (!desired.has(key)) evictChunk(key)
      }
      const ordered = orderQueue(ls.chunks, focus.dir, focus.vel, chunkSide, a)
      for (const chunk of ordered) requestChunk(chunk)

      // the suppression cap follows the focus (PlanetSim owns the material)
      if (supp) {
        supp.uniforms.fdFocusPlane.value.set(focusPlane.x, focusPlane.y)
        supp.uniforms.fdPatch.value = focusPlane.patch
        supp.uniforms.fdPlaneA.value = a
        supp.uniforms.fdChunkSide.value = chunkSide
        supp.uniforms.fdCapPlane.value = D / R // the cap radius in plane units
      }
    }
  })

  // clean teardown if the component unmounts while chunks are live
  useEffect(() => {
    return () => {
      for (const key of [...mountedRef.current.keys()]) evictChunk(key)
      pendingRef.current.clear()
      publishFineRegion(planet.id, null) // §6: no region on this body any more
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <group ref={groupRef} />
}
