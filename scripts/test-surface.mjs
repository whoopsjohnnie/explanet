/**
 * test-surface.mjs — headless tests for the surface walker (core/surface.js):
 * Voronoi cell lookup, gravity law, landing fall, surface-bound walking,
 * wall blocking, jumping, and integrator sanity.
 * Run: node scripts/test-surface.mjs
 */

import { makeStarterWorld } from '../src/core/starter.js'
import { generateElements } from '../src/core/generators.js'
import { getHexSphere } from '../src/core/hexsphere.js'
import { planetMass } from '../src/core/planetMath.js'
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
        const dd = dot(hex.cells[i].center, d)
        if (dd > bd) {
          bd = dd
          best = i
        }
      }
      const got = cellAtDirection(hex, d, hint)
      // ties only occur at exact boundaries (measure zero) — accept equal-dot
      if (got !== best && dot(hex.cells[got].center, d) < bd - 1e-12) ok = false
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
    const q = surface.heightAt(hex.cells[i].center, -1)
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
  const low = hex.cells[HIGH].neighbors[0]
  const w = {
    dir: [...hex.cells[low].center],
    r: surface.R + 0,
    radialVel: 0,
    grounded: true,
    cell: low,
    landedOnce: true,
  }
  // push straight from the low cell's center toward the tall cell's center
  const ci = hex.cells[low].center
  const cn = hex.cells[HIGH].center
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
  const w2 = { ...w, dir: [...hex.cells[low].center], cell: low }
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
  check(`jump leaves the ground and re-lands (peak ${peak.toFixed(2)} u)`, jumped && landedAgain)
  check(
    `jump apex is near target ${SURFACE.jumpHeight} u`,
    peak > SURFACE.jumpHeight * 0.7 && peak < SURFACE.jumpHeight * 1.6
  )
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
    const c = surf.hex.cells[i].center
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
  const tallDir = surf.hex.cells[tall].center
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
      if (march == null) ok = false // pick found what a finer march says misses
      else if (hit == null) {
        if (solid) ok = false // skipped a real penetration
      } else {
        const pLen = Math.hypot(hit.point[0], hit.point[1], hit.point[2])
        if (pLen - hit.radius > 1e-6 * Math.max(1, hit.radius)) ok = false // never floats above the surface
        if (solid) {
          if (hit.distance > march + step * 4) ok = false
          const mc = cellAtDirection(s.hex, nrm(add3(o, scale3(d, march))))
          if (hit.cell !== mc && !s.hex.cells[hit.cell].neighbors.includes(mc)) ok = false
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
