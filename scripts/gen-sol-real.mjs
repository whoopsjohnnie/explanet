#!/usr/bin/env node
/**
 * gen-sol-real.mjs — build the REAL solar system world (public/sol-real.json).
 *
 *   • Sun + 8 planets + Pluto + 4 dwarf planets: fully simulated (cannon),
 *     osculating J2000 elements → state vectors, true masses (density trick),
 *     true sidereal spins.
 *   • Earth stores REAL terrain: coastlines from world-atlas 1:50m, mountain
 *     systems as corridors (Everest 8.849 km on the f203 grid), climate-belt
 *     colors. Mars (dichotomy, Olympus, Valles, Hellas), the Moon (maria),
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
import { readSeed } from './seed.mjs'
import { generateElements } from '../src/core/generators.js'
import { createCraft } from '../src/core/worldSchema.js'
import { planetVolume, frequencyForRadius, radiusForFrequency, MAX_FREQUENCY } from '../src/core/planetMath.js'
import { keplerState } from '../src/core/kepler.js'
import { PLANETS, DWARFS, RINGS, EXTRA_MOONS, MOON_PALETTES, NAMED_COLORS, TAXA } from './sol-real/features.js'
import { atmosphereFor } from '../src/core/atmospheres.js'
import {
  buildEarth,
  buildMars,
  buildMoon,
  buildMercury,
  buildVenus,
  buildMoonByPalette,
  buildPotato,
  landRings,
  rasterLandMask,
} from './sol-real/terrain.js'

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

/** deterministic hash in [0,1) from a string — stable node/peri/M0 spread */
function hash01(str, salt = 0) {
  let h = Math.imul(salt + 2654435761, 1) ^ str.length
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 1597334677)
  h ^= h >>> 15
  h = Math.imul(h, 2246822519)
  h ^= h >>> 13
  return ((h >>> 0) % 1000000) / 1000000
}

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
const landTopo = JSON.parse(readSeed(seedAt('./sol-real/data/land-50m.json'), 'world-atlas 1:50m land TopoJSON — fetch from S3 (DATA.md)'))

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

let earthMask = null
function buildRockyTerrain(name, rKm, seed) {
  if (name === 'Earth') {
    if (!earthMask) earthMask = rasterLandMask(landRings(landTopo), 0.2)
    return { freq: MAX_FREQUENCY, elements: buildEarth(MAX_FREQUENCY, earthMask, seed) }
  }
  const freq = gridFor(rKm)
  if (name === 'Mars') return { freq, elements: buildMars(freq, seed) }
  if (name === 'Moon') return { freq, elements: buildMoon(freq, seed) }
  if (name === 'Mercury') return { freq, elements: buildMercury(freq, seed) }
  if (name === 'Venus') return { freq, elements: buildVenus(freq, seed) }
  if (name === 'Pluto')
    return { freq, elements: buildMoonByPalette(freq, { c: '#cfc2b0', c2: '#8a7d6e', t: 'ice' }, seed, { iceCaps: true }) }
  throw new Error(`no terrain builder for ${name}`)
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
  let pal
  if (d.taxon === 'ice') pal = { c: '#d8d6d2', c2: '#8f9498', t: 'snow' }
  else if (d.taxon === 'red') pal = { c: '#c98a5e', c2: '#8f5a36', t: 'ice' }
  else pal = { c: '#a5a096', c2: '#706b62', t: 'rock', craters: 0.6 }
  const elements = buildMoonByPalette(freq, pal, d.seed, { polarCaps: d.taxon === 'ice' })
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
// ---------------------------------------------------------------------------
const MOON_TERRAIN = {
  Moon: { pal: null }, // built by the real-maria builder (special-cased below)
  Io: { pal: MOON_PALETTES.io },
  Europa: { pal: MOON_PALETTES.europa },
  Ganymede: { pal: MOON_PALETTES.ganymede },
  Callisto: { pal: MOON_PALETTES.callisto },
  Titan: { pal: MOON_PALETTES.titan },
  Rhea: { pal: MOON_PALETTES.rhea },
  Iapetus: { pal: MOON_PALETTES.iapetus, opts: { redPole: true } },
  Dione: { pal: MOON_PALETTES.dione },
  Tethys: { pal: MOON_PALETTES.tethys },
  Enceladus: { pal: MOON_PALETTES.enceladus },
  Mimas: { pal: MOON_PALETTES.mimas },
  Phoebe: { pal: MOON_PALETTES.phoebe, cap: 10 },
  Titania: { pal: MOON_PALETTES.uranusMoon },
  Oberon: { pal: MOON_PALETTES.uranusMoon },
  Umbriel: { pal: { c: '#7e8286', c2: '#565a5e', t: 'snow' } },
  Ariel: { pal: { c: '#c3c8cc', c2: '#8b9094', t: 'snow' } },
  Miranda: { pal: { c: '#a9aeb2', c2: '#767b7f', t: 'snow' }, cap: 12 },
  Triton: { pal: MOON_PALETTES.triton },
  Charon: { pal: MOON_PALETTES.charon },
}

const PARENT_FAMILY = {
  Jupiter: MOON_PALETTES.jupiterMoon,
  Saturn: MOON_PALETTES.saturnMoon,
  Uranus: MOON_PALETTES.uranusMoon,
  Neptune: MOON_PALETTES.neptuneMoon,
  Mars: MOON_PALETTES.marsMoon,
  Pluto: MOON_PALETTES.saturnMoon,
  Haumea: MOON_PALETTES.neptuneMoon,
  Orcus: MOON_PALETTES.saturnMoon,
  Quaoar: MOON_PALETTES.saturnMoon,
  Salacia: MOON_PALETTES.saturnMoon,
  Eris: MOON_PALETTES.neptuneMoon,
}

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
  let elements
  if (m.parent === 'Earth' && m.name === 'Moon') elements = buildMoon(freq, seed)
  else if (named) elements = buildMoonByPalette(freq, named.pal, seed, named.opts || { craters: 0.35 })
  else {
    const pal = PARENT_FAMILY[m.parent] || MOON_PALETTES.saturnMoon
    elements = buildPotato(freq, { seed, color: pal.c, lumpiness: 0.16, craters: 0.5, scale })
  }
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
function asteroidColor(name, sbClass, aAU) {
  const lower = name.toLowerCase()
  for (const [k, c] of Object.entries(NAMED_COLORS)) if (lower.includes(k)) return c
  if (sbClass) {
    if (/centaur|transneptun|scattered|detached/i.test(sbClass)) return hash01(name, 3) < 0.5 ? TAXA.D : TAXA.P
    if (/trojan/i.test(sbClass)) return TAXA.D
    if (/apollo|amor|aten|arjuna|phocaea/i.test(sbClass)) return hash01(name, 4) < 0.7 ? TAXA.S : TAXA.C
  }
  if (aAU != null && aAU > 3.3) return TAXA.C
  return hash01(name, 5) < 0.7 ? TAXA.C : TAXA.S
}

function addSmall(o, kind) {
  const el = o.orbit
  if (!el || !Number.isFinite(el.e)) return
  const diam = Number(o.diameterKm) || (kind === 'comet' ? 6 : 3)
  const rKm = Math.max(diam / 2, 0.15)
  const { freq, scale } = sizeGrid(rKm, 2, kind === 'comet' ? 5 : diam >= 300 ? 25 : diam >= 60 ? 12 : 6)
  if (!Number.isFinite(freq)) return
  const seed = 2000 + Math.floor(hash01(o.name, 11) * 8999)
  const color = kind === 'comet' ? '#3f3a36' : asteroidColor(o.name, o.sbClass, el.a)
  const elements = buildPotato(freq, {
    seed,
    color,
    scale,
    lumpiness: kind === 'comet' ? 0.2 : diam >= 300 ? 0.07 : 0.15,
    craters: kind === 'comet' ? 0.25 : diam >= 200 ? 0.7 : 0.4,
    elongate: hash01(o.name, 12) < 0.25 ? 0.35 : 0,
  })
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
writeFileSync(new URL('../public/sol-real.json', import.meta.url), JSON.stringify(world))

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
  `Wrote public/sol-real.json — ${planets.length} bodies (${scripted} scripted), ` +
    `${storedAtoms.toLocaleString('en-US')} stored atoms, unit ≈ ${(1 / KM2U).toFixed(1)} km, M☉ = ${mSun.toExponential(3)}`
)
console.log('  ' + Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join('  '))
