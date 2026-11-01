/**
 * worldSchema.js
 * ---------------------------------------------------------------------------
 * Shape of a `world.json` document plus helpers to create / normalise it.
 *
 * {
 *   "version": 1,
 *   "name": "My Universe",
 *   "gravity": 40,                       // gravitational constant G (scaled)
 *   "scale": 35181.6,                    // optional: TRUE-SCALE worlds only —
 *                                        //   the length of ONE WORLD UNIT, in
 *                                        //   METERS (1 doc second = 1 real
 *                                        //   second, e.g. Sol Real). Makes the
 *                                        //   surface walker a real human in
 *                                        //   meters (core/surface.js
 *                                        //   SURFACE_REAL) instead of one tile
 *                                        //   tall; radius in meters =
 *                                        //   radius (units) × scale. Absent or
 *                                        //   ≤ 0 = the classic tile-anchored
 *                                        //   walk. NOTE: distinct from a body's
 *                                        //   `scale` (size factor, default 1).
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
 *       "parent": "p-jupiter",           // optional hierarchy hint (moon→planet);
 *                                        // simulation ignores it, UI groups by it
 *       "rings": {                       // optional ring system (visual only),
 *         "inner": 1.24,                 //   radii as MULTIPLES of the body radius,
 *         "outer": 2.32,                 //   tiltDeg = axial tilt of the ring plane,
 *         "tiltDeg": 26.7,               //   bands: [{from,to,color,alpha}] 0..1 radial
 *         "bands": [ { "from": 0.0, "to": 0.62, "color": "#c9b98f", "alpha": 0.55 } ]
 *       },
 *       "atmosphere": {                  // optional air — drives the walk-mode sky
 *                                        //   (src/components/WalkSky.jsx) and the HUD.
 *         "top": 0.094,                  //   the atmosphere tops out at this multiple
 *                                        //   of the body radius (Earth ≈ 600 km / R);
 *         "scaleHeight": 0.0013,         //   density e-folds over this height (8.5 km/R);
 *         "pressure": 1.013,             //   surface pressure in atm — how THICK the
 *                                        //   air is (Venus 92, Mars 0.006);
 *         "opacity": 0.62,               //   0..1 visual density (1 = opaque, Venus)
 *         "zenith": "#2f63b4",           //   sky colors overhead / at the horizon /
 *         "horizon": "#b3cde8",          //   forward-scattered around the sun — all
 *         "glow": "#ffd9a0"              //   optional, the renderer picks defaults
 *       },
 *       "elements": [ { "t": "grass", "h": 0.3, "c": "#57a05a" }, ... ]
 *     }
 *   ],
 *   "crafts": [                        // optional — the astronaut's vehicles
 *     {                                // (movement model: docs/flight.txt;
 *       "id": "c-ab12cd34",             //   live poses live in the runtime,
 *       "name": "Shuttle",              //   core/motion.js craftRuntime)
 *       "kind": "shuttle",              //   mover + tuning, core/craftTypes.js
 *       "realism": "arcade",            //   "arcade" = plug-and-play
 *       "pose": {                       //   "real"   = Newtonian
 *         "anchor": {                   // PARKED on a surface (persisted):
 *           "bodyId": "p-earth",         //   dir in the body-LOCAL frame
 *           "dir": [0, 0.6, 0.8],        //   (rides spin/orbit for free),
 *           "r": 21.4                    //   r = radius + terrain at that dir
 *         }                             // (or, in flight: "space":
 *       }                               //   { pos, vel, yaw, pitch } — the
 *     }                                 //   live state, captured on save)
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
 *
 * Database-backed worlds stream in (see server/db.mjs): a skeleton document
 * carries `dbId` per body, and giants carry `elements: null` + a `preview`
 * sample until their atoms arrive. A stub still has exact-orbit size and
 * mass — cell count comes from the frequency, mean relief from the DB.
 */

import { nanoid } from 'nanoid'
import { cellCountForFrequency } from './hexsphere.js'
import { generateElements, defaultElement } from './generators.js'
import { TERRAIN_TYPES } from './terrain.js'
import { DEFAULT_DENSITY, MAX_FREQUENCY } from './planetMath.js'
import { CRAFT_KINDS } from './craftTypes.js'

export const WORLD_VERSION = 1

export { CRAFT_KINDS }

export function createPlanet(opts = {}) {
  const frequency = clampInt(opts.frequency ?? 6, 1, MAX_FREQUENCY)
  const seed = opts.seed ?? Math.floor(Math.random() * 1e9)
  const preset = opts.preset ?? 'earthlike'
  const atmosphere = normalizeAtmosphere(opts.atmosphere)
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
    ...(opts.parent ? { parent: String(opts.parent) } : {}),
    ...(opts.rings ? { rings: normalizeRings(opts.rings) } : {}),
    ...(atmosphere ? { atmosphere } : {}),
    elements: opts.elements || generateElements(preset, frequency, seed),
  }
}

/**
 * Validate/repair a ring-system descriptor (visual only, docs in the header).
 * Radii are multiples of the body radius; tiltDeg tilts the ring plane.
 * bands (optional): [{from,to,color,alpha}] with from/to fractions 0..1 of
 * the ring span (inner..outer), alpha 0..1. Returns null when unusable.
 */
/**
 * Validate a scripted-orbit descriptor: an osculating Kepler ellipse the
 * body rides analytically (core/kepler.js) instead of integrating N-body
 * gravity. Lengths are engine units, angles radians, n is rad per document
 * second. `parent` (the body it orbits) lives on the planet itself.
 */
/** Coarse body taxonomy (migration 004); NULL/absent for hand-built worlds. */
export const KINDS = ['star', 'planet', 'dwarf', 'moon', 'asteroid', 'comet']

export function normalizeScriptsOrbit(s) {
  if (!s || typeof s !== 'object') return null
  const out = {}
  for (const k of ['a', 'e', 'inc', 'node', 'peri', 'n', 'm0']) {
    const v = Number(s[k])
    if (!Number.isFinite(v)) return null
    out[k] = v
  }
  if (!(out.a > 0) || !(out.n > 0) || out.e < 0 || out.e >= 0.999) return null
  return out
}

export function normalizeRings(r) {
  if (!r || typeof r !== 'object') return null
  const inner = Number(r.inner)
  const outer = Number(r.outer)
  if (!(inner > 0) || !(outer > inner)) return null
  const bands = Array.isArray(r.bands)
    ? r.bands
        .map((b) => {
          if (!b || typeof b !== 'object') return null
          const from = clamp01(Number(b.from))
          const to = clamp01(Number(b.to))
          if (!(to > from)) return null
          return {
            from,
            to,
            color: typeof b.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(b.color) ? b.color : '#c8bda2',
            alpha: clamp01(Number(b.alpha ?? 1)),
          }
        })
        .filter(Boolean)
    : null
  const tiltDeg = Number.isFinite(Number(r.tiltDeg)) ? Number(r.tiltDeg) : 0
  return { inner, outer, tiltDeg, ...(bands && bands.length ? { bands } : {}) }
}

/**
 * Validate/repair an atmosphere descriptor (docs in the header). `top` and
 * `scaleHeight` are multiples of the body radius, `pressure` is surface
 * pressure in atm ("how thick the air is"), `opacity` 0..1 the visual density
 * of the sky. Colors are optional; the walk-mode renderer falls back to a
 * generic blue sky. Returns null when unusable (no atmosphere).
 */
export function normalizeAtmosphere(a) {
  if (!a || typeof a !== 'object') return null
  const top = Number(a.top)
  if (!(top > 0)) return null
  let scaleHeight = Number(a.scaleHeight)
  if (!(scaleHeight > 0) || scaleHeight >= top) scaleHeight = top / 6 // ≈5 e-folds to the top
  const pressure = Number(a.pressure)
  const opacity = clamp01(Number(a.opacity ?? 0.6))
  const color = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : null)
  const zenith = color(a.zenith)
  const horizon = color(a.horizon)
  const glow = color(a.glow)
  return {
    top,
    scaleHeight,
    pressure: Number.isFinite(pressure) && pressure >= 0 ? pressure : 1,
    opacity,
    ...(zenith ? { zenith } : {}),
    ...(horizon ? { horizon } : {}),
    ...(glow ? { glow } : {}),
  }
}

function clamp01(v) {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0
}

export function createEmptyWorld(name = 'Untitled World') {
  return {
    version: WORLD_VERSION,
    name,
    gravity: 40,
    planets: [],
  }
}

/**
 * One craft (a vehicle the astronaut can be in). `pose` is either
 * `anchor: {bodyId, dir, r}` (parked on a surface — dir body-LOCAL, r the
 * radius+terrain at that direction; r may be null on fresh documents and is
 * resolved to the surface on first sync) or `space: {pos, vel, yaw, pitch}`
 * (in flight — the live state, captured into the file on save). See
 * docs/flight.txt for the movement model and core/motion.js for the movers.
 */
export function createCraft(opts = {}) {
  return {
    id: opts.id || `c-${nanoid(8)}`,
    name: typeof opts.name === 'string' && opts.name ? opts.name : 'Shuttle',
    kind: CRAFT_KINDS.includes(opts.kind) ? opts.kind : 'shuttle',
    realism: opts.realism === 'real' ? 'real' : 'arcade',
    pose: opts.pose || null,
  }
}

/** Validate/repair a craft list against a body list (the lenient contract:
 *  heal, don't throw). Unknown bodies re-anchor on the first landable one;
 *  unusable entries are dropped. */
export function normalizeCrafts(raw, planets) {
  if (!Array.isArray(raw)) return null
  const ids = new Set(planets.map((p) => p.id))
  const firstLandable = planets.find((p) => p.preset !== 'star')
  const out = []
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue
    let pose = null
    const a = c.pose && c.pose.anchor
    if (a && ids.has(a.bodyId) && Array.isArray(a.dir) && a.dir.length === 3) {
      const r = Number(a.r)
      pose = {
        anchor: {
          bodyId: a.bodyId,
          dir: [num(a.dir[0], 0), num(a.dir[1], 1), num(a.dir[2], 0)],
          r: Number.isFinite(r) && r > 0 ? r : null,
        },
      }
    } else {
      const sp = c.pose && c.pose.space
      if (sp && Array.isArray(sp.pos) && sp.pos.length === 3) {
        const n = (v, i) => (Number.isFinite(Number(sp[v][i])) ? Number(sp[v][i]) : 0)
        pose = {
          space: {
            pos: [n('pos', 0), n('pos', 1), n('pos', 2)],
            vel: [n('vel', 0), n('vel', 1), n('vel', 2)],
            yaw: Number.isFinite(Number(sp.yaw)) ? Number(sp.yaw) : 0,
            pitch: Number.isFinite(Number(sp.pitch)) ? Number(sp.pitch) : 0,
          },
        }
      }
    }
    if (!pose && firstLandable) pose = { anchor: { bodyId: firstLandable.id, dir: [0, 1, 0], r: null } }
    if (!pose) continue
    out.push({
      id: typeof c.id === 'string' && c.id ? c.id : `c-${nanoid(8)}`,
      name: typeof c.name === 'string' && c.name ? c.name : 'Shuttle',
      kind: CRAFT_KINDS.includes(c.kind) ? c.kind : 'shuttle',
      realism: c.realism === 'real' ? 'real' : 'arcade',
      pose,
    })
  }
  return out.length ? out : null
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

/** Repair a raw elements array into exactly cellCountForFrequency(frequency)
 *  valid elements (pads with defaults, heals unknown terrain keys/heights). */
export function repairElements(raw, frequency) {
  const wanted = cellCountForFrequency(frequency)
  const elements = Array.isArray(raw) ? raw : []
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
  return fixed
}

/**
 * Validate / repair a loaded world document. Throws only if the structure is
 * completely unusable; everything else is healed with defaults.
 *
 * DB-backed skeletons (server/db.mjs) carry `dbId` on every body and, for
 * bodies whose atoms have not streamed in, `elements: null` plus a `preview`
 * sample grid. Those planets load as STUBS (see isPlanetStub): size and mass
 * stay exact from frequency/density/stubAvgHeight, the renderer uses the
 * preview, and the store streams the atoms when the body is needed. Plain
 * world.json files (no dbId) keep the old pad-and-heal contract.
 */
export function normalizeWorld(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Not a world file')
  const world = createEmptyWorld(raw.name || 'Loaded World')
  world.version = WORLD_VERSION
  world.gravity = num(raw.gravity, 40)
  const wScale = positive(raw.scale, null) // physical scale: length of one world unit, in meters
  if (wScale) world.scale = wScale

  const planets = Array.isArray(raw.planets) ? raw.planets : []
  for (const p of planets) {
    if (!p || typeof p !== 'object') continue
    const frequency = clampInt(p.frequency ?? 6, 1, MAX_FREQUENCY)
    const stub = p.dbId != null && p.elements == null
    const planet = {
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
      elements: stub ? null : repairElements(p.elements, frequency),
    }
    if (p.dbId != null) planet.dbId = Math.trunc(Number(p.dbId))
    if (KINDS.includes(p.kind)) planet.kind = p.kind
    if (typeof p.parent === 'string' && p.parent && p.parent !== planet.id) planet.parent = p.parent.slice(0, 64)
    const rings = normalizeRings(p.rings)
    if (rings) planet.rings = rings
    const atmosphere = normalizeAtmosphere(p.atmosphere)
    if (atmosphere) planet.atmosphere = atmosphere
    const so = normalizeScriptsOrbit(p.scriptsOrbit)
    if (so) planet.scriptsOrbit = so
    if (stub) {
      if (Number.isFinite(Number(p.stubAvgHeight))) planet.stubAvgHeight = Number(p.stubAvgHeight)
      const pf = clampInt(p.preview?.frequency ?? 0, 1, MAX_FREQUENCY)
      if (pf < frequency && Array.isArray(p.preview.elements) && p.preview.elements.length)
        planet.preview = { frequency: pf, elements: repairElements(p.preview.elements, pf) }
    }
    world.planets.push(planet)
  }
  const crafts = normalizeCrafts(raw.crafts, world.planets)
  if (crafts) world.crafts = crafts
  return world
}

/** A body whose atoms live in the database but have not streamed in yet. */
export function isPlanetStub(planet) {
  return !!planet && planet.elements == null
}

/**
 * The document as it is saved to world.json: schema fields only. Database
 * internals (dbId, preview samples, stub stats) never leak into files.
 * `scale` (the true-scale annotation, meters per world unit) round-trips,
 * and so do `crafts` (already schema-clean; the save path captures live
 * flight poses into the document first — store.captureCrafts).
 */
export function serializeWorld(world) {
  return {
    version: world.version ?? WORLD_VERSION,
    name: world.name,
    gravity: world.gravity,
    ...(world.scale ? { scale: world.scale } : {}),
    ...(Array.isArray(world.crafts) && world.crafts.length ? { crafts: world.crafts } : {}),
    planets: world.planets.map(({ dbId, preview, stubAvgHeight, atomsPacked, ...doc }) => doc),
  }
}
