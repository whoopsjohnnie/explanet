/**
 * atoms.js
 * ---------------------------------------------------------------------------
 * Packed atom arrays: the same per-cell data the document keeps as
 * `elements[i] = { t, h, c }`, held in transferable typed arrays:
 *
 *   { materials: string[], t: Uint16Array, h: Float64Array,
 *     rgb: Uint32Array, hasC: Uint8Array }
 *
 * This is the wire/cache form used to feed the geometry worker — structured
 * clone of typed arrays is a memcpy, while 400k small objects would cost
 * ~100 ms of serialization on the main thread per build. A hydrated planet
 * keeps its packed arrays as `planet.atomsPacked` (an internal mirror, never
 * part of the document: serializeWorld strips it); applyBrush patches the
 * mirror cells so rebuilds never re-read the element objects.
 *
 * Framework-free (no three, no DOM) — the worker imports this directly.
 */

import { TERRAIN_TYPES } from './terrain.js'

/**
 * Parse a CSS hex color to 0xRRGGBB, mirroring geometry.js's hexToRgb:
 * 3-digit shorthand expands, alpha (6/8-digit) is ignored, garbage → null.
 */
export function hexToInt(hex) {
  if (typeof hex !== 'string') return null
  let s = hex.replace('#', '')
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2]
  const n = parseInt(s, 16)
  if (Number.isNaN(n)) return null
  return ((n >> 16) & 255) << 16 | ((n >> 8) & 255) << 8 | (n & 255)
}

function materialIndex(materials, dict, key) {
  const k = TERRAIN_TYPES[key] ? key : 'grass'
  let i = dict.get(k)
  if (i === undefined) {
    i = materials.length
    dict.set(k, i)
    materials.push(k)
  }
  return i
}

/**
 * Pack a document elements array (any planet loaded from a file). Cached by
 * array identity — elements are copy-on-write, so painting naturally
 * invalidates, and a remount reusing the same array costs nothing.
 */
const packCache = new WeakMap()
export function packElements(elements) {
  let packed = packCache.get(elements)
  if (!packed) {
    packed = packElementsUncached(elements)
    packCache.set(elements, packed)
  }
  return packed
}

function packElementsUncached(elements) {
  const materials = []
  const dict = new Map()
  const n = elements.length
  const t = new Uint16Array(n)
  const h = new Float64Array(n)
  const rgb = new Uint32Array(n)
  const hasC = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const el = elements[i] || {}
    t[i] = materialIndex(materials, dict, el.t)
    h[i] = Number.isFinite(el.h) ? el.h : 0
    const c = el.c === undefined ? null : hexToInt(el.c)
    if (c !== null) {
      rgb[i] = c
      hasC[i] = 1
    }
  }
  return { materials, t, h, rgb, hasC }
}

/**
 * Pack straight from the compact /api wire payload (material dict + t/h
 * columns + sparse [cell, color] pairs), validating terrain keys exactly
 * as fetchPlanetElements does.
 */
export function packFromWire({ materials: wireMaterials, t: wireT, h: wireH, c: wireC }) {
  const materials = []
  const dict = new Map()
  const n = wireH.length
  const t = new Uint16Array(n)
  const h = new Float64Array(n)
  const rgb = new Uint32Array(n)
  const hasC = new Uint8Array(n)
  // wire t[i] indexes wireMaterials; resolve + validate once per material
  const resolved = wireMaterials.map((k) => materialIndex(materials, dict, k))
  for (let i = 0; i < n; i++) {
    const mi = wireT[i] | 0
    t[i] = mi >= 0 && mi < resolved.length ? resolved[mi] : 0
    h[i] = Number.isFinite(wireH[i]) ? wireH[i] : 0
  }
  if (Array.isArray(wireC))
    for (const [ci, col] of wireC) {
      if (!(ci >= 0 && ci < n)) continue
      const c = hexToInt(col)
      if (c !== null) {
        rgb[ci] = c
        hasC[ci] = 1
      }
    }
  return { materials, t, h, rgb, hasC }
}

/** Rebuild document-shaped elements from packed arrays (worker side). */
export function elementsFromPacked(packed) {
  const { materials, t, h, rgb, hasC } = packed
  const out = new Array(t.length)
  for (let i = 0; i < out.length; i++) {
    const el = { t: materials[t[i]], h: h[i] }
    if (hasC[i]) el.c = '#' + rgb[i].toString(16).padStart(6, '0')
    out[i] = el
  }
  return out
}

/**
 * Mirror one edited element into its packed mirror (paint path): keeps
 * atomsPacked consistent with planet.elements without re-reading the grid.
 */
export function patchPackedCell(packed, index, el) {
  const dict = packedDict(packed)
  packed.t[index] = materialIndex(packed.materials, dict, el.t)
  packed.h[index] = Number.isFinite(el.h) ? el.h : 0
  const c = el.c === undefined ? null : hexToInt(el.c)
  if (c === null) packed.hasC[index] = 0
  else {
    packed.rgb[index] = c
    packed.hasC[index] = 1
  }
}

// material dict kept off the packed shape (it is a write-side detail);
// rebuilt lazily per packed object through this side table
const dicts = new WeakMap()
function packedDict(packed) {
  let d = dicts.get(packed)
  if (!d) {
    d = new Map()
    packed.materials.forEach((k, i) => d.set(k, i))
    dicts.set(packed, d)
  }
  return d
}

/**
 * Deep-ish copy for transfer: typed arrays are sliced (the originals stay
 * usable for future builds), so the buffers can be moved into the worker.
 * Returns { packed, transfer } — pass transfer to postMessage.
 */
export function packedForTransfer(packed) {
  const t = packed.t.slice()
  const h = packed.h.slice()
  const rgb = packed.rgb.slice()
  const hasC = packed.hasC.slice()
  return {
    packed: { materials: packed.materials.slice(), t, h, rgb, hasC },
    transfer: [t.buffer, h.buffer, rgb.buffer, hasC.buffer],
  }
}
