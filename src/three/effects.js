/**
 * Procedural texture effects for the Sol Real presentation layer.
 *
 * No postprocessing, no image assets — glows and ring bands are DataTextures
 * generated once and cached, so the whole effect set costs zero network and
 * one small GPU upload each.
 *
 *   makeGlowTexture()  radial falloff sprite for the star's corona/glow
 *   makeRingTexture()  1D radial band strip for planetary rings
 */
import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Glow sprite — white core → warm → faint blue haze, quadratic falloff.
// Additive blending bakes intensity into RGB (alpha ignored), so f() lands
// in the color channels.
// ---------------------------------------------------------------------------

const glowCache = new Map()

export function makeGlowTexture({ size = 256, power = 2.2, inner = [1, 0.93, 0.78], outer = [0.45, 0.62, 1] } = {}) {
  const key = `g${size}|${power}|${inner.join()}|${outer.join()}`
  let tex = glowCache.get(key)
  if (tex) return tex
  const data = new Uint8Array(size * size * 4)
  const c = (size - 1) / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / c
      const dy = (y - c) / c
      const t = Math.min(1, Math.hypot(dx, dy))
      // smooth core, long tail: f = (1-t)^power with a small constant floor
      const f = Math.pow(1 - t, power)
      const mixT = Math.min(1, t * 1.4)
      const i = (y * size + x) * 4
      data[i] = Math.round(255 * f * (inner[0] * (1 - mixT) + outer[0] * mixT))
      data[i + 1] = Math.round(255 * f * (inner[1] * (1 - mixT) + outer[1] * mixT))
      data[i + 2] = Math.round(255 * f * (inner[2] * (1 - mixT) + outer[2] * mixT))
      data[i + 3] = 255
    }
  }
  tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  tex.needsUpdate = true
  tex.colorSpace = THREE.SRGBColorSpace
  glowCache.set(key, tex)
  return tex
}

// ---------------------------------------------------------------------------
// Ring band texture — a W×H strip where u runs inner→outer radius.
// bands: [{ from, to, color, alpha }] with from/to normalized 0..1 across the
// ring gap. Fine-grained noise per texel breaks up flat color (ringlets).
// ---------------------------------------------------------------------------

const ringCache = new Map()

function hexToRgb(hex) {
  const s = hex.replace('#', '')
  const n = parseInt(s.length === 3 ? s.split('').map((ch) => ch + ch).join('') : s, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function makeRingTexture(bands, fallbackColor = '#c9b28a') {
  const key = JSON.stringify(bands || null) + '|' + fallbackColor
  let tex = ringCache.get(key)
  if (tex) return tex
  const W = 4 // identical columns; width>1 avoids point-sampling artifacts
  const H = 1024
  const data = new Uint8Array(W * H * 4)
  const list = Array.isArray(bands) && bands.length
    ? bands
    : [{ from: 0, to: 1, color: fallbackColor, alpha: 0.8 }]
  // deterministic hash-noise so band edges shimmer but never flicker
  const noise = (i) => {
    let x = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b)
    x ^= x >>> 13
    x = Math.imul(x, 0xc2b2ae35)
    x ^= x >>> 16
    return (x & 1023) / 1023 - 0.5
  }
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H
    let band = null
    for (const b of list) if (v >= b.from && v < b.to) { band = b; break }
    if (!band) band = list[list.length - 1]
    const [r, g, b] = hexToRgb(band.color || fallbackColor)
    // ringlet noise: strong high-frequency + gentle long-wave modulation
    const n = noise(y) * 26 + Math.sin(v * 130) * 10 + Math.sin(v * 27 + 2) * 14
    // soft edges at band boundaries (fade within 2 texels)
    const edge = Math.min(1, (v - band.from) * H * 0.5, (band.to - v) * H * 0.5)
    const a = Math.max(0, Math.min(1, (band.alpha ?? 0.8) + n / 255)) * Math.max(0, edge)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      data[i] = Math.max(0, Math.min(255, r + n))
      data[i + 1] = Math.max(0, Math.min(255, g + n))
      data[i + 2] = Math.max(0, Math.min(255, b + n))
      data[i + 3] = Math.round(a * 255)
    }
  }
  tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat)
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  tex.colorSpace = THREE.SRGBColorSpace
  ringCache.set(key, tex)
  return tex
}

/**
 * Flat annulus in the planet's EQUATOR plane (XZ, normal +Y).
 * uv.x runs 0 (inner) → 1 (outer) to sample the ring band texture; uv.y wraps.
 */
export function makeRingGeometry(inner, outer, segments = 160) {
  const pos = new Float32Array((segments + 1) * 2 * 3)
  const uv = new Float32Array((segments + 1) * 2 * 2)
  const idx = []
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2
    const cos = Math.cos(a)
    const sin = Math.sin(a)
    const vi = i * 2
    pos[vi * 3] = cos * inner
    pos[vi * 3 + 1] = 0
    pos[vi * 3 + 2] = sin * inner
    pos[(vi + 1) * 3] = cos * outer
    pos[(vi + 1) * 3 + 1] = 0
    pos[(vi + 1) * 3 + 2] = sin * outer
    uv[vi * 2] = 0
    uv[vi * 2 + 1] = i / segments
    uv[(vi + 1) * 2] = 1
    uv[(vi + 1) * 2 + 1] = i / segments
    if (i < segments) {
      const a0 = vi * 2
      idx.push(a0, a0 + 1, a0 + 2, a0 + 1, a0 + 3, a0 + 2)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  return geo
}
