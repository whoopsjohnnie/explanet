/**
 * planetMath.js
 * ---------------------------------------------------------------------------
 * Everything derived about a planet comes from its hexagonal elements:
 *
 *   cellCount  = number of elements
 *   radius     = sqrt(cellCount / 4π) · scale   (one area unit per cell)
 *   volume     = (1/3) Σ area_i · (R + h_i)    (pyramids from the core)
 *   mass       = density · volume
 *
 * So adding hexagons literally grows the planet and its gravity. `scale`
 * (default 1) decouples grid resolution from physical size — a small world
 * can carry a fine mesh — see worldSchema.js.
 */

import { getHexSphere, radiusFromCellCount } from './hexsphere.js'

export const DEFAULT_DENSITY = 0.05

export function planetHex(planet) {
  return getHexSphere(planet.frequency)
}

/** Per-planet size factor; 1 = "natural" radius of its grid. */
export function planetScale(planet) {
  const s = Number(planet.scale)
  return Number.isFinite(s) && s > 0 ? s : 1
}

export function planetRadius(planet) {
  return radiusFromCellCount(planet.elements.length) * planetScale(planet)
}

export function planetVolume(planet, radius = planetRadius(planet)) {
  const hex = getHexSphere(planet.frequency)
  if (hex.cellCount === planet.elements.length) {
    // Cell areas are measured on the unit sphere; rescale so they sum to 4π
    // and multiply by R² for the world-space base area. Each cell is treated
    // as a pyramid from the planet core: V = 1/3 · base · (R + h).
    const norm = (4 * Math.PI) / hex.cells.reduce((s, c) => s + c.area, 0)
    let vol = 0
    for (let i = 0; i < hex.cells.length; i++) {
      const base = hex.cells[i].area * norm * radius * radius
      vol += (1 / 3) * base * (radius + planet.elements[i].h)
    }
    return vol
  }
  return (4 / 3) * Math.PI * radius ** 3
}

export function planetMass(planet) {
  const density = planet.density ?? DEFAULT_DENSITY
  return density * planetVolume(planet)
}

export function planetStats(planet) {
  const radius = planetRadius(planet)
  const volume = planetVolume(planet, radius)
  const mass = (planet.density ?? DEFAULT_DENSITY) * volume
  let landCells = 0
  let minH = Infinity
  let maxH = -Infinity
  for (const el of planet.elements) {
    if (el.t !== 'water' && el.t !== 'star') landCells++
    if (el.h < minH) minH = el.h
    if (el.h > maxH) maxH = el.h
  }
  return {
    cellCount: planet.elements.length,
    radius,
    volume,
    mass,
    landCells,
    seaCells: planet.elements.length - landCells,
    minH: Number.isFinite(minH) ? minH : 0,
    maxH: Number.isFinite(maxH) ? maxH : 0,
  }
}
