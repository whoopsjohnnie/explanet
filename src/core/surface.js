/**
 * surface.js
 * ---------------------------------------------------------------------------
 * Pure, framework-free kinematics for walking on a planet's surface.
 *
 * The walker is deliberately NOT a cannon body: planet colliders are
 * heightless spheres at the base radius R, while the actual surface is the
 * RENDERED top surface — the chord-triangle fans of the hex elements
 * (core/geometry.js). Walking the rendered surface (not the per-cell sphere
 * R + h(cell)) is what welds the astronaut to the ground as drawn: flat
 * chord fans sag below the sphere by up to a hex apothem squared over 8R
 * (~100 m on a true-scale 35 km grid), and an avatar on the invisible sphere
 * would float a hundred metres above the ground under its feet. The same
 * rule makes the walker follow terrain edits and any deformation of the
 * elements live, because the surface is re-derived from them every step.
 * A rigid-body avatar would sink into mountains and skate on the rotating
 * collider anyway. Instead surface mode integrates a tiny walker of its own
 * against that height field, in the PLANET-LOCAL frame: the walker rides
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
 *     law as the orbital sim, F = G·m/(r² + ε²) — and the fall terminates on
 *     contact (the surface is star-shaped, so every fall ends somewhere).
 *
 * Astronaut scale: one of TWO modes, resolved by makeSurface():
 *   • TILE mode (default, worlds without a scale annotation): every length
 *     is a SURFACE ratio × the planet's tile radius — the astronaut is one
 *     hex plate tall on every world (see the tuning section below).
 *   • REAL mode (worlds carrying a positive `scale` document field —
 *     true-scale worlds where one world unit is that many METERS and 1
 *     document second is 1 real second, e.g. Sol Real): the astronaut is a
 *     real human, authored in meters in SURFACE_REAL and converted through
 *     the world scale (1 m = 1/scale units). Gravity skips the game-feel
 *     gravityScale: the sim's softened law IS the physical gravity on such
 *     worlds, so surfaceGravity() clamps in m/s² instead (see below).
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
// Tuning — the astronaut scales WITH its world (tile mode)
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

// ---------------------------------------------------------------------------
// Tuning — the real-human astronaut (real mode, worlds with `scale`)
// ---------------------------------------------------------------------------
// Tile mode makes a true-scale world (Sol Real: 1 u ≈ 35 km, 1 doc second =
// 1 real second) a game: the walker there is one tile tall — a 22 km being
// striding at 133 km/s, with 21 km plates under its feet. Worlds that carry
// a positive `scale` document field (METERS per world unit) instead get a
// REAL human, authored in meters here and converted to world units by
// makeSurface() (1 m = 1/scale units). sprintMult/airControl stay in
// SURFACE: they are unitless multipliers, identical in both modes.
export const SURFACE_REAL = {
  eye: 1.6, // m — eye height
  walkSpeed: 1.4, // m/s — a brisk stroll
  stepUp: 0.3, // m — a stride climbs a 30 cm rise, no more (km-scale cliffs
               //   on a 35 km hex grid ARE walls at this size — honest)
  stepDownSnap: 0.5, // m — descents up to this keep you grounded
  jumpHeight: 0.5, // m — a standing jump apex
  maxFallSpeed: 15, // m/s — terminal speed of the landing fall
  spawnHover: 120, // m — spawn this far above the surface → the landing
  minGravityMs2: 0.5, // m/s² — real-mode gravity clamp: below this, falls
  maxGravityMs2: 30, //   and jumps stop feeling physical (moon-ish floor,
                     //   super-Earth-ish ceiling)
}

/**
 * HUD telemetry side-channel: the walker component writes these numbers at
 * 60 Hz; the HUD polls them slowly. Keeps live walk numbers out of React
 * state without the HUD needing three.js.
 */
export const walkReadout = { alt: 0, vel: 0, grounded: false, sprint: false }

/**
 * The ASTRONAUT-ON-FOOT's LOCATION — a property of the walker itself (the
 * avatar model), expressed in the frame of the body they stand on
 * (docs/positioning.txt §3 "BODY-FIXED", §5 lat/lon). It is NOT a HUD
 * concern: the walker OWNS these numbers and updates them only when it MOVES
 * relative to its body. While the astronaut stands still — even as the body
 * spins and orbits — the body-fixed location is unchanged (it co-rotates with
 * the body), so nothing is recomputed. The HUD and every other reader just
 * read it; the same pattern is meant to hold for crafts and bodies.
 *
 *   bodyId  the reference body the astronaut is standing on (null off-foot)
 *   dir     body-local unit direction — the continuous pose (§5)
 *   r       distance from the body's center (units)
 *   cell    the underfoot hex cell — the discrete identity (§5)
 *   fwd     body-local view heading — where the astronaut is looking
 *   lat/lon the derived human readout (geocentric; display only)
 */
export const walkerLocation = {
  bodyId: null,
  dir: [0, 1, 0],
  r: 0,
  cell: -1,
  fwd: [0, 0, 1],
  lat: 0,
  lon: 0,
}

/**
 * Downward acceleration at radius r around a body of mass `mass` under the
 * world's softened gravity law (matches stepGravity / orbitalSpeed).
 *
 * Tile mode (3-arg, the default): scaled for feel and clamped in world
 * units to stay walkable on everything from moons to giants — the sim's G
 * values are game-scale by design.
 *
 * Real mode (positive `scale`, meters per world unit): the world is
 * true-scale (masses are calibrated so the softened law reproduces the REAL
 * gravitational attraction in engine units), so the game-feel gravityScale
 * would corrupt a physical 9.8 m/s² Earth — instead the raw acceleration is
 * converted to m/s², clamped to the human-livable band, and converted back
 * to world units.
 */
export function surfaceGravity(worldG, mass, r, scale) {
  const raw = (worldG * Math.abs(mass)) / (r * r + C.physics.softeningEpsSq)
  if (!(Number.isFinite(scale) && scale > 0))
    return Math.min(SURFACE.maxGravity, Math.max(SURFACE.minGravity, raw * SURFACE.gravityScale))
  const ms2 = raw * scale
  return Math.min(SURFACE_REAL.maxGravityMs2, Math.max(SURFACE_REAL.minGravityMs2, ms2)) / scale
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

// ---------------------------------------------------------------------------
// The rendered top surface — chord-fan planes (the walked height field)
// ---------------------------------------------------------------------------
// The surface the walker rides is the surface the renderer draws: each cell's
// top is a triangle fan of CHORDS (center + corners, all vertices at radius
// R + h), so the fan lies in flat planes that sag below the sphere. Each fan
// triangle (C, E_k, E_{k+1}) defines one plane; since every vertex sits at
// radius rho = R + h, the plane's ORIENTATION depends only on the grid
// (cached once per frequency) while its distance from the center scales with
// rho — paint/shake updates of h cost nothing but the rescale.
//
// For a unit direction dir inside the cell, the fan's radius along dir is the
// LOWER ENVELOPE of the fan's planes:
//     r(dir) = min_k  rho·(n_k·c) / (n_k·dir)
// which equals the exact triangle intersection to machine precision for every
// direction in the cell (verified across all cells, freqs 1–24) — and at the
// exact cell-edge directions, where a single cell's triangles only meet in a
// line, the min still returns the shared edge's radius. It is also
// allocation-free (~6 dot products + divisions), keeping the 60 Hz walker and
// the ~1000-sample pick sweep cheap.
const fanTables = new Map() // frequency → { normals: Float64Array, centerCos: Float64Array }

function fanTable(frequency) {
  let t = fanTables.get(frequency)
  if (t) return t
  const hex = getHexSphere(frequency)
  const n = hex.cellCount
  const normals = new Float64Array(n * 6 * 3)
  const centerCos = new Float64Array(n * 6)
  for (let i = 0; i < n; i++) {
    const sn = hex.sides[i]
    const cx = hex.centers[i * 3]
    const cy = hex.centers[i * 3 + 1]
    const cz = hex.centers[i * 3 + 2]
    for (let k = 0; k < sn; k++) {
      const k3 = (i * 6 + k) * 3
      const k1 = (i * 6 + (k + 1) % sn) * 3
      // chord-triangle edges (E_k − C, E_{k+1} − C): direction-independent of rho
      const ax = hex.corners[k3] - cx
      const ay = hex.corners[k3 + 1] - cy
      const az = hex.corners[k3 + 2] - cz
      const bx = hex.corners[k1] - cx
      const by = hex.corners[k1 + 1] - cy
      const bz = hex.corners[k1 + 2] - cz
      let nx = ay * bz - az * by
      let ny = az * bx - ax * bz
      let nz = ax * by - ay * bx
      const l = Math.hypot(nx, ny, nz) || 1
      nx /= l
      ny /= l
      nz /= l
      // orient so the center vertex (and the body center's side) is positive
      let nc = nx * cx + ny * cy + nz * cz
      const o = (i * 6 + k) * 3
      if (nc < 0) {
        nx = -nx
        ny = -ny
        nz = -nz
        nc = -nc
      }
      normals[o] = nx
      normals[o + 1] = ny
      normals[o + 2] = nz
      centerCos[i * 6 + k] = nc // plane distance = rho · (n_k·c)
    }
  }
  t = { normals, centerCos }
  fanTables.set(frequency, t)
  return t
}

/**
 * Radius of the RENDERED top surface (the cell's chord-fan planes) along a
 * body-LOCAL unit direction `dir` inside cell `cell`, whose current vertex
 * radius is `rho` = R + h(cell). Falls back to `rho` if no plane faces dir
 * (degenerate guard — unreachable for a dir inside the cell).
 */
export function fanRadiusAt(hex, cell, rho, dir) {
  const t = fanTable(hex.frequency)
  const sn = hex.sides[cell]
  const o0 = cell * 6
  let best = Infinity
  for (let k = 0; k < sn; k++) {
    const o = (o0 + k) * 3
    const nd = t.normals[o] * dir[0] + t.normals[o + 1] * dir[1] + t.normals[o + 2] * dir[2]
    if (nd > 0) {
      const r = (rho * t.centerCos[o0 + k]) / nd
      if (r < best) best = r
    }
  }
  return best === Infinity ? rho : best
}

/**
 * Build a surface query over a snapshot of a planet document. Rebuild when
 * `planet.elements` identity changes — the same copy-on-write contract as
 * the geometry memo.
 *
 * `scale` (the world's physical scale — METERS per world unit, see the
 * tuning sections above): when positive, the astronaut is a real human —
 * SURFACE_REAL meters converted through it (1 m = 1/scale units) — instead
 * of one tile tall.
 *
 * Returns NULL for a DB stub (`elements: null`) — a surface query needs the
 * real document grid, and the freq-16 `preview` sample is not it. Callers
 * own hydration (landOnPlanet / launchCraft hydrate first; the Walker kicks
 * it and waits).
 * `heightAt(dir).radius` is the RENDERED surface radius along dir — the
 * chord fan of the cell underfoot (see above), continuous inside a cell and
 * jumping by the relief step across cell edges, exactly like the drawn mesh.
 * `h` remains the cell's per-element relief (the quantity the step/wall
 * logic compares — the in-cell fan sag must not read as terrain).
 *
 * @returns {{ hex, R: number, maxH: number, tile: number, real: number|null, metrics: object, heightAt: (dir:number[], hint?:number) => {cell:number,h:number,radius:number} } | null}
 */
export function makeSurface(planet, scale) {
  if (!planet || !Array.isArray(planet.elements)) return null
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
  // tuning becomes lengths. Everything walker-side reads these.
  const real = Number.isFinite(scale) && scale > 0 ? scale : null
  const S = real ? SURFACE_REAL : SURFACE
  const m2u = real ? 1 / real : tile // meters→units (real) | the tile scale
  const metrics = {
    eye: S.eye * m2u,
    walkSpeed: S.walkSpeed * m2u,
    stepUp: S.stepUp * m2u,
    stepDownSnap: S.stepDownSnap * m2u,
    jumpHeight: S.jumpHeight * m2u,
    maxFallSpeed: S.maxFallSpeed * m2u,
    spawnHover: S.spawnHover * m2u,
  }
  const heightAt = (dir, hint) => {
    const cell = cellAtDirection(hex, dir, hint)
    const h = hs[cell]
    // the RENDERED surface: the cell's chord fan at dir (== R + h at the
    // cell's own center, sagging toward its edges — the mesh underfoot)
    return { cell, h, radius: fanRadiusAt(hex, cell, R + h, dir) }
  }
  return { hex, R, maxH, hs, tile, real, metrics, heightAt }
}

/**
 * Body-fixed direction `angle` radians ahead of `dir`, along the ground in the
 * direction of `tangent` (the view heading; projected onto the plane ⊥ to dir).
 * The geometry half of Add Craft's placement: the caller decides the arc angle
 * (a few of the craft's own lengths, meters converted through the world's
 * scale — see store.js addCraft), so a meter-sized hull parks the same NUMBER
 * OF ITS OWN LENGTHS ahead on every world.
 *
 * @param {number[]} dir     body-fixed unit direction of the astronaut
 * @param {number[]} tangent body-fixed view heading (any length; projected)
 * @param {number} angle     arc angle in radians along the ground ahead
 * @returns {number[]} new body-fixed unit direction
 */
export function aheadDirection(dir, tangent, angle) {
  // the ground ahead: the heading projected onto the plane ⊥ to dir
  const dd = dot(tangent, dir)
  let tx = tangent[0] - dd * dir[0]
  let ty = tangent[1] - dd * dir[1]
  let tz = tangent[2] - dd * dir[2]
  if (tx * tx + ty * ty + tz * tz < 1e-12) {
    // looking straight up/down: a deterministic horizontal fallback (dir × ref)
    const rx = Math.abs(dir[1]) < 0.9 ? 0 : 1
    const ry = Math.abs(dir[1]) < 0.9 ? 1 : 0
    tx = -dir[2] * ry
    ty = dir[2] * rx
    tz = dir[0] * ry - dir[1] * rx
  }
  const tl = Math.hypot(tx, ty, tz) || 1
  tx /= tl
  ty /= tl
  tz /= tl
  // rotate dir about the axis (dir × tangent) by the arc angle
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  let ax = dir[1] * tz - dir[2] * ty
  let ay = dir[2] * tx - dir[0] * tz
  let az = dir[0] * ty - dir[1] * tx
  const al = Math.hypot(ax, ay, az) || 1
  ax /= al
  ay /= al
  az /= al
  // Rodrigues with dir·axis = 0:  dir·cos + (axis × dir)·sin
  const cx = ay * dir[2] - az * dir[1]
  const cy = az * dir[0] - ax * dir[2]
  const cz = ax * dir[1] - ay * dir[0]
  return norm3([dir[0] * c + cx * s, dir[1] * c + cy * s, dir[2] * c + cz * s])
}

/**
 * Ray → heightfield intersection in the planet-LOCAL frame: origin and dir
 * are number[3] arrays (dir any nonzero length; normalized here), no
 * triangle mesh involved — the surface is the rendered chord fans, queried
 * analytically (fanRadiusAt). The signed penetration function
 *   f(t) = |origin + t·dir| − (fan radius at the direction of that point)
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
    return len - fanRadiusAt(hex, hint, R + hs[hint], dirS)
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
    // f(t) jumps where the ray crosses a boundary between cells of unequal
    // height, and the bisection can land exactly on such a jump: the point at
    // `hi` may then sit above the surface of the cell the funnel reports.
    // Snap it radially onto that cell's RENDERED surface (its chord fan at
    // the hit direction) so a hit never floats, while `distance` keeps the
    // ray parameter of the entry itself.
    const point = [origin[0] + d[0] * hi, origin[1] + d[1] * hi, origin[2] + d[2] * hi]
    const len = Math.sqrt(point[0] * point[0] + point[1] * point[1] + point[2] * point[2])
    const radius = len > 0 ? fanRadiusAt(hex, hint, R + h, [point[0] / len, point[1] / len, point[2] / len]) : R + h
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
