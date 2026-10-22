#!/usr/bin/env node
/**
 * verify-sol-real.mjs — numerical audit of the Sol Real world document.
 *
 * No browser here, so the physics has to be checked on paper:
 *  1. every scripted body has a valid ellipse (prepareOrbit) and CLOSES:
 *     p(2π/n) ≡ p(0) to solver precision;
 *  2. Kepler's third law against the ENGINE's own gravity: n²·a³ must equal
 *     G·M_parent — the unit system only works if real periods + real sma,
 *     scaled by KM2U, reproduce the engine masses (this catches anchor drift
 *     in gen-sol-real's mSun / density trick);
 *  3. N-body planets carry the right orbital energy: the semimajor axis
 *     recomputed from (r, v, μ☉) must match the real one;
 *  4. geometry spot checks: Everest, Saturn's rings, atmospheres, body census.
 *
 *   node scripts/verify-sol-real.mjs [path/to/sol-real.json]
 */

import fs from 'node:fs'
import { keplerState, prepareOrbit } from '../src/core/kepler.js'
import { planetVolume, radiusForFrequency } from '../src/core/planetMath.js'

const PATH = process.argv[2] || 'public/sol-real.json'
const w = JSON.parse(fs.readFileSync(PATH, 'utf8'))
const G = w.gravity ?? 40
const bodies = w.planets
const byName = new Map(bodies.map((p) => [p.name, p]))
const byId = new Map(bodies.map((p) => [p.id, p]))

// anchors shared with gen-sol-real.mjs
const KM2U = radiusForFrequency(203) / 6371.009 // engine units per km
const U2KM = 1 / KM2U
const AU_KM = 1.495978707e8
const DAY_S = 86400

let fails = 0
let checks = 0
const problems = []
function check(ok, msg) {
  checks++
  if (!ok) {
    fails++
    if (problems.length < 25) problems.push(msg)
  }
}

// engine mass of a body: density × volume (stub-aware: the generation
// descriptor carries avgHeight after serializeWorld stripped stubAvgHeight)
function engineMass(p) {
  const gen = p.generation
  return p.density * planetVolume({
    frequency: p.frequency,
    scale: p.scale,
    elements: p.elements || null,
    stubAvgHeight: gen?.avgHeight ?? p.stubAvgHeight ?? 0,
  })
}
const mSun = engineMass(byName.get('Sun'))
const muOf = (p) => G * engineMass(p)

// ---------------------------------------------------------------------------
// 1+2. scripted bodies: closure + third law (moon ellipses are PARENT-local)
// ---------------------------------------------------------------------------
let scripted = 0
const worst = { close: 0, closeName: '', law: 0, lawName: '' }
for (const p of bodies) {
  const so = p.scriptsOrbit
  if (!so) continue
  scripted++
  const el = prepareOrbit(so)
  check(el, `${p.name}: scriptsOrbit rejected by prepareOrbit`)
  if (!el) continue

  const T = (2 * Math.PI) / el.n
  const a0 = keplerState(el, 0)
  const aT = keplerState(el, T)
  const drift = Math.hypot(...a0.pos.map((v, i) => v - aT.pos[i]))
  const rel = drift / el.a
  if (rel > worst.close) {
    worst.close = rel
    worst.closeName = p.name
  }
  check(rel < 1e-6, `${p.name}: orbit fails to close (drift ${rel.toExponential(2)}·a)`)

  // Kepler III: n² a³ = G·M_parent (parent is a doc id; default Sun)
  const parent = p.parent ? byId.get(p.parent) ?? byName.get(p.parent) : byName.get('Sun')
  check(parent, `${p.name}: parent "${p.parent}" not in world`)
  if (!parent) continue
  const lhs = el.n * el.n * el.a ** 3
  const ratio = lhs / muOf(parent)
  if (Math.abs(ratio - 1) > Math.abs(worst.law)) {
    worst.law = ratio - 1
    worst.lawName = `${p.name} (${p.kind ?? '?'}, around ${parent.name})`
  }
  // Weak-gravity systems have loose scraped data: Pluto's small moons are
  // mean-motion resonant, and Jupiter/Saturn irregulars carry 2–4 % slop
  // between their tabulated period and sma.
  const tol = parent.name === 'Pluto' ? 0.25 : p.parent && p.parent !== 'Sun' ? 0.05 : 0.02
  check(
    Math.abs(ratio - 1) < tol,
    `${p.name}: n²a³/GM = ${ratio.toFixed(4)} (around ${parent.name})`
  )

  // a bound moon must live inside its parent's Hill sphere (irregulars
  // genuinely reach ~0.5·rH — this catches scale typos, not dynamics)
  if (p.parent && p.parent !== 'Sun') {
    const hill =
      Math.hypot(parent.center.x, parent.center.y, parent.center.z) *
      Math.cbrt(engineMass(parent) / (3 * mSun))
    check(
      el.a < 0.9 * hill,
      `${p.name}: a=${(el.a * U2KM).toExponential(2)} km beyond ${(parent.name)} ` +
        `Hill sphere (${(hill * U2KM).toExponential(2)} km)`
    )
  }
}

// ---------------------------------------------------------------------------
// 3. N-body planets: specific orbital energy ⇒ real semimajor axis
// ---------------------------------------------------------------------------
const REAL_A_AU = {
  Mercury: 0.387, Venus: 0.723, Earth: 1.0, Mars: 1.524, Jupiter: 5.203,
  Saturn: 9.537, Uranus: 19.191, Neptune: 30.069, Pluto: 39.48,
  Ceres: 2.766, Eris: 67.86, Haumea: 43.13, Makemake: 45.79,
}
const muSun = G * mSun
for (const [name, aAU] of Object.entries(REAL_A_AU)) {
  const p = byName.get(name)
  if (!p) {
    check(false, `${name}: missing from world`)
    continue
  }
  check(!p.scriptsOrbit, `${name}: should be N-body but is scripted`)
  const c = p.center
  const v = p.velocity
  const r = Math.hypot(c.x, c.y, c.z)
  const speed2 = v.x * v.x + v.y * v.y + v.z * v.z
  const a = 1 / (2 / r - speed2 / muSun) // vis-viva
  const aAUeng = a * U2KM / AU_KM
  check(
    Math.abs(aAUeng / aAU - 1) < 0.05,
    `${name}: orbital a = ${aAUeng.toFixed(3)} AU, real ${aAU} AU`
  )
}

// ---------------------------------------------------------------------------
// 4. geometry / census spot checks
// ---------------------------------------------------------------------------
const census = {}
for (const p of bodies) census[p.kind || '(none)'] = (census[p.kind || '(none)'] || 0) + 1
check(census.star === 1, `census: ${census.star} stars`)
check(census.planet === 8, `census: ${census.planet} planets`)
check((census.dwarf ?? 0) >= 5, `census: ${census.dwarf} dwarfs`)
check((census.moon ?? 0) > 450, `census: ${census.moon} moons`)

const earth = byName.get('Earth')
let maxH = 0
for (const el of earth.elements) maxH = Math.max(maxH, el.h)
const everestKm = maxH * 6371.009 / radiusForFrequency(earth.frequency) / (earth.scale || 1)
check(Math.abs(everestKm - 8.849) < 0.1, `Everest: ${everestKm.toFixed(2)} km`)

const saturn = byName.get('Saturn')
check(saturn.rings && saturn.rings.bands.length >= 4, 'Saturn rings missing/thin')

// atmospheres: the catalog must ride along — Earth/Venus/Mars/giants + Titan,
// Triton, Pluto have air; the Moon must NOT. Heights are radius multiples,
// so Earth's top should land near 600 km and scaleHeight near 8.5 km.
const ATMOSPHERED = ['Earth', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Titan', 'Triton', 'Pluto']
for (const name of ATMOSPHERED) {
  const a = byName.get(name)?.atmosphere
  check(a && a.top > 0 && a.scaleHeight > 0 && a.scaleHeight < a.top, `${name}: atmosphere missing/malformed`)
}
check(!byName.get('Moon').atmosphere, 'Moon must be airless')
const earthAtmo = earth.atmosphere
if (earthAtmo) {
  check(Math.abs(earthAtmo.top * 6371.009 - 600) < 60, `Earth atmosphere top ${(earthAtmo.top * 6371.009).toFixed(0)} km ≠ ~600 km`)
  check(Math.abs(earthAtmo.scaleHeight * 6371.009 - 8.5) < 1, `Earth scale height ${(earthAtmo.scaleHeight * 6371.009).toFixed(1)} km ≠ ~8.5 km`)
}
const withAtmo = bodies.filter((p) => p.atmosphere)

// ---------------------------------------------------------------------------
console.log(`verify-sol-real: ${PATH}`)
console.log(`  ${bodies.length} bodies (${scripted} scripted) — kinds:`, JSON.stringify(census))
console.log(`  m☉ = ${mSun.toExponential(4)}, KM2U = ${KM2U.toFixed(6)}`)
console.log(`  closure: worst ${worst.close.toExponential(2)}·a (${worst.closeName})`)
console.log(`  Kepler III: worst |n²a³/GM − 1| = ${Math.abs(worst.law).toExponential(2)} (${worst.lawName})`)
console.log(`  Everest ${everestKm.toFixed(2)} km, Saturn rings ${saturn.rings?.bands?.length} bands, atmospheres ${withAtmo.length} (${withAtmo.map((p) => p.name).join(', ')})`)
if (problems.length) {
  console.log(`\nFAIL (${fails}/${checks}):`)
  for (const p of problems) console.log('  ✗ ' + p)
  process.exit(1)
}
console.log(`\nOK — ${checks} checks passed`)
