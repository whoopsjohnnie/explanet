/**
 * Walker.jsx — surface mode: land on a planet and walk around on it.
 *
 * Mounted only while store.walkMode is set (keyed by planetId, so landing on
 * another planet remounts cleanly). The actual walking physics live in
 * core/surface.js (pure + headless-tested); this component does the frame
 * plumbing:
 *
 *  • integrate the walker in the PLANET-LOCAL frame, so it rides the planet's
 *    spin and orbit for free; world pose = planetPos + quat·(dir·r), read
 *    from the live body registry every frame (never through React state),
 *  • first-person camera at all times: the camera sits at EYE height above
 *    the surface, exactly where the astronaut's eyes are, through the landing
 *    fall, the walk and every jump. The view heading is stored PLANET-LOCAL —
 *    exactly like the walker's position — so it composes through the planet's
 *    quaternion every frame: the view is WELDED to the surface, and a landmark
 *    stays dead ahead no matter how the planet spins or flies; the horizon
 *    turns with the planet, never under it. Look-around is a held pointer
 *    drag: yaw rotates the heading around the walker's local up, pitch around
 *    the local right, elevation clamped short of the poles so the horizon
 *    stays level with the surface normal — on a spherical world this is what
 *    OrbitControls cannot give (its azimuth is locked to world Y), which is
 *    why the walker owns the camera outright and Scene.jsx disables
 *    OrbitControls while walking,
 *  • translate the camera-relative WASD input into a local tangent wish —
 *    the heading already lives in the local frame, and the wish is its
 *    projection onto the tangent plane, so you always move where you look.
 *
 * No avatar is rendered — the camera IS the astronaut. On mount the walker
 * spawns above the surface facing your current view and falls down: the
 * landing moment, seen from your eyes. On unmount the orbit pivot returns to
 * the planet center, dragging the camera by the same delta (the CameraFollow
 * trick) so the editor resumes with a sane framing.
 */

import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useStore } from '../state/store.js'
import { registry } from '../core/physics.js'
import { planetMass } from '../core/planetMath.js'
import { makeSurface, createWalker, stepWalker, surfaceGravity, walkReadout } from '../core/surface.js'

const EYE = 0.62 // astronaut eye height above the surface (top of head ≈ 0.7)
const LOOK_SENS = 0.0032 // radians of view rotation per dragged pixel
const PITCH_LIMIT = 1.45 // ±83° from the horizon; never flips past straight up/down

export default function Walker({ planetId }) {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls)
  const gl = useThree((s) => s.gl)
  const planet = useStore((s) => s.world.planets.find((p) => p.id === planetId))

  // rebuild the surface query when the planet document identity changes
  // (same copy-on-write contract as the geometry memo)
  const surface = useMemo(() => (planet ? makeSurface(planet) : null), [planet])
  const mass = useMemo(() => (planet ? planetMass(planet) : 0), [planet])

  // live session: { walker, fwdL (view heading, planet-local), lastFwd, placed }
  const stateRef = useRef(null)
  const keys = useRef({ up: false, down: false, left: false, right: false, sprint: false, jump: false })
  // accumulated look-drag in pixels, consumed by the frame loop
  const look = useRef({ id: null, x: 0, y: 0, dx: 0, dy: 0 })

  // scratch objects — the frame loop must not allocate
  const tmp = useMemo(
    () => ({
      q: new THREE.Quaternion(),
      qInv: new THREE.Quaternion(),
      m: new THREE.Matrix4(),
      planetPos: new THREE.Vector3(),
      dirW: new THREE.Vector3(),
      upL: new THREE.Vector3(),
      player: new THREE.Vector3(),
      eye: new THREE.Vector3(),
      gaze: new THREE.Vector3(),
      fwd: new THREE.Vector3(),
      rgt: new THREE.Vector3(),
      wish: new THREE.Vector3(),
      wishArr: [0, 0, 0],
      d: new THREE.Vector3(),
    }),
    []
  )

  // ------------------------------------------------------------- keyboard --
  useEffect(() => {
    const onKey = (down) => (e) => {
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const k = keys.current
      switch (e.code) {
        case 'KeyW':
          k.up = down
          break
        case 'KeyS':
          k.down = down
          break
        case 'KeyA':
          k.left = down
          break
        case 'KeyD':
          k.right = down
          break
        case 'ArrowUp':
          k.up = down
          e.preventDefault()
          break
        case 'ArrowDown':
          k.down = down
          e.preventDefault()
          break
        case 'ArrowLeft':
          k.left = down
          e.preventDefault()
          break
        case 'ArrowRight':
          k.right = down
          e.preventDefault()
          break
        case 'ShiftLeft':
        case 'ShiftRight':
          k.sprint = down
          break
        case 'Space':
          e.preventDefault()
          if (down && !e.repeat) k.jump = true // edge-triggered, consumed per frame
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
    }
  }, [])

  // ------------------------------------------------------ pointer look -----
  // Held drag = first-person look (mouse or touch). Deltas accumulate and are
  // consumed once per frame so look input is frame-rate independent and never
  // applied twice between physics steps.
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
      l.dx += e.clientX - l.x
      l.dy += e.clientY - l.y
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

  // --------------------------------------------------- camera hand-back ----
  // Read the latest controls/camera through refs so this cleanup fires only
  // on real unmount (controls settles null→instance shortly after mount; a
  // dep on it would run the cleanup mid-walk and respawn the walker).
  const controlsRef = useRef(controls)
  controlsRef.current = controls
  useEffect(
    () => () => {
      stateRef.current = null
      walkReadout.alt = 0
      walkReadout.vel = 0
      walkReadout.grounded = false
      const entry = registry.bodies.get(planetId)
      const orbit = controlsRef.current
      if (orbit && entry) {
        // orbit pivots back to the planet center, dragging the camera with it
        tmp.d.set(entry.pos.x, entry.pos.y, entry.pos.z).sub(orbit.target)
        camera.position.add(tmp.d)
        orbit.target.set(entry.pos.x, entry.pos.y, entry.pos.z)
        orbit.update()
      }
    },
    [planetId, camera, tmp]
  )

  // --------------------------------------------------------------- frame --
  useFrame((_, delta) => {
    const st = useStore.getState()
    if (!st.walkMode || st.walkMode.planetId !== planetId) return

    const entry = registry.bodies.get(planetId)
    if (!entry || !surface || !planet) {
      st.exitWalkMode()
      return
    }

    const dt = Math.min(delta, 0.05)
    tmp.q.set(entry.quat.x, entry.quat.y, entry.quat.z, entry.quat.w)
    tmp.qInv.copy(tmp.q).invert()
    tmp.planetPos.set(entry.pos.x, entry.pos.y, entry.pos.z)

    // spawn: the face of the planet currently turned toward the camera
    let s = stateRef.current
    if (!s) {
      tmp.dirW.copy(camera.position).sub(tmp.planetPos)
      if (tmp.planetPos.distanceToSquared(camera.position) < 1e-6) tmp.dirW.set(0, 1, 0)
      tmp.dirW.normalize().applyQuaternion(tmp.qInv)
      s = {
        walker: createWalker(surface, [tmp.dirW.x, tmp.dirW.y, tmp.dirW.z]),
        fwdL: new THREE.Vector3(),
        lastFwd: new THREE.Vector3(0, 0, -1),
        placed: false,
      }
      stateRef.current = s
    }
    const w = s.walker
    tmp.upL.set(w.dir[0], w.dir[1], w.dir[2]) // local up == local position dir

    // ---- view heading: on the first frame keep the direction we landed ----
    // looking, in world space; store it PLANET-LOCAL from then on
    if (!s.placed) {
      camera.getWorldDirection(s.fwdL)
      s.fwdL.applyQuaternion(tmp.qInv)
      clampElevation(s.fwdL, tmp.upL, tmp.rgt)
      s.placed = true
    }

    // ---- consume look drag: yaw around local up, pitch around local right -
    const l = look.current
    if (l.dx !== 0 || l.dy !== 0) {
      s.fwdL.applyAxisAngle(tmp.upL, -l.dx * LOOK_SENS)
      tmp.rgt.crossVectors(s.fwdL, tmp.upL)
      if (tmp.rgt.lengthSq() > 1e-8) {
        s.fwdL.applyAxisAngle(tmp.rgt.normalize(), -l.dy * LOOK_SENS)
        clampElevation(s.fwdL, tmp.upL, tmp.rgt)
      }
      s.fwdL.normalize()
      l.dx = 0
      l.dy = 0
    }

    // ---- wish direction: view heading projected onto the tangent plane ---
    const k = keys.current
    const fwdIn = (k.up ? 1 : 0) - (k.down ? 1 : 0)
    const strafeIn = (k.right ? 1 : 0) - (k.left ? 1 : 0)
    tmp.fwd.copy(s.fwdL).addScaledVector(tmp.upL, -s.fwdL.dot(tmp.upL))
    if (tmp.fwd.lengthSq() > 1e-8) {
      tmp.fwd.normalize()
      s.lastFwd.copy(tmp.fwd)
    } else {
      tmp.fwd.copy(s.lastFwd) // looking straight up/down: keep last ground heading
      tmp.fwd.addScaledVector(tmp.upL, -tmp.fwd.dot(tmp.upL))
      tmp.fwd.normalize()
    }
    tmp.rgt.crossVectors(tmp.fwd, tmp.upL)
    tmp.wish // heading lives in the planet-local frame, so the wish already does too
      .set(0, 0, 0)
      .addScaledVector(tmp.fwd, fwdIn)
      .addScaledVector(tmp.rgt, strafeIn)
    tmp.wishArr[0] = tmp.wish.x
    tmp.wishArr[1] = tmp.wish.y
    tmp.wishArr[2] = tmp.wish.z

    // ---- integrate (pure core math, planet-local frame) --------------------
    const g = surfaceGravity(st.world.gravity, mass, w.r)
    stepWalker(surface, w, g, tmp.wishArr, { jump: k.jump, sprint: k.sprint }, dt)
    k.jump = false

    // ---- world pose: the camera rides the astronaut's eyes -----------------
    tmp.dirW.set(w.dir[0], w.dir[1], w.dir[2]).applyQuaternion(tmp.q) // up at feet
    tmp.player.copy(tmp.planetPos).addScaledVector(tmp.dirW, w.r) // feet
    tmp.eye.copy(tmp.player).addScaledVector(tmp.dirW, EYE) // eyes — through
    camera.position.copy(tmp.eye) // fall, walk and jump alike
    // gaze = local heading spun into the world: the view is WELDED to the
    // surface, so the horizon turns exactly with the planet, never under it
    tmp.gaze.copy(s.fwdL).applyQuaternion(tmp.q).add(tmp.eye)
    tmp.m.lookAt(tmp.eye, tmp.gaze, tmp.dirW)
    camera.quaternion.setFromRotationMatrix(tmp.m)

    // ---- HUD telemetry -----------------------------------------------------
    const ground = surface.heightAt(w.dir, w.cell)
    walkReadout.alt = Math.max(0, w.r - ground.radius)
    walkReadout.vel = w.radialVel
    walkReadout.grounded = w.grounded
    walkReadout.sprint = k.sprint && (fwdIn !== 0 || strafeIn !== 0)
  })

  // first-person: you don't see your own body — no avatar to render
  return null
}

/** Rotate `fwd` about `rgt` (scratch, overwritten) until its elevation above
 *  the tangent plane at `up` sits within ±PITCH_LIMIT. */
function clampElevation(fwd, up, rgt) {
  const el = Math.asin(THREE.MathUtils.clamp(fwd.dot(up), -1, 1))
  if (el > PITCH_LIMIT || el < -PITCH_LIMIT) {
    rgt.crossVectors(fwd, up)
    if (rgt.lengthSq() > 1e-8) fwd.applyAxisAngle(rgt.normalize(), (el > 0 ? PITCH_LIMIT : -PITCH_LIMIT) - el)
  }
  fwd.normalize()
}
