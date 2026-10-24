/**
 * StarField.jsx — the real sky, replacing drei's random Stars.
 *
 * ~9,100 catalogued naked-eye stars (Yale Bright Star Catalog, projected by
 * core/starsky.js from J2000 RA/Dec into the engine's ecliptic frame) plus
 * procedural Milky Way dust sampled in galactic coordinates. Constellations
 * land where they actually are, and the galactic band holds its true ~60°
 * angle to the planets' orbital plane — no extra alignment knob: the sky and
 * the solar system share one frame.
 *
 * One additive Points draw over two layers: catalog stars colored by spectral
 * class and sized/brightened by magnitude, and a dense faint dust band. Raw
 * shader material, so (like WalkSky) it applies the ACES + sRGB curve itself
 * to match the tone-mapped scene. raycast is disabled — picking is the
 * heightfield march and a sky shell must never swallow clicks.
 *
 * The sky stays mounted under atmospheres (the WalkSky dome draws beneath it,
 * additive stars on top): a per-frame gain reproduces WalkSky's day/night
 * curve from the live star altitude and thins by the air's opacity, so the
 * Milky Way shows on the night side of a walk, washes out under the sun, and
 * never competes with opaque cloud decks (Venus) — while airless bodies keep
 * it undimmed.
 */

import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import {
  decodeBrightStars,
  radecToEngine,
  generateDust,
  starSizePx,
  starIntensity,
  SPECTRAL_COLORS,
} from '../core/starsky.js'
import { STAR_B64 } from '../core/starCatalog.js'
import { useStore } from '../state/store.js'
import { registry } from '../core/physics.js'

const DUST_COUNT = 28000

const VERT = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
attribute float aI;
uniform float uPR;
varying vec3 vColor;
varying float vI;
void main() {
  vColor = aColor;
  vI = aI;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uPR;
}
`

const FRAG = /* glsl */ `
varying vec3 vColor;
varying float vI;
uniform float uVis; // sky-wide fade: daylight under an atmosphere → 0

vec3 aces(vec3 x) { // Narkowicz ACES fit — mirrors the renderer's pipeline
  const vec3 a = vec3(2.51); const vec3 c = vec3(2.43); const vec3 e = vec3(0.14);
  const float b = 0.03; const float d = 0.59;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) * 1.055 - 0.055, step(vec3(0.0031308), c));
}

void main() {
  float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
  float a = exp(-d * d * 4.0) * (1.0 - smoothstep(0.6, 1.0, d)); // soft round dot
  gl_FragColor = vec4(toSRGB(aces(vColor * vI * a * uVis)), 1.0);
}
`

/** WalkSky's day→night curve (GLSL smoothstep mirror). */
const smoothstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export default function StarField({ radius }) {
  const dpr = useThree((s) => s.gl.getPixelRatio())

  const { geometry, material } = useMemo(() => {
    const bright = decodeBrightStars(STAR_B64)
    const dust = generateDust(DUST_COUNT, 7)
    const n = bright.count + dust.w.length
    const pos = new Float32Array(n * 3)
    const col = new Float32Array(n * 3)
    const size = new Float32Array(n)
    const inten = new Float32Array(n)
    const v = [0, 0, 0]

    for (let i = 0; i < bright.count; i++) {
      radecToEngine(bright.ra[i], bright.dec[i], v)
      const tint = SPECTRAL_COLORS[bright.spec[i]]
      pos[i * 3] = v[0] * radius
      pos[i * 3 + 1] = v[1] * radius
      pos[i * 3 + 2] = v[2] * radius
      col[i * 3] = tint[0]
      col[i * 3 + 1] = tint[1]
      col[i * 3 + 2] = tint[2]
      size[i] = starSizePx(bright.mag[i])
      inten[i] = starIntensity(bright.mag[i])
    }
    // unresolved disk stars: tiny, dim, a hair blue-white; the band's glow
    const base = bright.count
    for (let j = 0; j < dust.w.length; j++) {
      const i = base + j
      pos[i * 3] = dust.dir[j * 3] * radius
      pos[i * 3 + 1] = dust.dir[j * 3 + 1] * radius
      pos[i * 3 + 2] = dust.dir[j * 3 + 2] * radius
      col[i * 3] = 0.72
      col[i * 3 + 1] = 0.78
      col[i * 3 + 2] = 1.0
      size[i] = 1.0 + 1.5 * dust.w[j]
      inten[i] = 0.03 + 0.14 * dust.w[j]
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geometry.setAttribute('aColor', new THREE.BufferAttribute(col, 3))
    geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1))
    geometry.setAttribute('aI', new THREE.BufferAttribute(inten, 1))
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius)
    const material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uPR: { value: dpr }, uVis: { value: 1 } },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false, // a backdrop: never occludes, never fights log depth
      fog: false,
    })
    return { geometry, material }
  }, [radius, dpr])

  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material]
  )

  // sky visibility, eased so landing/lift-off doesn't pop: 1 in orbit and on
  // airless walks; under an atmosphere = (1 − daylight) · haze(air density),
  // reading the live registry poses exactly like WalkSky reads them.
  const vis = useRef(1)
  const tmp = useMemo(() => ({ up: new THREE.Vector3(), sun: new THREE.Vector3() }), [])
  useFrame(({ camera }, dt) => {
    const s = useStore.getState()
    let target = 1
    const wm = s.walkMode
    if (wm) {
      const p = s.world.planets.find((q) => q.id === wm.planetId)
      const atmo = p?.atmosphere
      if (atmo) {
        const pe = registry.bodies.get(p.id)
        tmp.up.set(
          camera.position.x - (pe ? pe.pos.x : p.center.x),
          camera.position.y - (pe ? pe.pos.y : p.center.y),
          camera.position.z - (pe ? pe.pos.z : p.center.z)
        )
        if (tmp.up.lengthSq() < 1e-9) tmp.up.set(0, 1, 0)
        tmp.up.normalize()
        let light = 0
        const star = s.world.planets.find((q) => q.kind === 'star' || q.preset === 'star')
        if (star) {
          const se = registry.bodies.get(star.id)
          tmp.sun.set(
            (se ? se.pos.x : star.center.x) - camera.position.x,
            (se ? se.pos.y : star.center.y) - camera.position.y,
            (se ? se.pos.z : star.center.z) - camera.position.z
          )
          if (tmp.sun.lengthSq() > 1e-9) {
            // the same sun-elevation curve the dome darkens with
            light = smoothstep(-0.12, 0.3, tmp.sun.normalize().dot(tmp.up))
          }
        }
        // pow() keeps thin air (Pluto 0.1, Mars 0.3) bright and opaque decks
        // (Venus/Titan 1.0) starless, with Earth 0.62 a reasonable ~2/3
        target = (1 - light) * Math.pow(1 - Math.min(1, atmo.opacity ?? 0), 0.45)
      }
    }
    vis.current += (target - vis.current) * (1 - Math.exp(-dt * 6))
    material.uniforms.uVis.value = vis.current
  })

  return <points geometry={geometry} material={material} frustumCulled={false} raycast={() => null} />
}
