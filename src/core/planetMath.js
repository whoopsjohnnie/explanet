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
 *
 * THE ATOM MODEL (scale = 1): every cell then covers exactly ONE area unit
 * on every planet, so a hexagon is a universal "atom" of surface and the
 * atom ladder radiusForFrequency(1..MAX_FREQUENCY) is a quantized list of
 * the only radii a planet may have. Mass rides on top of it: asking for a
 * target mass (with a density) snaps to the nearest legal grid — see
 * frequencyForMass(). Small planets are genuinely chunky: the smallest
 * possible world is a 12-cell dodecahedron.
 */

import { getHexSphere, radiusFromCellCount, cellCountForFrequency } from './hexsphere.js'
import { C } from './constants.js'

export const DEFAULT_DENSITY = 0.05

/**
 * Largest geodesic frequency a document may carry. 203 ≈ 64·√10: the top of
 * the ladder holds ~10× the cells of the old freq-64 cap (412,092) now that
 * grids are stored as flat typed arrays (see hexsphere.js).
 */
export const MAX_FREQUENCY = C.atom.maxFrequency

/** Natural ("atom", scale 1) radius of the frequency-n grid. */
export function radiusForFrequency(f) {
  return radiusFromCellCount(cellCountForFrequency(f))
}

/**
 * Frequency of the atom grid whose natural radius is nearest to R — the
 * inverse of radiusForFrequency, exact on the ladder (round-trips for every
 * 1 ≤ f ≤ MAX_FREQUENCY) and clamped to the legal frequency range. The
 * ladder R(n) = √((10n²+2)/4π) is not exactly linear in n, so "nearest" is
 * decided by comparing candidate RADII, not by rounding n itself.
 */
export function frequencyForRadius(radius) {
  const r = Number(radius)
  if (!Number.isFinite(r) || r <= 0) return 1
  const n0 = Math.round(Math.sqrt(Math.max(0, (4 * Math.PI * r * r - 2) / 10)))
  let best = Math.min(MAX_FREQUENCY, Math.max(1, n0))
  let bestD = Math.abs(radiusFromCellCount(cellCountForFrequency(best)) - r)
  for (const n of [best - 1, best + 1]) {
    if (n < 1 || n > MAX_FREQUENCY) continue
    const d = Math.abs(radiusFromCellCount(cellCountForFrequency(n)) - r)
    if (d < bestD) {
      best = n
      bestD = d
    }
  }
  return best
}

/** Radius of a (sphere-approximated) planet of mass m at density ρ. */
export function radiusForMass(mass, density) {
  const m = Number(mass)
  const d = Number(density)
  if (!Number.isFinite(m) || m <= 0 || !Number.isFinite(d) || d <= 0) return 0
  return Math.cbrt((3 * m) / (4 * Math.PI * d))
}

/**
 * Atom-grid frequency for a target mass at density ρ (sphere approximation,
 * terrain relief ignored — this is a targeting helper, the document's real
 * mass still derives exactly from its elements).
 */
export function frequencyForMass(mass, density) {
  const r = radiusForMass(mass, density)
  return r > 0 ? frequencyForRadius(r) : 1
}

export function planetHex(planet) {
  return getHexSphere(planet.frequency)
}

/** Per-planet size factor; 1 = "natural" radius of its grid. */
export function planetScale(planet) {
  const s = Number(planet.scale)
  return Number.isFinite(s) && s > 0 ? s : 1
}

/**
 * Hex count a planet covers. A DB-stubbed planet (atoms not streamed yet,
 * `elements: null`) answers from its grid: cell count is exact from the
 * frequency alone, which is what keeps radius — and every orbit — correct
 * while the atoms are still on their way.
 */
export function planetCellCount(planet) {
  return planet.elements ? planet.elements.length : cellCountForFrequency(planet.frequency)
}

export function planetRadius(planet) {
  return radiusFromCellCount(planetCellCount(planet)) * planetScale(planet)
}

export function planetVolume(planet, radius = planetRadius(planet)) {
  if (!planet.elements) {
    // Stub: exact equal-area integral with the database's stored mean relief
    // — V = (1/3)·4πR²·(R + avg h). Error vs. the true integral is only the
    // grid's cell-area variance (< 0.1% on these grids).
    const avgH = Number(planet.stubAvgHeight) || 0
    return (4 / 3) * Math.PI * radius * radius * (radius + avgH)
  }
  const hex = getHexSphere(planet.frequency)
  if (hex.cellCount === planet.elements.length) {
    // Cell areas are measured on the unit sphere; rescale so they sum to 4π
    // and multiply by R² for the world-space base area. Each cell is treated
    // as a pyramid from the planet core: V = 1/3 · base · (R + h).
    const norm = (4 * Math.PI) / (hex.averageArea * hex.cellCount)
    let vol = 0
    for (let i = 0; i < planet.elements.length; i++) {
      const base = hex.areas[i] * norm * radius * radius
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
  if (!planet.elements) {
    // stub: size stats are exact from the grid; terrain tallies arrive with
    // the atoms (null = unknown, not zero)
    return {
      cellCount: planetCellCount(planet),
      radius,
      volume,
      mass,
      landCells: null,
      seaCells: null,
      minH: 0,
      maxH: 0,
    }
  }
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
