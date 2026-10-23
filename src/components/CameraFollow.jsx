/**
 * CameraFollow.jsx — rigidly drags the camera along with the selected planet
 * so orbit controls keep working while worlds fly around.
 *
 * Reads the live physics registry — which PlanetSim keeps bit-identical to
 * the rendered (float32) mesh transform, so follow locks the planet to the
 * frame instead of gliding over a float32 staircase.
 */

import { useFrame, useThree } from '@react-three/fiber'
import { useStore } from '../state/store.js'
import { registry } from '../core/physics.js'

export default function CameraFollow() {
  const controls = useThree((s) => s.controls)
  const camera = useThree((s) => s.camera)
  useFrame(() => {
    if (!controls?.target) return
    if (useStore.getState().walkMode) return // surface walker owns the camera (first person)
    if (!useStore.getState().followSelected) return
    const id = useStore.getState().selectedId
    const body = id ? registry.bodies.get(id) : null
    if (!body) return
    const t = controls.target
    const dx = body.pos.x - t.x
    const dy = body.pos.y - t.y
    const dz = body.pos.z - t.z
    if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) < 1e-7) return
    camera.position.set(camera.position.x + dx, camera.position.y + dy, camera.position.z + dz)
    t.set(body.pos.x, body.pos.y, body.pos.z)
    controls.update()
  })
  return null
}
