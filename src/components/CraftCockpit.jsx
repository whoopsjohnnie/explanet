/**
 * CraftCockpit.jsx — the camera while piloting a craft.
 *
 * Cockpit first person by default: the camera sits in the craft's nose and
 * looks along its forward axis — the craft's attitude IS the view (there is
 * no avatar; the ship is the body, like the walker has none). C flips to a
 * third-person CHASE cam behind and above the ship so you can see it. Both
 * views share one attitude; the mesh is posed by Crafts.jsx from the same
 * craftRuntime state the camera reads, every frame.
 *
 * Controls (App.jsx keeps the editor's tool keys out of piloting modes):
 *   W/S          thrust forward / backward (real: also Space = hard retro)
 *   A/D          strafe
 *   R/F          up / down
 *   Shift        boost
 *   ←/→          yaw    ↑/↓ pitch    (or hold & drag to aim)
 *   C            cockpit ⇄ chase
 *   E            eject   (handled in App.jsx)
 *   Esc          free camera (handled in App.jsx)
 *
 * The live craft state is stepped by AmbientCrafts (mounted earlier in the
 * tree, so it runs first); this component only reads it and drives the
 * camera. Input goes through the shared flightInput side channel — the same
 * one the headless harness drives.
 */

import { useEffect, useRef, useMemo, useState } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useStore } from '../state/store.js'
import { craftRuntime, craftWorldPose, craftVectors, flightInput, resetFlightInput } from '../core/motion.js'

const LOOK_SENS = 0.0032 // radians of aim per dragged pixel (same as the walker)

export default function CraftCockpit({ craftId }) {
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const [chase, setChase] = useState(false)

  const tmp = useMemo(
    () => ({ pos: new THREE.Vector3(), look: new THREE.Vector3(), fwd: new THREE.Vector3(), up: new THREE.Vector3() }),
    []
  )
  const nearPrev = useRef(null)
  const look = useRef({ id: null, x: 0, y: 0 })

  // ---------------------------------------------------------------- keys --
  useEffect(() => {
    const onKey = (down) => (e) => {
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const k = flightInput
      switch (e.code) {
        case 'KeyW':
          k.fwd = down ? 1 : 0
          break
        case 'KeyS':
          k.back = down ? 1 : 0
          break
        case 'KeyA':
          k.left = down ? 1 : 0
          break
        case 'KeyD':
          k.right = down ? 1 : 0
          break
        case 'KeyR':
          k.up = down ? 1 : 0
          break
        case 'KeyF':
          k.down = down ? 1 : 0
          break
        case 'ShiftLeft':
        case 'ShiftRight':
          k.boost = down
          break
        case 'Space':
          k.retro = down
          break
        case 'ArrowLeft':
          k.yaw = down ? 1 : 0
          e.preventDefault()
          break
        case 'ArrowRight':
          k.yaw = down ? -1 : 0
          e.preventDefault()
          break
        case 'ArrowUp':
          k.pitch = down ? 1 : 0
          e.preventDefault()
          break
        case 'ArrowDown':
          k.pitch = down ? -1 : 0
          e.preventDefault()
          break
        case 'KeyC':
          if (down && !e.repeat) setChase((c) => !c)
          break
        default:
          return
      }
    }
    const kd = onKey(true)
    const ku = onKey(false)
    window.addEventListener('keydown', kd)
    window.addEventListener('keyup', ku)
    return () => {
      window.removeEventListener('keydown', kd)
      window.removeEventListener('keyup', ku)
      resetFlightInput() // never leave a key held for the next session
    }
  }, [])

  // ----------------------------------------------- pointer aim (hold drag) -
  useEffect(() => {
    const el = gl.domElement
    const onDown = (e) => {
      const l = look.current
      if (l.id !== null) return
      l.id = e.pointerId
      l.x = e.clientX
      l.y = e.clientY
      if (el.setPointerCapture) el.setPointerCapture(e.pointerId)
      e.preventDefault()
    }
    const onMove = (e) => {
      const l = look.current
      if (e.pointerId !== l.id) return
      flightInput.lookDX += e.clientX - l.x
      flightInput.lookDY += e.clientY - l.y
      l.x = e.clientX
      l.y = e.clientY
    }
    const onUp = (e) => {
      if (e.pointerId === look.current.id) look.current.id = null
    }
    const onCtx = (e) => e.preventDefault()
    el.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    el.addEventListener('contextmenu', onCtx)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      el.removeEventListener('contextmenu', onCtx)
    }
  }, [gl])

  // ------------------------------------------- first-person near plane -----
  // The cockpit sits inside the hull: the editor's near plane would clip the
  // nose away. A near plane a sliver above zero (the log depth buffer
  // carries it) keeps the ship's own geometry visible in cockpit view.
  useEffect(
    () => () => {
      if (nearPrev.current != null) {
        camera.near = nearPrev.current
        camera.updateProjectionMatrix()
      }
    },
    [camera]
  )

  // ---------------------------------------------------------------- frame --
  useFrame(() => {
    const s = useStore.getState()
    if (!s.player || s.player.kind !== 'craft' || s.player.craftId !== craftId) return
    const rt = craftRuntime.get(craftId)
    if (!rt) return
    const pose = craftWorldPose(rt)
    if (!pose) return
    const size = rt.size

    if (nearPrev.current == null) {
      nearPrev.current = camera.near
      camera.near = Math.min(camera.near, Math.max(1e-5, size * 0.04))
      camera.updateProjectionMatrix()
    }

    tmp.pos.set(pose.pos.x, pose.pos.y, pose.pos.z)
    if (rt.state.mode === 'park') {
      // on the pad: sit in the cockpit, nose skyward (forward = up)
      tmp.up.set(pose.up[0], pose.up[1], pose.up[2])
      tmp.fwd.copy(tmp.up)
      camera.position.copy(tmp.pos).addScaledVector(tmp.up, size * 0.35)
      tmp.look.copy(tmp.pos).addScaledVector(tmp.up, size * 2)
    } else if (chase) {
      tmp.fwd.set(pose.forward[0], pose.forward[1], pose.forward[2])
      tmp.up.set(pose.up[0], pose.up[1], pose.up[2])
      camera.position.copy(tmp.pos).addScaledVector(tmp.fwd, -size * 6).addScaledVector(tmp.up, size * 2.2)
      tmp.look.copy(tmp.pos)
    } else {
      // cockpit: in the nose, looking along the forward axis
      tmp.fwd.set(pose.forward[0], pose.forward[1], pose.forward[2])
      tmp.up.set(pose.up[0], pose.up[1], pose.up[2])
      camera.position.copy(tmp.pos).addScaledVector(tmp.up, size * 0.3)
      tmp.look.copy(tmp.pos).addScaledVector(tmp.fwd, size * 10)
    }
    camera.lookAt(tmp.look)
  })

  return null
}
