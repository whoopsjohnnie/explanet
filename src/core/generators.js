/**
 * generators.js
 * ---------------------------------------------------------------------------
 * Procedural element generators for new planets. Uses seeded value-noise +
 * fBm so a planet can be regenerated deterministically from its seed.
 * Output is a plain `elements` array: [{ t: terrain, h: height, c?: color }].
 */

import { getHexSphere, cellCountForFrequency } from './hexsphere.js'

// ---------------------------------------------------------------------------
// Seeded 3D value noise + fBm
// ---------------------------------------------------------------------------
function hash3(x, y, z, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 144665) ^ Math.imul(seed | 0, 2246822519)
  h = (h ^ (h >>> 13)) >>> 0
  h = Math.imul(h, 1274126177) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

const smooth = (t) => t * t * (3 - 2 * t)

function valueNoise(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z)
  const u = smooth(x - xi), v = smooth(y - yi), w = smooth(z - zi)
  const c000 = hash3(xi, yi, zi, seed)
  const c100 = hash3(xi + 1, yi, zi, seed)
  const c010 = hash3(xi, yi + 1, zi, seed)
  const c110 = hash3(xi + 1, yi + 1, zi, seed)
  const c001 = hash3(xi, yi, zi + 1, seed)
  const c101 = hash3(xi + 1, yi, zi + 1, seed)
  const c011 = hash3(xi, yi + 1, zi + 1, seed)
  const c111 = hash3(xi + 1, yi + 1, zi + 1, seed)
  const x00 = c000 + (c100 - c000) * u
  const x10 = c010 + (c110 - c010) * u
  const x01 = c001 + (c101 - c001) * u
  const x11 = c011 + (c111 - c011) * u
  const y0 = x00 + (x10 - x00) * v
  const y1 = x01 + (x11 - x01) * v
  return y0 + (y1 - y0) * w
}

function fbm(x, y, z, seed, octaves = 5) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * freq, y * freq, z * freq, seed + o * 101)
    norm += amp
    amp *= 0.5
    freq *= 2.05
  }
  return sum / norm
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------
export const PRESETS = [
  { id: 'earthlike', label: 'Earth-like' },
  { id: 'rocky', label: 'Rocky' },
  { id: 'desert', label: 'Desert' },
  { id: 'ice', label: 'Ice' },
  { id: 'lava', label: 'Volcanic' },
  { id: 'gas', label: 'Gas Giant' },
  { id: 'moon', label: 'Moon' },
  { id: 'star', label: 'Star (static, massive)' },
]

const lerp = (a, b, t) => a + (b - a) * t

function mixHex(c1, c2, t) {
  const p = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]
  const a = p(c1), b = p(c2)
  const h = (x) => Math.round(x).toString(16).padStart(2, '0')
  return `#${h(lerp(a[0], b[0], t))}${h(lerp(a[1], b[1], t))}${h(lerp(a[2], b[2], t))}`
}

/**
 * Generate an elements array for a planet.
 * @param {string} preset
 * @param {number} frequency geodesic frequency
 * @param {number} seed
 */
export function generateElements(preset, frequency, seed = Math.floor(Math.random() * 1e9)) {
  const hex = getHexSphere(frequency)
  const { cellCount, centers } = hex
  const elements = new Array(cellCount)

  for (let i = 0; i < cellCount; i++) {
    const b = i * 3
    const x = centers[b]
    const y = centers[b + 1]
    const z = centers[b + 2]
    let el

    switch (preset) {
      case 'star': {
        const n = fbm(x * 3, y * 3, z * 3, seed, 4)
        el = { t: 'star', h: 0.05 + n * 0.25, c: mixHex('#ffd977', '#ff8a2e', n) }
        break
      }
      case 'gas': {
        const lat = Math.asin(clamp(y, -1, 1))
        const bands = Math.sin(lat * 14 + fbm(x * 2, y * 6, z * 2, seed, 3) * 2.5)
        const n = fbm(x * 5, y * 5, z * 5, seed + 7, 4)
        const t01 = (bands + 1) / 2
        el = {
          t: 'sand',
          h: 0.02 + n * 0.08,
          c: mixHex(mixHex('#d9a066', '#f7e6c9', t01), '#b56d45', n * 0.5),
        }
        break
      }
      case 'lava': {
        const n = fbm(x * 2.4, y * 2.4, z * 2.4, seed, 5)
        const rivers = Math.abs(fbm(x * 3.2, y * 3.2, z * 3.2, seed + 31, 4) - 0.5)
        const h = 0.1 + n * 1.1
        if (rivers < 0.09) el = { t: 'lava', h: h - 0.05 }
        else el = { t: 'rock', h, c: mixHex('#3d3a40', '#57514f', n) }
        break
      }
      case 'ice': {
        const n = fbm(x * 2.6, y * 2.6, z * 2.6, seed, 5)
        const leads = fbm(x * 4, y * 4, z * 4, seed + 13, 3)
        if (leads < 0.32) el = { t: 'water', h: 0, c: '#7fb6d9' }
        else el = { t: 'snow', h: 0.06 + n * 0.55, c: mixHex('#eef3f7', '#c8dcf0', n) }
        break
      }
      case 'desert': {
        const dunes = Math.abs(Math.sin(x * 5 + fbm(x * 2, y * 2, z * 2, seed, 3) * 4)) * 0.3
        const n = fbm(x * 2.2, y * 2.2, z * 2.2, seed, 5)
        if (n < 0.34) el = { t: 'rock', h: 0.15 + n * 0.9, c: '#9a7d5c' }
        else el = { t: 'sand', h: 0.1 + n * 0.4 + dunes }
        break
      }
      case 'moon': {
        let n = fbm(x * 2.8, y * 2.8, z * 2.8, seed, 5)
        const craters = Math.pow(Math.abs(fbm(x * 6, y * 6, z * 6, seed + 3, 3) - 0.5) * 2, 3)
        n = n * 0.7 + craters * 0.4
        el = { t: 'rock', h: 0.05 + n * 0.7, c: mixHex('#9d9da4', '#74747c', n) }
        break
      }
      case 'rocky': {
        const n = fbm(x * 2.2, y * 2.2, z * 2.2, seed, 5)
        const h = 0.05 + Math.pow(n, 1.3) * 1.2
        el = h > 0.75 ? { t: 'rock', h, c: mixHex('#77777f', '#9a8f84', n) } : { t: 'dirt', h }
        break
      }
      case 'earthlike':
      default: {
        const e = (fbm(x * 2.1, y * 2.1, z * 2.1, seed, 6) - 0.47) * 2.4
        const detail = fbm(x * 6, y * 6, z * 6, seed + 17, 3)
        const polar = Math.abs(y)
        if (e < 0.02) {
          // ocean (frozen near the poles)
          if (polar > 0.86) el = { t: 'snow', h: 0.04, c: '#dbe9f4' }
          else el = { t: 'water', h: 0, c: mixHex('#1f6fc0', '#3f93dd', clamp(detail, 0, 1)) }
        } else {
          const h = Math.pow(e, 1.35) * 1.9
          if (polar > 0.78 - detail * 0.08) el = { t: 'snow', h, c: '#eef3f7' }
          else if (h < 0.14) el = { t: 'sand', h }
          else if (h < 0.72) el = { t: 'grass', h, c: mixHex('#57a05a', '#69b36b', detail) }
          else if (h < 1.25) el = { t: 'rock', h, c: mixHex('#84838a', '#93887c', detail) }
          else el = { t: 'snow', h }
        }
        break
      }
    }
    elements[i] = el
  }
  return elements
}

export function defaultElement() {
  return { t: 'grass', h: 0.12 }
}

export { cellCountForFrequency }
