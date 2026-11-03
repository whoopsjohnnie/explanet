/**
 * test-surface.mjs — headless tests for the surface walker (core/surface.js):
 * Voronoi cell lookup, gravity law, landing fall, surface-bound walking,
 * wall blocking, jumping, and integrator sanity.
 * Run: node scripts/test-surface.mjs
 */

import { makeStarterWorld } from '../src/core/starter.js'
import { generateElements } from '../src/core/generators.js'
import { getHexSphere, dotCenter, hasNeighbor, cellCountForFrequency } from '../src/core/hexsphere.js'
import { planetMass, radiusForFrequency, MAX_FREQUENCY } from '../src/core/planetMath.js'
import {
  SURFACE,
  surfaceGravity,
  makeSurface,
  createWalker,
  stepWalker,
  cellAtDirection,
  intersectHeightfield,
} from '../src/core/surface.js'

let failures = 0
const check = (name, cond) => {
  console.log(`${cond ? '✓' : '✗'} ${name}`)
  if (!cond) failures++
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const centerOf = (hex, i) => [hex.centers[i * 3], hex.centers[i * 3 + 1], hex.centers[i * 3 + 2]]

function mulberry32(seed) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const randDir = (rand) => {
  const z = rand() * 2 - 1
  const a = rand() * Math.PI * 2
  const r = Math.sqrt(Math.max(0, 1 - z * z))
  return [r * Math.cos(a), z, r * Math.sin(a)]
}

const world = makeStarterWorld()
const G = world.gravity
const landable = world.planets.find((p) => p.preset !== 'star')

// ---------------------------------------------------------------------------
// cellAtDirection == brute-force nearest center (random dirs, random hints)
// ---------------------------------------------------------------------------
{
  let ok = true
  let tested = 0
  const rand = mulberry32(7)
  for (const freq of [2, 5, 8]) {
    const hex = getHexSphere(freq)
    const planet = { frequency: freq, elements: generateElements('earthlike', freq, 9) }
    makeSurface(planet) // exercise the builder
    for (let t = 0; t < 2000; t++) {
      const d = randDir(rand)
      const hint = Math.floor(rand() * hex.cellCount)
      let best = 0
      let bd = -2
      for (let i = 0; i < hex.cellCount; i++) {
        const dd = dotCenter(hex, i, d)
        if (dd > bd) {
          bd = dd
          best = i
        }
      }
      const got = cellAtDirection(hex, d, hint)
      // ties only occur at exact boundaries (measure zero) — accept equal-dot
      if (got !== best && dotCenter(hex, got, d) < bd - 1e-12) ok = false
      tested++
    }
  }
  check(`cellAtDirection matches brute-force nearest center (${tested} random dirs)`, ok)
}

// heightAt at a cell's own center direction returns that cell's height
{
  const planet = landable
  const hex = getHexSphere(planet.frequency)
  const surface = makeSurface(planet)
  let ok = true
  for (let i = 0; i < hex.cellCount; i++) {
    const q = surface.heightAt(centerOf(hex, i), -1)
    if (q.cell !== i || Math.abs(q.h - (planet.elements[i].h || 0)) > 1e-12) ok = false
  }
  check('surface height at cell centers matches element heights', ok)
}

// gravity law: matches the softened orbital law, scaled; clamped at extremes
{
  const expected = clamp(((40 * 100) / (10 * 10 + 4)) * SURFACE.gravityScale, SURFACE.minGravity, SURFACE.maxGravity)
  const ok = Math.abs(surfaceGravity(40, 100, 10) - expected) < 1e-12
  const tiny = surfaceGravity(40, 1e-6, 1000) >= SURFACE.minGravity - 1e-12
  const huge = surfaceGravity(1e9, 1e9, 1) <= SURFACE.maxGravity + 1e-12
  check('surfaceGravity follows G·m/(r²+ε²) with feel scale + clamps', ok && tiny && huge)
}

// ---------------------------------------------------------------------------
// landing: spawn above the surface → fall → grounded, never below surface
// ---------------------------------------------------------------------------
{
  const surface = makeSurface(landable)
  const w = createWalker(surface, [0, 1, 0])
  const mass = planetMass(landable)
  let below = false
  let steps = 0
  while (!w.grounded && steps < 60 * 15) {
    stepWalker(surface, w, surfaceGravity(G, mass, w.r), null, {}, 1 / 60)
    const g = surface.heightAt(w.dir, w.cell)
    if (w.r < g.radius - 1e-9) below = true
    steps++
  }
  const g = surface.heightAt(w.dir, w.cell)
  check(
    'walker spawns airborne and falls onto the surface',
    w.landedOnce && w.grounded && !below && Math.abs(w.r - g.radius) < 1e-9
  )
  check('landing happened within a few seconds', steps > 15 && steps < 60 * 10)
}

// ---------------------------------------------------------------------------
// walking: stays surface-bound, never inside the planet, covers ground
// (on the flat gas-giant relief so walking is never wall-blocked)
// ---------------------------------------------------------------------------
{
  const planet = { frequency: 4, elements: generateElements('gas', 4, 3) }
  const surface = makeSurface(planet)
  const mass = 20
  const w = createWalker(surface, [0.3, 0.9, 0.1])
  let guard = 0
  while (!w.grounded && guard++ < 60 * 15) stepWalker(surface, w, surfaceGravity(G, mass, w.r), null, {}, 1 / 60)

  let below = false
  let maxAlt = 0
  let total = 0
  let finite = true
  const wish = [1, 0, 0]
  for (let i = 0; i < 60 * 25; i++) {
    const prev = [...w.dir]
    stepWalker(surface, w, surfaceGravity(G, mass, w.r), wish, { sprint: true }, 1 / 60)
    total += Math.acos(clamp(dot(prev, w.dir), -1, 1)) * surface.R
    const g = surface.heightAt(w.dir, w.cell)
    if (w.r < g.radius - 1e-9) below = true
    maxAlt = Math.max(maxAlt, w.r - g.radius)
    finite &&= Number.isFinite(w.r) && Number.isFinite(dot(w.dir, w.dir))
  }
  check(`walking covers ground along the surface (${total.toFixed(1)} u sprinted)`, total > 30)
  check('walker never dips below the surface while walking', !below)
  check(`walker stays glued to flat relief (max alt ${maxAlt.toFixed(3)})`, maxAlt < 0.2 && w.grounded)
  check('walker state stays finite', finite)
}

// ---------------------------------------------------------------------------
// walls: a neighboring tile raised above stepUp blocks the walker (it may
// slide along the wall but never crosses onto it). Natural fBm terrain has
// no such walls — they come from player edits, so build one synthetically.
// ---------------------------------------------------------------------------
{
  const hex = getHexSphere(2)
  const elements = new Array(hex.cellCount).fill(0).map(() => ({ t: 'rock', h: 0 }))
  const HIGH = 37
  elements[HIGH] = { t: 'rock', h: 2.2 } // a raised pillar
  const planet = { frequency: 2, elements }
  const surface = makeSurface(planet)
  const low = hex.neighbors[HIGH * 6]
  const w = {
    dir: centerOf(hex, low),
    r: surface.R + 0,
    radialVel: 0,
    grounded: true,
    cell: low,
    landedOnce: true,
  }
  // push straight from the low cell's center toward the tall cell's center
  const ci = centerOf(hex, low)
  const cn = centerOf(hex, HIGH)
  const wd = dot(ci, cn)
  const wish = [cn[0] - ci[0] * wd, cn[1] - ci[1] * wd, cn[2] - ci[2] * wd]
  let crossed = false
  for (let i = 0; i < 60 * 4; i++) {
    stepWalker(surface, w, surfaceGravity(G, 30, w.r), wish, {}, 1 / 60)
    if (w.cell === HIGH) crossed = true
  }
  check('raised tile walls block the walker', !crossed)

  // and diagonal approach slides along the wall instead of sticking dead-on:
  // start moving at ~60° into the wall, expect continued motion
  const w2 = { ...w, dir: centerOf(hex, low), cell: low }
  const tangent = [wish[2], wish[0], wish[1]] // some non-parallel direction
  let moved2 = 0
  for (let i = 0; i < 60 * 2; i++) {
    const prev = [...w2.dir]
    const mix = [wish[0] + tangent[0] * 1.5, wish[1] + tangent[1] * 1.5, wish[2] + tangent[2] * 1.5]
    stepWalker(surface, w2, surfaceGravity(G, 30, w2.r), mix, {}, 1 / 60)
    moved2 += Math.acos(clamp(dot(prev, w2.dir), -1, 1))
  }
  check(`approaching a wall at an angle slides along it (${moved2.toFixed(2)} rad)`, moved2 > 0.2)
}

// ---------------------------------------------------------------------------
// jumping: leaves the ground, reaches ~jumpHeight, and lands back down
// ---------------------------------------------------------------------------
{
  const surface = makeSurface(landable)
  const mass = planetMass(landable)
  const w = createWalker(surface, [0, 1, 0])
  let guard = 0
  while (!w.grounded && guard++ < 60 * 15) stepWalker(surface, w, surfaceGravity(G, mass, w.r), null, {}, 1 / 60)

  const g0 = surface.heightAt(w.dir, w.cell)
  let jumped = false
  let peak = 0
  let landedAgain = false
  // one jump frame, then coast until grounded again
  for (let i = 0; i < 60 * 6; i++) {
    const ev = stepWalker(surface, w, surfaceGravity(G, mass, w.r), null, { jump: i === 0 }, 1 / 60)
    if (ev === 'jumped') jumped = true
    const g = surface.heightAt(w.dir, w.cell)
    peak = Math.max(peak, w.r - g.radius)
    if (i > 2 && ev === 'landed') {
      landedAgain = true
      break
    }
  }
  void g0
  check(`jump leaves the ground and re-lands (peak ${peak.toFixed(4)} u)`, jumped && landedAgain)
  const jumpTarget = surface.metrics.jumpHeight
  check(
    `jump apex is near target ${jumpTarget.toFixed(4)} u (tile-scaled)`,
    peak > jumpTarget * 0.7 && peak < jumpTarget * 1.6
  )
}

// ---------------------------------------------------------------------------
// astronaut scale: hexes are universal atoms (scale-1 grids), so the tile —
// and every SURFACE length derived from it — is the SAME absolute size on
// every starter world. The horizon gets genuinely close on small worlds:
// that is the honest consequence of Pluto being twelve atoms across.
// ---------------------------------------------------------------------------
{
  const landables = world.planets.filter((q) => q.preset !== 'star')
  const surfs = landables.map((p) => makeSurface(p))
  check(
    'universal atoms: tile size identical (0.6204) on every starter world',
    surfs.every((s) => Math.abs(s.tile - 0.6204) < 1e-3)
  )
  check(
    'the astronaut is literally one being: all walker metrics identical across worlds',
    surfs.every(
      (s) =>
        Math.abs(s.metrics.eye - surfs[0].metrics.eye) < 1e-9 &&
        Math.abs(s.metrics.walkSpeed - surfs[0].metrics.walkSpeed) < 1e-9 &&
        Math.abs(s.metrics.jumpHeight - surfs[0].metrics.jumpHeight) < 1e-9
    )
  )
  const giant = landables.reduce((a, b) => (a.elements.length >= b.elements.length ? a : b))
  const gs = makeSurface(giant)
  const dip = Math.sqrt((2 * gs.metrics.eye) / gs.R) // radians the horizon sits below eye level
  check(
    `horizon sits comfortably far on the largest world (${giant.name}: ${(dip * 57.3).toFixed(1)}°)`,
    dip < 0.16
  )

  const nat = makeSurface({ frequency: 10, elements: generateElements('earthlike', 10, 5) })
  const m = nat.metrics
  check(
    'natural-scale (scale 1) worlds reproduce the original walker tuning',
    Math.abs(m.eye - 0.62) < 0.01 &&
      Math.abs(m.walkSpeed - 3.8) < 0.05 &&
      Math.abs(m.stepUp - 0.5) < 0.01 &&
      Math.abs(m.jumpHeight - 1.15) < 0.01 &&
      Math.abs(m.spawnHover - 4.5) < 0.02
  )
}

// ---------------------------------------------------------------------------
// real-size astronaut (world.scale): a true-scale world carries the length
// of one world unit in METERS — the walker is a real human (meters,
// SURFACE_REAL), gravity is physical (the sim's softened law IS the real
// pull there), and the tile-anchored defaults above stay untouched for
// worlds without the field.
// ---------------------------------------------------------------------------
{
  // the same anchor the true-scale generators use (gen-sol-real.mjs): Earth
  // fills the top of the ladder, 1 document second = 1 real second
  const SCALE = (6371.009 * 1e3) / radiusForFrequency(MAX_FREQUENCY) // ≈ 35182 m/u
  const toM = (v) => v * SCALE

  // metrics: a human in meters, converted through the world scale (grid-independent)
  const rs = makeSurface({ frequency: 6, elements: generateElements('rocky', 6, 1) }, SCALE)
  const m = rs.metrics
  check(
    `real-mode metrics are a human (eye ${(toM(m.eye) * 100).toFixed(0)} cm, walk ${(toM(m.walkSpeed) * 100).toFixed(0)} cm/s)`,
    Math.abs(toM(m.eye) - 1.6) < 1e-9 &&
      Math.abs(toM(m.walkSpeed) - 1.4) < 1e-9 &&
      Math.abs(toM(m.stepUp) - 0.3) < 1e-9 &&
      Math.abs(toM(m.jumpHeight) - 0.5) < 1e-9 &&
      Math.abs(toM(m.spawnHover) - 120) < 1e-9 &&
      rs.real === SCALE
  )
  // the same world without the annotation keeps the tile-anchored astronaut
  const ts = makeSurface({ frequency: 6, elements: generateElements('rocky', 6, 1) })
  check(
    'no scale → tile-anchored astronaut unchanged',
    ts.real === null && Math.abs(ts.metrics.eye - SURFACE.eye * ts.tile) < 1e-12
  )

  // gravity: the true-scale softened law reproduces the REAL pull (Earth
  // ≈ 9.8 m/s²). Masses follow the generators' density trick (mu × mSun),
  // with mSun solved for the true 1-AU Earth year exactly like gen-sol-real.
  const EARTH_YEAR = 365.25 * 86400
  const AU = (149_597_870.7 * 1e3) / SCALE // meters → world units
  const mSun = (4 * Math.PI * Math.PI * AU * (AU * AU + 4)) / (G * EARTH_YEAR * EARTH_YEAR)
  const mEarth = 3.003e-6 * mSun
  const R_earth = (6371.009 * 1e3) / SCALE
  const gEarth = surfaceGravity(G, mEarth, R_earth, SCALE)
  check(
    `real-mode surface gravity is physical (Earth ${(gEarth * SCALE).toFixed(2)} m/s²)`,
    Math.abs(gEarth * SCALE - 9.82) < 0.2
  )
  // the tile-mode path on the same body is the old game-feel clamp (pinned)
  check(
    'tile mode on the same true-scale body keeps the game-feel clamp (1.0 u/s²)',
    surfaceGravity(G, mEarth, R_earth) === SURFACE.minGravity
  )

  // motion: the 120 m spawn fall and a ~0.5 m jump under ~9.8 m/s²
  {
    const flatWorld = { frequency: 4, elements: new Array(cellCountForFrequency(4)).fill(0).map(() => ({ t: 'rock', h: 0 })) }
    const surf = makeSurface(flatWorld, SCALE)
    // a body mass whose real-mode gravity is 9.807 m/s² at the world radius
    const mass = ((9.807 / SCALE) * (surf.R * surf.R + 4)) / G // eps² = 4
    const w = createWalker(surf, [0, 1, 0])
    let steps = 0
    while (!w.grounded && steps < 60 * 20) {
      stepWalker(surf, w, surfaceGravity(G, mass, w.r, SCALE), null, {}, 1 / 60)
      steps++
    }
    check(
      `real-mode spawn fall is a human landing (120 m in ${(steps / 60).toFixed(1)} s)`,
      w.landedOnce && w.grounded && steps > 60 * 8 && steps < 60 * 12
    )
    const target = surf.metrics.jumpHeight // 0.5 m in units
    let jumped = false
    let landed = false
    let peak = 0
    for (let i = 0; i < 60 * 8; i++) {
      const ev = stepWalker(surf, w, surfaceGravity(G, mass, w.r, SCALE), null, { jump: i === 0 }, 1 / 60)
      if (ev === 'jumped') jumped = true
      if (i > 3 && ev === 'landed') {
        landed = true
        break
      }
      const gnd = surf.heightAt(w.dir, w.cell)
      peak = Math.max(peak, w.r - gnd.radius)
    }
    check(
      `real-mode jump apex ≈ 0.5 m (got ${(toM(peak)).toFixed(2)} m)`,
      jumped && landed && peak > target * 0.7 && peak < target * 1.6
    )
  }
}

// ---------------------------------------------------------------------------
// determinism + fuzz: scripted random walk twice → identical, all finite
// ---------------------------------------------------------------------------
{
  const runScript = () => {
    const surface = makeSurface(landable)
    const mass = planetMass(landable)
    const w = createWalker(surface, [-0.2, 0.4, 0.85])
    const rand = mulberry32(42)
    const states = []
    for (let i = 0; i < 60 * 30; i++) {
      const wish = rand() < 0.15 ? [0, 0, 0] : randDir(rand)
      stepWalker(surface, w, surfaceGravity(G, mass, w.r), wish, { jump: rand() < 0.08, sprint: rand() < 0.3 }, 1 / 60)
      if (i % 17 === 0) states.push(w.r, w.dir[0], w.dir[1], w.dir[2], w.grounded ? 1 : 0, w.cell)
    }
    return states
  }
  const a = runScript()
  const b = runScript()
  const identical = a.length === b.length && a.every((v, i) => v === b[i])
  const allFinite = a.every((v) => Number.isFinite(v))
  check('walker integration is deterministic', identical)
  check('walker fuzz stays finite (30 s random walk + jumps)', allFinite)
}

// ---------------------------------------------------------------------------
// intersectHeightfield: analytic ray pick (drives pointer events in Planet.jsx)
// ---------------------------------------------------------------------------
{
  const scale3 = (v, s) => [v[0] * s, v[1] * s, v[2] * s]
  const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
  const nrm = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1
    return [v[0] / l, v[1] / l, v[2] / l]
  }

  const pickPlanet = { frequency: 5, scale: 1, elements: generateElements('earthlike', 5, 11) }
  const surf = makeSurface(pickPlanet)
  const R = surf.R

  let radialOk = true
  let maxDistErr = 0
  for (let i = 0; i < surf.hex.cellCount; i++) {
    const c = centerOf(surf.hex, i)
    const hit = intersectHeightfield(surf, scale3(c, 6 * R), scale3(c, -1))
    if (!hit || hit.cell !== i) {
      radialOk = false
      break
    }
    maxDistErr = Math.max(maxDistErr, Math.abs(hit.distance - (6 * R - hit.radius)))
  }
  check(`radial pick: every cell picks itself (${surf.hex.cellCount} rays)`, radialOk && maxDistErr < 1e-9)

  // raised tile: picks at its raised radius, and occludes what is behind it
  const tall = 17
  const tallDir = centerOf(surf.hex, tall)
  pickPlanet.elements[tall] = { ...pickPlanet.elements[tall], h: R * 0.5 }
  const surf2 = makeSurface(pickPlanet)
  const hitTop = intersectHeightfield(surf2, scale3(tallDir, 3 * R), scale3(tallDir, -1))
  check('raised tile picks at raised radius', hitTop && hitTop.cell === tall && Math.abs(hitTop.radius - 1.5 * R) < 1e-12)
  const tip = scale3(tallDir, 1.5 * R)
  const origin = add3(scale3(tallDir, 3 * R), [R * 0.4, R * 0.2, 0])
  const dirOblique = nrm([tip[0] - origin[0], tip[1] - origin[1], tip[2] - origin[2]])
  const hitOblique = intersectHeightfield(surf2, origin, dirOblique)
  const dTip = Math.hypot(tip[0] - origin[0], tip[1] - origin[1], tip[2] - origin[2])
  check('oblique ray is stopped by the raised tile', !!hitOblique && hitOblique.distance <= dTip + 1e-9)

  check(
    'ray missing the planet returns null',
    intersectHeightfield(surf2, [4 * R, 5 * R, 4 * R], nrm([1, 0.3, 1])) === null
  )
  check('ray from inside the planet returns null', intersectHeightfield(surf2, [0, 0, 0], [0, 0, -1]) === null)

  // brute-force march agreement on random rays
  const rand = mulberry32(5150)
  for (const [label, planet] of [['relief f5', pickPlanet], [landable.name, landable]]) {
    const s = makeSurface(planet)
    const maxRs = s.R + s.maxH
    let ok = true
    let hits = 0
    let misses = 0
    for (let k = 0; k < 50 && ok; k++) {
      const o = scale3(randDir(rand), maxRs * 2.3)
      const jitter = scale3(randDir(rand), maxRs * 0.9)
      const d = nrm([jitter[0] - o[0], jitter[1] - o[1], jitter[2] - o[2]])
      const step = maxRs * 0.001
      let march = null
      let marchCell = -1
      for (let t = 0; t <= maxRs * 2.4; t += step) {
        const q = add3(o, scale3(d, t))
        const r = s.heightAt(nrm(q), marchCell)
        marchCell = r.cell
        if (Math.hypot(q[0], q[1], q[2]) <= r.radius) {
          march = t
          break
        }
      }
      const hit = intersectHeightfield(s, o, d)
      if (march == null && hit == null) {
        misses++
        continue
      }
      // How solid is the penetration the fine march found? Depth a few
      // march steps past entry separates real walls from sub-step graze
      // slivers, which the analytic pick may legitimately skip.
      let solid = false
      if (march != null) {
        const q2 = add3(o, scale3(d, march + step * 8))
        solid = s.heightAt(nrm(q2), -1).radius - Math.hypot(q2[0], q2[1], q2[2]) > step
      }
      if (march == null) {
        // The pick's bisection leaves its hit inside the surface (f(hi) ≤ 0
        // by construction). If the coarse march above still missed it, the
        // penetration is a sub-step sliver — a ray grazing a fan kink or
        // relief wall (the documented case). Verify the hit penetrates at
        // its own point: a true sliver is a legitimate miss for the march;
        // a non-penetrating "hit" is a real bug.
        const p = hit.point
        const pl = Math.hypot(p[0], p[1], p[2])
        if (pl - s.heightAt(nrm(p), hit.cell).radius > 1e-6 * Math.max(1, pl)) ok = false
        else misses++
      } else if (hit == null) {
        if (solid) ok = false // skipped a real penetration
      } else {
        const pLen = Math.hypot(hit.point[0], hit.point[1], hit.point[2])
        if (pLen - hit.radius > 1e-6 * Math.max(1, hit.radius)) ok = false // never floats above the surface
        if (solid) {
          if (hit.distance > march + step * 4) ok = false
          const mc = cellAtDirection(s.hex, nrm(add3(o, scale3(d, march))))
          if (hit.cell !== mc && !hasNeighbor(s.hex, hit.cell, mc)) ok = false
        }
      }
      if (ok) hits++
    }
    check(`analytic pick matches brute-force march (${label}: ${hits} hits, ${misses} misses)`, ok)
  }

  // cost guard: this runs per pointer/wheel event, per planet
  const surfH = makeSurface(landable)
  const maxRh = surfH.R + surfH.maxH
  const t0 = Date.now()
  let n = 0
  for (let k = 0; k < 5000; k++) {
    const o = scale3(randDir(rand), maxRh * 1.8)
    const dd = nrm([
      -o[0] + (rand() - 0.5) * maxRh,
      -o[1] + (rand() - 0.5) * maxRh,
      -o[2] + (rand() - 0.5) * maxRh,
    ])
    if (intersectHeightfield(surfH, o, dd)) n++
  }
  const ms = Date.now() - t0
  check(`5000 analytic picks on a ${landable.elements.length}-cell world in ${ms} ms (${n} hits)`, ms < 1500 && n > 0)
}

process.exit(failures === 0 ? 0 : 1)
