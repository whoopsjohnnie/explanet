/**
 * starter.js
 * ---------------------------------------------------------------------------
 * Sol — a miniature of the real solar system: the Sun plus Mercury…Pluto.
 *
 * Calibration (everything lives here; the engine is untouched):
 *
 *   • Distances are exactly proportional, and the scene scale is DYNAMIC:
 *     unitsPerAU() keeps compact systems at the classic 35 u/AU and lets a
 *     wide system earn more (scaled by ATOM_ZOOM with the atom anchor —
 *     here ≈ 281.7, so Pluto's orbit lands at ≈ 11,100 units). Scene.jsx
 *     sizes the camera, fog and starfield to the system's own extent, so
 *     any set of worlds frames correctly.
 *   • One central mass drives the orbits, so Kepler's third law makes every
 *     period ratio REAL (Mercury 0.24 yr … Pluto 247.9 yr). The Sun's mass
 *     is solved from the engine's softened force law (v²/r = G·M/(r²+ε²),
 *     ε² = 4) so that Earth completes 1 AU in EARTH_YEAR seconds. Bigger
 *     scene scales shrink ε² relative to the orbits, so wide systems are
 *     even more exactly Keplerian.
 *   • Planet masses are the real solar mass ratios (densities back them out
 *     from each grid volume), so planet–planet perturbations are true to
 *     scale: the Sun dominates and the system is stable.
 *   • Sizes follow the ATOM MODEL: every planet is a scale-1 grid, so one
 *     hexagon covers exactly one area unit on EVERY world — hexes are atoms
 *     of a universal size and Jupiter fills the largest legal grid
 *     (frequency MAX_FREQUENCY = 203, 412,092 cells). A planet's frequency
 *     is DERIVED from its true radius (frequencyForRadius), so relative
 *     radii are exact up to the atom ladder's quantization (≤ ±10% at the
 *     small end: Earth ≈ 3,242 hexes, Mars 1,002, Pluto still a chunky 92 —
 *     small worlds are genuinely chunky). Mass quantizes with them: heavier
 *     worlds are made of more hexes, period. Relief (element `h`) scales
 *     with the radius, so terrain proportions are identical on every world.
 *     The Sun — 109 Earth radii true — keeps a reduced visual size; its
 *     mass is real.
 *   • Orbits are circular at each world's mean distance, inclined by the
 *     real orbital inclinations; starting positions are the J2000 mean
 *     longitudes. Eccentricity is the only real effect left out.
 *   • Spins keep the real relative day lengths (Venus/Uranus/Pluto spin
 *     retrograde via their obliquity), compressed so Earth's day ≈ 10 s.
 *   • No moons: at true scale the Moon would orbit INSIDE the Earth here
 *     (0.0026 AU ≈ 0.23 units).
 *   • Air: bodies with real atmospheres carry an `atmosphere` descriptor
 *     (core/atmospheres.js — heights as radius multiples, pressure in atm),
 *     which the walk-mode sky renderer turns into daytime gradients.
 *
 * Used as the app's initial world and by scripts/gen-sample-world.mjs to
 * (re)generate public/world.json. Node-importable (no DOM access).
 */

import { createEmptyWorld, createPlanet, createCraft } from './worldSchema.js'
import { atmosphereFor } from './atmospheres.js'
import { generateElements } from './generators.js'
import { planetVolume, frequencyForRadius, radiusForFrequency, MAX_FREQUENCY } from './planetMath.js'
import { orbitalSpeed } from './physics.js'

const HOME_SCALE = 35 // u/AU of the original compact demo — the floor
const MAX_SCALE = 90 // cap, so far-flung systems stay manageable
const EARTH_YEAR = 60 // real seconds for one Earth orbit
const SPIN_RATE = 0.6 // rad/s for a world with a 1-Earth-day rotation period
const DEG = Math.PI / 180

// The atom anchor (Jupiter = radiusForFrequency(MAX_FREQUENCY)) sets how big
// a hex is; distances must follow it so planet-vs-orbit proportions survive
// a cap change. The freq-64 anchor landed at 88.8 u/AU for this system, so
// everything scales by the anchor's growth — √10 when 64 → 203 (10× cells).
const ATOM_ZOOM = radiusForFrequency(MAX_FREQUENCY) / radiusForFrequency(64)

/**
 * Scene units per astronomical unit for a set of worlds: compact systems
 * (the original 2–3 world demo, anything within ~15 AU) keep the classic
 * 35 u/AU (× ATOM_ZOOM); wider systems gain scale linearly, so this
 * nine-planet system earns a proportionally grander scene. Larger scales
 * also fade the engine's ε² = 4 softening to near-nothing → more Keplerian
 * orbits.
 */
function unitsPerAU(maxOrbitAu) {
  return Math.min(MAX_SCALE * ATOM_ZOOM, Math.max(HOME_SCALE * ATOM_ZOOM, maxOrbitAu * 2.25 * ATOM_ZOOM))
}

/** Rodrigues rotation of vector v about unit axis by angle (radians). */
function rotate(v, axis, angle) {
  const [kx, ky, kz] = axis
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const d = kx * v[0] + ky * v[1] + kz * v[2]
  const cx = ky * v[2] - kz * v[1]
  const cy = kz * v[0] - kx * v[2]
  const cz = kx * v[1] - ky * v[0]
  return [
    v[0] * c + cx * s + kx * d * (1 - c),
    v[1] * c + cy * s + ky * d * (1 - c),
    v[2] * c + cz * s + kz * d * (1 - c),
  ]
}

/** Spin vector for a real rotation period + axial obliquity (deg). */
function spin(day, tiltDeg) {
  const w = SPIN_RATE / day
  const t = tiltDeg * DEG
  return { x: w * Math.sin(t), y: w * Math.cos(t), z: 0 }
}

// rKm = mean radius — its hex grid (frequency) is DERIVED from it: atoms are
// one size for every world, so big planets are simply made of more of them;
// a = mean distance (AU); inc/node = orbital inclination / ascending node (deg);
// lon = J2000 mean longitude (deg); day = sidereal rotation period (Earth days);
// tilt = axial obliquity (deg); mu = mass in solar masses.
const PLANET_DATA = [
  { name: 'Mercury', preset: 'moon',      rKm: 2439.7,  a: 0.3871,  inc: 7.0,   node: 48.3,  lon: 252.3, day: 58.646,  tilt: 0.03,   mu: 1.660e-7, seed: 101 },
  { name: 'Venus',   preset: 'desert',    rKm: 6051.8,  a: 0.7233,  inc: 3.39,  node: 76.7,  lon: 181.0, day: 243.02,  tilt: 177.36, mu: 2.448e-6, seed: 202 },
  { name: 'Earth',   preset: 'earthlike', rKm: 6371.0,  a: 1.0,     inc: 0.0,   node: 0.0,   lon: 100.5, day: 0.99727, tilt: 23.44,  mu: 3.003e-6, seed: 42 },
  { name: 'Mars',    preset: 'desert',    rKm: 3389.5,  a: 1.5237,  inc: 1.85,  node: 49.6,  lon: 355.5, day: 1.02595, tilt: 25.19,  mu: 3.227e-7, seed: 303 },
  { name: 'Jupiter', preset: 'gas',       rKm: 69911,   a: 5.2029,  inc: 1.3,   node: 100.5, lon: 34.4,  day: 0.41354, tilt: 3.13,   mu: 9.548e-4, seed: 404 },
  { name: 'Saturn',  preset: 'gas',       rKm: 58232,   a: 9.5367,  inc: 2.49,  node: 113.7, lon: 49.9,  day: 0.44401, tilt: 26.73,  mu: 2.858e-4, seed: 505 },
  { name: 'Uranus',  preset: 'ice',       rKm: 25362,   a: 19.1913, inc: 0.77,  node: 74.0,  lon: 313.2, day: 0.71833, tilt: 97.77,  mu: 4.366e-5, seed: 606 },
  { name: 'Neptune', preset: 'ice',       rKm: 24622,   a: 30.069,  inc: 1.77,  node: 131.8, lon: 304.9, day: 0.67125, tilt: 28.32,  mu: 5.150e-5, seed: 707 },
  { name: 'Pluto',   preset: 'ice',       rKm: 1188.3,  a: 39.482,  inc: 17.16, node: 110.3, lon: 230.0, day: 6.3872,  tilt: 122.53, mu: 6.55e-9,  seed: 808 },
]

// Scene scale for this set of worlds: ≈ 88.8 u/AU → Pluto at ≈ 3,506 u.
const AU = unitsPerAU(Math.max(...PLANET_DATA.map((d) => d.a)))

// Real radii in km, anchored so Jupiter exactly fills the largest legal
// atom grid — this fixes the universal size of one hex:
const KM2U = radiusForFrequency(MAX_FREQUENCY) / 69911

// Relief reference: generator heights are tuned for an Earth-sized world,
// so h scales with the atom radius (Earth keeps its exact generator relief).
const RELIEF_REF = radiusForFrequency(frequencyForRadius(6371.0 * KM2U))

export function makeStarterWorld() {
  const world = createEmptyWorld('Sol System')
  const G = world.gravity

  // Solar mass such that a circular 1 AU orbit has period EARTH_YEAR under
  // the softened law used in physics.js:  v²/r = G·M/(r² + 4).
  const mSun = (4 * Math.PI * Math.PI * AU * (AU * AU + 4)) / (G * EARTH_YEAR * EARTH_YEAR)

  // The Sun is the atom model's one exception: 109 Earth radii would need
  // millions of hexes, so it keeps a deliberately reduced visual size
  // (≈ 0.37 Jupiter radii on screen — a 10-step-up atom grid of its own).
  const sunRes = 76
  const sun = createPlanet({
    id: 'p-sun',
    name: 'Sun',
    preset: 'star',
    frequency: sunRes,
    seed: 1207,
    isStatic: true,
    center: { x: 0, y: 0, z: 0 },
    elements: generateElements('star', sunRes, 1207).map((e) => ({
      ...e,
      h: e.h * (radiusForFrequency(sunRes) / RELIEF_REF),
    })),
  })
  sun.density = mSun / planetVolume(sun)
  sun.spin = spin(25.38, 7.25) // real relative rotation, same time compression
  world.planets.push(sun)

  for (const d of PLANET_DATA) {
    // The atom model: frequency (hex count) comes from the true radius, the
    // grid stays at its natural size (scale 1), and relief rides along with
    // the radius so every world has the same terrain proportions. h = 0
    // (sea level) is preserved exactly.
    const res = frequencyForRadius(d.rKm * KM2U)
    const relief = radiusForFrequency(res) / RELIEF_REF
    const elements = generateElements(d.preset, res, d.seed).map((e) => ({
      ...e,
      h: e.h * relief,
    }))

    const planet = createPlanet({
      id: `p-${d.name.toLowerCase()}`,
      name: d.name,
      preset: d.preset,
      frequency: res,
      seed: d.seed,
      spin: spin(d.day, d.tilt),
      ...(atmosphereFor(d.name, d.rKm) ? { atmosphere: atmosphereFor(d.name, d.rKm) } : {}),
      elements,
    })
    // Density that reproduces the planet's real mass at this grid volume.
    planet.density = (d.mu * mSun) / planetVolume(planet)

    // Circular orbit at the true mean distance, then tip the orbital plane
    // by the real inclination about the ascending node.
    const r = d.a * AU
    let pos = [r * Math.cos(d.lon * DEG), 0, r * Math.sin(d.lon * DEG)]
    const speed = orbitalSpeed(G, mSun, r) // exact circular speed for the engine's law
    let vel = [(pos[2] / r) * speed, 0, (-pos[0] / r) * speed]
    if (d.inc !== 0) {
      const axis = [Math.cos(d.node * DEG), 0, Math.sin(d.node * DEG)]
      pos = rotate(pos, axis, d.inc * DEG)
      vel = rotate(vel, axis, d.inc * DEG)
    }
    planet.center = { x: pos[0], y: pos[1], z: pos[2] }
    planet.velocity = { x: vel[0], y: vel[1], z: vel[2] }
    world.planets.push(planet)
  }

  // The astronaut's craft: a shuttle parked on Earth. Launching places the
  // astronaut on foot here by default (docs/flight.txt) — you arrive on the
  // ground, next to the pad, and walk by default.
  world.crafts = [
    createCraft({
      id: 'c-shuttle-earth',
      name: 'Shuttle',
      kind: 'shuttle',
      realism: 'arcade',
      pose: { anchor: { bodyId: 'p-earth', dir: [0, 0.7, 0.7], r: null } },
    }),
  ]

  return world
}
