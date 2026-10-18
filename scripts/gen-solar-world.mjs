#!/usr/bin/env node
/**
 * gen-solar-world.mjs — the SCALING TRIAL world (docs/scaling.txt §5/§8).
 *
 * A realistic solar system exercising the two halves of the design at once:
 *
 *   • STORED bodies at the 35 km atom anchor — Earth fills the ladder
 *     (frequency 203, 412,092 hexes of REAL terrain in the DB), Mercury,
 *     Venus, Mars and Pluto stored on their natural grids. One unit ≈ 35 km;
 *     mass per hex follows §8.3 (a body property: density × R/3 per hex).
 *   • GENERATED bodies (bodies.generation, zero atom rows): the Sun and the
 *     four gas/ice giants. Their frequency+scale describe their TRUE size
 *     (a freq-64 grid at scale 34.8 IS a Jupiter), and the server synthesizes
 *     their surfaces on demand from {fn:'preset', preset, seed, relief} —
 *     hydration, previews, walking included, with nothing stored.
 *
 * TRUE ratios throughout: the Sun is the Sun (≈109 Earth radii), Jupiter
 * dwarfs Earth, and orbits sit at their real distances — a compressed layout
 * cannot hold a real Sun (its radius would reach past Jupiter's orbit).
 * Orbits are circular at the true mean distances with the real inclinations;
 * the solar mass is solved from the engine's softened law for a REAL 365-day
 * Earth year, and spin vectors give true sidereal rotation rates; planet
 * densities reproduce the real mass ratios (so the Sun dominates and the
 * system is stable).
 *
 * Writes public/solar-trial.json; import with:
 *   node scripts/import-db.mjs public/solar-trial.json
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { generateElements } from '../src/core/generators.js'
import { planetVolume, frequencyForRadius, radiusForFrequency, MAX_FREQUENCY } from '../src/core/planetMath.js'
import { orbitalSpeed } from '../src/core/physics.js'

const G = 40
// TRUE tempo: one orbit per real year, one spin per real day. The engine
// integrates at a fixed 1/60 s step per frame, so document seconds ARE
// wall-clock seconds (at 60 Hz). The starter world runs a theatrical
// 60 s year / 0.6 rad/s spin; this trial keeps reality instead — Earth
// drifts ~0.85 u/s along its 2.7M-u orbit and turns once per 24 h.
const EARTH_YEAR = 365.25 * 86400 // seconds
const SPIN_RATE = (2 * Math.PI) / 86400 // rad/s for a 1-Earth-day rotation
const DEG = Math.PI / 180

// ---- anchors ---------------------------------------------------------------
// The atom unit: Earth fills the top of the ladder (412,092 hexes, ~35.2 km
// per hex). The starter anchored JUPITER there; this world anchors EARTH.
const EARTH_R_KM = 6371.009
const KM2U = radiusForFrequency(MAX_FREQUENCY) / EARTH_R_KM // units per km
const RELIEF_REF = radiusForFrequency(MAX_FREQUENCY) // generator h is tuned Earth-size

// Scene distances: TRUE ratios — 1 AU in units (≈4.25 million). A real-Sun
// trial forces this: the Sun's true radius (≈19,800 u) would swallow every
// orbit of the starter's compressed 282-u/AU layout, Jupiter's included.
// The camera machinery scales with the system extent (Scene.jsx).
const AU_KM = 149_597_870.7
const AU = AU_KM * KM2U

// Generated-body grids: coarse meshes scaled to true size (the trial's
// "functional bodies"). Frequency must stay > the server's preview freq (16).
const GIANT_GRID = 64
const SUN_GRID = 96

// ---- data (same table + constants as starter.js) ---------------------------
// Stored: frequency derives from the true radius on the new anchor.
const STORED = [
  { name: 'Mercury', preset: 'moon', rKm: 2439.7, a: 0.3871, inc: 7.0, node: 48.3, lon: 252.3, day: 58.646, tilt: 0.03, mu: 1.66e-7, seed: 101 },
  { name: 'Venus', preset: 'desert', rKm: 6051.8, a: 0.7233, inc: 3.39, node: 76.7, lon: 181.0, day: 243.02, tilt: 177.36, mu: 2.448e-6, seed: 202 },
  { name: 'Earth', preset: 'earthlike', rKm: 6371.0, a: 1.0, inc: 0.0, node: 0.0, lon: 100.5, day: 0.99727, tilt: 23.44, mu: 3.003e-6, seed: 42 },
  { name: 'Mars', preset: 'desert', rKm: 3389.5, a: 1.5237, inc: 1.85, node: 49.6, lon: 355.5, day: 1.02595, tilt: 25.19, mu: 3.227e-7, seed: 303 },
  { name: 'Pluto', preset: 'ice', rKm: 1188.3, a: 39.482, inc: 17.16, node: 110.3, lon: 230.0, day: 6.3872, tilt: 122.53, mu: 6.55e-9, seed: 808 },
]
// Generated: coarse grid, scale to true radius, nothing stored.
const GENERATED = [
  { name: 'Sun', preset: 'star', rKm: 696340, grid: SUN_GRID, a: 0, inc: 0, node: 0, lon: 0, day: 25.38, tilt: 7.25, mu: 1, seed: 1207, isStatic: true },
  { name: 'Jupiter', preset: 'gas', rKm: 69911, grid: GIANT_GRID, a: 5.2029, inc: 1.3, node: 100.5, lon: 34.4, day: 0.41354, tilt: 3.13, mu: 9.548e-4, seed: 404 },
  { name: 'Saturn', preset: 'gas', rKm: 58232, grid: GIANT_GRID, a: 9.5367, inc: 2.49, node: 113.7, lon: 49.9, day: 0.44401, tilt: 26.73, mu: 2.858e-4, seed: 505 },
  { name: 'Uranus', preset: 'ice', rKm: 25362, grid: GIANT_GRID, a: 19.1913, inc: 0.77, node: 74.0, lon: 313.2, day: 0.71833, tilt: 97.77, mu: 4.366e-5, seed: 606 },
  { name: 'Neptune', preset: 'ice', rKm: 24622, grid: GIANT_GRID, a: 30.069, inc: 1.77, node: 131.8, lon: 304.9, day: 0.67125, tilt: 28.32, mu: 5.15e-5, seed: 707 },
]

// ---- mechanics (starter.js conventions) ------------------------------------
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
function spinVec(day, tiltDeg) {
  const w = SPIN_RATE / day
  const t = tiltDeg * DEG
  return { x: w * Math.sin(t), y: w * Math.cos(t), z: 0 }
}
function orbit(a, inc, node, lon, mSun) {
  if (a === 0) return { center: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } } // the anchor
  const r = a * AU
  let pos = [r * Math.cos(lon * DEG), 0, r * Math.sin(lon * DEG)]
  const speed = orbitalSpeed(G, mSun, r)
  let vel = [(pos[2] / r) * speed, 0, (-pos[0] / r) * speed]
  if (inc !== 0) {
    const axis = [Math.cos(node * DEG), 0, Math.sin(node * DEG)]
    pos = rotate(pos, axis, inc * DEG)
    vel = rotate(vel, axis, inc * DEG)
  }
  return {
    center: { x: pos[0], y: pos[1], z: pos[2] },
    velocity: { x: vel[0], y: vel[1], z: vel[2] },
  }
}

// Solar mass so a circular 1 AU orbit has period EARTH_YEAR under the
// softened law (v²/r = G·M/(r²+4)) — the starter's solve.
const mSun = (4 * Math.PI * Math.PI * AU * (AU * AU + 4)) / (G * EARTH_YEAR * EARTH_YEAR)

// ---- build -------------------------------------------------------------------
const planets = []

for (const d of STORED) {
  const frequency = frequencyForRadius(d.rKm * KM2U)
  const relief = radiusForFrequency(frequency) / RELIEF_REF // relief ∝ radius, h=0 preserved
  const elements = generateElements(d.preset, frequency, d.seed).map((e) => ({ ...e, h: e.h * relief }))
  const planet = {
    id: `p-${d.name.toLowerCase()}`,
    name: d.name,
    preset: d.preset,
    seed: d.seed,
    frequency,
    scale: 1,
    density: (d.mu * mSun) / planetVolume({ frequency, scale: 1, elements }),
    isStatic: false,
    elements,
    ...orbit(d.a, d.inc, d.node, d.lon, mSun),
    spin: spinVec(d.day, d.tilt),
  }
  planets.push(planet)
}

for (const d of GENERATED) {
  const radius = d.rKm * KM2U // units — the TRUE size (visual for the Sun)
  const gridRadius = radiusForFrequency(d.grid)
  const scale = radius / gridRadius
  const relief = radius / RELIEF_REF // generator relief tuned Earth-size → ∝ radius
  // Synthesize locally (deterministic — same call the server will make) for
  // the mean relief and the exact mass integral. NOTHING is stored.
  const sample = generateElements(d.preset, d.grid, d.seed).map((e) => ({ ...e, h: e.h * relief }))
  let sum = 0
  for (const e of sample) sum += e.h
  const planet = {
    id: `p-${d.name.toLowerCase()}`,
    name: d.name,
    preset: d.preset,
    seed: d.seed,
    frequency: d.grid,
    scale,
    density: (d.mu * mSun) / planetVolume({ frequency: d.grid, scale, elements: sample }),
    isStatic: !!d.isStatic,
    generation: {
      fn: 'preset',
      preset: d.preset,
      seed: d.seed,
      relief,
      avgHeight: sum / sample.length,
    },
    ...orbit(d.a, d.inc, d.node, d.lon, mSun),
    spin: spinVec(d.day, d.tilt),
  }
  planets.push(planet)
}

const world = { version: 1, name: 'Sol Trial', gravity: G, planets }
mkdirSync(new URL('../public', import.meta.url), { recursive: true })
const out = new URL('../public/solar-trial.json', import.meta.url)
writeFileSync(out, JSON.stringify(world))

// ---- summary -------------------------------------------------------------------
let storedAtoms = 0
console.log(`Wrote public/solar-trial.json — unit ≈ ${(1 / KM2U).toFixed(1)} km, AU = ${AU.toFixed(0)} u, M☉ = ${mSun.toExponential(3)}`)
for (const p of planets) {
  const R = radiusForFrequency(p.frequency) * p.scale
  const cells = 10 * p.frequency * p.frequency + 2
  if (!p.generation) storedAtoms += cells
  const kmPerHex = (1 / KM2U) * (p.scale > 1 ? p.scale : 1)
  console.log(
    `  ${p.name.padEnd(8)} ${p.generation ? 'generated' : 'stored   '} f${String(p.frequency).padStart(3)} scale=${p.scale.toFixed(2).padStart(7)} ` +
      `R=${R.toFixed(1).padStart(8)}u  cells=${String(cells).padStart(7)}  hex≈${kmPerHex.toFixed(1).padStart(7)}km`
  )
}
console.log(`  stored atoms total: ${storedAtoms.toLocaleString('en-US')}`)
