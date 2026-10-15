/**
 * lod.js
 * ---------------------------------------------------------------------------
 * Level-of-detail grids for rendering. A planet's DOCUMENT always keeps its
 * full-frequency grid (element identity is positional); a LOD level is just
 * a coarser synthetic grid sampled from it — every coarse cell adopts the
 * terrain/type/height of the fine cell under its center. Feeding such a
 * grid into buildPlanetGeometryData yields a valid mesh whose triangles can
 * be remapped back to fine cell indices, so painting still hits the right
 * cells no matter how far away the camera is.
 *
 * Framework-free (no three, no DOM) — like everything in core/.
 */

import { getHexSphere } from './hexsphere.js'
import { cellAtDirection } from './surface.js'

/**
 * Render-resolution chain for a planet frequency, halving toward 4:
 * 64 → [64, 32, 16, 8, 4]. Frequencies ≤ 4 get no chain.
 */
export function lodChain(frequency) {
  const chain = [frequency]
  for (;;) {
    const prev = chain[chain.length - 1]
    const next = Math.max(4, Math.floor(prev / 2))
    if (next >= prev) break
    chain.push(next)
  }
  return chain
}

/**
 * Switch distances (from the planet CENTER) for the chain, in world units:
 * level k is used while distance < thresholds[k], so the FIRST entry belongs
 * to chain[1] (the distance at which we drop off full resolution).
 * Thresholds keep hex angular size constant — a hex spans ~2R/n units, so
 * switching at d = K·R/n means the hex is ~1/K·... of the screen regardless
 * of planet size or level; LOD_SWITCH is tuned so a hex is ~4-5 px when its
 * level retires.
 */
export function lodDistances(chain, radius, LOD_SWITCH = 570) {
  const out = []
  for (let k = 1; k < chain.length; k++) out.push((LOD_SWITCH * radius) / chain[k])
  return out
}

/**
 * Coarse render grid sampled from a planet's fine elements.
 * @returns {{ elements: Array, fineIndex: Uint32Array }} fineIndex[i] =
 *   index in planet.elements of the fine cell that produced coarse cell i
 *   (used to remap geometry picking indices back to document cells).
 */
export function sampleLodElements(planet, frequency) {
  const fine = getHexSphere(planet.frequency)
  const coarse = getHexSphere(frequency)
  const elements = new Array(coarse.cellCount)
  const fineIndex = new Uint32Array(coarse.cellCount)
  let hint = -1
  for (let i = 0; i < coarse.cellCount; i++) {
    const f = cellAtDirection(fine, coarse.cells[i].center, hint)
    hint = f
    fineIndex[i] = f
    const src = planet.elements[f]
    elements[i] = { t: src.t, h: src.h, ...(typeof src.c === 'string' ? { c: src.c } : {}) }
  }
  return { elements, fineIndex }
}
