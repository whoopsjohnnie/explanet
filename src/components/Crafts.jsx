/**
 * Crafts.jsx — the world's vehicles, rendered and kept moving.
 *
 *  • AmbientCrafts mounts one CraftMesh per craft (world.crafts) and runs
 *    the craft step loop in useFrame: every craft integrates its mover
 *    (core/motion.js stepCraft) — parked ones ride their body analytically,
 *    flying ones coast (arcade eases to a hover; real keeps orbiting) —
 *    with the piloted craft fed the live flightInput and its telemetry
 *    written to the motionReadout side channel.
 *  • CraftMesh renders one craft as a small primitive (unit shuttle, nose
 *    +Z) posed EVERY frame from the craftRuntime — the same float32
 *    registry stream as the planet meshes (a parked craft composes from its
 *    body's registry entry, so it rides the same quantized pose).
 *
 * The player's own craft renders too: the chase camera (C) exists to see
 * the ship, and the cockpit sits inside it.
 */

import { useEffect, useRef, useMemo } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useStore } from '../state/store.js'
import {
  craftRuntime,
  craftWorldPose,
  stepCraft,
  syncCraftRuntime,
  writeCraftReadout,
  setMotionWorld,
  flightInput,
} from '../core/motion.js'

const NO_RAYCAST = () => null

function CraftMesh({ craft }) {
  const ref = useRef()
  const piloting = useStore((s) => !!s.player && s.player.kind !== 'freeCam')
  const selectCraft = useStore((s) => s.selectCraft)
  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), up: new THREE.Vector3(), fwd: new THREE.Vector3(), rgt: new THREE.Vector3() }), [])

  useFrame(() => {
    const rt = craftRuntime.get(craft.id)
    if (!rt || !ref.current) return
    const pose = craftWorldPose(rt)
    if (!pose) return
    const o = ref.current
    o.position.set(pose.pos.x, pose.pos.y, pose.pos.z)
    tmp.up.set(pose.up[0], pose.up[1], pose.up[2])
    tmp.fwd.set(pose.forward[0], pose.forward[1], pose.forward[2])
    tmp.rgt.crossVectors(tmp.up, tmp.fwd) // right = up × forward
    tmp.m.makeBasis(tmp.rgt, tmp.up, tmp.fwd)
    o.quaternion.setFromRotationMatrix(tmp.m)
    o.scale.setScalar(rt.size)
  })

  // a parked shuttle, unit-sized (≈1 tile fraction of the host body):
  // fuselage + nose along +Z, delta wings, a belly light
  return (
    <group
      ref={ref}
      raycast={piloting ? NO_RAYCAST : undefined}
      onClick={piloting ? undefined : (e) => {
        e.stopPropagation()
        selectCraft(craft.id)
      }}
    >
      <mesh position={[0, 0, 0.15]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.26, 0.3, 0.9, 12]} />
        <meshStandardMaterial color="#cdd6e4" metalness={0.55} roughness={0.4} />
      </mesh>
      <mesh position={[0, 0, 0.82]} rotation={[Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.3, 0.45, 12]} />
        <meshStandardMaterial color="#9fb2cc" metalness={0.6} roughness={0.35} />
      </mesh>
      <mesh position={[-0.38, -0.02, -0.25]} rotation={[0, 0, 0.5]}>
        <boxGeometry args={[0.5, 0.05, 0.5]} />
        <meshStandardMaterial color="#7d8aa0" metalness={0.5} roughness={0.5} />
      </mesh>
      <mesh position={[0.38, -0.02, -0.25]} rotation={[0, 0, -0.5]}>
        <boxGeometry args={[0.5, 0.05, 0.5]} />
        <meshStandardMaterial color="#7d8aa0" metalness={0.5} roughness={0.5} />
      </mesh>
    </group>
  )
}

export default function AmbientCrafts() {
  const world = useStore((s) => s.world)
  const crafts = world.crafts || []

  // document identity changed → reconcile the runtime (sizes, fresh states,
  // dropped crafts) — and the world the EVA step runs against
  useEffect(() => {
    syncCraftRuntime(world)
    setMotionWorld(world)
  }, [world])

  useFrame((_, delta) => {
    const s = useStore.getState()
    if (!s.playing) return
    const dt = Math.min(delta, 0.05)
    const piloting = s.player?.kind === 'craft'
    for (const c of s.world.crafts || []) {
      const input = piloting && s.player.craftId === c.id ? flightInput : null
      stepCraft(c, dt, input)
      if (input) writeCraftReadout(c) // HUD telemetry for the piloted craft
    }
  })

  if (!crafts.length) return null
  return (
    <>
      {crafts.map((c) => (
        <CraftMesh key={c.id} craft={c} />
      ))}
    </>
  )
}
