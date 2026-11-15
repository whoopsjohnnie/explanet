#!/usr/bin/env node
/**
 * gen-sol-real.mjs — build the REAL solar system world (public/sol-real.json).
 *
 *   • Sun + 8 planets + Pluto + 4 dwarf planets: fully simulated (cannon),
 *     osculating J2000 elements → state vectors, true masses (density trick),
 *     true sidereal spins.
 *   • Earth stores REAL terrain from the ETOPO2022 60s DEM: true coastlines,
 *     true mountain heights, seafloor DEPTH as negative h (sea level = 0,
 *     Mariana Trench walkable at −10 km), climate-belt + elevation colors.
 *     Mars (dichotomy, Olympus, Valles, Hellas), the Moon (maria),
 *     Mercury (Caloris) and Venus likewise. The giant moons get palette-true
 *     procedural surfaces (Io sulfur, Europa linea, Titan dunes…).
 *   • ~450 moons, ~450 asteroids, ~70 comets: SCRIPTED test particles
 *     (scriptsOrbit → core/kepler.js) — real orbits, chunky terrain, true
 *     colors, zero gravity cost. That is what keeps a ~900-body world at
 *     60 fps: pairwise applyForce only runs for the 14 massive bodies.
 *   • Rings around Saturn/Jupiter/Uranus (document descriptor → renderer).
 *   • Real atmospheres on Earth/Venus/Mars/giants + Titan, Triton, Pluto
 *     (core/atmospheres.js catalog → document descriptor → walk-mode sky).
 *
 * Same anchors as the Sol Trial (gen-solar-world.mjs): one hex ≈ 35 km on
 * the f203 Earth, 1 AU ≈ 4.25 million units, one document second = one real
 * second, solar mass solved from the softened law for a true Earth year.
 * The world carries `scale` (that same anchor, in meters per unit) so the
 * surface walker is a REAL human — 1.6 m eyes, 1.4 m/s, 9.8 m/s² on Earth —
 * instead of one 35 km tile tall (core/surface.js SURFACE_REAL).
 *
 * Import:  node scripts/import-db.mjs public/sol-real.json
 */

import { writeFileSync } from 'node:fs'
import { readSeed, readSeedBinary } from './seed.mjs'
import { generateElements } from '../src/core/generators.js'
import { createCraft } from '../src/core/worldSchema.js'
import { planetVolume, frequencyForRadius, radiusForFrequency, MAX_FREQUENCY } from '../src/core/planetMath.js'
import { keplerState } from '../src/core/kepler.js'
import { PLANETS, DWARFS, RINGS, EXTRA_MOONS } from './sol-real/features.js'
import { atmosphereFor } from '../src/core/atmospheres.js'
import { buildEarth, elementsFromHexFn } from './sol-real/terrain.js'
import { terrainFor, MOON_TERRAIN, hash01 } from './sol-real/bodyTerrain.mjs'
import { loadEtopo } from './sol-real/etopo.mjs'

// ---------------------------------------------------------------------------
// CLI options — the stored high-res (docs/terrain2.txt)
//   --hex-meters <m>  set worlds.hex_meters (the world's stored hex edge, m)
//   --out <path>      write the world doc here (default public/sol-real.json)
//
// Resolution is a WORLD property: when hex_meters is set, EVERY non-generated
// body stores its hexcells at that size (there is no per-body flag — the rule
// is derived, docs/terrain2.txt §4). A doc built with --hex-meters is a NORMAL
// world document carrying only the world-level hex size. The actual hexcells
// (hundreds of millions of rows across the stored bodies) are streamed into
// the DB by scripts/import-hexcells.mjs AFTER the world is imported — a JSON
// doc never holds them (large worlds are DB-only).
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
const argOpt = (f, d = undefined) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : d
}
const HEX_METERS = Number(argOpt('--hex-meters')) || null
const OUT_PATH = argOpt('--out', '../public/sol-real.json')

// ---------------------------------------------------------------------------
// anchors (identical to the Sol Trial)
// ---------------------------------------------------------------------------
const G = 40
const EARTH_YEAR = 365.25 * 86400
const SPIN_RATE = (2 * Math.PI) / 86400
const DEG = Math.PI / 180
const EARTH_R_KM = 6371.009
const KM2U = radiusForFrequency(MAX_FREQUENCY) / EARTH_R_KM // ≈ 0.028435 u/km
const RELIEF_REF = radiusForFrequency(MAX_FREQUENCY)
const AU_KM = 149_597_870.7
const AU = AU_KM * KM2U
const M_SUN_KG = 1.98892e30
const JD_J2000 = 2451545.0
const mSun = (4 * Math.PI * Math.PI * AU * (AU * AU + 4)) / (G * EARTH_YEAR * EARTH_YEAR)

const km2u = (v) => v * KM2U
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const slug = (s) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

// hash01 (the deterministic string hash for node/peri/M0/seed/color spread)
// lives in ./sol-real/bodyTerrain.mjs — imported above — because it drives
// BOTH the orbital spread here and the per-body terrain parameters there.

function spinVec(day, tiltDeg) {
  const w = SPIN_RATE / day
  const t = (tiltDeg || 0) * DEG
  return { x: w * Math.sin(t), y: w * Math.cos(t), z: 0 }
}

const gridFor = (rKm, min = 2, max = MAX_FREQUENCY) => clamp(frequencyForRadius(km2u(rKm)), min, max)

/**
 * Grid + exact scale for a true radius. Bodies whose natural grid is more
 * than 12% off (sub-atom dust, mostly) ride scale ≠ 1 — the documented
 * fine-mesh escape hatch — so Vesta is 262 km and a 6 km rock is a 6 km rock.
 */
function sizeGrid(rKm, min = 2, max = MAX_FREQUENCY) {
  const rU = km2u(rKm)
  const f = clamp(frequencyForRadius(rU), min, max)
  const Rf = radiusForFrequency(f)
  const scale = Math.abs(Rf - rU) / rU > 0.12 ? rU / Rf : 1
  return { freq: f, scale }
}

/**
 * Elements → { orbit (engine units, for scriptsOrbit), center, velocity }
 * evaluated at t = 0 (document time = J2000). Near-parabolic orbits (a ≤ 0
 * or e ≥ 0.9985) are clamped to a bounded ellipse through the same
 * perihelion — the analytic integrator has no hyperbolae.
 */
function stateFrom(el) {
  const aKmIn = el.aAU != null ? el.aAU * AU_KM : el.aKm
  const eIn = el.e
  let aKm = aKmIn
  let e = clamp(eIn, 0, 0.998)
  let clamped = false
  if (!(aKm > 0) || eIn >= 0.9985) {
    e = 0.995
    aKm = (el.qKm != null ? el.qKm : aKmIn * (1 - eIn)) / (1 - e)
    clamped = true // the ellipse is synthetic — its period must follow from a
  }
  const periodS = el.periodDays && !clamped
    ? el.periodDays * 86400
    : Math.sqrt((aKm / AU_KM) ** 3) * EARTH_YEAR
  const n = (2 * Math.PI) / periodS
  let m0
  if (el.tpJD != null) m0 = n * (JD_J2000 - el.tpJD) * 86400
  else {
    const dEpoch = el.epochJD != null ? el.epochJD : JD_J2000
    m0 = (el.M0Deg || 0) * DEG + n * (JD_J2000 - dEpoch) * 86400
  }
  const orbit = {
    a: km2u(aKm),
    e,
    inc: (el.iDeg || 0) * DEG,
    node: (el.omDeg || 0) * DEG,
    peri: (el.wDeg || 0) * DEG,
    n,
    m0: m0 % (2 * Math.PI),
  }
  const st = keplerState(orbit, 0)
  return {
    orbit,
    center: { x: st.pos[0], y: st.pos[1], z: st.pos[2] },
    velocity: { x: st.vel[0], y: st.vel[1], z: st.vel[2] },
  }
}

// ---------------------------------------------------------------------------
// data files
// ---------------------------------------------------------------------------
const seedAt = (rel) => new URL(rel, import.meta.url).pathname
const moonsData = JSON.parse(readSeed(seedAt('./sol-real/data/moons.json'), 'regenerate with scripts/sol-real/fetch-moons.mjs or fetch from S3 (DATA.md)'))
const orbitsData = JSON.parse(readSeed(seedAt('./sol-real/data/orbits.json'), 'regenerate with scripts/sol-real/fetch-small.mjs or fetch from S3 (DATA.md)'))
const etopo = loadEtopo(
  readSeedBinary(seedAt('./sol-real/data/etopo2022-60s.f32'), 'fetch + convert with scripts/sol-real/fetch-terrain.mjs (DATA.md)')
)
// name → seed-table entry for the small bodies (asteroids/comets) — terrainFor
// reads diameter/sbClass/a from it for the potato color + lumpiness
const small = new Map()
for (const a of orbitsData.asteroids) small.set(a.name, a)
for (const c of orbitsData.comets) small.set(c.name, c)

const PLANET_DOC_ID = {}
for (const p of PLANETS) PLANET_DOC_ID[p.name] = `p-${p.name.toLowerCase()}`
const DWARF_DOC_ID = {}
for (const d of DWARFS) if (!d.skip) DWARF_DOC_ID[d.name] = `d-${d.name.toLowerCase()}`
// moon hosts that live in the asteroid list get deterministic asteroid ids
const ASTEROID_HOST = { Orcus: 'a-orcus', Quaoar: 'a-quaoar', Salacia: 'a-salacia' }

// ---------------------------------------------------------------------------
// bodies
// ---------------------------------------------------------------------------
const planets = []
const usedDocIds = new Set()
function uniqueId(base) {
  let id = base
  let k = 2
  while (usedDocIds.has(id)) id = `${base}-${k++}`
  usedDocIds.add(id)
  return id
}

function densityFor(mu, frequency, scale, elements) {
  return (mu * mSun) / planetVolume({ frequency, scale, elements })
}

// reserve ids that moons reference by name
for (const id of Object.values(ASTEROID_HOST)) usedDocIds.add(id)

// ---- the Sun (generated) ----
{
  const radius = km2u(696340)
  const grid = 96
  const scale = radius / radiusForFrequency(grid)
  const relief = radius / RELIEF_REF
  const sample = generateElements('star', grid, 1207).map((e) => ({ ...e, h: e.h * relief }))
  let sum = 0
  for (const e of sample) sum += e.h
  planets.push({
    id: uniqueId('p-sun'),
    name: 'Sun',
    preset: 'star',
    kind: 'star',
    seed: 1207,
    frequency: grid,
    scale,
    density: (1 * mSun) / planetVolume({ frequency: grid, scale, elements: sample }),
    isStatic: true,
    generation: { fn: 'preset', preset: 'star', seed: 1207, relief, avgHeight: sum / sample.length },
    center: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    spin: spinVec(25.38, 7.25),
  })
}

// ---- planets: osculating elements at J2000 (M = L − ω − Ω) ----
const ORBITS_J2000 = {
  Mercury: { aAU: 0.387098, e: 0.20563, iDeg: 7.005, omDeg: 48.331, wDeg: 29.124, M0Deg: 174.796 },
  Venus: { aAU: 0.723332, e: 0.006772, iDeg: 3.395, omDeg: 76.68, wDeg: 54.884, M0Deg: 50.115 },
  Earth: { aAU: 1.0, e: 0.016709, iDeg: 0.0, omDeg: 0, wDeg: 114.208, M0Deg: 358.617 },
  Mars: { aAU: 1.523679, e: 0.0934, iDeg: 1.85, omDeg: 49.559, wDeg: 286.502, M0Deg: 19.395 },
  Jupiter: { aAU: 5.202887, e: 0.048386, iDeg: 2.056, omDeg: 100.474, wDeg: 274.2, M0Deg: 20.02 },
  Saturn: { aAU: 9.536676, e: 0.053862, iDeg: 2.486, omDeg: 113.665, wDeg: 339.392, M0Deg: 317.347 },
  Uranus: { aAU: 19.189165, e: 0.047257, iDeg: 0.773, omDeg: 74.006, wDeg: 96.999, M0Deg: 142.239 },
  Neptune: { aAU: 30.069923, e: 0.008606, iDeg: 1.77, omDeg: 131.784, wDeg: 276.34, M0Deg: 256.228 },
  Pluto: { aAU: 39.482117, e: 0.248827, iDeg: 17.14, omDeg: 110.303, wDeg: 113.758, M0Deg: 14.53 },
}

const GIANTS = {
  Jupiter: { preset: 'gas_jupiter', seed: 404 },
  Saturn: { preset: 'gas_saturn', seed: 505 },
  Uranus: { preset: 'ice_uranus', seed: 606 },
  Neptune: { preset: 'ice_neptune', seed: 707 },
}

/**
 * A rocky planet's document grid + elements. Earth is the only DEM-sourced
 * body (the ETOPO2022 60s catalog — real coastlines and relief); every other
 * body resolves through the shared terrainFor dispatch (bodyTerrain.mjs) so
 * the document and the stored high-res hexes (import-hexcells.mjs) evaluate
 * the SAME per-hex function — they agree by construction.
 */
function buildRockyTerrain(name, rKm, seed) {
  if (name === 'Earth') {
    return { freq: MAX_FREQUENCY, elements: buildEarth(MAX_FREQUENCY, etopo, seed) }
  }
  const freq = gridFor(rKm)
  const tf = terrainFor({ name, kind: name === 'Pluto' ? 'dwarf' : 'planet', parent: null, seed, frequency: freq, scale: 1 })
  return { freq, elements: elementsFromHexFn(tf, freq) }
}

for (const d of PLANETS) {
  const orb = stateFrom(ORBITS_J2000[d.name])
  const giant = GIANTS[d.name]
  if (giant) {
    const radius = km2u(d.rKm)
    const grid = 64
    const scale = radius / radiusForFrequency(grid)
    const relief = radius / RELIEF_REF
    const sample = generateElements(giant.preset, grid, giant.seed).map((e) => ({ ...e, h: e.h * relief }))
    let sum = 0
    for (const e of sample) sum += e.h
    planets.push({
      id: uniqueId(PLANET_DOC_ID[d.name]),
      name: d.name,
      preset: giant.preset,
      kind: 'planet',
      seed: giant.seed,
      frequency: grid,
      scale,
      density: (d.mu * mSun) / planetVolume({ frequency: grid, scale, elements: sample }),
      isStatic: false,
      generation: { fn: 'preset', preset: giant.preset, seed: giant.seed, relief, avgHeight: sum / sample.length },
      ...(RINGS[d.name] ? { rings: RINGS[d.name] } : {}),
      ...(atmosphereFor(d.name, d.rKm) ? { atmosphere: atmosphereFor(d.name, d.rKm) } : {}),
      center: orb.center,
      velocity: orb.velocity,
      spin: spinVec(d.day, d.tilt),
    })
    continue
  }
  const { freq, elements } = buildRockyTerrain(d.name, d.rKm, d.seed)
  const atmo = atmosphereFor(d.name, d.rKm)
  planets.push({
    id: uniqueId(PLANET_DOC_ID[d.name]),
    name: d.name,
    kind: d.name === 'Pluto' ? 'dwarf' : 'planet',
    preset: d.name === 'Earth' ? 'earthlike' : d.name === 'Venus' || d.name === 'Mars' ? 'desert' : d.name === 'Pluto' ? 'ice' : 'moon',
    seed: d.seed,
    frequency: freq,
    scale: 1,
    density: densityFor(d.mu, freq, 1, elements),
    isStatic: false,
    ...(atmo ? { atmosphere: atmo } : {}),
    // Earth is the only body with a real DEM: its fine region streams the
    // ETOPO2022 60s catalog (docs/terrain.txt stage 2). The fine-hex edge is
    // the catalog's pixel size (1.85 km); the document stays f203.
    ...(d.name === 'Earth' ? { terrain: { catalog: 'ETOP2022-60s' } } : {}),
    elements,
    center: orb.center,
    velocity: orb.velocity,
    spin: spinVec(d.day, d.tilt),
  })
}

// ---- dwarf planets (stored procedural terrain, cannon-simulated) ----
for (const d of DWARFS) {
  if (d.skip) continue
  const orb = stateFrom({ aAU: d.a, e: d.e, iDeg: d.i, omDeg: d.om, wDeg: d.w, M0Deg: d.M0 })
  const freq = gridFor(d.rKm)
  const elements = elementsFromHexFn(terrainFor({ name: d.name, kind: 'dwarf', parent: null, seed: d.seed, frequency: freq, scale: 1 }), freq)
  const atmo = atmosphereFor(d.name, d.rKm)
  planets.push({
    id: uniqueId(DWARF_DOC_ID[d.name]),
    name: d.name,
    kind: 'dwarf',
    preset: 'ice',
    seed: d.seed,
    frequency: freq,
    scale: 1,
    density: densityFor(d.mu, freq, 1, elements),
    isStatic: false,
    ...(atmo ? { atmosphere: atmo } : {}),
    elements,
    center: orb.center,
    velocity: orb.velocity,
    spin: spinVec(d.day, d.tilt),
  })
}

// ---------------------------------------------------------------------------
// moons — all scripted Kepler orbits around their parents
// (MOON_TERRAIN / PARENT_FAMILY / the per-body terrain dispatch live in
//  ./sol-real/bodyTerrain.mjs — MOON_TERRAIN is imported for the grid caps)
// ---------------------------------------------------------------------------
const parentRadii = {}
for (const p of PLANETS) parentRadii[p.name] = p.rKm

function estimateMu(diamKm, parent) {
  const rho =
    parent === 'Saturn' ? 900 : parent === 'Jupiter' ? 2200 : parent === 'Uranus' || parent === 'Neptune' ? 1500 : 2000
  const r = (diamKm / 2) * 1000
  return ((4 / 3) * Math.PI * r ** 3 * rho) / M_SUN_KG
}

function addMoon(m) {
  const parentId = PLANET_DOC_ID[m.parent] || DWARF_DOC_ID[m.parent] || ASTEROID_HOST[m.parent]
  if (!parentId) return
  const diam = Number(m.diam) || 8
  const rKm = Math.max(diam / 2, 0.4)
  const named = MOON_TERRAIN[m.name]
  const { freq, scale } = named
    ? named.cap
      ? sizeGrid(rKm, 2, named.cap)
      : sizeGrid(rKm)
    : sizeGrid(rKm, 2, 8)
  const seed = 1000 + Math.floor(hash01(m.name, 7) * 8999)
  // the shared dispatch (bodyTerrain.mjs): Moon → the real-maria builder,
  // named moons → their palette, the rest → a potato in the parent's family
  // palette — the SAME terrainFor the stored high-res hexes resolve through
  const elements = elementsFromHexFn(terrainFor({ name: m.name, kind: 'moon', parent: m.parent, seed, frequency: freq, scale }, { small }), freq)
  const mu = Number(m.mass15) ? (Number(m.mass15) * 1e15) / M_SUN_KG : estimateMu(diam, m.parent)

  const sma = Number(m.sma)
  if (!(sma > 0)) return
  const periodDays = Number(m.period) || 3
  const node = hash01(m.name, 21) * 360
  const peri = hash01(m.name, 34) * 360
  const m0 = hash01(m.name, 55) * 360
  const orb = stateFrom({
    aKm: sma,
    e: clamp(Number(m.ecc) || 0, 0, 0.9),
    iDeg: Number(m.inc) || 0,
    omDeg: node,
    wDeg: peri,
    M0Deg: m0,
    periodDays,
  })

  // big regular moons are tidally locked; small ones tumble
  const locked = diam > 400
  const spin = locked
    ? { x: 0, y: (2 * Math.PI) / (periodDays * 86400), z: 0 }
    : spinVec(1 + hash01(m.name, 9) * 40, hash01(m.name, 10) * 160)

  const atmo = atmosphereFor(m.name, rKm)
  planets.push({
    id: uniqueId(`m-${slug(m.parent)}-${slug(m.name)}`),
    name: m.name,
    kind: 'moon',
    preset: 'moon',
    seed,
    frequency: freq,
    scale,
    density: densityFor(mu, freq, scale, elements),
    isStatic: false,
    ...(atmo ? { atmosphere: atmo } : {}),
    parent: parentId,
    elements,
    scriptsOrbit: orb.orbit,
    center: orb.center,
    velocity: orb.velocity,
    spin,
  })
}

{
  const all = [...(Array.isArray(moonsData) ? moonsData : moonsData.moons || []), ...EXTRA_MOONS]
  const seen = new Set()
  for (const m of all) {
    if (!m || !m.name) continue
    const key = `${m.parent}|${m.name}`.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    addMoon(m)
  }
}

// ---------------------------------------------------------------------------
// asteroids & comets — scripted potatoes with real colors
// ---------------------------------------------------------------------------
function addSmall(o, kind) {
  const el = o.orbit
  if (!el || !Number.isFinite(el.e)) return
  const diam = Number(o.diameterKm) || (kind === 'comet' ? 6 : 3)
  const rKm = Math.max(diam / 2, 0.15)
  const { freq, scale } = sizeGrid(rKm, 2, kind === 'comet' ? 5 : diam >= 300 ? 25 : diam >= 60 ? 12 : 6)
  if (!Number.isFinite(freq)) return
  const seed = 2000 + Math.floor(hash01(o.name, 11) * 8999)
  // the shared dispatch (bodyTerrain.mjs): a potato with real colors by SBDX
  // class, lumpiness by size — the SAME terrainFor the stored high-res hexes
  // resolve through (color + lumpiness come off the `small` seed table)
  const elements = elementsFromHexFn(terrainFor({ name: o.name, kind, parent: null, seed, frequency: freq, scale, diameterKm: diam }, { small }), freq)
  const rho = kind === 'comet' ? 500 : diam > 150 ? 2500 : 1800
  const mu = ((4 / 3) * Math.PI * (rKm * 1000) ** 3 * rho) / M_SUN_KG
  const qAU = el.q != null && Number.isFinite(el.q) ? el.q : el.a * (1 - el.e)
  const periodDays =
    el.period && Number.isFinite(el.period) && el.a > 0 ? el.period : Math.sqrt(Math.abs(qAU / (1 - Math.min(el.e, 0.995))) ** 3) * 365.25
  const st = stateFrom({
    aAU: el.a > 0 ? el.a : null,
    qKm: qAU * AU_KM,
    e: el.e,
    iDeg: el.i || 0,
    omDeg: el.om || 0,
    wDeg: el.w || 0,
    tpJD: el.tp || null,
    M0Deg: el.tp ? undefined : el.ma || 0,
    epochJD: el.tp ? undefined : el.epoch,
    periodDays: Number.isFinite(periodDays) && periodDays > 0 ? periodDays : undefined,
  })
  const spin = spinVec(2 + hash01(o.name, 13) * 20, hash01(o.name, 14) * 170)
  planets.push({
    id: uniqueId(`${kind === 'comet' ? 'c' : 'a'}-${slug(o.name)}`),
    name: o.name,
    kind,
    preset: kind === 'comet' ? 'ice' : 'rocky',
    seed,
    frequency: freq,
    scale,
    diameterKm: diam,   // real diameter (km) — the hexcells importer's band input
    density: densityFor(mu, freq, scale, elements),
    isStatic: false,
    elements,
    scriptsOrbit: st.orbit,
    center: st.center,
    velocity: st.velocity,
    spin,
  })
}

const dwarfNames = new Set(Object.keys(DWARF_DOC_ID).map((n) => n.toLowerCase()))
for (const o of orbitsData.asteroids) {
  if (!o.orbit) continue
  if (dwarfNames.has(o.name.toLowerCase())) continue
  addSmall(o, 'asteroid')
}
for (const c of orbitsData.comets) {
  if (!c.orbit) continue
  addSmall(c, 'comet')
}

// ---------------------------------------------------------------------------
// write + summary
// ---------------------------------------------------------------------------
// physical scale: length of one world unit, in METERS (1 doc second = 1 real
// second) — turns the surface walker into a real human (SURFACE_REAL)
// One shuttle per major landable body, parked on its surface (nose up).
// The astronaut launches on foot at the first of these (docs/flight.txt).
const SHUTTLE_BODIES = [
  ['p-mercury', 'Mercury'],
  ['p-venus', 'Venus'],
  ['p-earth', 'Earth'],
  ['m-earth-moon', 'Moon'],
  ['p-mars', 'Mars'],
]
const world = {
  version: 1,
  name: 'Sol Real',
  gravity: G,
  scale: 1000 / KM2U,
  ...(HEX_METERS ? { hex_meters: HEX_METERS } : {}),
  planets,
  crafts: SHUTTLE_BODIES.filter(([id]) => planets.some((p) => p.id === id)).map(([id, name]) =>
    createCraft({
      id: `c-shuttle-${id.slice(2)}`,
      name: `${name} Shuttle`,
      kind: 'shuttle',
      realism: 'arcade',
      pose: { anchor: { bodyId: id, dir: [0, 0.7, 0.7], r: null } },
    })
  ),
}
writeFileSync(new URL(OUT_PATH, import.meta.url), JSON.stringify(world))

// Earth verification: the DEM integration must read like the real world
{
  const earth = planets.find((p) => p.name === 'Earth')
  let land = 0
  let sea = 0
  let maxKm = 0
  let minKm = 0
  for (const e of earth.elements) {
    if (e.h >= 0) land++
    else sea++
    const km = e.h / KM2U
    if (km > maxKm) maxKm = km
    if (km < minKm) minKm = km
  }
  const pct = (n) => ((n / earth.elements.length) * 100).toFixed(1)
  console.log(
    `  Earth: LAND ${land.toLocaleString('en-US')} (${pct(land)}%) / SEA ${sea.toLocaleString('en-US')} (${pct(sea)}%) — ` +
      `peak ${maxKm.toFixed(2)} km, deepest ${minKm.toFixed(2)} km ` +
      `(real: ~29% land, Everest 8.85 km, Mariana −11.0 km; the (mean±extreme)/2 hex blend reads a touch lower)`
  )
}

let storedAtoms = 0
let scripted = 0
const byKind = {}
for (const p of planets) {
  const cells = 10 * p.frequency * p.frequency + 2
  if (p.scriptsOrbit) scripted++
  else if (!p.generation) storedAtoms += cells
  const kind = p.id.startsWith('m-')
    ? 'moon'
    : p.id.startsWith('a-')
      ? 'asteroid'
      : p.id.startsWith('c-')
        ? 'comet'
        : p.preset === 'star'
          ? 'star'
          : 'planet/dwarf'
  byKind[kind] = (byKind[kind] || 0) + 1
}
console.log(
  `Wrote ${OUT_PATH.replace(/^\.\.\//, '')} — ${planets.length} bodies (${scripted} scripted), ` +
    `${storedAtoms.toLocaleString('en-US')} stored atoms, unit ≈ ${(1 / KM2U).toFixed(1)} km, M☉ = ${mSun.toExponential(3)}`
)
console.log('  ' + Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join('  '))
if (HEX_METERS) {
  const stored = planets.filter((p) => !p.generation)
  console.log(
    `  high-res: hex_meters=${HEX_METERS}m — all ${stored.length} stored (non-generated) bodies ` +
      `store their hexcells at that size (hexcells streamed in by scripts/import-hexcells.mjs after the import)`
  )
}
