/**
 * starter.js
 * ---------------------------------------------------------------------------
 * Sol — a miniature of the real solar system: the Sun plus Mercury…Pluto.
 *
 * Calibration (everything lives here; the engine is untouched):
 *
 *   • Distances are exactly proportional, and the scene scale is DYNAMIC:
 *     unitsPerAU() keeps compact systems at the classic 35 u/AU and lets a
 *     wide system earn more (here ≈ 88.8, so Pluto's orbit lands at ≈ 3,506
 *     units). Scene.jsx sizes the camera, fog and starfield to the system's
 *     own extent, so any set of worlds frames correctly.
 *   • One central mass drives the orbits, so Kepler's third law makes every
 *     period ratio REAL (Mercury 0.24 yr … Pluto 247.9 yr). The Sun's mass
 *     is solved from the engine's softened force law (v²/r = G·M/(r²+ε²),
 *     ε² = 4) so that Earth completes 1 AU in EARTH_YEAR seconds. Bigger
 *     scene scales shrink ε² relative to the orbits, so wide systems are
 *     even more exactly Keplerian.
 *   • Planet masses are the real solar mass ratios (densities back them out
 *     from each grid volume), so planet–planet perturbations are true to
 *     scale: the Sun dominates and the system is stable.
 *   • Sizes are EXACT true relative radii, anchored on Jupiter filling a
 *     frequency-24 grid. The per-planet `scale` field decouples physical
 *     size from grid resolution, so every world can carry a uniform
 *     frequency-64 grid (40,962 hex cells to paint and walk on) while
 *     Jupiter still dwarfs Earth exactly 10.97×. Relief (element `h`) is
 *     scaled with the radius, so terrain proportions survive shrinking.
 *     The Sun — 109 Earth radii true — keeps a reduced visual size; its
 *     mass is real.
 *   • Orbits are circular at each world's mean distance, inclined by the
 *     real orbital inclinations; starting positions are the J2000 mean
 *     longitudes. Eccentricity is the only real effect left out.
 *   • Spins keep the real relative day lengths (Venus/Uranus/Pluto spin
 *     retrograde via their obliquity), compressed so Earth's day ≈ 10 s.
 *   • No moons: at true scale the Moon would orbit INSIDE the Earth here
 *     (0.0026 AU ≈ 0.23 units).
 *
 * Used as the app's initial world and by scripts/gen-sample-world.mjs to
 * (re)generate public/world.json. Node-importable (no DOM access).
 */

import { createEmptyWorld, createPlanet } from './worldSchema.js'
import { generateElements } from './generators.js'
import { cellCountForFrequency, radiusFromCellCount } from './hexsphere.js'
import { planetVolume } from './planetMath.js'
import { orbitalSpeed } from './physics.js'

const HOME_SCALE = 35 // u/AU of the original compact demo — the floor
const MAX_SCALE = 90 // cap, so far-flung systems stay manageable
const EARTH_YEAR = 60 // real seconds for one Earth orbit
const SPIN_RATE = 0.6 // rad/s for a world with a 1-Earth-day rotation period
const DEG = Math.PI / 180

/**
 * Scene units per astronomical unit for a set of worlds: compact systems
 * (the original 2–3 world demo, anything within ~15 AU) keep the classic
 * 35 u/AU; wider systems gain scale linearly, so this nine-planet system
 * earns a proportionally grander scene. Larger scales also fade the
 * engine's ε² = 4 softening to near-nothing → more Keplerian orbits.
 */
function unitsPerAU(maxOrbitAu) {
  return Math.min(MAX_SCALE, Math.max(HOME_SCALE, maxOrbitAu * 2.25))
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

// rKm = mean radius; res = hex-grid resolution (mesh detail — physical size
// comes from rKm via `scale`, independent of res);
// a = mean distance (AU); inc/node = orbital inclination / ascending node (deg);
// lon = J2000 mean longitude (deg); day = sidereal rotation period (Earth days);
// tilt = axial obliquity (deg); mu = mass in solar masses.
const PLANET_DATA = [
  { name: 'Mercury', preset: 'moon',      res: 64,  rKm: 2439.7,  a: 0.3871,  inc: 7.0,   node: 48.3,  lon: 252.3, day: 58.646,  tilt: 0.03,   mu: 1.660e-7, seed: 101 },
  { name: 'Venus',   preset: 'desert',    res: 64,  rKm: 6051.8,  a: 0.7233,  inc: 3.39,  node: 76.7,  lon: 181.0, day: 243.02,  tilt: 177.36, mu: 2.448e-6, seed: 202 },
  { name: 'Earth',   preset: 'earthlike', res: 64, rKm: 6371.0,  a: 1.0,     inc: 0.0,   node: 0.0,   lon: 100.5, day: 0.99727, tilt: 23.44,  mu: 3.003e-6, seed: 42 },
  { name: 'Mars',    preset: 'desert',    res: 64,  rKm: 3389.5,  a: 1.5237,  inc: 1.85,  node: 49.6,  lon: 355.5, day: 1.02595, tilt: 25.19,  mu: 3.227e-7, seed: 303 },
  { name: 'Jupiter', preset: 'gas',       res: 64, rKm: 69911,   a: 5.2029,  inc: 1.3,   node: 100.5, lon: 34.4,  day: 0.41354, tilt: 3.13,   mu: 9.548e-4, seed: 404 },
  { name: 'Saturn',  preset: 'gas',       res: 64, rKm: 58232,   a: 9.5367,  inc: 2.49,  node: 113.7, lon: 49.9,  day: 0.44401, tilt: 26.73,  mu: 2.858e-4, seed: 505 },
  { name: 'Uranus',  preset: 'ice',       res: 64, rKm: 25362,   a: 19.1913, inc: 0.77,  node: 74.0,  lon: 313.2, day: 0.71833, tilt: 97.77,  mu: 4.366e-5, seed: 606 },
  { name: 'Neptune', preset: 'ice',       res: 64, rKm: 24622,   a: 30.069,  inc: 1.77,  node: 131.8, lon: 304.9, day: 0.67125, tilt: 28.32,  mu: 5.150e-5, seed: 707 },
  { name: 'Pluto',   preset: 'ice',       res: 64,  rKm: 1188.3,  a: 39.482,  inc: 17.16, node: 110.3, lon: 230.0, day: 6.3872,  tilt: 122.53, mu: 6.55e-9,  seed: 808 },
]

// Scene scale for this set of worlds: ≈ 88.8 u/AU → Pluto at ≈ 3,506 u.
const AU = unitsPerAU(Math.max(...PLANET_DATA.map((d) => d.a)))

// Real radii in km, anchored so Jupiter exactly fills a frequency-24 grid:
const KM2U = radiusFromCellCount(cellCountForFrequency(24)) / 69911

export function makeStarterWorld() {
  const world = createEmptyWorld('Sol System')
  const G = world.gravity

  // Solar mass such that a circular 1 AU orbit has period EARTH_YEAR under
  // the softened law used in physics.js:  v²/r = G·M/(r² + 4).
  const mSun = (4 * Math.PI * Math.PI * AU * (AU * AU + 4)) / (G * EARTH_YEAR * EARTH_YEAR)

  const sun = createPlanet({
    id: 'p-sun',
    name: 'Sun',
    preset: 'star',
    frequency: 8,
    seed: 1207,
    isStatic: true,
    center: { x: 0, y: 0, z: 0 },
  })
  sun.density = mSun / planetVolume(sun)
  sun.spin = spin(25.38, 7.25) // real relative rotation, same time compression
  world.planets.push(sun)

  for (const d of PLANET_DATA) {
    // Exact size: shrink (or keep) the grid's natural radius to the true
    // relative radius. Relief is in absolute units, so scale it too —
    // h = 0 (sea level) is preserved exactly.
    const scale = (d.rKm * KM2U) / radiusFromCellCount(cellCountForFrequency(d.res))
    const elements = generateElements(d.preset, d.res, d.seed).map((e) => ({
      ...e,
      h: e.h * scale,
    }))

    const planet = createPlanet({
      id: `p-${d.name.toLowerCase()}`,
      name: d.name,
      preset: d.preset,
      frequency: d.res,
      scale,
      seed: d.seed,
      spin: spin(d.day, d.tilt),
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

  return world
}
