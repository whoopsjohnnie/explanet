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

import { getHexSphere, dotCenter } from './hexsphere.js'
import { planetRadius } from './planetMath.js'
import { C } from './constants.js'

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
// Tuning — the astronaut scales WITH its world
// ---------------------------------------------------------------------------
// Every LENGTH constant below is a multiple of the planet's TILE SCALE: the
// circumradius of one hex plate on the planet being walked (makeSurface()
// resolves these ratios into surface.metrics, in world units). The astronaut
// is therefore always "one tile tall" — on a true-scale solar system, where
// Earth's 40k-cell grid puts a tile at ~0.02 u, the walker shrinks with it.
// A fixed eye height there would stand 30 tiles tall and tip the horizon
// 45° down: every world would read as a small ball. Tying body, stride,
// step and jump to the tile keeps the walk — and the visible curvature —
// identical from a 0.4 u moon to a 21 u giant. The ratios are the original
// absolute tuning (eye 0.62, speed 3.8, …) divided by the tile radius of a
// natural grid (0.6204), so scale-1 worlds keep their exact old feel.
export const SURFACE = {
  eye: 1.0, // astronaut eye height above the tile under foot
  walkSpeed: 6.12, // tiles / s along the surface (≈ eye-heights / s)
  sprintMult: 1.8,
  airControl: 0.75, // fraction of move speed available while airborne
  stepUp: 0.81, // max tile height increase a stride can climb
  stepDownSnap: 0.89, // descents up to this keep you grounded (snap down)
  jumpHeight: 1.85, // target jump apex (scaled by gravity)
  maxFallSpeed: 48.3,
  spawnHover: 7.25, // spawn this far above the surface → dramatic landing fall
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
  const a = ((worldG * Math.abs(mass)) / (r * r + C.physics.softeningEpsSq)) * SURFACE.gravityScale
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
    const d = dotCenter(hex, i, dir)
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
  let bestDot = dotCenter(hex, best, dir)
  for (let guard = 0; guard < hex.cellCount; guard++) {
    let improved = false
    const nb = best * 6
    for (let s = 0, sn = hex.sides[best]; s < sn; s++) {
      const n = hex.neighbors[nb + s]
      const d = dotCenter(hex, n, dir)
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
 * @returns {{ hex, R: number, maxH: number, tile: number, metrics: object, heightAt: (dir:number[], hint?:number) => {cell:number,h:number,radius:number} }}
 */
export function makeSurface(planet) {
  const hex = getHexSphere(planet.frequency)
  const R = planetRadius(planet)
  const hs = new Float64Array(planet.elements.length)
  let maxH = 0
  for (let i = 0; i < planet.elements.length; i++) {
    const h = (planet.elements[i] && planet.elements[i].h) || 0
    hs[i] = h
    if (h > maxH) maxH = h
  }
  // Tile scale: circumradius s of a hex of area 4πR²/N  (hex area = 3√3/2·s²).
  // ~0.6204 for a natural grid (scale 1); it shrinks with true-scale planets.
  const tile = R * Math.sqrt((8 * Math.PI) / (3 * Math.sqrt(3) * hex.cellCount))
  // The astronaut's resolved body metrics in world units — the one place the
  // SURFACE ratios become lengths. Everything walker-side reads these.
  const metrics = {
    eye: SURFACE.eye * tile,
    walkSpeed: SURFACE.walkSpeed * tile,
    stepUp: SURFACE.stepUp * tile,
    stepDownSnap: SURFACE.stepDownSnap * tile,
    jumpHeight: SURFACE.jumpHeight * tile,
    maxFallSpeed: SURFACE.maxFallSpeed * tile,
    spawnHover: SURFACE.spawnHover * tile,
  }
  const heightAt = (dir, hint) => {
    const cell = cellAtDirection(hex, dir, hint)
    const h = hs[cell]
    return { cell, h, radius: R + h }
  }
  return { hex, R, maxH, hs, tile, metrics, heightAt }
}

/**
 * Ray → heightfield intersection in the planet-LOCAL frame: origin and dir
 * are number[3] arrays (dir any nonzero length; normalized here), no
 * triangle mesh involved. The signed penetration function
 *   f(t) = |origin + t·dir| − (R + h(direction of that point))
 * is negative inside the planet; the hit is its first zero, found by
 * marching the enclosing sphere's chord and bisecting. This handles relief
 * WALLS (jumps between cell heights) exactly, which sphere-column fixed
 * point iterations cannot represent.
 *
 * Marching keeps the cost a flat ~1000 cheap hill-climbs — independent of
 * grid resolution or terrain triangle counts — which is what keeps pointer
 * events (R3F raycasts on every pointer move AND wheel tick, every planet)
 * instant on full-resolution worlds. Returns the DOCUMENT cell under the ray.
 *
 * @returns {{ cell:number, h:number, radius:number, distance:number, point:number[] }|null}
 *   `distance` is along the (unit-normalized) ray from `origin`; null when
 *   the ray misses or starts inside the surface (mirrors FrontSide culling).
 */
export function intersectHeightfield(surface, origin, dir) {
  const d = norm3(dir)
  const hex = surface.hex
  const R = surface.R
  const hs = surface.hs
  const maxR = R + surface.maxH
  const oc = dot(origin, origin)
  let hint = -1

  // Scratch reused by every sample (single-threaded core, no allocation in
  // the hot loop — this runs ~1000× per pointer event across the scene).
  const dirS = [0, 0, 0]

  // Signed penetration f(t): < 0 inside the planet. Mutates `hint`.
  const evalAt = (t) => {
    const px = origin[0] + d[0] * t
    const py = origin[1] + d[1] * t
    const pz = origin[2] + d[2] * t
    const len = Math.sqrt(px * px + py * py + pz * pz)
    dirS[0] = px / len
    dirS[1] = py / len
    dirS[2] = pz / len
    hint = cellAtDirection(hex, dirS, hint)
    return len - (R + hs[hint])
  }

  // Bisect f between an outside sample (lo) and an inside one (hi).
  const refine = (lo, hi) => {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) * 0.5
      if (evalAt(mid) <= 0) hi = mid
      else lo = mid
    }
    evalAt(hi) // leaves the cell under `hi` in `hint`
    const h = hs[hint]
    const radius = R + h
    // f(t) jumps where the ray crosses a boundary between cells of unequal
    // height, and the bisection can land exactly on such a jump: the point at
    // `hi` may then sit above the radius of the cell the funnel reports.
    // Snap it radially onto that cell's surface so a hit never floats, while
    // `distance` keeps the ray parameter of the entry itself.
    const point = [origin[0] + d[0] * hi, origin[1] + d[1] * hi, origin[2] + d[2] * hi]
    const len = Math.sqrt(point[0] * point[0] + point[1] * point[1] + point[2] * point[2])
    if (len > 0) {
      const s = radius / len
      point[0] *= s
      point[1] *= s
      point[2] *= s
    }
    return { cell: hint, h, radius, distance: hi, point }
  }

  if (oc <= maxR * maxR) {
    if (evalAt(0) <= 0) return null // inside planet
    // Above the surface but inside the max-relief envelope (camera hugging a
    // world): the chord solve would start past the planet, so march outward
    // from the camera until the surface is crossed.
    const step = Math.max(maxR * 0.004, 1e-5)
    let lo = 0
    for (let i = 1; i <= 250; i++) {
      const t = i * step
      if (evalAt(t) <= 0) return refine(lo, t)
      lo = t
    }
    return null
  }

  const b = dot(origin, d)
  const sq0 = b * b - (oc - maxR * maxR)
  if (sq0 < 0) return null // misses even the tallest sphere
  const tIn = -b - Math.sqrt(sq0)
  if (tIn < 0) return null
  const tOut = -b + Math.sqrt(sq0) // all crossings lie inside this chord

  // March the chord to the first sample that penetrates the surface, then
  // bisect to place the crossing. Penetration windows thinner than one step
  // (chord/1024 — sub-pixel slivers where a ray grazes a relief wall) may be
  // skipped; the answer then lands on the next surface the ray reaches.
  const step = (tOut - tIn) / 1024
  let hi = null
  for (let i = 0; i <= 1024; i++) {
    const t = tIn + step * i
    if (evalAt(t) <= 0) {
      hi = t
      break
    }
  }
  if (hi == null) return null // graze: nothing reaches the surface
  return refine(Math.max(tIn, hi - step), hi)
}

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

/**
 * Spawn a walker hovering `metrics.spawnHover` above the surface at `dir`
 * (planet-local unit vector) so the first thing it does is fall to the
 * ground — the "land on the planet" moment.
 */
export function createWalker(surface, dir) {
  const d = norm3(dir && dir.length === 3 ? dir : [0, 1, 0])
  const q = surface.heightAt(d)
  return {
    dir: d,
    r: q.radius + surface.metrics.spawnHover,
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
  const M = surface.metrics
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
        M.walkSpeed *
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
      if (w.grounded && next.h - ground.h > M.stepUp) {
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
      if (!(w.grounded && next.h - ground.h > M.stepUp)) {
        w.dir = nd
        w.cell = next.cell
      }
    }
  }

  // ---- jump -----------------------------------------------------------------
  if (w.grounded && input.jump) {
    w.radialVel = Math.sqrt(2 * gravity * M.jumpHeight)
    w.grounded = false
    event = 'jumped'
  }

  // ---- vertical ---------------------------------------------------------------
  ground = surface.heightAt(w.dir, w.cell)
  w.cell = ground.cell
  if (w.grounded) {
    if (w.r - ground.radius <= M.stepDownSnap) {
      // track the ground: small steps up/down and terrain edits
      w.r = ground.radius
    } else {
      // walked off a taller ledge than the snap: start falling from height
      w.grounded = false
      w.radialVel = 0
    }
  }
  if (!w.grounded) {
    w.radialVel = Math.max(w.radialVel - gravity * step, -M.maxFallSpeed)
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
