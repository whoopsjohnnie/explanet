/**
 * worldSchema.js
 * ---------------------------------------------------------------------------
 * Shape of a `world.json` document plus helpers to create / normalise it.
 *
 * {
 *   "version": 1,
 *   "name": "My Universe",
 *   "gravity": 40,                       // gravitational constant G (scaled)
 *   "planets": [
 *     {
 *       "id": "p1",
 *       "name": "Terra",
 *       "preset": "earthlike",           // informational only
 *       "seed": 12345,
 *       "frequency": 6,                  // geodesic subdivision → cells
 *       "scale": 1,                      // size factor vs. the raw grid
 *       "center":   { "x": 40, "y": 0, "z": 0 },
 *       "velocity": { "x": 0,  "y": 0, "z": 8 },
 *       "spin":     { "x": 0,  "y": 0.4, "z": 0 },
 *       "density": 0.05,
 *       "isStatic": false,               // true → unaffected by gravity
 *       "elements": [ { "t": "grass", "h": 0.3, "c": "#57a05a" }, ... ]
 *     }
 *   ]
 * }
 *
 * Radius, volume and mass are derived from `elements` (see planetMath.js):
 * radius = √(cells / 4π) · scale. At scale 1 — THE ATOM MODEL — each cell
 * covers exactly one area unit on every planet: hexagons are atoms of a
 * universal size, a planet's mass is quantized in whole hexes, and its
 * frequency is derived from its target mass via frequencyForMass().
 * `scale` remains as an escape hatch (a small planet can carry a fine
 * mesh; older files keep loading); it defaults to 1, and `h` in elements
 * stays in absolute world units — scale it alongside the radius when
 * shrinking a generated grid.
 */

import { nanoid } from 'nanoid'
import { cellCountForFrequency } from './hexsphere.js'
import { generateElements, defaultElement } from './generators.js'
import { TERRAIN_TYPES } from './terrain.js'
import { DEFAULT_DENSITY, MAX_FREQUENCY } from './planetMath.js'

export const WORLD_VERSION = 1

export function createPlanet(opts = {}) {
  const frequency = clampInt(opts.frequency ?? 6, 1, MAX_FREQUENCY)
  const seed = opts.seed ?? Math.floor(Math.random() * 1e9)
  const preset = opts.preset ?? 'earthlike'
  return {
    id: opts.id || `p-${nanoid(8)}`,
    name: opts.name || 'New Planet',
    preset,
    seed,
    frequency,
    scale: positive(opts.scale, 1),
    center: vec3(opts.center),
    velocity: vec3(opts.velocity),
    spin: vec3(opts.spin ?? { x: 0, y: 0.3, z: 0 }),
    density: typeof opts.density === 'number' ? opts.density : preset === 'star' ? 0.14 : DEFAULT_DENSITY,
    isStatic: !!opts.isStatic || preset === 'star',
    elements: opts.elements || generateElements(preset, frequency, seed),
  }
}

export function createEmptyWorld(name = 'Untitled World') {
  return {
    version: WORLD_VERSION,
    name,
    gravity: 40,
    planets: [],
  }
}

function vec3(v) {
  return { x: num(v?.x), y: num(v?.y), z: num(v?.z) }
}
function num(v, d = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}
function positive(v, d) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : d
}
function clampInt(v, a, b) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return a
  return Math.max(a, Math.min(b, n))
}

/**
 * Validate / repair a loaded world document. Throws only if the structure is
 * completely unusable; everything else is healed with defaults.
 */
export function normalizeWorld(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Not a world file')
  const world = createEmptyWorld(raw.name || 'Loaded World')
  world.version = WORLD_VERSION
  world.gravity = num(raw.gravity, 40)

  const planets = Array.isArray(raw.planets) ? raw.planets : []
  for (const p of planets) {
    if (!p || typeof p !== 'object') continue
    const frequency = clampInt(p.frequency ?? 6, 1, MAX_FREQUENCY)
    const wanted = cellCountForFrequency(frequency)
    let elements = Array.isArray(p.elements) ? p.elements : []

    // repair elements: correct length + fields
    const fixed = new Array(wanted)
    for (let i = 0; i < wanted; i++) {
      const src = elements[i]
      const def = defaultElement()
      if (!src || typeof src !== 'object') {
        fixed[i] = def
        continue
      }
      fixed[i] = {
        t: TERRAIN_TYPES[src.t] ? src.t : def.t,
        h: num(src.h, def.h),
        ...(typeof src.c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(src.c) ? { c: src.c } : {}),
      }
    }

    world.planets.push({
      id: typeof p.id === 'string' && p.id ? p.id : `p-${nanoid(8)}`,
      name: typeof p.name === 'string' && p.name ? p.name : 'Planet',
      preset: p.preset || 'earthlike',
      seed: num(p.seed, 1),
      frequency,
      scale: positive(p.scale, 1),
      center: vec3(p.center),
      velocity: vec3(p.velocity),
      spin: vec3(p.spin),
      density: num(p.density, DEFAULT_DENSITY),
      isStatic: !!p.isStatic,
      elements: fixed,
    })
  }
  return world
}
