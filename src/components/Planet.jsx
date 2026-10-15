/**
 * Planet.jsx
 * ---------------------------------------------------------------------------
 * One planet = one cannon sphere body + one render mesh per terrain type.
 *
 *  • Physics : spherical collider whose radius/mass are derived from the
 *              hex elements. Registers itself with the gravity registry.
 *  • Render  : geometry rebuilt from `planet.elements` (batched by terrain).
 *              Each triangle knows its cell index for picking.
 *  • Paint   : pointer down/move with an active brush maps raycast hits to
 *              cells and mutates the world document.
 */

import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useSphere } from '@react-three/cannon'
import { useThree } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import { useStore } from '../state/store.js'
import { registerBody } from '../core/physics.js'
import { buildPlanetGeometryData } from '../core/geometry.js'
import { planetRadius, planetMass } from '../core/planetMath.js'
import { getTerrainMaterials } from '../three/materials.js'

export default function Planet({ planet }) {
  const materials = getTerrainMaterials()
  const selected = useStore((s) => s.selectedId === planet.id)
  const showLabels = useStore((s) => s.showLabels)
  const tool = useStore((s) => s.tool)
  const walking = useStore((s) => !!s.walkMode)
  const applyBrush = useStore((s) => s.applyBrush)
  const select = useStore((s) => s.select)
  const controls = useThree((s) => s.controls)

  const radius = planetRadius(planet)
  const mass = planetMass(planet)
  const isStatic = !!planet.isStatic

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
  const meshes = useMemo(() => {
    const data = buildPlanetGeometryData(planet)
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
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planet.elements, planet.frequency, planet.scale])

  useEffect(() => () => meshes.forEach((m) => m.geometry.dispose()), [meshes])

  // -------------------------------------------------------------- paint --
  const painting = useRef(false)
  const lastCell = useRef(-1)

  const cellFromEvent = (e) => {
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
  return (
    <group ref={bodyRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove}>
      {meshes.map((m) => (
        <mesh key={m.type} geometry={m.geometry} material={materials[m.type]} />
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
