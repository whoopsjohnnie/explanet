/**
 * Planet.jsx
 * ---------------------------------------------------------------------------
 * One planet = one cannon sphere body + one render mesh per terrain type.
 *
 *  • Physics : spherical collider whose radius/mass are derived from the
 *              hex elements. Registers itself with the gravity registry.
 *  • Render  : geometry rebuilt from `planet.elements` (batched by terrain),
 *              held at every LOD level (halving frequency, sampled from the
 *              fine grid); only the level matching the camera distance is
 *              mounted, so draw cost falls off with distance.
 *  • Pick    : analytic — the first batch mesh raycasts against the surface
 *              heightfield (core/surface.js), not against triangles, and the
 *              hit carries the DOCUMENT cell index. Cost is independent of
 *              resolution and constant across LOD, which is what keeps
 *              R3F's per-pointer-move/wheel raycasts instant up close.
 *  • Paint   : pointer down/move with an active brush maps picks to cells
 *              and mutates the world document.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { useSphere } from '@react-three/cannon'
import { useFrame, useThree } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import { useStore } from '../state/store.js'
import { registerBody, registry } from '../core/physics.js'
import { buildLodGeometryData } from '../core/geometry.js'
import { lodChain, lodDistances, LOD_SWITCH } from '../core/lod.js'
import { makeSurface, intersectHeightfield } from '../core/surface.js'
import { planetRadius, planetMass, planetScale, radiusForFrequency } from '../core/planetMath.js'
import { getTerrainMaterials } from '../three/materials.js'

// scratch objects for the analytic pick (single-threaded, per-call)
const _ray = new THREE.Ray()
const _inv = new THREE.Matrix4()
// terrain batches share one heightfield pick (on meshes[0]); everything else
// opts out of raycasting entirely
const NO_RAYCAST = () => null

export default function Planet({ planet }) {
  const materials = getTerrainMaterials()
  const selected = useStore((s) => s.selectedId === planet.id)
  const showLabels = useStore((s) => s.showLabels)
  const tool = useStore((s) => s.tool)
  const walking = useStore((s) => !!s.walkMode)
  const applyBrush = useStore((s) => s.applyBrush)
  const select = useStore((s) => s.select)
  const hydratePlanet = useStore((s) => s.hydratePlanet)
  const controls = useThree((s) => s.controls)

  const radius = planetRadius(planet)
  const mass = planetMass(planet)
  const isStatic = !!planet.isStatic

  // ------------------------------------------------------------ streaming --
  // A DB stub (atoms not streamed yet) renders its preview sample: the
  // server-sampled coarse grid re-scaled so its core radius equals the true
  // one. Everything downstream (LOD chain, surface pick) treats it as a
  // small planet; when the atoms arrive, `planet.elements` changes identity
  // and the full grid takes over. Physics never used the preview — stub
  // radius/mass are exact-orbit values from frequency + density (+ mean
  // relief), so nothing jumps when the stream completes.
  const renderPlanet = useMemo(() => {
    if (planet.elements) return planet
    const pv = planet.preview
    if (!pv || !pv.elements?.length) return null
    const scale =
      planetScale(planet) * (radiusForFrequency(planet.frequency) / radiusForFrequency(pv.frequency))
    return { frequency: pv.frequency, elements: pv.elements, scale }
  }, [planet.elements, planet.preview, planet.frequency, planet.scale])

  // ------------------------------------------------------------- physics --
  const [bodyRef, api] = useSphere(
    () => ({
      mass: isStatic ? 0 : mass,
      type: isStatic ? 'Static' : 'Dynamic',
      args: [Math.max(radius, 0.1)],
      position: [planet.center.x, planet.center.y, planet.center.z],
      velocity: [planet.velocity.x, planet.velocity.y, planet.velocity.z],
      angularVelocity: [planet.spin.x, planet.spin.y, planet.spin.z],
      allowSleep: false,
      friction: 0.15,
      restitution: 0.35,
    }),
    undefined,
    // recreate the collider only when the planet physically changes size
    [planet.id, isStatic, Math.round(radius * 1000)]
  )

  // publish live state to the gravity registry
  const entryRef = useRef(null)
  useEffect(() => {
    const entry = {
      api,
      pos: { ...planet.center },
      vel: { ...planet.velocity },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      mass,
      isStatic,
      radius,
    }
    entryRef.current = entry
    const un1 = api.position.subscribe((v) => {
      entry.pos.x = v[0]
      entry.pos.y = v[1]
      entry.pos.z = v[2]
    })
    const un2 = api.velocity.subscribe((v) => {
      entry.vel.x = v[0]
      entry.vel.y = v[1]
      entry.vel.z = v[2]
    })
    const un3 = api.quaternion.subscribe((v) => {
      entry.quat.x = v[0]
      entry.quat.y = v[1]
      entry.quat.z = v[2]
      entry.quat.w = v[3]
    })
    const unregister = registerBody(planet.id, entry)
    return () => {
      un1()
      un2()
      un3()
      unregister()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, planet.id])

  // keep registry + body in sync when derived values change
  useEffect(() => {
    const entry = entryRef.current
    if (entry) {
      entry.mass = mass
      entry.isStatic = isStatic
      entry.radius = radius
    }
    api.mass.set(isStatic ? 0 : mass)
  }, [mass, isStatic, radius, api])

  // document edits (position/velocity/spin fields) → physics body
  useEffect(() => {
    api.position.set(planet.center.x, planet.center.y, planet.center.z)
    api.velocity.set(planet.velocity.x, planet.velocity.y, planet.velocity.z)
    api.angularVelocity.set(planet.spin.x, planet.spin.y, planet.spin.z)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planet.center, planet.velocity, planet.spin, api])

  // -------------------------------------------------------------- render --
  // One geometry set per LOD level (the document grid — or the preview grid
  // while stubbed — plus halved chains down to 4). Built once per document
  // edit; level switching just picks a set, and only the active set is
  // mounted — the GPU never draws a level the camera can't see. (Picking is
  // analytic and LOD-independent, see paint below.)
  const lodLevels = useMemo(() => {
    if (!renderPlanet) return []
    const chain = lodChain(renderPlanet.frequency)
    return chain.map((f) => {
      const data = buildLodGeometryData(renderPlanet, f)
      const out = []
      for (const [type, d] of data) {
        const g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.BufferAttribute(d.positions, 3))
        g.setAttribute('color', new THREE.BufferAttribute(d.colors, 3))
        g.setAttribute('uv', new THREE.BufferAttribute(d.uvs, 2))
        g.computeVertexNormals()
        g.userData.cellByTri = d.cellByTri
        out.push({ type, geometry: g })
      }
      return { frequency: f, meshes: out }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderPlanet])

  const thresholds = useMemo(
    () => lodDistances(lodChain(renderPlanet ? renderPlanet.frequency : planet.frequency), radius),
    [renderPlanet, radius]
  )

  const [level, setLevel] = useState(0)
  const levelRef = useRef(0)
  const camera = useThree((s) => s.camera)

  useFrame(() => {
    // proximity streaming: once the camera is closer than the preview grid's
    // angular-resolution limit ((LOD_SWITCH/pf)·R), the sample stops matching
    // what the full chain would render — start the atom download (guarded,
    // fire-and-forget; hydratePlanet dedupes concurrent requests)
    if (renderPlanet !== planet && planet.preview) {
      const body = registry.bodies.get(planet.id)
      const c = body ? body.pos : planet.center
      const dR =
        Math.hypot(camera.position.x - c.x, camera.position.y - c.y, camera.position.z - c.z) / radius
      if (dR * planet.preview.frequency < LOD_SWITCH) hydratePlanet(planet.id)
    }
    if (thresholds.length === 0) return
    const body = registry.bodies.get(planet.id)
    const c = body ? body.pos : planet.center
    const dx = camera.position.x - c.x
    const dy = camera.position.y - c.y
    const dz = camera.position.z - c.z
    const distR = Math.sqrt(dx * dx + dy * dy + dz * dz) / radius
    // hysteresis (±20%) so orbits and zoom drags don't thrash level swaps
    let want = levelRef.current
    while (want < thresholds.length && distR > thresholds[want] * 1.2) want++
    while (want > 0 && distR < thresholds[want - 1] / 1.2) want--
    if (want !== levelRef.current) {
      levelRef.current = want
      setLevel(want)
    }
  })

  useEffect(
    () => () => lodLevels.forEach((l) => l.meshes.forEach((m) => m.geometry.dispose())),
    [lodLevels]
  )

  // -------------------------------------------------------------- paint --
  const painting = useRef(false)
  const lastCell = useRef(-1)

  // Analytic pick: the first terrain batch replaces three's per-triangle
  // raycast with a ray→heightfield march (core/surface.js). R3F raycasts the
  // scene on *wheel* events too — one full pick per scroll tick — so this is
  // what keeps zooming close to a world smooth: ~10³ hinted cell lookups
  // instead of ~600k triangle tests, exact at every LOD. Intersections carry
  // the document cell index directly (cellByTri stays on the geometry as a
  // fallback path); the remaining batches opt out of raycasting.
  const surface = useMemo(
    () => (renderPlanet ? makeSurface(renderPlanet) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [renderPlanet]
  )
  const pickRaycast = useCallback(
    function (raycaster, intersects) {
      if (!surface) return
      _inv.copy(this.matrixWorld).invert()
      _ray.copy(raycaster.ray).applyMatrix4(_inv)
      const hit = intersectHeightfield(
        surface,
        [_ray.origin.x, _ray.origin.y, _ray.origin.z],
        [_ray.direction.x, _ray.direction.y, _ray.direction.z]
      )
      if (!hit) return
      const point = new THREE.Vector3(hit.point[0], hit.point[1], hit.point[2]).applyMatrix4(this.matrixWorld)
      intersects.push({ distance: raycaster.ray.origin.distanceTo(point), point, object: this, cell: hit.cell })
    },
    [surface]
  )

  const cellFromEvent = (e) => {
    if (e.cell != null) return e.cell
    const cbt = e.object?.geometry?.userData?.cellByTri
    if (!cbt || e.faceIndex == null) return undefined
    return cbt[e.faceIndex]
  }

  const onPointerDown = (e) => {
    if (walking) return // surface mode: pointer drives the camera, not tools
    if (e.button !== 0) return
    const ci = cellFromEvent(e)
    if (ci == null) return
    e.stopPropagation()
    if (tool === 'select') {
      select(planet.id)
      return
    }
    painting.current = true
    if (controls) controls.enabled = false
    applyBrush(planet.id, ci)
    lastCell.current = ci
  }

  const onPointerMove = (e) => {
    if (walking) return
    if (!painting.current) return
    const ci = cellFromEvent(e)
    if (ci == null || ci === lastCell.current) return
    e.stopPropagation()
    applyBrush(planet.id, ci)
    lastCell.current = ci
  }

  useEffect(() => {
    const up = () => {
      painting.current = false
      lastCell.current = -1
      if (controls) controls.enabled = true
    }
    window.addEventListener('pointerup', up)
    return () => window.removeEventListener('pointerup', up)
  }, [controls])

  // ---------------------------------------------------------------- view --
  const shown = lodLevels[Math.min(level, lodLevels.length - 1)]
  return (
    <group ref={bodyRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove}>
      {shown &&
        shown.meshes.map((m, i) => (
        <mesh
          key={m.type}
          geometry={m.geometry}
          material={materials[m.type]}
          raycast={i === 0 ? pickRaycast : NO_RAYCAST}
        />
      ))}

      {planet.preset === 'star' && (
        <pointLight color="#ffe3ab" intensity={2.6} distance={0} decay={0.055} />
      )}

      {selected && (
        <mesh raycast={() => null}>
          <sphereGeometry args={[radius * 1.08, 28, 18]} />
          <meshBasicMaterial color="#7fd4ff" wireframe transparent opacity={0.12} depthWrite={false} />
        </mesh>
      )}

      {showLabels && (
        <Html
          position={[0, radius + 2.4, 0]}
          center
          distanceFactor={110}
          zIndexRange={[30, 0]}
          style={{ pointerEvents: 'none' }}
        >
          <div className={`planet-label ${selected ? 'planet-label--selected' : ''}`}>{planet.name}</div>
        </Html>
      )}
    </group>
  )
}
