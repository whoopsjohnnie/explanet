/**
 * Crafts.jsx — the world's vehicles, rendered and kept moving.
 *
 *  • AmbientCrafts mounts one CraftMesh per craft (world.crafts) and runs
 *    the craft step loop in useFrame: every craft integrates its mover
 *    (core/motion.js stepCraft) — parked ones ride their body analytically,
 *    flying ones coast (arcade eases to a hover; real keeps orbiting) —
 *    with the piloted craft fed the live flightInput and its telemetry
 *    written to the motionReadout side channel.
 *  • CraftMesh renders one craft from its DESIGN — the serialized mesh
 *    document (core/craftDesigns.js: `models.design` from the world
 *    database, a per-craft override, or the built-in default for the kind)
 *    — posed EVERY frame from the craftRuntime: the same float32 registry
 *    stream as the planet meshes (a parked craft composes from its body's
 *    registry entry, so it rides the same quantized pose). The mesh scales
 *    by rt.size / design.length, so the model renders at its true meter size
 *    (sizeMeters / world.scale, like the real-human astronaut).
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
import { craftDesignFor } from '../core/craftDesigns.js'

const NO_RAYCAST = () => null

// The part primitives a design may use (core/craftDesigns.js CRAFT_DESIGN_SHAPES,
// mirrored as three geometries — the size array is the geometry's args).
const GEOMETRIES = {
  box: (s) => <boxGeometry args={[s[0], s[1], s[2]]} />,
  cylinder: (s) => <cylinderGeometry args={[s[0], s[1], s[2], s[3] ?? 16]} />,
  cone: (s) => <coneGeometry args={[s[0], s[1], s[2] ?? 16]} />,
  sphere: (s) => <sphereGeometry args={[s[0], s[1] ?? 24, s[2] ?? 16]} />,
}

/** One part of a craft design document: a positioned, rotated primitive. */
function DesignPart({ part }) {
  const m = part.material
  return (
    <mesh position={part.position} rotation={part.rotation}>
      {GEOMETRIES[part.shape](part.size)}
      <meshStandardMaterial
        color={m.color}
        metalness={m.metalness}
        roughness={m.roughness}
        {...(m.emissive ? { emissive: m.emissive, emissiveIntensity: m.emissiveIntensity } : {})}
      />
    </mesh>
  )
}

/**
 * The craft's mesh, rebuilt from its design JSON (the `ShuttleModel`/
 * `RoverModel` of old, now data): parts map 1:1 to three primitives, nose
 * (drive heading) along +Z in model units. Unknown shapes never reach here
 * (normalizeCraftDesign drops them; the built-in defaults only use known ones).
 */
function CraftDesignModel({ design }) {
  return (
    <>
      {design.parts.map((p, i) => (
        <DesignPart key={i} part={p} />
      ))}
    </>
  )
}

function CraftMesh({ craft }) {
  const ref = useRef()
  const piloting = useStore((s) => !!s.player && s.player.kind !== 'freeCam')
  const selectCraft = useStore((s) => s.selectCraft)
  // the design the craft renders with: its own (DB-model or document) design,
  // else the built-in for its kind — stable per craft document identity
  const design = useMemo(() => craftDesignFor(craft), [craft])
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
    // rt.size is the craft's length in WORLD units; design.length is the
    // model's nose-to-tail span in MODEL units — the scale between them
    o.scale.setScalar(rt.size / design.length)
  })

  return (
    <group
      ref={ref}
      raycast={piloting ? NO_RAYCAST : undefined}
      onClick={piloting ? undefined : (e) => {
        e.stopPropagation()
        selectCraft(craft.id)
      }}
    >
      <CraftDesignModel design={design} />
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
