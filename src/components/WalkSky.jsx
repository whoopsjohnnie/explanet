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
 *    glow around the system's star — the real starfield (StarField.jsx)
 *    draws over the dome and fades itself along the same twilight curve,
 *    so a night walk shows the actual Milky Way and the sun washes it out;
 *  • twilight, the real one: the sky stays FULLY lit while the sun is above
 *    the horizon and only fades to night once it has sunk `skyFade.sunDown`
 *    below it — a sunset must not cut to black at the horizon. Inside the
 *    `skyFade.sunUp` band above the horizon the day colors blend into the
 *    sunset palette: a deep red band hugging the horizon (full width in
 *    azimuth) fading up to a warm amber zenith, with a wide, intense
 *    forward-scatter patch around the low sun;
 *  • the sky's own light on the ground: while the sun is low the star's
 *    pointLight grazes the terrain, so an ambientLight rides the same curve
 *    (pale fill by day → warm orange glow at sunset, scaled by air density)
 *    and the ground stays visible through the whole sunset;
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
import { BAND_FN } from '../core/glsl.js'

const DEFAULTS = { zenith: '#3a6ab8', horizon: '#b8cfe4', glow: '#ffd9a0' }
// The sunset palette is universal warm — Rayleigh red, not a per-body dial:
// what the air does to a low sun is the same on every world (pass-2 group,
// lives in code like the rest of the walkSky colors).
const SUNSET_HORIZON = '#ff5a1f' // deep orange-red hugging the horizon
const SUNSET_ZENITH = '#f0ad60' // warm amber the band fades up into
// The sky's own light on the ground (the ambientLight below): with the sun
// low, the orange sky IS the light. Intensity follows the twilight curve;
// thin air scatters little, so it scales with the atmosphere's opacity.
const FILL_DAY = 0.22
const FILL_SUNSET = 0.7
const FILL_SUNSET_COLOR = '#ff8a4a'
const FILL_REF_OPACITY = 0.62 // Earth: full-strength fill

/** GLSL smoothstep mirror — the twilight curve is evaluated in JS for the fill light. */
const smoothstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position; // unit sphere centered on the eye → sky direction
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

// The twilight bounds and gradient-step counts are injected from constants.json
// (StarField's JS star fade and the ground fill below read the same numbers —
// one definition, three consumers). Step counts of 0 make bandize a
// pass-through, so the default sky stays smooth.
const FRAG = /* glsl */ `
${BAND_FN}
varying vec3 vDir;
uniform vec3 uZenith, uHorizon, uNight, uGlow, uSunsetHorizon, uSunsetZenith, uSunDir, uUpDir;
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
  float elev = dot(sun, uUpDir); // the sun's own elevation above the horizon

  // twilight: the sky stays fully lit while the sun is up and fades to night
  // only once it has sunk sunDown below the horizon — a sunset must not cut
  // to black at the horizon (t=1 must select the smoothstep: mix picks the
  // SECOND arg when the factor is 1, and uHasSun IS 1 in every star world)
  float light = mix(1.0, smoothstep(${gnum(C.skyFade.sunDown)}, 0.0, elev), uHasSun);
  // the warm sunset zone: full at the horizon, gone by sunUp above it
  float sunsetT = mix(0.0, 1.0 - smoothstep(0.0, ${gnum(C.skyFade.sunUp)}, elev), uHasSun);
  light = bandize(light, ${gnum(C.gradient.steps.skyDayNight)});
  sunsetT = bandize(sunsetT, ${gnum(C.gradient.steps.skyDayNight)});

  // day sky: horizon → zenith with the dense band hugging the horizon — with
  // the sunset bleeding into BOTH ends of the gradient: a deep red band hugging
  // the horizon (full width in azimuth) fading up to a warm amber zenith; the
  // body's own colors take over as the sun rises
  vec3 hor = mix(uHorizon, uSunsetHorizon, sunsetT);
  vec3 zen = mix(uZenith, uSunsetZenith, sunsetT);
  vec3 day = mix(hor, zen, bandize(pow(up, 0.55), ${gnum(C.gradient.steps.skyZenith)}));
  // forward scatter around the star: wide + intense at the horizon (the
  // broad bright patch of a real sunset), tight + faint by day; banded too
  // → contour rings around the star (the glare "lines" of the VGA look)
  day += uGlow * bandize(pow(sd, mix(7.0, 3.0, sunsetT)), ${gnum(C.gradient.steps.sunGlare)})
       * mix(0.4, 1.5, sunsetT) * uHasSun;
  vec3 col = mix(uNight, day, light);
  // corona, visible even at dusk — banded with the same sunGlare count, so
  // the halo around the star steps through the same contour rings
  col += uGlow * bandize(pow(sd, 250.0), ${gnum(C.gradient.steps.sunGlare)}) * mix(2.0, 3.0, sunsetT) * uHasSun;
  // no stars here: the real sky (StarField.jsx) rides on top of the dome,
  // self-faded by the same twilight curve — the dome only paints air.
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
  const fillRef = useRef(null)

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
        uSunsetHorizon: { value: color(SUNSET_HORIZON, SUNSET_HORIZON) },
        uSunsetZenith: { value: color(SUNSET_ZENITH, SUNSET_ZENITH) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uUpDir: { value: new THREE.Vector3(0, 1, 0) },
        uOpacity: { value: atmo.opacity },
        uHasSun: { value: 0 },
      },
    })
  }, [atmo])
  useEffect(() => () => material?.dispose(), [material])

  // ground-fill light state (the ambientLight in the render tree): color
  // rides the day→sunset blend, intensity the twilight curve × air density
  const fill = useMemo(() => {
    if (!atmo) return null
    return {
      day: new THREE.Color(atmo.horizon || DEFAULTS.horizon), // pale sky fill by day
      sunset: new THREE.Color(FILL_SUNSET_COLOR),
      scale: Math.min(1, (atmo.opacity ?? 0) / FILL_REF_OPACITY),
    }
  }, [atmo])

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

    // ground fill: the sky's own light on the terrain — see the FILL_*
    // constants above. The same twilight curve as the dome (JS mirror); the
    // color rides the day→sunset blend. Without it the sun's point light
    // grazes the terrain and the ground goes black long before the sky.
    const fl = fillRef.current
    if (fl && fill) {
      const elev = hasSun ? tmp.sun.dot(up) : 1
      const light = smoothstep(C.skyFade.sunDown, 0, elev)
      const tint = hasSun ? 1 - smoothstep(0, C.skyFade.sunUp, elev) : 0
      fl.color.copy(fill.day).lerp(fill.sunset, tint)
      fl.intensity = hasSun ? light * (FILL_DAY + (FILL_SUNSET - FILL_DAY) * tint) * fill.scale : 0
    }
  })

  if (!atmo) return null
  return (
    <>
      <mesh ref={meshRef} material={material} renderOrder={-1} frustumCulled={false}>
        {/* unit dome, scaled to the frustum each frame; modest tessellation —
            every gradient term is per-pixel from the direction, not the mesh */}
        <sphereGeometry args={[1, C.decor.domeWidthSegs, C.decor.domeHeightSegs]} />
      </mesh>
      {/* the sky's light on the ground — driven in useFrame, walk-mode only */}
      <ambientLight ref={fillRef} intensity={0} />
    </>
  )
}
