#!/usr/bin/env node
/**
 * score-kepler.mjs — s0 scoring: Keplerian elements from 3D Cartesian states.
 *
 * core/kepler.js grew an inverse map (cartesianToElements): state vectors in
 * engine units → the document `scripts` descriptor {a,e,inc,node,peri,n,m0}.
 * This script scores it on three suites, from cheap-and-total to real:
 *
 *   A  simulation round-trip — every scripted body in public/sol-real.json
 *      (moons, ~30k asteroids, 77 comets): propagate its own descriptor with
 *      the engine's keplerState at three epochs, refit from (pos, vel) alone,
 *      and demand the descriptor back + exact position recovery. mu is taken
 *      per-descriptor as n²·a³, which is the model keplerState actually
 *      integrates, so this suite scores the inverse machinery (branches,
 *      retrograde/degenerate cases, phase bookkeeping) to solver precision.
 *   B  real ephemeris — JPL Horizons VECTORS (km, km/s, J2000 ecliptic) for
 *      real comets and asteroids at document t = 0, fitted, then checked
 *      against Horizons' own osculating ELEMENTS from the same epoch and
 *      against round-tripping the vectors. Fitted descriptors are written to
 *      data/kepler-fitted.json in document form. Skips (not fails) offline;
 *      --offline forces the skip.
 *   C  the N-body planets — their J2000 center+velocity in the document,
 *      fitted with the physical MU_SUN and compared to the published
 *      J2000 elements gen-sol-real placed them from (an end-to-end check:
 *      published elements → forward Kepler → state → fit → elements).
 *
 * Run: node scripts/score-kepler.mjs [--offline]   (or scripts/run_s0.sh)
 * Exit 0 only if every executed check passes.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { keplerState, cartesianToElements, prepareOrbit } from '../src/core/kepler.js'
import { radiusForFrequency, MAX_FREQUENCY } from '../src/core/planetMath.js'

// ---------------------------------------------------------------------------
// anchors (identical to gen-sol-real: the document's unit system)
// ---------------------------------------------------------------------------
const TWO_PI = Math.PI * 2
const DEG = Math.PI / 180
const EARTH_YEAR = 365.25 * 86400
const EARTH_R_KM = 6371.009
const KM2U = radiusForFrequency(MAX_FREQUENCY) / EARTH_R_KM // ≈ 0.028435 u/km
const AU_KM = 149_597_870.7
const AU = AU_KM * KM2U
const JD_J2000 = 2451545.0
const MU_SUN = (4 * Math.PI * Math.PI * AU * AU * AU) / (EARTH_YEAR * EARTH_YEAR)

// published J2000 heliocentric elements the N-body planets were placed from
// (same table as gen-sol-real's ORBITS_J2000, kept here independently)
const PLANET_ELEMENTS = {
  Mercury: { aAU: 0.387098, e: 0.20563, iDeg: 7.005, omDeg: 48.331, wDeg: 29.124, M0Deg: 174.796 },
  Venus: { aAU: 0.723332, e: 0.006772, iDeg: 3.395, omDeg: 76.68, wDeg: 54.884, M0Deg: 50.115 },
  Earth: { aAU: 1.0, e: 0.016709, iDeg: 0.0, omDeg: 0, wDeg: 114.208, M0Deg: 358.617 },
  Mars: { aAU: 1.523679, e: 0.0934, iDeg: 1.85, omDeg: 49.559, wDeg: 286.502, M0Deg: 19.395 },
  Jupiter: { aAU: 5.202887, e: 0.048386, iDeg: 2.056, omDeg: 100.474, wDeg: 274.2, M0Deg: 20.02 },
  Saturn: { aAU: 9.536676, e: 0.053862, iDeg: 2.486, omDeg: 113.665, wDeg: 339.392, M0Deg: 317.347 },
  Uranus: { aAU: 19.189165, e: 0.047257, iDeg: 0.773, omDeg: 74.006, wDeg: 96.999, M0Deg: 142.239 },
  Neptune: { aAU: 30.069923, e: 0.008606, iDeg: 1.77, omDeg: 131.784, wDeg: 276.34, M0Deg: 256.228 },
}

// Suite B roster: JPL Horizons small-body ids at J2000. Halley's IOBJ
// (90000001) is verified against the DASTCOM header; other comet ids are not
// 90000000+n and the designation search is broken on this instance, so the
// real-comet coverage beyond Halley stays with suite A (77 catalog comets,
// real elements). Asteroids live at 2000000 + catalogue number (Bennu →
// 2101955). label must appear in the response header (or the id in
// parentheses) — this resolver fuzzy-matches unknown ids silently (a bare
// '1P' returns a pluton), so identity is asserted before anything is scored.
const REAL_BODIES = [
  { cmd: '90000001', label: '1P/Halley', kind: 'comet' },
  { cmd: '2000001', label: '1 Ceres', kind: 'asteroid' },
  { cmd: '2000002', label: '2 Pallas', kind: 'asteroid' },
  { cmd: '2000004', label: '4 Vesta', kind: 'asteroid' },
  { cmd: '2000253', label: '253 Mathilde', kind: 'asteroid' },
  { cmd: '2000433', label: '433 Eros', kind: 'asteroid' },
  { cmd: '2001566', label: '1566 Icarus', kind: 'asteroid' },
  { cmd: '2065803', label: '65803 Didymos', kind: 'asteroid' },
  { cmd: '2099942', label: '99942 Apophis', kind: 'asteroid' },
  { cmd: '2101955', label: '101955 Bennu', kind: 'asteroid' },
]

// ---------------------------------------------------------------------------
// scoring harness
// ---------------------------------------------------------------------------
let checks = 0
let failed = 0
const failures = []
function check(label, ok, detail) {
  checks++
  if (!ok) {
    failed++
    if (failures.length < 25) failures.push(`${label}: ${detail}`)
  }
}
const angDiff = (a, b) => {
  let d = (a - b) % TWO_PI
  if (d > Math.PI) d -= TWO_PI
  if (d < -Math.PI) d += TWO_PI
  return Math.abs(d)
}

/**
 * Score a refit against the descriptor it should recover. `t` is the sample
 * time. Only identifiable quantities are compared: degenerate documents (the
 * catalog is full of inc=0 Saturnian moons and e=0 circulars) split the orbit
 * into angles arbitrarily, while cartesianToElements returns the canonical
 * split — same orbit, different coordinates. So: node only when the plane is
 * defined (inc > 0), periapsis via ϖ = node+peri (e > 0), and phase via the
 * mean longitude λ = m0+node+peri at time t (always defined; reduces to M
 * for non-degenerate orbits once ϖ and node match).
 */
function scoreRefit(label, el, fit, t) {
  if (!fit) {
    check(label, false, 'fit returned null')
    return
  }
  if (!prepareOrbit(fit)) {
    check(label, false, 'fit failed prepareOrbit validation')
    return
  }
  check(`${label} a`, Math.abs(fit.a / el.a - 1) < 1e-9, `a ${fit.a} vs ${el.a}`)
  check(`${label} e`, Math.abs(fit.e - el.e) < 1e-9, `e ${fit.e} vs ${el.e}`)
  check(`${label} n`, Math.abs(fit.n / el.n - 1) < 1e-7, `n ${fit.n} vs ${el.n}`)
  check(`${label} inc`, Math.abs(fit.inc - el.inc) < 1e-7, `inc ${fit.inc / DEG} vs ${el.inc / DEG}`)
  const inclined = el.inc > 1e-6 && Math.PI / 2 - Math.abs(el.inc - Math.PI / 2) > 1e-6
  if (inclined) {
    check(`${label} node`, angDiff(fit.node, el.node) < 1e-7, `node ${fit.node / DEG} vs ${el.node / DEG}`)
    if (el.e > 1e-4) {
      check(`${label} peri`, angDiff(fit.peri, el.peri) < 1e-7, `peri ${fit.peri / DEG} vs ${el.peri / DEG}`)
    }
  }
  if (el.e > 1e-4) {
    check(`${label} varpi`, angDiff(fit.node + fit.peri, el.node + el.peri) < 1e-7, `ϖ ${(fit.node + fit.peri) / DEG} vs ${(el.node + el.peri) / DEG}`)
  }
  const dL = angDiff(fit.m0 + fit.n * t + fit.node + fit.peri, el.m0 + el.n * t + el.node + el.peri)
  check(`${label} lambda(t)`, dL < 1e-6, `λ ${dL} rad off`)
  const st0 = keplerState(el, t)
  const st1 = keplerState(prepareOrbit(fit), t)
  const pos = Math.hypot(st1.pos[0] - st0.pos[0], st1.pos[1] - st0.pos[1], st1.pos[2] - st0.pos[2])
  const vel = Math.hypot(st1.vel[0] - st0.vel[0], st1.vel[1] - st0.vel[1], st1.vel[2] - st0.vel[2])
  check(`${label} pos`, pos < 1e-6 * Math.max(1, el.a), `Δr ${pos.toExponential(2)} u`)
  check(`${label} vel`, vel < 1e-6 * Math.max(el.n, 1e-12) * el.a, `Δv ${vel.toExponential(2)} u/s`)
}

// ===========================================================================
// Suite A — simulation round-trip over every scripted body of the document
// ===========================================================================
function suiteSimulation() {
  const path = new URL('../public/sol-real.json', import.meta.url)
  if (!existsSync(path)) {
    console.log('A  SIM ROUND-TRIP ......... SKIP (no public/sol-real.json — run gen-sol-real)')
    return null
  }
  const world = JSON.parse(readFileSync(path, 'utf8'))
  let done = 0
  for (const p of world.planets) {
    const el = p.scriptsOrbit
    if (!el) continue
    const ok = prepareOrbit(el)
    if (!ok) continue
    // the descriptor's own mu: keplerState integrates exactly this model, so
    // the inverse must recover it to solver precision regardless of what
    // gravity the catalog period came from
    const mu = el.n * el.n * el.a * el.a * el.a
    const P = TWO_PI / el.n
    for (const [i, frac] of [0, 1 / 7, 3.13].entries()) {
      const t = frac * P
      const st = keplerState(el, t)
      const fit = cartesianToElements(st.pos, st.vel, mu, t)
      scoreRefit(`A ${p.name}@${i}`, ok, fit, t)
    }
    done++
  }
  console.log(`A  SIM ROUND-TRIP ......... ${done} scripted bodies × 3 epochs`)
  return world
}

// ===========================================================================
// Suite C — N-body planet states vs published J2000 elements
// ===========================================================================
function suitePlanets(world) {
  if (!world) {
    console.log('C  PLANET J2000 ........... SKIP (no document)')
    return
  }
  let done = 0
  for (const [name, el] of Object.entries(PLANET_ELEMENTS)) {
    const p = world.planets.find((q) => q.name === name)
    if (!p || !p.center || !p.velocity) {
      check(`C ${name} present`, false, 'planet missing from document')
      continue
    }
    const pos = [p.center.x, p.center.y, p.center.z]
    const vel = [p.velocity.x, p.velocity.y, p.velocity.z]
    const fit = cartesianToElements(pos, vel, MU_SUN, 0) // physical mu: real check
    if (!fit) {
      check(`C ${name} fit`, false, 'null')
      continue
    }
    const aU = el.aAU * AU
    check(`C ${name} a`, Math.abs(fit.a / aU - 1) < 1e-9, `${fit.a / AU} AU vs ${el.aAU}`)
    check(`C ${name} e`, Math.abs(fit.e - el.e) < 1e-9, `${fit.e} vs ${el.e}`)
    check(`C ${name} inc`, Math.abs(fit.inc / DEG - el.iDeg) < 1e-6, `${fit.inc / DEG}° vs ${el.iDeg}°`)
    if (el.iDeg > 0.1) {
      check(`C ${name} om`, angDiff(fit.node, el.omDeg * DEG) < 1e-6, '')
      check(`C ${name} M0`, angDiff(fit.m0, el.M0Deg * DEG) < 1e-6, '')
    }
    if (!(el.iDeg < 0.1)) check(`C ${name} w`, angDiff(fit.peri, el.wDeg * DEG) < 1e-6, '')
    done++
  }
  console.log(`C  PLANET J2000 ........... ${done} planets, physical MU_SUN vs published elements`)
}

// ===========================================================================
// Suite B — real state vectors from JPL Horizons at document epoch J2000
// ===========================================================================
const HORIZONS = 'https://ssd.jpl.nasa.gov/api/horizons.api'
const ANGTOL = 0.01 * DEG // elements cross-check tolerance (angles)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function horizons(params) {
  const q = new URLSearchParams({ format: 'text', OBJ_DATA: 'NO', MAKE_EPHEM: 'YES', ...params })
  const res = await fetch(`${HORIZONS}?${q}`, { signal: AbortSignal.timeout(60_000) })
  const text = await res.text()
  if (!res.ok) throw new Error(`Horizons ${res.status}: ${text.slice(0, 120)}`)
  return text
}
function soe(text) {
  const m = text.match(/\$\$SOE\r?\n([\s\S]*?)\$\$EOE/)
  return m ? m[1] : null
}
// lookbehind keeps "VX =" from matching X, "MA =" from matching A, etc.
const numFrom = (blk, key) => {
  const m = blk.match(new RegExp(`(?<![A-Z])${key}\\s*=\\s*([-+\\d.Ee]+)`))
  if (!m) throw new Error(`field ${key} not parsed`)
  return parseFloat(m[1])
}

async function suiteReal() {
  if (process.argv.includes('--offline')) {
    console.log('B  HORIZONS REAL .......... SKIP (--offline)')
    return
  }
  const fitted = []
  let done = 0
  for (const rb of REAL_BODIES) {
    if (done > 0) await sleep(1200) // be polite: the API throttles bursts
    const common = {
      COMMAND: `'${rb.cmd}'`,
      CENTER: "'500@10'",
      // J2000.0 = document t = 0; Horizons insists start < stop, so a 1 s window
      START_TIME: "'2000-01-01 12:00:00'",
      STOP_TIME: "'2000-01-01 12:00:01'",
      STEP_SIZE: '1 d',
      OUT_UNITS: 'KM-S',
      REF_PLANE: 'ECLIPTIC',
    }
    try {
      // the API flakes intermittently (empty 200s), and its resolver fuzzy-
      // matches unknown ids — retry, and refuse anything not labeled as the
      // requested body (a bare '1P' silently returns a pluton here)
      let vecTxt, elTxt, vecBlk, elBlk
      for (let attempt = 1; ; attempt++) {
        vecTxt = await horizons({ ...common, EPHEM_TYPE: 'VECTORS' })
        elTxt = await horizons({ ...common, EPHEM_TYPE: 'ELEMENTS' })
        vecBlk = soe(vecTxt)
        elBlk = soe(elTxt)
        if (vecBlk && elBlk) break
        if (attempt >= 4) throw new Error('no SOE block in 4 tries')
        await sleep(4000)
      }
      const identified = (t) => t.includes(rb.label) || t.includes(`(${rb.cmd})`)
      if (!identified(vecTxt) || !identified(elTxt)) {
        throw new Error(`resolver mismatch: '${rb.label}' not identified in response`)
      }
      // Horizons gives heliospheric ECLIPTIC vectors; the engine frame is
      // (x=X, y=ecliptic north, z=−Y) — convert, then fit, then everything
      // downstream (keplerState, document center/velocity) speaks engine.
      const toEngine = (keys) => {
        const [x, y, z] = keys.map((k) => numFrom(vecBlk, k) * KM2U)
        return [x, z, -y]
      }
      const pos = toEngine(['X', 'Y', 'Z'])
      const vel = toEngine(['VX', 'VY', 'VZ'])
      const fit = cartesianToElements(pos, vel, MU_SUN, 0)
      if (!fit) throw new Error('fit null (unbound or e ≥ 0.999?)')
      if (!prepareOrbit(fit)) throw new Error('fit fails prepareOrbit')

      // real-ephemeris cross-check: my fit vs Horizons' own osculating elements
      const gt = { a: numFrom(elBlk, 'A'), e: numFrom(elBlk, 'EC'), i: numFrom(elBlk, 'IN'), om: numFrom(elBlk, 'OM'), w: numFrom(elBlk, 'W'), ma: numFrom(elBlk, 'MA') }
      const aGT = gt.a * KM2U
      // 2e-4, not tighter: some small-body SPKs merge an older ephemeris
      // (Bennu: DE424) than the vectors' DE441 — vectors-vs-elements noise
      // for those rides at ~5e-5 in a. The position/velocity round-trip
      // below stays at solver precision; that is the fitter's own test.
      check(`B ${rb.label} a`, Math.abs(fit.a / aGT - 1) < 2e-4, `${fit.a / AU} AU vs ${gt.a / AU_KM}`)
      check(`B ${rb.label} e`, Math.abs(fit.e - gt.e) < 5e-5, `${fit.e} vs ${gt.e}`)
      check(`B ${rb.label} inc`, Math.abs(fit.inc / DEG - gt.i) < 0.01, `${fit.inc / DEG}° vs ${gt.i}°`)
      if (gt.i > 1 && gt.i < 179) {
        check(`B ${rb.label} om`, angDiff(fit.node, gt.om * DEG) < ANGTOL, `${fit.node / DEG} vs ${gt.om}`)
        check(`B ${rb.label} w`, angDiff(fit.peri, gt.w * DEG) < ANGTOL, `${fit.peri / DEG} vs ${gt.w}`)
        check(`B ${rb.label} MA`, angDiff(fit.m0, gt.ma * DEG) < ANGTOL, `${fit.m0 / DEG} vs ${gt.ma}`)
      }
      // round trip: the fitted descriptor must reproduce the fetched vectors
      const st = keplerState(prepareOrbit(fit), 0)
      const dr = Math.hypot(st.pos[0] - pos[0], st.pos[1] - pos[1], st.pos[2] - pos[2])
      const vmax = Math.max(...vel.map(Math.abs))
      const dv = Math.hypot(st.vel[0] - vel[0], st.vel[1] - vel[1], st.vel[2] - vel[2])
      check(`B ${rb.label} pos`, dr < 1e-4, `Δr ${dr.toExponential(2)} u (~${((dr / KM2U) * 1000).toExponential(2)} m)`)
      check(`B ${rb.label} vel`, dv / vmax < 1e-6, `Δv ${dv.toExponential(2)} u/s`)
      fitted.push({
        name: rb.label,
        kind: rb.kind,
        source: 'horizons VECTORS @ J2000.0 (heliospheric ecliptic, KM-S)',
        scriptsOrbit: fit,
        center: { x: pos[0], y: pos[1], z: pos[2] },
        velocity: { x: vel[0], y: vel[1], z: vel[2] },
      })
      done++
    } catch (err) {
      console.log(`   ! ${rb.label}: ${err.message} — skipped`)
    }
  }
  if (done > 0) {
    const out = new URL('../data/kepler-fitted.json', import.meta.url)
    mkdirSync(new URL('../data', import.meta.url), { recursive: true })
    writeFileSync(
      out,
      JSON.stringify(
        {
          generatedBy: 'scripts/score-kepler.mjs',
          epochJD: JD_J2000,
          note: 'fitted with core/kepler.js cartesianToElements from real Horizons state vectors; scriptsOrbit is document format — drop these bodies into a world as scripted test particles',
          bodies: fitted,
        },
        null,
        2
      )
    )
  }
  console.log(`B  HORIZONS REAL .......... ${done}/${REAL_BODIES.length} bodies fitted + cross-checked, → data/kepler-fitted.json`)
}

// ===========================================================================
const t0 = Date.now()
console.log('score-kepler — Keplerian fit from Cartesian states')
const world = suiteSimulation()
await suiteReal()
suitePlanets(world)
console.log('—'.repeat(64))
console.log(`${checks.toLocaleString('en-US')} checks, ${failed} failed — ${failed ? 'FAIL' : 'PASS'}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
if (failures.length) console.log(failures.join('\n'))
process.exit(failed ? 1 : 0)
