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

process.exit(failures === 0 ? 0 : 1)
