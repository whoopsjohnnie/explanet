/**
 * WalkSky.jsx — the sky above the surface walker, driven by the body's
 * `atmosphere` document descriptor (core/atmospheres.js catalog; see
 * worldSchema.js for the shape). Mounted beside Walker while walking; renders
 * nothing for airless bodies, which correctly keep the bare starfield.
 *
 * One camera-centered dome, every frame (Walker.jsx owns the camera; this
 * just hangs a sky on it):
 *
 *  • horizon→zenith gradient in the body's colors, plus a forward-scatter
 *    glow around the system's star, which also sets day vs. night — the real
 *    starfield (StarField.jsx) draws over the dome and fades itself along
 *    this same curve, so a night walk shows the actual Milky Way and the
 *    sun washes it out by day;
 *  • the dome NEVER writes depth and tests against the opaque scene: terrain
 *    and planets occlude it, the Sun stays a crisp disk through the haze
 *    (extinction-free, but honest-looking), and it can never eat the world;
 *  • heights stay implicit — a walk-scale observer can't see `top` or
 *    `scaleHeight` directly; from orbit they show up as the limb shell in
 *    AtmosphereGlow.jsx instead; the visible job here is colors + opacity.
 *
 * R3F tone-maps (ACES) and sRGB-encodes standard materials; raw shader
 * materials are skipped by the renderer, so this shader applies the same
 * curve itself and matches the terrain it sits behind.
 */

import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useStore } from '../state/store.js'
import { registry } from '../core/physics.js'
import { C, gnum } from '../core/constants.js'

const DEFAULTS = { zenith: '#3a6ab8', horizon: '#b8cfe4', glow: '#ffd9a0' }

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position; // unit sphere centered on the eye → sky direction
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

// The day-curve bounds are injected from constants.json (StarField's JS fade
// reads the same numbers — one definition, two languages).
const FRAG = /* glsl */ `
varying vec3 vDir;
uniform vec3 uZenith, uHorizon, uNight, uGlow, uSunDir, uUpDir;
uniform float uOpacity, uHasSun;

vec3 aces(vec3 x) { // Narkowicz ACES fit — mirrors the renderer's pipeline
  const vec3 a = vec3(2.51); const vec3 c = vec3(2.43); const vec3 e = vec3(0.14);
  const float b = 0.03; const float d = 0.59;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) * 1.055 - 0.055, step(vec3(0.0031308), c));
}

void main() {
  vec3 dir = normalize(vDir);
  float up = max(dot(dir, uUpDir), 0.0);
  vec3 sun = mix(vec3(0.0, 1.0, 0.0), uSunDir, uHasSun);
  float sd = max(dot(dir, sun), 0.0);

  // day sky: horizon → zenith with the dense band hugging the horizon,
  // plus a wide forward-scatter brightening toward the star
  vec3 day = mix(uHorizon, uZenith, pow(up, 0.55));
  day += uGlow * pow(sd, 7.0) * 0.4 * uHasSun; // no star → pure tint, no fake scatter
  // sun elevation drives day→night (t=1 must select the smoothstep: mix picks
  // the SECOND arg when the factor is 1, and uHasSun IS 1 in every star world)
  float light = mix(1.0, smoothstep(${gnum(C.skyFade.sunDown)}, ${gnum(C.skyFade.sunUp)}, dot(sun, uUpDir)), uHasSun);
  vec3 col = mix(uNight, day, light);
  col += uGlow * pow(sd, 250.0) * 2.0 * uHasSun; // corona, visible even at dusk
  // no stars here: the real sky (StarField.jsx) rides on top of the dome,
  // self-faded by the same sun-elevation curve — the dome only paints air.
  gl_FragColor = vec4(toSRGB(aces(col)), uOpacity);
}
`

export default function WalkSky({ planetId }) {
  const camera = useThree((s) => s.camera)
  const planet = useStore((s) => s.world.planets.find((p) => p.id === planetId))
  const star = useStore(
    (s) => s.world.planets.find((p) => p.kind === 'star') || s.world.planets.find((p) => p.preset === 'star')
  )
  const atmo = planet?.atmosphere
  const meshRef = useRef(null)

  // rebuild only when the descriptor itself changes (hydration copy-on-write
  // preserves the atmosphere reference, so streaming atoms costs nothing)
  const material = useMemo(() => {
    if (!atmo) return null
    const color = (hex, fallback) => new THREE.Color(hex || fallback)
    return new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false, // occlusion tests against terrain, but never occludes
      fog: false, // the sky IS the haze; the editor fog stays an orbit-view effect
      uniforms: {
        uZenith: { value: color(atmo.zenith, DEFAULTS.zenith) },
        uHorizon: { value: color(atmo.horizon, DEFAULTS.horizon) },
        uNight: { value: color(atmo.zenith, DEFAULTS.zenith).multiplyScalar(0.04) },
        uGlow: { value: color(atmo.glow, DEFAULTS.glow) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uUpDir: { value: new THREE.Vector3(0, 1, 0) },
        uOpacity: { value: atmo.opacity },
        uHasSun: { value: 0 },
      },
    })
  }, [atmo])
  useEffect(() => () => material?.dispose(), [material])

  const tmp = useMemo(() => ({ up: new THREE.Vector3(), sun: new THREE.Vector3() }), [])

  // runs after Walker's useFrame (mounted after it): the camera pose is fresh
  useFrame(() => {
    const mesh = meshRef.current
    if (!mesh || !material || !atmo) return
    // the dome rides the eye; far*0.4 keeps it inside the frustum on every
    // world scale (log depth handles the range)
    mesh.position.copy(camera.position)
    mesh.scale.setScalar(Math.max(1, camera.far * 0.4))

    // local up = away from the planet center, from the live registry pose
    const entry = registry.bodies.get(planetId)
    const up = tmp.up
    if (entry)
      up.set(camera.position.x - entry.pos.x, camera.position.y - entry.pos.y, camera.position.z - entry.pos.z)
    if (up.lengthSq() < 1e-9) up.set(0, 1, 0)
    material.uniforms.uUpDir.value.copy(up.normalize())

    // star direction: live registry position, falling back to the document
    // snapshot; no star in the world → uniform sky tint (uHasSun = 0)
    let hasSun = 0
    if (star) {
      const se = registry.bodies.get(star.id)
      const sx = se ? se.pos.x : star.center.x
      const sy = se ? se.pos.y : star.center.y
      const sz = se ? se.pos.z : star.center.z
      tmp.sun.set(sx - camera.position.x, sy - camera.position.y, sz - camera.position.z)
      if (tmp.sun.lengthSq() > 1e-9) {
        material.uniforms.uSunDir.value.copy(tmp.sun.normalize())
        hasSun = 1
      }
    }
    material.uniforms.uHasSun.value = hasSun
  })

  if (!atmo) return null
  return (
    <mesh ref={meshRef} material={material} renderOrder={-1} frustumCulled={false}>
      {/* unit dome, scaled to the frustum each frame; modest tessellation —
          every gradient term is per-pixel from the direction, not the mesh */}
      <sphereGeometry args={[1, 48, 24]} />
    </mesh>
  )
}
