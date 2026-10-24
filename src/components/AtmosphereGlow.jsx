/**
 * AtmosphereGlow.jsx — the orbit-view atmosphere: a thin, sunlit shell around
 * every body with an `atmosphere` descriptor, so a world reads as "has air"
 * while you fly past it (the walk-mode counterpart is WalkSky.jsx).
 *
 * One sphere per atmospheric body (≤ ~10 in Sol Real), radius R·(1 + top)
 * with `top` clamped to a visible band, rendered additive: the fresnel term
 * is ~0 straight-on and ~1 at the limb, so the planet's own disk stays
 * untouched and the glow hugs the edge — the blue rim-of-Earth look. Only
 * the dayside glows (smooth terminator, brighter toward the star, like the
 * forward-scattering haze actually is); the night limb stays dark.
 *
 * House rules it obeys:
 *  • never raycasts (picking is the heightfield march — a shell must not
 *    swallow clicks), never writes depth, never blocks anything;
 *  • camera inside the shell (zoomed to the surface / walking) → the glow
 *    gates itself off — the walk sky takes over from there;
 *  • decoration like the ring texture and star glow (toneMapped-false): raw
 *    sRGB color straight from the descriptor, no ACES — unlike WalkSky,
 *    which replaces the background and must match terrain shading.
 */

import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useStore } from '../state/store.js'
import { registry } from '../core/physics.js'
import { C, gnum } from '../core/constants.js'
import { BAND_FN } from '../core/glsl.js'

const NO_RAYCAST = () => null

/** sRGB 0..1 components straight from hex (3- or 6-digit; 8 loses its alpha). */
function srgb(hex, fallback) {
  let h = typeof hex === 'string' ? hex.replace('#', '') : ''
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  if (h.length < 6) h = fallback.replace('#', '')
  const n = parseInt(h.slice(0, 6), 16)
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

const VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vW;
void main() {
  vN = normalize(mat3(modelMatrix) * normal); // uniform scale → world normal
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`

// The limb glow and air-side terminator are bandize()-quantized from the shared
// gradientSteps dial (counts injected via gnum; 0 = smooth, the default).
const FRAG = /* glsl */ `
${BAND_FN}
varying vec3 vN;
varying vec3 vW;
uniform vec3 uColor;
uniform vec3 uSunDir;
uniform float uIntensity, uFresnel, uHasSun;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  float outside = smoothstep(0.0, 0.05, dot(N, V)); // inside the shell → off
  float fres = 1.0 - max(dot(N, V), 0.0);
  float glow = pow(bandize(fres, ${gnum(C.gradient.steps.limbGlow)}), uFresnel);
  float lit = mix(bandize(smoothstep(-0.2, 0.25, dot(N, uSunDir)), ${gnum(C.gradient.steps.airTerminator)}), 1.0, 1.0 - uHasSun);
  float cres = 0.75 + 0.65 * pow(max(dot(V, uSunDir), 0.0) * uHasSun, 5.0);
  float a = glow * lit * cres * uIntensity * outside;
  gl_FragColor = vec4(uColor, min(a, 1.0));
}
`

export default function AtmosphereGlow({ planet, atmo, radius }) {
  const star = useStore(
    (s) => s.world.planets.find((p) => p.kind === 'star') || s.world.planets.find((p) => p.preset === 'star')
  )

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        side: THREE.FrontSide,
        fog: false,
        uniforms: {
          uColor: { value: new THREE.Vector3(...srgb(atmo.horizon, '#9fc4e8')) },
          uSunDir: { value: new THREE.Vector3(0, 1, 0) },
          // thickness of the air drives the brightness (Pluto faint, Venus bold)
          uIntensity: { value: 0.3 + (atmo.opacity ?? 0.6) * 1.2 },
          uFresnel: { value: 2.4 },
          uHasSun: { value: 0 },
        },
      }),
    [atmo]
  )
  useEffect(() => () => material.dispose(), [material])

  const tmp = useMemo(() => new THREE.Vector3(), [])
  useFrame(() => {
    if (!star) {
      material.uniforms.uHasSun.value = 0
      return
    }
    const se = registry.bodies.get(star.id)
    const pe = registry.bodies.get(planet.id)
    tmp.set(
      (se ? se.pos.x : star.center.x) - (pe ? pe.pos.x : planet.center.x),
      (se ? se.pos.y : star.center.y) - (pe ? pe.pos.y : planet.center.y),
      (se ? se.pos.z : star.center.z) - (pe ? pe.pos.z : planet.center.z)
    )
    if (tmp.lengthSq() < 1e-12) return
    material.uniforms.uSunDir.value.copy(tmp.normalize())
    material.uniforms.uHasSun.value = 1
  })

  // how far the glow stands off the surface: the atmosphere's own `top`,
  // clamped into a band that reads on screen (Pluto's high haze caps out)
  const shellR = radius * (1 + Math.min(0.28, Math.max(0.025, atmo.top)))
  return (
    <mesh material={material} scale={shellR} raycast={NO_RAYCAST}>
      <sphereGeometry args={[1, C.decor.domeWidthSegs, C.decor.domeHeightSegs]} />
    </mesh>
  )
}
