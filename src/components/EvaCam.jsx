/**
 * EvaCam.jsx — the adrift astronaut (EVA): first person in open space.
 *
 * The astronaut is an OBJECT like any other: real gravity always pulls (the
 * softened law, core/motion.js stepEva), the jetpack's thrust always
 * outweighs the local gravity so it can hover on every body, and a fall
 * that ends on a surface switches the astronaut to ON FOOT there (the
 * landing → walk transition, no buttons). Ejecting from a flying craft
 * lands the astronaut here, inheriting the craft's velocity.
 *
 * The camera is the astronaut (no avatar mesh). Input rides the shared
 * flightInput side channel exactly like the piloted craft does — WASD/R/F
 * thrust along the view, Shift boost, hold & drag to look, E to board the
 * nearest craft (App.jsx), Esc for the free camera (App.jsx).
 */

import { useEffect, useRef, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useStore } from '../state/store.js'
import { eva, craftVectors, stepEva, setMotionWorld, writeEvaReadout, flightInput, resetFlightInput } from '../core/motion.js'

const LOOK_SENS = 0.0032

export default function EvaCam() {
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const world = useStore((s) => s.world)

  const lookRef = useRef({ id: null, x: 0, y: 0 })
  const tmp = useMemo(() => ({ look: { x: 0, y: 0, z: 0 } }), [])

  // the EVA step runs against this world document (keeps core store-free)
  useEffect(() => {
    setMotionWorld(world)
  }, [world])

  // first-person near plane: on a true-scale world the eye can be centimetres
  // from the terrain — the log depth buffer carries a tiny near plane
  useEffect(() => {
    const prev = camera.near
    camera.near = Math.min(prev, 1e-5)
    camera.updateProjectionMatrix()
    return () => {
      camera.near = prev
      camera.updateProjectionMatrix()
    }
  }, [camera])

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
          e.preventDefault()
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
      resetFlightInput()
    }
  }, [])

  // ----------------------------------------------------------- look (drag) -
  useEffect(() => {
    const el = gl.domElement
    const onDown = (e) => {
      const l = lookRef.current
      if (l.id !== null) return
      l.id = e.pointerId
      l.x = e.clientX
      l.y = e.clientY
      if (el.setPointerCapture) el.setPointerCapture(e.pointerId)
      e.preventDefault()
    }
    const onMove = (e) => {
      const l = lookRef.current
      if (e.pointerId !== l.id) return
      flightInput.lookDX += e.clientX - l.x
      flightInput.lookDY += e.clientY - l.y
      l.x = e.clientX
      l.y = e.clientY
    }
    const onUp = (e) => {
      if (e.pointerId === lookRef.current.id) lookRef.current.id = null
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

  // ---------------------------------------------------------------- frame --
  useFrame((_, delta) => {
    const s = useStore.getState()
    if (!s.player || s.player.kind !== 'eva') return
    const st = eva.state
    if (!st) return // a land event just flipped the session; wait for it
    const dt = Math.min(delta, 0.05)
    const ev = s.playing ? stepEva(dt, flightInput) : null
    if (ev) {
      // the fall ended: on foot where it landed (Walker spawns there)
      s.evaLand(ev)
      return
    }
    writeEvaReadout()
    camera.position.set(st.pos.x, st.pos.y, st.pos.z)
    const v = craftVectors(st.yaw, st.pitch)
    camera.lookAt(st.pos.x + v.forward[0], st.pos.y + v.forward[1], st.pos.z + v.forward[2])
  })

  return null
}
