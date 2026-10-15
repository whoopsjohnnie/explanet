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
 *  • translate camera-relative WASD input through the inverse planet
 *    rotation into a local tangent wish,
 *  • third-person chase framing via the same delta-drag trick as CameraFollow
 *    — the camera is dragged along with the walker while OrbitControls keeps
 *    handling look-around and zoom,
 *  • render a small astronaut marker at the walker's feet.
 *
 * On mount the walker spawns above the surface facing the camera and falls
 * down — the landing moment. On unmount the orbit hands back to the planet
 * center without a view jump.
 */

import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useStore } from '../state/store.js'
import { registry } from '../core/physics.js'
import { planetMass } from '../core/planetMath.js'
import { makeSurface, createWalker, stepWalker, surfaceGravity, walkReadout } from '../core/surface.js'

const EYE = 0.72 // camera anchor height above the surface (the astronaut's chest)
const noRaycast = () => null

export default function Walker({ planetId }) {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls)
  const planet = useStore((s) => s.world.planets.find((p) => p.id === planetId))

  // rebuild the surface query when the planet document identity changes
  // (same copy-on-write contract as the geometry memo)
  const surface = useMemo(() => (planet ? makeSurface(planet) : null), [planet])
  const mass = useMemo(() => (planet ? planetMass(planet) : 0), [planet])

  // live session: { walker, prevPlayer, lastFwd, placed }
  const stateRef = useRef(null)
  const avatarRef = useRef(null)
  const keys = useRef({ up: false, down: false, left: false, right: false, sprint: false, jump: false })

  // scratch objects — the frame loop must not allocate
  const tmp = useMemo(
    () => ({
      q: new THREE.Quaternion(),
      qInv: new THREE.Quaternion(),
      planetPos: new THREE.Vector3(),
      dirW: new THREE.Vector3(),
      player: new THREE.Vector3(),
      anchor: new THREE.Vector3(),
      camF: new THREE.Vector3(),
      fwd: new THREE.Vector3(),
      rgt: new THREE.Vector3(),
      wish: new THREE.Vector3(),
      wishArr: [0, 0, 0],
      d: new THREE.Vector3(),
      upY: new THREE.Vector3(0, 1, 0),
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
        prevPlayer: new THREE.Vector3(),
        lastFwd: new THREE.Vector3(0, 0, -1),
        placed: false,
      }
      stateRef.current = s
    }
    const w = s.walker

    // ---- wish direction: camera-relative, projected, into the local frame
    const k = keys.current
    const fwdIn = (k.up ? 1 : 0) - (k.down ? 1 : 0)
    const strafeIn = (k.right ? 1 : 0) - (k.left ? 1 : 0)
    tmp.dirW.set(w.dir[0], w.dir[1], w.dir[2]).applyQuaternion(tmp.q) // world up
    camera.getWorldDirection(tmp.camF)
    tmp.fwd.copy(tmp.camF).addScaledVector(tmp.dirW, -tmp.camF.dot(tmp.dirW))
    if (tmp.fwd.lengthSq() > 1e-8) {
      tmp.fwd.normalize()
      s.lastFwd.copy(tmp.fwd)
    } else {
      tmp.fwd.copy(s.lastFwd) // looking straight down: keep last ground heading
      tmp.fwd.addScaledVector(tmp.dirW, -tmp.fwd.dot(tmp.dirW))
      tmp.fwd.normalize()
    }
    tmp.rgt.crossVectors(tmp.fwd, tmp.dirW)
    tmp.wish
      .set(0, 0, 0)
      .addScaledVector(tmp.fwd, fwdIn)
      .addScaledVector(tmp.rgt, strafeIn)
      .applyQuaternion(tmp.qInv)
    tmp.wishArr[0] = tmp.wish.x
    tmp.wishArr[1] = tmp.wish.y
    tmp.wishArr[2] = tmp.wish.z

    // ---- integrate (pure core math, planet-local frame) --------------------
    const g = surfaceGravity(st.world.gravity, mass, w.r)
    stepWalker(surface, w, g, tmp.wishArr, { jump: k.jump, sprint: k.sprint }, dt)
    k.jump = false

    // ---- world pose ----------------------------------------------------------
    tmp.dirW.set(w.dir[0], w.dir[1], w.dir[2]).applyQuaternion(tmp.q) // up at feet
    tmp.player.copy(tmp.planetPos).addScaledVector(tmp.dirW, w.r) // feet
    tmp.anchor.copy(tmp.dirW).multiplyScalar(EYE).add(tmp.player) // chest

    if (controls) {
      if (!s.placed) {
        // keep the current view direction, snap the orbit pivot to the walker
        // and pull in to a walking distance
        tmp.d.copy(tmp.anchor).sub(controls.target)
        camera.position.add(tmp.d)
        tmp.d.copy(camera.position).sub(tmp.anchor)
        const dist = tmp.d.length() || 1
        const want = Math.min(Math.max(dist, 3.2), 14)
        if (Math.abs(dist - want) > 1e-4) {
          tmp.d.multiplyScalar(want / dist)
          camera.position.copy(tmp.anchor).add(tmp.d)
        }
        controls.target.copy(tmp.anchor)
        controls.update()
        s.prevPlayer.copy(tmp.player)
        s.placed = true
      } else {
        // delta-drag: translate the camera by the walker's frame movement so
        // orbiting/zooming keep working while walking (CameraFollow trick)
        camera.position.add(tmp.d.copy(tmp.player).sub(s.prevPlayer))
        controls.target.copy(tmp.anchor)
        controls.update()
        s.prevPlayer.copy(tmp.player)
      }
    }

    // ---- avatar + HUD telemetry ----------------------------------------------
    const av = avatarRef.current
    if (av) {
      av.position.copy(tmp.player)
      av.quaternion.setFromUnitVectors(tmp.upY, tmp.dirW)
    }
    const ground = surface.heightAt(w.dir, w.cell)
    walkReadout.alt = Math.max(0, w.r - ground.radius)
    walkReadout.vel = w.radialVel
    walkReadout.grounded = w.grounded
    walkReadout.sprint = k.sprint && (fwdIn !== 0 || strafeIn !== 0)
  })

  return (
    <group ref={avatarRef}>
      {/* a small flat-shaded astronaut standing where the walker is */}
      <mesh position={[-0.07, 0.1, 0]} raycast={noRaycast}>
        <boxGeometry args={[0.09, 0.2, 0.1]} />
        <meshStandardMaterial color="#c9cfdd" flatShading roughness={0.8} />
      </mesh>
      <mesh position={[0.07, 0.1, 0]} raycast={noRaycast}>
        <boxGeometry args={[0.09, 0.2, 0.1]} />
        <meshStandardMaterial color="#c9cfdd" flatShading roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.33, 0]} raycast={noRaycast}>
        <capsuleGeometry args={[0.13, 0.18, 3, 10]} />
        <meshStandardMaterial color="#eef1f7" flatShading roughness={0.7} />
      </mesh>
      <mesh position={[0, 0.36, -0.14]} raycast={noRaycast}>
        <boxGeometry args={[0.17, 0.2, 0.09]} />
        <meshStandardMaterial color="#ffb84d" flatShading roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.57, 0]} raycast={noRaycast}>
        <sphereGeometry args={[0.125, 12, 10]} />
        <meshStandardMaterial color="#f4f6fb" flatShading roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.575, 0.075]} raycast={noRaycast}>
        <sphereGeometry args={[0.08, 12, 10]} />
        <meshStandardMaterial color="#1b2740" metalness={0.6} roughness={0.25} />
      </mesh>
      <mesh position={[0.13, 0.34, 0.06]} raycast={noRaycast}>
        <boxGeometry args={[0.035, 0.06, 0.035]} />
        <meshStandardMaterial color="#5fa8ff" emissive="#5fa8ff" emissiveIntensity={2} toneMapped={false} />
      </mesh>
    </group>
  )
}
