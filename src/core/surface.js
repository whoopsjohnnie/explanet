/**
 * surface.js
 * ---------------------------------------------------------------------------
 * Pure, framework-free kinematics for walking on a planet's surface.
 *
 * The walker is deliberately NOT a cannon body: planet colliders are
 * heightless spheres at the base radius R, while the actual surface is
 * r(dir) = R + h(cell(dir)) — the star-shaped top surface of the hex
 * elements. A rigid-body avatar would sink into mountains and skate on the
 * rotating collider. Instead surface mode integrates a tiny walker of its
 * own against that height field, in the PLANET-LOCAL frame: the walker rides
 * the planet's spin and orbit for free, and the renderer composes the world
 * pose as planetPos + quat·(dir·r) from the live body registry.
 *
 * Movement model:
 *   • Position = unit direction (local frame) + radius r.
 *   • Which tile is underfoot is the nearest cell center (Voronoi lookup):
 *     a greedy funnel walk over hex adjacency from the last known cell; the
 *     quasi-regular dual grid has no local maxima (verified headlessly).
 *   • Grounded: tangent motion rotates dir. A new cell may be stepped up
 *     onto (≤ stepUp) or stepped down from (≤ stepDownSnap); bigger steps up
 *     are walls — the move is blocked and slides along the wall instead.
 *     Walking off a bigger ledge turns into a real fall.
 *   • Airborne: r integrates against surface gravity — the same softened
 *     law as the orbital sim, F = G·m/(r² + ε²), scaled for feel — and the
 *     fall terminates on contact (the surface is star-shaped, so every fall
 *     ends somewhere).
 *
 * Walker state is a plain mutable object stepped at 60 Hz outside React
 * state — the same rule as the body registry in physics.js.
 */

import { getHexSphere, radiusFromCellCount } from './hexsphere.js'

// ---------------------------------------------------------------------------
// Small vec helpers (arrays of 3)
// ---------------------------------------------------------------------------
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const len3 = (a) => Math.sqrt(dot(a, a))
function norm3(a) {
  const l = len3(a) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------
export const SURFACE = {
  walkSpeed: 3.8, // world units / s along the surface
  sprintMult: 1.8,
  airControl: 0.75, // fraction of move speed available while airborne
  stepUp: 0.5, // max tile height increase a stride can climb
  stepDownSnap: 0.55, // descents up to this keep you grounded (snap down)
  jumpHeight: 1.15, // target jump apex in world units (scaled by gravity)
  maxFallSpeed: 30,
  spawnHover: 4.5, // spawn this far above the surface → dramatic landing fall
  gravityScale: 0.12, // feel scale: the sim's G values are huge by design
  minGravity: 1.0,
  maxGravity: 30,
}

/**
 * HUD telemetry side-channel: the walker component writes these numbers at
 * 60 Hz; the HUD polls them slowly. Keeps live walk numbers out of React
 * state without the HUD needing three.js.
 */
export const walkReadout = { alt: 0, vel: 0, grounded: false, sprint: false }

/**
 * Downward acceleration at radius r around a body of mass `mass` under the
 * world's softened gravity law (matches stepGravity / orbitalSpeed),
 * scaled and clamped to stay walkable on everything from moons to giants.
 */
export function surfaceGravity(worldG, mass, r) {
  const a = ((worldG * Math.abs(mass)) / (r * r + 4)) * SURFACE.gravityScale
  return Math.min(SURFACE.maxGravity, Math.max(SURFACE.minGravity, a))
}

// ---------------------------------------------------------------------------
// Surface queries
// ---------------------------------------------------------------------------

/** Brute-force nearest cell center — fallback for invalid hints & reference. */
function nearestCellBrute(hex, dir) {
  let best = 0
  let bestDot = -Infinity
  for (let i = 0; i < hex.cellCount; i++) {
    const d = dot(hex.cells[i].center, dir)
    if (d > bestDot) {
      bestDot = d
      best = i
    }
  }
  return best
}

/**
 * Index of the cell whose center direction is nearest to `dir` (the Voronoi
 * lookup that decides what is underfoot). Greedy hill-climb over the hex
 * adjacency graph starting from `hint` (normally the previous cell): a few
 * steps on a quasi-regular grid, no local maxima, guarded to terminate.
 */
export function cellAtDirection(hex, dir, hint) {
  let best =
    Number.isInteger(hint) && hint >= 0 && hint < hex.cellCount ? hint : nearestCellBrute(hex, dir)
  let bestDot = dot(hex.cells[best].center, dir)
  for (let guard = 0; guard < hex.cellCount; guard++) {
    let improved = false
    for (const n of hex.cells[best].neighbors) {
      const d = dot(hex.cells[n].center, dir)
      if (d > bestDot + 1e-12) {
        bestDot = d
        best = n
        improved = true
      }
    }
    if (!improved) break
  }
  return best
}

/**
 * Build a surface query over a snapshot of a planet document. Rebuild when
 * `planet.elements` identity changes — the same copy-on-write contract as
 * the geometry memo.
 * @returns {{ hex, R: number, heightAt: (dir:number[], hint?:number) => {cell:number,h:number,radius:number} }}
 */
export function makeSurface(planet) {
  const hex = getHexSphere(planet.frequency)
  const R = radiusFromCellCount(planet.elements.length)
  const heightAt = (dir, hint) => {
    const cell = cellAtDirection(hex, dir, hint)
    const el = planet.elements[cell]
    const h = el ? el.h || 0 : 0
    return { cell, h, radius: R + h }
  }
  return { hex, R, heightAt }
}

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

/**
 * Spawn a walker hovering `spawnHover` above the surface at `dir`
 * (planet-local unit vector) so the first thing it does is fall to the
 * ground — the "land on the planet" moment.
 */
export function createWalker(surface, dir) {
  const d = norm3(dir && dir.length === 3 ? dir : [0, 1, 0])
  const q = surface.heightAt(d)
  return {
    dir: d,
    r: q.radius + SURFACE.spawnHover,
    radialVel: 0,
    grounded: false,
    cell: q.cell,
    landedOnce: false,
  }
}

/**
 * Advance the walker by `dt` seconds (mutates `w`). Pure math — the caller
 * supplies gravity and a wish direction already expressed in the planet's
 * local frame.
 * @param {object} surface makeSurface() result
 * @param {object} w       walker state (createWalker)
 * @param {number} gravity downward acceleration at the walker's altitude
 * @param {number[]|null} wish desired move direction, local frame; projected
 *        onto the tangent plane, so length and radial tilt are ignored
 * @param {{jump?: boolean, sprint?: boolean}} input
 * @returns {'landed'|'jumped'|null} discrete event raised this step
 */
export function stepWalker(surface, w, gravity, wish, input, dt) {
  const step = Math.min(Math.max(dt || 0, 0), 0.05)
  let event = null

  let ground = surface.heightAt(w.dir, w.cell)
  w.cell = ground.cell

  // ---- tangent movement ---------------------------------------------------
  if (wish && step > 0) {
    const d = w.dir
    const wd = dot(d, wish)
    const tx = wish[0] - d[0] * wd
    const ty = wish[1] - d[1] * wd
    const tz = wish[2] - d[2] * wd
    const tl = Math.sqrt(tx * tx + ty * ty + tz * tz)
    if (tl > 1e-9) {
      const speed =
        SURFACE.walkSpeed *
        (input.sprint ? SURFACE.sprintMult : 1) *
        (w.grounded ? 1 : SURFACE.airControl)
      const k = (speed * step) / Math.max(w.r, 0.25) // angle swept on the sphere
      const dirTo = (vx, vy, vz) => {
        const l = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1
        return norm3([d[0] + (vx / l) * k, d[1] + (vy / l) * k, d[2] + (vz / l) * k])
      }
      let nd = dirTo(tx, ty, tz)
      let next = surface.heightAt(nd, w.cell)
      // Walls: while grounded you cannot step up more than stepUp. Slide
      // along the wall by removing the component into the blocked cell.
      if (w.grounded && next.h - ground.h > SURFACE.stepUp) {
        const bn = norm3([
          nd[0] - d[0] * dot(d, nd),
          nd[1] - d[1] * dot(d, nd),
          nd[2] - d[2] * dot(d, nd),
        ])
        const bnd = dot([tx, ty, tz], bn)
        const px = tx - bn[0] * bnd
        const py = ty - bn[1] * bnd
        const pz = tz - bn[2] * bnd
        if (px * px + py * py + pz * pz > 1e-9) {
          nd = dirTo(px, py, pz)
          next = surface.heightAt(nd, w.cell)
        }
      }
      if (!(w.grounded && next.h - ground.h > SURFACE.stepUp)) {
        w.dir = nd
        w.cell = next.cell
      }
    }
  }

  // ---- jump -----------------------------------------------------------------
  if (w.grounded && input.jump) {
    w.radialVel = Math.sqrt(2 * gravity * SURFACE.jumpHeight)
    w.grounded = false
    event = 'jumped'
  }

  // ---- vertical ---------------------------------------------------------------
  ground = surface.heightAt(w.dir, w.cell)
  w.cell = ground.cell
  if (w.grounded) {
    if (w.r - ground.radius <= SURFACE.stepDownSnap) {
      // track the ground: small steps up/down and terrain edits
      w.r = ground.radius
    } else {
      // walked off a taller ledge than the snap: start falling from height
      w.grounded = false
      w.radialVel = 0
    }
  }
  if (!w.grounded) {
    w.radialVel = Math.max(w.radialVel - gravity * step, -SURFACE.maxFallSpeed)
    w.r += w.radialVel * step
    if (w.r <= ground.radius) {
      // contact — the surface is star-shaped so this always terminates
      w.r = ground.radius
      w.radialVel = 0
      w.grounded = true
      w.landedOnce = true
      event = 'landed'
    }
  }
  return event
}
