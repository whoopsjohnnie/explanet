/**
 * Planet.jsx — bodies of the world, in two flavors sharing one view.
 *
 *  • PlanetSim    ordinary body: a cannon sphere + pairwise N-body gravity.
 *  • PlanetFlyer  scripted test particle (planet.scriptsOrbit): rides an
 *                 analytic Kepler ellipse (core/kepler.js), has NO cannon
 *                 body at all. This is what lets a real-catalog world carry
 *                 ~450 moons and ~400 small bodies: pairwise gravity costs
 *                 an applyForce round-trip per pair per frame, and none of
 *                 those bodies has mass worth sharing anyway.
 *
 * Shared pieces (both flavors):
 *  • Render  : geometry rebuilt from `planet.elements` (batched by terrain),
 *              held at every LOD level; only the level matching the camera
 *              distance is mounted.
 *  • Pick    : analytic — the first batch mesh raycasts against the surface
 *              heightfield (core/surface.js); the hit carries the DOCUMENT
 *              cell index, exact at every LOD.
 *  • Paint   : pointer down/move with an active brush maps picks to cells.
 *  • Decor   : rings (document descriptor), star glow sprites, name label —
 *              mounted in a spin-canceled group so they don't tumble.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { useSphere } from '@react-three/cannon'
import { useFrame, useThree } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import { makeGlowTexture, makeRingTexture, makeRingGeometry } from '../three/effects.js'
import { useStore } from '../state/store.js'
import { registerBody, registry } from '../core/physics.js'
import { buildLodGeometryData, computeFaceNormals } from '../core/geometry.js'
import { lodChain, lodDistances } from '../core/lod.js'
import { makeSurface, intersectHeightfield } from '../core/surface.js'
import { keplerState, prepareOrbit } from '../core/kepler.js'
import { planetRadius, planetMass, planetScale, radiusForFrequency } from '../core/planetMath.js'
import { getTerrainMaterials } from '../three/materials.js'
import { buildLevelsAsync, ASYNC_MIN_CELLS } from '../three/geometryService.js'

// scratch objects for the analytic pick (single-threaded, per-call)
const _ray = new THREE.Ray()
const _inv = new THREE.Matrix4()
// terrain batches share one heightfield pick (on meshes[0]); everything else
// opts out of raycasting entirely
const NO_RAYCAST = () => null
const EMPTY_LEVELS = []

/** Synchronous LOD chain build — small planets, and the worker-failed path. */
function buildLevelsSync(renderPlanet) {
  return lodChain(renderPlanet.frequency).map((f) => {
    const data = buildLodGeometryData(renderPlanet, f)
    const out = []
    for (const [type, d] of data) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(d.positions, 3))
      g.setAttribute('color', new THREE.BufferAttribute(d.colors, 3))
      g.setAttribute('uv', new THREE.BufferAttribute(d.uvs, 2))
      g.setAttribute('normal', new THREE.BufferAttribute(computeFaceNormals(d.positions), 3))
      g.userData.cellByTri = d.cellByTri
      out.push({ type, geometry: g })
    }
    return { frequency: f, meshes: out }
  })
}

/**
 * The level to mount for camera level `want`, tolerating holes: an async
 * build fills levels as they land (coarse first), so pick the nearest level
 * that exists, preferring a coarser one over a missing finer one.
 */
function pickLevel(levels, want) {
  let best = null
  let bestD = Infinity
  for (let i = 0; i < levels.length; i++) {
    const l = levels[i]
    if (!l || l.meshes.length === 0) continue
    const d = i <= want ? (want - i) * 2 : i - want
    if (d < bestD) {
      bestD = d
      best = l
    }
  }
  return best
}

/** Dispose geometries present in `prev` but not in `next` (partial swaps). */
function disposeNotIn(prev, next) {
  if (!prev) return
  const keep = new Set()
  for (const l of next || []) for (const m of l?.meshes || []) keep.add(m.geometry)
  for (const l of prev) for (const m of l?.meshes || []) if (!keep.has(m.geometry)) m.geometry.dispose()
}

// ---------------------------------------------------------------------------
// Shared hooks — geometry chain, level selection, analytic pick/paint.
// ---------------------------------------------------------------------------

/** What we render: the document grid, or the preview sample while stubbed. */
function useRenderPlanet(planet) {
  return useMemo(() => {
    if (planet.elements) return planet
    const pv = planet.preview
    if (!pv || !pv.elements?.length) return null
    const scale =
      planetScale(planet) * (radiusForFrequency(planet.frequency) / radiusForFrequency(pv.frequency))
    return { frequency: pv.frequency, elements: pv.elements, scale }
  }, [planet.elements, planet.preview, planet.frequency, planet.scale])
}

/** LOD levels (sync or worker), the mounted level, and camera-driven swaps. */
function useLodLevels(planet, renderPlanet, radius) {
  const bigRender = !!renderPlanet && renderPlanet.elements.length > ASYNC_MIN_CELLS
  const [workerFailed, setWorkerFailed] = useState(false)
  const useAsync = bigRender && !workerFailed
  const syncLevels = useMemo(
    () => (!useAsync && renderPlanet ? buildLevelsSync(renderPlanet) : null),
    [renderPlanet, useAsync]
  )
  const [asyncSet, setAsyncSet] = useState(null)
  const levelsRef = useRef(null)
  const nextLevels = useAsync ? asyncSet : syncLevels
  if (nextLevels) levelsRef.current = nextLevels
  const lodLevels = levelsRef.current || EMPTY_LEVELS

  useEffect(() => {
    if (!useAsync || !renderPlanet) return undefined
    return buildLevelsAsync(planet.id, renderPlanet, {
      atomsPacked: renderPlanet === planet ? planet.atomsPacked : null,
      seed: levelsRef.current,
      onLevels: setAsyncSet,
      onError: () => setWorkerFailed(true),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planet.id, renderPlanet, useAsync])

  const thresholds = useMemo(
    () => lodDistances(lodChain(renderPlanet ? renderPlanet.frequency : planet.frequency), radius),
    [renderPlanet, radius]
  )

  const [level, setLevel] = useState(0)
  const levelRef = useRef(0)
  const camera = useThree((s) => s.camera)

  useFrame(() => {
    if (thresholds.length === 0) return
    const body = registry.bodies.get(planet.id)
    const c = body ? body.pos : planet.center
    const dx = camera.position.x - c.x
    const dy = camera.position.y - c.y
    const dz = camera.position.z - c.z
    const distR = Math.sqrt(dx * dx + dy * dy + dz * dz) / radius
    let want = levelRef.current
    while (want < thresholds.length && distR > thresholds[want] * 1.2) want++
    while (want > 0 && distR < thresholds[want - 1] / 1.2) want--
    if (want !== levelRef.current) {
      levelRef.current = want
      setLevel(want)
    }
  })

  // geometries freed on swap (partial async deliveries share levels, so
  // dispose by identity difference) and on unmount
  const prevLevelsRef = useRef(null)
  useEffect(() => {
    const prev = prevLevelsRef.current
    prevLevelsRef.current = lodLevels
    if (prev && prev !== lodLevels) disposeNotIn(prev, lodLevels)
  }, [lodLevels])
  useEffect(
    () => () => {
      disposeNotIn(levelsRef.current, null)
      levelsRef.current = null
    },
    []
  )

  return { lodLevels, level }
}

/** Analytic heightfield pick + brush painting (identical for both flavors). */
function usePlanetPick(planet, renderPlanet) {
  const tool = useStore((s) => s.tool)
  const walking = useStore((s) => !!s.walkMode)
  const applyBrush = useStore((s) => s.applyBrush)
  const select = useStore((s) => s.select)
  const controls = useThree((s) => s.controls)

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

  const painting = useRef(false)
  const lastCell = useRef(-1)

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

  return { pickRaycast, onPointerDown, onPointerMove }
}

// ---------------------------------------------------------------------------
// PlanetView — terrain meshes + decor shared by both physics flavors.
// ---------------------------------------------------------------------------

function PlanetView({ spinRef, planet, radius, shown, materials, pickRaycast, onPointerDown, onPointerMove, children }) {
  const selected = useStore((s) => s.selectedId === planet.id)
  const showLabels = useStore((s) => s.showLabels)
  const parentSelected = useStore((s) => !!planet.parent && s.selectedId === planet.parent)
  const camera = useThree((s) => s.camera)

  // ---- rings + glow textures (pure display: never raycast, no physics) ----
  const isStar = planet.preset === 'star'
  const rings =
    planet.rings && Number.isFinite(planet.rings.inner) && Number.isFinite(planet.rings.outer)
      ? planet.rings
      : null
  const ringGeo = useMemo(
    () => (rings ? makeRingGeometry(Math.max(radius * rings.inner, 0.02), radius * rings.outer) : null),
    [rings, radius]
  )
  const ringMat = useMemo(
    () =>
      rings
        ? new THREE.MeshBasicMaterial({
            map: makeRingTexture(rings.bands, planet.color),
            side: THREE.DoubleSide,
            transparent: true,
            depthWrite: false,
            opacity: 0.98,
            toneMapped: false,
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rings, planet.color]
  )
  useEffect(
    () => () => {
      ringGeo?.dispose?.()
      ringMat?.dispose?.()
    },
    [ringGeo, ringMat]
  )
  const glowTex = useMemo(() => (isStar ? makeGlowTexture({ size: 256, power: 2.4 }) : null), [isStar])

  // ---- spin-canceled overlay + label distance gate --------------------------
  // spinRef carries the spin quaternion; the overlay group cancels it every
  // frame, so the ring plane keeps its document tilt and labels sit still.
  const poseRef = useRef(null)
  const [labelOn, setLabelOn] = useState(true)
  const labelOnRef = useRef(true)
  useFrame(() => {
    if (poseRef.current && spinRef.current) {
      poseRef.current.quaternion.copy(spinRef.current.quaternion).invert()
    }
    // With ~700 bodies every visible Html is a DOM element: gate labels by
    // apparent size. Major bodies are always labeled; moons appear when their
    // neighborhood is in focus (or the parent is selected); small bodies
    // only up close. ×0.8 hysteresis on the way out.
    let want = true
    if (!selected && !parentSelected) {
      const body = registry.bodies.get(planet.id)
      const c = body ? body.pos : planet.center
      const d = Math.hypot(camera.position.x - c.x, camera.position.y - c.y, camera.position.z - c.z)
      const ratio = radius / Math.max(d, 1e-9)
      const near = planet.parent
        ? planet.preset === 'asteroid' || planet.preset === 'comet'
          ? 0.03
          : 0.012
        : 0
      const limit = labelOnRef.current ? near * 0.8 : near
      want = near === 0 || ratio > limit
    }
    if (want !== labelOnRef.current) {
      labelOnRef.current = want
      setLabelOn(want)
    }
  })

  return (
    <group onPointerDown={onPointerDown} onPointerMove={onPointerMove}>
      {children}

      {isStar && (
        <>
          <pointLight color="#ffe3ab" intensity={2.6} distance={0} decay={0.055} />
          {/* additive glow sprites: a tight corona + a wide haze. Sprites
              face the camera, so spin never touches them. */}
          <sprite raycast={NO_RAYCAST} scale={radius * 3.1}>
            <spriteMaterial
              map={glowTex}
              blending={THREE.AdditiveBlending}
              transparent
              opacity={0.9}
              depthWrite={false}
              toneMapped={false}
            />
          </sprite>
          <sprite raycast={NO_RAYCAST} scale={radius * 9}>
            <spriteMaterial
              map={glowTex}
              blending={THREE.AdditiveBlending}
              transparent
              opacity={0.28}
              depthWrite={false}
              toneMapped={false}
            />
          </sprite>
        </>
      )}

      {selected && (
        <mesh raycast={() => null}>
          <sphereGeometry args={[radius * 1.08, 28, 18]} />
          <meshBasicMaterial color="#7fd4ff" wireframe transparent opacity={0.12} depthWrite={false} />
        </mesh>
      )}

      <group ref={poseRef}>
        {ringGeo && ringMat && (
          <mesh
            geometry={ringGeo}
            material={ringMat}
            raycast={NO_RAYCAST}
            rotation={[0, 0, ((rings.tiltDeg || 0) * Math.PI) / 180]}
          />
        )}

        {showLabels && labelOn && (
          <Html
            position={[0, radius * 1.18 + 1.6, 0]}
            center
            distanceFactor={110}
            zIndexRange={[30, 0]}
            style={{ pointerEvents: 'none' }}
          >
            <div className={`planet-label ${selected ? 'planet-label--selected' : ''}`}>{planet.name}</div>
          </Html>
        )}
      </group>
    </group>
  )
}

function TerrainMeshes({ shown, materials, pickRaycast }) {
  return (
    <>
      {shown &&
        shown.meshes.map((m, i) => (
          <mesh
            key={m.type}
            geometry={m.geometry}
            material={materials[m.type]}
            raycast={i === 0 ? pickRaycast : NO_RAYCAST}
          />
        ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// PlanetSim — cannon body + N-body gravity (the classic path).
// ---------------------------------------------------------------------------

function PlanetSim({ planet }) {
  const materials = getTerrainMaterials()
  const radius = planetRadius(planet)
  const mass = planetMass(planet)
  const isStatic = !!planet.isStatic

  const renderPlanet = useRenderPlanet(planet)
  const { lodLevels, level } = useLodLevels(planet, renderPlanet, radius)
  const { pickRaycast, onPointerDown, onPointerMove } = usePlanetPick(planet, renderPlanet)

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

  const shown = pickLevel(lodLevels, level)
  return (
    <group ref={bodyRef}>
      <PlanetView
        spinRef={bodyRef}
        planet={planet}
        radius={radius}
        shown={shown}
        materials={materials}
        pickRaycast={pickRaycast}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
      >
        <TerrainMeshes shown={shown} materials={materials} pickRaycast={pickRaycast} />
      </PlanetView>
    </group>
  )
}

// ---------------------------------------------------------------------------
// PlanetFlyer — scripted Keplerian test particle, no cannon body.
// ---------------------------------------------------------------------------

const _st = { pos: [0, 0, 0], vel: [0, 0, 0] }
const _axis = new THREE.Vector3()
const _dq = new THREE.Quaternion()

function PlanetFlyer({ planet }) {
  const materials = getTerrainMaterials()
  const radius = planetRadius(planet)
  const mass = planetMass(planet)

  const renderPlanet = useRenderPlanet(planet)
  const { lodLevels, level } = useLodLevels(planet, renderPlanet, radius)
  const { pickRaycast, onPointerDown, onPointerMove } = usePlanetPick(planet, renderPlanet)

  const orbit = useMemo(() => prepareOrbit(planet.scriptsOrbit), [planet.scriptsOrbit])

  const groupRef = useRef(null)
  const entryRef = useRef(null)
  const simT = useRef(0)
  const spin = useMemo(() => {
    const s = planet.spin || { x: 0, y: 0, z: 0 }
    const len = Math.hypot(s.x, s.y, s.z)
    return len > 1e-12
      ? { axis: [s.x / len, s.y / len, s.z / len], rate: len }
      : { axis: [0, 1, 0], rate: 0 }
  }, [planet.spin])

  // registry entry WITHOUT api — physics.js skips api-less entries in pairs,
  // which is exactly the test-particle semantics we want
  useEffect(() => {
    if (!orbit) return undefined
    const st = keplerState(orbit, 0, _st)
    const parent = planet.parent ? registry.bodies.get(planet.parent) : null
    const entry = {
      api: undefined,
      pos: {
        x: st.pos[0] + (parent ? parent.pos.x : 0),
        y: st.pos[1] + (parent ? parent.pos.y : 0),
        z: st.pos[2] + (parent ? parent.pos.z : 0),
      },
      vel: {
        x: st.vel[0] + (parent ? parent.vel.x : 0),
        y: st.vel[1] + (parent ? parent.vel.y : 0),
        z: st.vel[2] + (parent ? parent.vel.z : 0),
      },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      mass,
      isStatic: false,
      radius,
      scripted: true,
    }
    entryRef.current = entry
    const unregister = registerBody(planet.id, entry)
    return () => {
      entryRef.current = null
      unregister()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planet.id, orbit])

  useFrame((_, delta) => {
    const entry = entryRef.current
    if (!entry || !orbit) return
    const playing = useStore.getState().playing
    const dt = playing ? Math.min(delta, 0.05) : 0
    simT.current += dt

    const st = keplerState(orbit, simT.current, _st)
    const parent = planet.parent ? registry.bodies.get(planet.parent) : null
    const px = st.pos[0] + (parent ? parent.pos.x : 0)
    const py = st.pos[1] + (parent ? parent.pos.y : 0)
    const pz = st.pos[2] + (parent ? parent.pos.z : 0)
    entry.pos.x = px
    entry.pos.y = py
    entry.pos.z = pz
    entry.vel.x = st.vel[0] + (parent ? parent.vel.x : 0)
    entry.vel.y = st.vel[1] + (parent ? parent.vel.y : 0)
    entry.vel.z = st.vel[2] + (parent ? parent.vel.z : 0)

    if (spin.rate > 0) {
      _axis.set(spin.axis[0], spin.axis[1], spin.axis[2])
      _dq.setFromAxisAngle(_axis, spin.rate * dt)
      // entry quat is a plain object — mirror THREE's math in place
      const q = entry.quat
      const { x, y, z, w } = q
      q.x = x * _dq.w + _dq.x * w + y * _dq.z - z * _dq.y
      q.y = y * _dq.w + _dq.y * w + z * _dq.x - x * _dq.z
      q.z = z * _dq.w + _dq.z * w + x * _dq.y - y * _dq.x
      q.w = w * _dq.w - _dq.x * x - _dq.y * y - _dq.z * z
    }
    const g = groupRef.current
    if (g) {
      g.position.set(px, py, pz)
      g.quaternion.set(entry.quat.x, entry.quat.y, entry.quat.z, entry.quat.w)
    }
  })

  const shown = pickLevel(lodLevels, level)
  return (
    <group ref={groupRef}>
      <PlanetView
        spinRef={groupRef}
        planet={planet}
        radius={radius}
        shown={shown}
        materials={materials}
        pickRaycast={pickRaycast}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
      >
        <TerrainMeshes shown={shown} materials={materials} pickRaycast={pickRaycast} />
      </PlanetView>
    </group>
  )
}

export default function Planet({ planet }) {
  return planet.scriptsOrbit ? <PlanetFlyer planet={planet} /> : <PlanetSim planet={planet} />
}
