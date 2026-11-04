/**
 * motion.js
 * ---------------------------------------------------------------------------
 * The CRAFT & ASTRONAUT MOTION framework (design: docs/flight.txt).
 * Framework-free (no three, no DOM) — the headless test scripts exercise it
 * directly, exactly like hexsphere/geometry/surface.
 *
 * Entity model
 *   You are always the ASTRONAUT. The astronaut is either
 *     on foot   — the walker (core/surface.js, byte-identical),
 *     in a craft — piloting it (its mover steps the craft's live state),
 *     adrift     — EVA in space: real gravity + jetpack (stepEva below),
 *   and the store (state/store.js) holds only the session identity
 *   (`player`), never the 60 Hz pose.
 *
 *   Crafts are WORLD OBJECTS (world.crafts[], persisted in the file like
 *   bodies) with their own position, momentum and a mover picked by `kind`
 *   (core/craftTypes.js). Live craft poses live in the mutable
 *   `craftRuntime` map below — the same contract as the physics registry
 *   and the walker: never through React state.
 *
 * Mover contract (a plugin is { enter?, step(state, input, dt), exit? }
 * over a mutable state object; `input` is null for unattended crafts):
 *   • spaceflight (shuttle, P1): flies in space; may LAND/PARK on a surface
 *     (altitude → 0), never drives. `real` integrates the softened gravity
 *     law of core/physics.js (ε² = 4 — the same force the bodies feel), so
 *     a craft falls into a body's influence, can orbit it and slingshot
 *     around it. `arcade` ignores gravity, eases its body-RELATIVE velocity
 *     toward the input, and moves at tile-anchored speed.
 *   • eva (adrift astronaut, P1): always Newtonian — gravity affects the
 *     astronaut too; the jetpack's thrust always outweighs local gravity.
 *   • walk (P1, lives in core/surface.js) and drive (P2) follow the same
 *     contract; the registry below is the place new movers plug in.
 *
 * The body-relative readout (altitude / lat-lon / dominance) has NO hard
 * trigger: `dominantBody()` returns the body with the largest softened
 * pull plus its share of the total pull (0..1), and the HUD fades the
 * readout in as that share grows — falling into a body's influence.
 *
 * Parking is a PERSISTED state: when a craft's altitude over its dominant
 * body reaches 0, stepCraft rewrites the craft's document pose to
 * `anchor: {bodyId, dir, r}` (dir in the body-LOCAL frame, so the craft
 * rides the body's spin and orbit for free, like the walker) and its live
 * state switches to mode 'park'. Launch (launchCraftState) does the
 * reverse: body velocity + spin surface velocity + a radial kick, facing
 * straight up (radially outward) so W thrusts away from the body.
 */

import { C } from './constants.js'
import { registry } from './physics.js'
import { planetRadius } from './planetMath.js'
import { getHexSphere } from './hexsphere.js'
import { cellAtDirection, fanRadiusAt, makeSurface } from './surface.js'
import { CRAFT_TYPES, EVA_TUNING } from './craftTypes.js'

export { CRAFT_TYPES, EVA_TUNING }

// ---------------------------------------------------------------------------
// small vec helpers (the core stays allocation-light, three-free)
// ---------------------------------------------------------------------------

export function norm3(v) {
  const l = Math.hypot(v[0], v[1], v[2])
  return l < 1e-12 ? [0, 1, 0] : [v[0] / l, v[1] / l, v[2] / l]
}
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
// NOTE: {x,y,z} objects (pos/vel), not arrays — NaN here would silently
// disable both landing checks (NaN <= threshold is always false)
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

/** Rotate vector v (array) by quaternion q ({x,y,z,w}). */
export function rotateByQuat(v, q) {
  const { x, y, z, w } = q
  const qx = x, qy = y, qz = z
  const tx = 2 * (qy * v[2] - qz * v[1])
  const ty = 2 * (qz * v[0] - qx * v[2])
  const tz = 2 * (qx * v[1] - qy * v[0])
  return [
    v[0] + w * tx + (qy * tz - qz * ty),
    v[1] + w * ty + (qz * tx - qx * tz),
    v[2] + w * tz + (qx * ty - qy * tx),
  ]
}
export function invertQuat(q) {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w }
}

// ---------------------------------------------------------------------------
// craft attitude — yaw about world +Y (ecliptic north), then pitch about the
// craft's own right axis. Orthonormal basis:
//   forward = (sinψ·cosθ, sinθ, cosψ·cosθ)
//   up      = (−sinψ·sinθ, cosθ, −cosψ·sinθ)
//   right   = (cosψ, 0, −sinψ)          (right = up × forward)
// A craft mesh is modeled nose +Z; the components build the basis matrix
// (right, up, forward) from these and set the quaternion.
// ---------------------------------------------------------------------------

export function craftVectors(yaw, pitch) {
  const cp = Math.cos(pitch), sp = Math.sin(pitch)
  const cy = Math.cos(yaw), sy = Math.sin(yaw)
  return {
    forward: [sy * cp, sp, cy * cp],
    up: [-sy * sp, cp, -cy * sp],
    right: [cy, 0, -sy],
  }
}

// ---------------------------------------------------------------------------
// the softened gravity field — the EXACT law core/physics.js applies
// between bodies (a = G·M/(d²+ε²) toward the body). Crafts, astronauts and
// everything else feel it in real mode; nothing here re-derives it.
// `bodies` is a Map id → registry entry {pos, vel, quat, mass, radius, planet?}
// (pass physics.registry.bodies).
// ---------------------------------------------------------------------------

export function gravityAt(p, G, bodies = registry.bodies) {
  const out = { x: 0, y: 0, z: 0 }
  const eps = C.physics.softeningEpsSq
  for (const b of bodies.values()) {
    if (!b.mass) continue
    const dx = b.pos.x - p.x
    const dy = b.pos.y - p.y
    const dz = b.pos.z - p.z
    const d2 = dx * dx + dy * dy + dz * dz
    const d = Math.sqrt(d2)
    if (d < 1e-9) continue
    const k = G * b.mass / ((d2 + eps) * d)
    out.x += dx * k
    out.y += dy * k
    out.z += dz * k
  }
  return out
}

/**
 * The body a position is most under the influence of: the largest softened
 * pull, with its share of the TOTAL pull (0..1). This continuous share is
 * the soft dominance metric the HUD fades in with — there is no hard
 * "you are now relative to the Moon" trigger.
 */
export function dominantBody(p, G, bodies = registry.bodies) {
  const eps = C.physics.softeningEpsSq
  let bestId = null
  let best = null
  let bestA = 0
  let total = 0
  for (const [id, b] of bodies) {
    if (!b.mass) continue
    const dx = b.pos.x - p.x
    const dy = b.pos.y - p.y
    const dz = b.pos.z - p.z
    const d2 = dx * dx + dy * dy + dz * dz
    const a = (G * b.mass) / (d2 + eps)
    total += a
    if (a > bestA) {
      bestA = a
      best = b
      bestId = id
    }
  }
  return best ? { id: bestId, body: best, pull: bestA, share: total > 0 ? bestA / total : 0 } : null
}

// ---------------------------------------------------------------------------
// surface queries for crafts (framework-free: the hex grid + cell lookup are
// core; no mesh, no three)
// ---------------------------------------------------------------------------

/** Hex-tile circumradius of a body (mirrors makeSurface's tile: a hex of
 *  area 4πR²/N has circumradius √(2·area/(3√3))). */
export function tileRadius(radius, frequency) {
  const n = 10 * frequency * frequency + 2
  return radius * Math.sqrt((8 * Math.PI) / (3 * Math.sqrt(3) * n))
}

/**
 * Altitude of world position p above a body's RENDERED SURFACE — terrain-
 * corrected (the chord fan of the nearest hex cell — the very surface the
 * walker rides and the mesh draws) when the body's elements are in hand,
 * flat-sphere otherwise. The landing trigger uses the cheap flat distance;
 * the HUD and the park radius use this.
 */
export function altitudeOf(p, body, planet) {
  const dx = p.x - body.pos.x
  const dy = p.y - body.pos.y
  const dz = p.z - body.pos.z
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (!planet || !planet.elements) return d - body.radius
  const dir = norm3([dx, dy, dz])
  const hex = getHexSphere(planet.frequency)
  const cell = cellAtDirection(hex, dir)
  const h = (planet.elements[cell] && planet.elements[cell].h) || 0
  return d - fanRadiusAt(hex, cell, body.radius + h, dir)
}

/**
 * Height (units) of the body's RENDERED surface above its base radius — the
 * chord fan of the hex cell under a body-LOCAL direction (any length;
 * normalized here). Callers add it to the body's base radius to get the
 * surface radius along that direction; it is the same surface the walker
 * rides (core/surface.js fanRadiusAt).
 */
export function heightAtDir(planet, dirLocal) {
  if (!planet || !planet.elements) return 0
  const hex = getHexSphere(planet.frequency)
  const cell = cellAtDirection(hex, dirLocal)
  const h = (planet.elements[cell] && planet.elements[cell].h) || 0
  const R = planetRadius(planet)
  return fanRadiusAt(hex, cell, R + h, norm3(dirLocal)) - R
}

/**
 * Lat/lon (degrees) of a body-LOCAL direction against the body's spin axis
 * (pole). The longitude reference meridian is the one nearest local +X.
 * Display data only — no physics reads it.
 */
export function latLonOf(dir, pole) {
  let p = norm3(pole)
  const d = norm3(dir)
  const lat = (Math.asin(Math.max(-1, Math.min(1, dot3(d, p)))) * 180) / Math.PI
  let ref = [1, 0, 0]
  if (Math.abs(p[0]) > 0.9) ref = [0, 0, 1]
  const x = norm3([ref[0] - p[0] * dot3(ref, p), ref[1] - p[1] * dot3(ref, p), ref[2] - p[2] * dot3(ref, p)])
  const y = cross3(p, x)
  const lon = (Math.atan2(dot3(d, y), dot3(d, x)) * 180) / Math.PI
  return { lat, lon }
}

// ---------------------------------------------------------------------------
// the runtime craft registry — live poses outside React state
// ---------------------------------------------------------------------------
// craftId → {
//   doc:     the craft document object (world.crafts[i]),
//   world:   the current world document (G, scale),
//   size:    the craft's length in world units (sizeMeters / world.scale),
//   state:   { mode:'park', bodyId, dir: number[3] (body-local), r }
//         |  { mode:'space', pos, vel: {x,y,z}, yaw, pitch }
// }
// In space, `vel` is ABSOLUTE for real crafts and RELATIVE to the dominant
// body for arcade ones (body-relative flight) — stepCraft knows which.

export const craftRuntime = new Map()

const ZERO = { x: 0, y: 0, z: 0 }

function stateFromPose(craft, world) {
  const a = craft.pose && craft.pose.anchor
  if (a) {
    const body = world.planets.find((q) => q.id === a.bodyId)
    const dir = Array.isArray(a.dir) && a.dir.length === 3 ? norm3(a.dir) : [0, 1, 0]
    // r may be null on a fresh file (Number(null) === 0 would read as a
    // finite "0" and launch the craft from the body's CENTER) — leave it
    // null and let syncCraftRuntime resolve it against the terrain
    const r = a.r != null && Number.isFinite(Number(a.r)) && Number(a.r) > 0 ? Number(a.r) : null
    // a drive craft (rover) persists its heading so it reloads facing the way
    // it was parked; a missing/invalid one is lazy-initialized on first drive
    const isDrive = craft.kind === 'drive'
    const heading =
      isDrive && Array.isArray(a.heading) && a.heading.length === 3 ? norm3(a.heading) : null
    return {
      mode: 'park',
      bodyId: a.bodyId,
      dir,
      r,
      // a drive craft (rover) obeys gravity but has no lift: it starts grounded
      // on its surface (r resolves to the chord fan on sync) and gains radial
      // velocity only by falling off a ledge (driveStep) — never by a jump.
      ...(isDrive ? { grounded: true, radialVel: 0 } : {}),
      ...(heading ? { heading } : {}),
    }
  }
  const sp = (craft.pose && craft.pose.space) || {}
  const pos = (v, i) => (Array.isArray(v) && Number.isFinite(v[i]) ? v[i] : 0)
  return {
    mode: 'space',
    pos: { x: pos(sp.pos, 0), y: pos(sp.pos, 1), z: pos(sp.pos, 2) },
    vel: { x: pos(sp.vel, 0), y: pos(sp.vel, 1), z: pos(sp.vel, 2) },
    yaw: Number.isFinite(Number(sp.yaw)) ? Number(sp.yaw) : 0,
    pitch: Number.isFinite(Number(sp.pitch)) ? Number(sp.pitch) : 0,
  }
}

/**
 * Reconcile craftRuntime with a world document. Called by the scene
 * (AmbientCrafts) whenever the document identity changes: fresh crafts get
 * a live state from their document pose, gone crafts are dropped, sizes
 * resolve from the world's scale (sizeMeters → world units), and a parked
 * craft whose `r` was never stored (null on a fresh file) lands on the
 * terrain.
 */
export function syncCraftRuntime(world) {
  // the document moved on: drop the cached rover surface (a new world's
  // element arrays are fresh identities, but this frees the old one now)
  driveSurface = null
  driveSurfaceKey = null
  const crafts = Array.isArray(world.crafts) ? world.crafts : []
  const seen = new Set()
  for (const craft of crafts) {
    if (!craft || !craft.id) continue
    seen.add(craft.id)
    let rt = craftRuntime.get(craft.id)
    if (!rt) {
      rt = { doc: craft, state: stateFromPose(craft, world) }
      craftRuntime.set(craft.id, rt)
    }
    rt.doc = craft
    rt.world = world

    // size: the craft's physical length in world units — sizeMeters converted
    // through the world's scale (1 m = 1/scale units), a fixed real-world size
    // like the real-human astronaut (surface.js SURFACE_REAL). Every world
    // carries a positive scale (worlds.scale NOT NULL), so this always resolves;
    // the fallback guards a malformed document.
    {
      const type = CRAFT_TYPES[craft.kind] || CRAFT_TYPES.shuttle
      const scale = Number.isFinite(world.scale) && world.scale > 0 ? world.scale : null
      rt.size = scale ? type.sizeMeters / scale : 0.5
    }

    // a parked craft whose anchor body vanished (body deleted) re-anchors
    // on the first landable body — the lenient contract
    if (rt.state.mode === 'park') {
      const body = world.planets.find((q) => q.id === rt.state.bodyId)
      if (!body) {
        const first = world.planets.find((q) => q.preset !== 'star')
        if (!first) continue
        rt.state = { mode: 'park', bodyId: first.id, dir: [0, 1, 0], r: planetRadius(first) }
        craft.pose = { anchor: { bodyId: first.id, dir: [0, 1, 0], r: planetRadius(first) } }
        continue
      }
      if (!Number.isFinite(rt.state.r)) {
        rt.state.r = planetRadius(body) + heightAtDir(body, rt.state.dir)
      }
    }
  }
  for (const id of [...craftRuntime.keys()]) if (!seen.has(id)) craftRuntime.delete(id)
}

/**
 * World pose of a craft for rendering: position + (up, forward) basis.
 * Parked crafts compose from their body's registry entry (pos + quat·dir·r)
 * — the float32-quantized entry, so the craft mesh rides the same stream as
 * the planet mesh.
 */
export function craftWorldPose(rt) {
  const st = rt.state
  if (st.mode === 'park') {
    const entry = registry.bodies.get(st.bodyId)
    if (!entry) return null
    const dirW = rotateByQuat(st.dir, entry.quat)
    // a drive craft (rover) faces its HEADING (a body-local tangent); any
    // other parked craft uses a deterministic tangent so it has a nose
    let fwdLocal
    if (rt.doc.kind === 'drive' && Array.isArray(st.heading)) fwdLocal = st.heading
    else {
      let ref = [1, 0, 0]
      if (Math.abs(st.dir[0]) > 0.9) ref = [0, 0, 1]
      fwdLocal = norm3(cross3(ref, st.dir))
    }
    return {
      pos: {
        x: entry.pos.x + dirW[0] * st.r,
        y: entry.pos.y + dirW[1] * st.r,
        z: entry.pos.z + dirW[2] * st.r,
      },
      up: dirW,
      forward: rotateByQuat(fwdLocal, entry.quat),
    }
  }
  const v = craftVectors(st.yaw, st.pitch)
  return { pos: st.pos, up: v.up, forward: v.forward }
}

/** Write the craft's current live state back into its document pose — the
 *  save path (store.captureCrafts) calls this so a file round-trips. */
export function captureCraftPose(rt) {
  const st = rt.state
  if (st.mode === 'space') {
    rt.doc.pose = {
      space: {
        pos: [st.pos.x, st.pos.y, st.pos.z],
        vel: [st.vel.x, st.vel.y, st.vel.z],
        yaw: st.yaw,
        pitch: st.pitch,
      },
    }
  } else {
    // a drive craft (rover) also persists its heading so it reloads facing the
    // way it was parked
    const anchor = { bodyId: st.bodyId, dir: [st.dir[0], st.dir[1], st.dir[2]], r: st.r }
    if (rt.doc.kind === 'drive' && Array.isArray(st.heading))
      anchor.heading = [st.heading[0], st.heading[1], st.heading[2]]
    rt.doc.pose = { anchor }
  }
}

// ---------------------------------------------------------------------------
// the spaceflight mover (shuttle)
// ---------------------------------------------------------------------------

const LAND_EPS = 0.002 // fraction of the body radius: at or under this, land
const LAUNCH_LIFT = 0.005 // fraction of the body radius to launch from — a few
                          // landing-bands above the pad, so the craft starts
                          // OUTSIDE the landing band (never re-parks on its
                          // first frame). Body-scale by design: a meter-sized
                          // craft is tiny next to the band it must clear.

function parkCraft(rt, id, body) {
  const st = rt.state
  const dx = st.pos.x - body.pos.x
  const dy = st.pos.y - body.pos.y
  const dz = st.pos.z - body.pos.z
  const d = Math.max(Math.hypot(dx, dy, dz), 1e-9)
  const dirW = [dx / d, dy / d, dz / d]
  const dir = rotateByQuat(dirW, invertQuat(body.quat)) // body-LOCAL: rides the spin
  const r = body.radius + heightAtDir(body.planet, dir)
  rt.doc.pose = { anchor: { bodyId: id, dir, r } } // parking is persisted
  st.mode = 'park'
  st.bodyId = id
  st.dir = dir
  st.r = r
  delete st.pos
  delete st.vel
}

/**
 * Step one craft by dt. `input` (flightInput below, or null when the
 * astronaut is not in it): { fwd, back, left, right, up, down, boost, retro,
 * yaw, pitch, lookDX, lookDY } — lookDX/lookDY are pointer-drag pixels,
 * consumed (zeroed) here. Returns the state, or null for a parked craft.
 */
export function stepCraft(craft, dt, input = null) {
  const rt = craftRuntime.get(craft.id)
  if (!rt) return null
  const st = rt.state
  const world = rt.world
  if (!world) return null
  if (st.mode === 'park') {
    // a drive craft (rover) is ground-locked: piloting it DRIVES it along the
    // surface (it never flies). Other parked crafts just ride the body.
    if (input && craft.kind === 'drive') driveStep(rt, input, dt)
    return null // parked: nothing to integrate in space
  }

  const type = CRAFT_TYPES[craft.kind] || CRAFT_TYPES.shuttle
  const dom = dominantBody(st.pos, world.gravity)
  const v = craftVectors(st.yaw, st.pitch)
  // inputs may be partial (the app passes the full flightInput; tests may
  // pass just the pressed axes) — absent axes read as 0
  const fwdIn = (input?.fwd || 0) - (input?.back || 0)
  const strIn = (input?.right || 0) - (input?.left || 0)
  const vertIn = (input?.up || 0) - (input?.down || 0)
  const boost = input?.boost

  if (craft.realism === 'real') {
    // Newtonian: the softened gravity law on everything + thrust along the
    // craft frame. Velocities are ABSOLUTE — the craft orbits, falls,
    // slingshot, exactly like a body would.
    const t = type.real
    const thrust = (world.scale ? t.thrustMps2 / world.scale : t.thrustUps2) * (boost ? t.boost : 1)
    const g = gravityAt(st.pos, world.gravity)
    const retro = input && input.retro ? 2 : 0
    const ax = v.forward[0] * thrust * (fwdIn - retro) + v.right[0] * thrust * strIn + v.up[0] * thrust * vertIn + g.x
    const ay = v.forward[1] * thrust * (fwdIn - retro) + v.right[1] * thrust * strIn + v.up[1] * thrust * vertIn + g.y
    const az = v.forward[2] * thrust * (fwdIn - retro) + v.right[2] * thrust * strIn + v.up[2] * thrust * vertIn + g.z
    st.vel.x += ax * dt
    st.vel.y += ay * dt
    st.vel.z += az * dt
    st.pos.x += st.vel.x * dt
    st.pos.y += st.vel.y * dt
    st.pos.z += st.vel.z * dt
    if (input && input.yaw) st.yaw += t.yawRate * input.yaw * dt
    if (input && input.pitch) st.pitch += t.pitchRate * input.pitch * dt
  } else {
    // Arcade: NON-Newtonian. No gravity; the body-RELATIVE velocity eases
    // onto the input target at tile-anchored speed (plug-and-play on any
    // world, true-scale included); the world position rides the dominant
    // body's velocity so "held still" means "held over the ground".
    const t = type.arcade
    const host = dom && dom.body.planet ? dom.body : null
    const tile = host ? tileRadius(host.radius, host.planet.frequency) : 1
    const spd = t.speedTiles * tile * (boost ? t.boost : 1)
    const k = 1 - Math.exp(-dt / t.ease)
    const tvx = v.forward[0] * spd * fwdIn + v.right[0] * spd * strIn + v.up[0] * spd * vertIn
    const tvy = v.forward[1] * spd * fwdIn + v.right[1] * spd * strIn + v.up[1] * spd * vertIn
    const tvz = v.forward[2] * spd * fwdIn + v.right[2] * spd * strIn + v.up[2] * spd * vertIn
    st.vel.x += (tvx - st.vel.x) * k
    st.vel.y += (tvy - st.vel.y) * k
    st.vel.z += (tvz - st.vel.z) * k
    const bv = (dom && dom.body.vel) || ZERO
    st.pos.x += (bv.x + st.vel.x) * dt
    st.pos.y += (bv.y + st.vel.y) * dt
    st.pos.z += (bv.z + st.vel.z) * dt
    if (input && input.yaw) st.yaw += t.yawRate * input.yaw * dt
    if (input && input.pitch) st.pitch += t.pitchRate * input.pitch * dt
  }

  // pointer look-drag steers the attitude (consumed once per frame)
  if (input) {
    if (input.lookDX) {
      st.yaw -= input.lookDX * 0.0032
      input.lookDX = 0
    }
    if (input.lookDY) {
      st.pitch = Math.max(-1.45, Math.min(1.45, st.pitch - input.lookDY * 0.0032))
      input.lookDY = 0
    }
  }

  // landing: altitude over the dominant body's surface → 0
  if (dom) {
    const d = dist3(st.pos, dom.body.pos)
    if (d - dom.body.radius <= LAND_EPS * dom.body.radius) parkCraft(rt, dom.id, dom.body)
  }
  return st
}

// ---------------------------------------------------------------------------
// the drive mover (rover, P2) — a ground-locked vehicle that NEVER flies
// ---------------------------------------------------------------------------
// The rover is always in the parked anchor state ({ mode:'park', bodyId, dir
// (body-LOCAL), r }) — driving just moves that anchor along the RENDERED
// surface (the same chord-fan the walker rides), so it welds to the terrain
// and rides the body's spin/orbit for free. It has a body-LOCAL HEADING
// (the direction it faces) and a live THROTTLE; `input` is the shared
// flightInput (fwd/back = throttle, yaw = steer, boost = Shift). Like the
// arcade shuttle its speed is TILE-ANCHORED, so it crosses terrain at a game
// pace on every world. It has no 'space' mode — launchCraftState refuses it.

// The piloted rover's body surface query (makeSurface over its elements). Only
// one rover is piloted at a time, so a single cache slot keyed by the elements
// identity suffices: a copy-on-write paint or a different body rebuilds it, and
// an unattended (or stub-bodied) rover never builds one.
let driveSurface = null
let driveSurfaceKey = null
function getDriveSurface(planet) {
  if (!planet || !planet.elements) return null
  if (driveSurfaceKey !== planet.elements) {
    driveSurface = makeSurface(planet, null) // only heightAt / tile / hex are used
    driveSurfaceKey = planet.elements
  }
  return driveSurface
}

// Rotate unit v about unit axis by angle (rad) — Rodrigues, allocation-light
// (v is a tangent so v·axis ≈ 0 and the axis-parallel term vanishes).
function rotateAboutAxis(v, axis, angle) {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const cross = cross3(axis, v)
  return [v[0] * c + cross[0] * s, v[1] * c + cross[1] * s, v[2] * c + cross[2] * s]
}
// Project v onto the tangent plane ⊥ dir (the local up) and normalize.
function reTangent(v, dir) {
  const d = dot3(v, dir)
  const t = [v[0] - dir[0] * d, v[1] - dir[1] * d, v[2] - dir[2] * d]
  const l = Math.hypot(t[0], t[1], t[2])
  return l < 1e-12 ? null : [t[0] / l, t[1] / l, t[2] / l]
}
// A deterministic tangent perpendicular to dir (a default heading).
function tangentTo(dir) {
  const ref = Math.abs(dir[0]) > 0.9 ? [0, 0, 1] : [1, 0, 0]
  return norm3(cross3(ref, dir))
}

/** Step the piloted ROVER by dt against its body's rendered surface. Mutates
 *  the anchor (dir, r, heading, cell, speed). Pure core math — no three. */
function driveStep(rt, input, dt) {
  const st = rt.state
  const world = rt.world
  const body = world.planets.find((q) => q.id === st.bodyId)
  if (!body) return
  const surface = getDriveSurface(body)
  if (!surface) return // stub (no elements): nothing to drive on, sit still

  const type = CRAFT_TYPES.drive
  const tile = surface.tile
  // tile-anchored top speed (game pace on every world), in world units
  const speedMax = type.speedTiles * tile * (input.boost ? type.boost : 1)
  const climb = type.climbTiles * tile
  // the fall (see the drive tuning): a drop beyond `drop` goes airborne, and
  // while airborne the radial velocity integrates against `gravity`, clamped
  // at `maxFall`. All in world units (tiles × the body's tile radius).
  const drop = type.dropTiles * tile
  const gravity = type.gravityTiles * tile
  const maxFall = type.maxFallTiles * tile
  // smooth the throttle toward its target (ease)
  const throttle = (input.fwd || 0) - (input.back || 0)
  st.speed = (st.speed || 0) + (throttle * speedMax - (st.speed || 0)) * (1 - Math.exp(-dt / type.ease))

  // heading: a body-local tangent the rover faces; lazy-initialized
  if (!Array.isArray(st.heading)) st.heading = tangentTo(st.dir)
  // steer: rotate the heading about the local up (dir)
  if (input.yaw) st.heading = reTangent(rotateAboutAxis(st.heading, st.dir, type.turnRate * input.yaw * dt), st.dir)

  const d = st.dir
  const h = st.heading
  const hd = dot3(h, d)
  const tx = h[0] - d[0] * hd
  const ty = h[1] - d[1] * hd
  const tz = h[2] - d[2] * hd
  const tl = Math.hypot(tx, ty, tz)
  if (tl > 1e-9 && Math.abs(st.speed) > 1e-12) {
    const k = (st.speed * dt) / Math.max(st.r, 0.25) // arc angle swept this step
    const dirTo = (vx, vy, vz) => {
      const l = Math.hypot(vx, vy, vz) || 1
      return norm3([d[0] + (vx / l) * k, d[1] + (vy / l) * k, d[2] + (vz / l) * k])
    }
    let nd = dirTo(tx, ty, tz)
    const ground = surface.heightAt(d, st.cell)
    let next = surface.heightAt(nd, st.cell)
    // walls: a GROUND-LOCKED rover can't step up more than the climb limit —
    // the move is blocked and slides along the wall (the walker's rule, at the
    // rover's climb). An airborne rover clears relief freely (it's in the air).
    let blocked = st.grounded && next.h - ground.h > climb
    if (blocked) {
      const bn = reTangent(nd, d) // the direction into the blocked cell
      if (bn) {
        const bnd = tx * bn[0] + ty * bn[1] + tz * bn[2]
        const px = tx - bn[0] * bnd
        const py = ty - bn[1] * bnd
        const pz = tz - bn[2] * bnd
        if (px * px + py * py + pz * pz > 1e-9) {
          nd = dirTo(px, py, pz)
          next = surface.heightAt(nd, st.cell)
          blocked = next.h - ground.h > climb
        }
      }
    }
    if (!blocked) {
      // parallel-transport the heading with the move (the walker does the
      // same for its view): the great-circle step is a rotation about
      // norm(d × nd), and applying it to the heading keeps the nose on the
      // horizon — without it, a long unsteered drive leaves the stored
      // heading behind and the nose tilts into the ground (h·d = sin θ).
      const ax = cross3(d, nd)
      const al = Math.hypot(ax[0], ax[1], ax[2])
      if (al > 1e-12) {
        const ang = Math.atan2(al, dot3(d, nd))
        st.heading = reTangent(rotateAboutAxis(st.heading, [ax[0] / al, ax[1] / al, ax[2] / al], ang), nd)
      }
      st.dir = nd
      st.cell = next.cell
    }
  }

  // ---- vertical: the rover obeys gravity but has NO lift ------------------
  // The same grounded/airborne state machine the walker runs (core/surface.js
  // stepWalker), minus the jump. Grounded, it tracks the rendered chord fan
  // (the weld); a downhill step bigger than the drop limit means it drove off
  // a ledge → airborne. Airborne, the radial velocity integrates against a
  // tile-anchored gravity and the fall ends on contact. There is no input that
  // raises it, so radialVel only ever goes inward — it can fall, not fly.
  const ground = surface.heightAt(st.dir, st.cell)
  st.cell = ground.cell
  if (st.grounded) {
    if (st.r - ground.radius <= drop) {
      st.r = ground.radius // track the ground: small steps up/down + terrain edits
    } else {
      st.grounded = false
      st.radialVel = 0 // drove off a taller ledge: start the fall from rest
    }
  }
  if (!st.grounded) {
    st.radialVel = Math.max(st.radialVel - gravity * dt, -maxFall)
    st.r += st.radialVel * dt
    if (st.r <= ground.radius) {
      st.r = ground.radius // contact — the surface is star-shaped, so it always ends
      st.radialVel = 0
      st.grounded = true
    }
  }
}

// ---------------------------------------------------------------------------
// launch & eject (called by the store; mutate the runtime + document pose)
// ---------------------------------------------------------------------------

/**
 * Launch a parked craft: position on its anchor point, velocity = body
 * velocity + spin surface velocity (ω×r) + a small radial kick, attitude
 * facing radially outward (W thrusts away from the body). The document pose
 * switches to `space` — from here the live state is truth until it parks
 * again or the world is saved.
 */
export function launchCraftState(craftId) {
  const rt = craftRuntime.get(craftId)
  // a drive craft (rover) is ground-locked — it has no launch, only driving
  if (!rt || rt.state.mode !== 'park' || rt.doc.kind === 'drive') return null
  const st = rt.state
  const world = rt.world
  const body = world.planets.find((q) => q.id === st.bodyId)
  const entry = registry.bodies.get(st.bodyId)
  const type = CRAFT_TYPES[rt.doc.kind] || CRAFT_TYPES.shuttle
  if (!entry) return null
  // r must be resolved (syncCraftRuntime does it for a live body) — a null
  // here would put the launch position at NaN
  if (!Number.isFinite(st.r)) st.r = entry.radius + heightAtDir(body, st.dir)
  const dirW = rotateByQuat(st.dir, entry.quat)
  const spin = (body && body.spin) || { x: 0, y: 0, z: 0 }
  const rvec = [dirW[0] * st.r, dirW[1] * st.r, dirW[2] * st.r]
  const vspin = cross3([spin.x, spin.y, spin.z], rvec)
  const kick = world.scale ? type.real.kickMps2 / world.scale : type.real.kickUps2
  // lift the launch point LAUNCH_LIFT·radius above the pad — body-scale, so a
  // meter-sized craft still clears the landing band on every body (the old
  // rt.size·2 offset was tied to the tile and is far too small for a 30 m hull)
  const lift = LAUNCH_LIFT * entry.radius
  const pos = {
    x: entry.pos.x + dirW[0] * (st.r + lift),
    y: entry.pos.y + dirW[1] * (st.r + lift),
    z: entry.pos.z + dirW[2] * (st.r + lift),
  }
  const vel = {
    x: entry.vel.x + vspin[0] + dirW[0] * kick,
    y: entry.vel.y + vspin[1] + dirW[1] * kick,
    z: entry.vel.z + vspin[2] + dirW[2] * kick,
  }
  if (rt.doc.realism === 'arcade') {
    // arcade velocity is RELATIVE to the body: strip the body's own motion
    vel.x -= entry.vel.x
    vel.y -= entry.vel.y
    vel.z -= entry.vel.z
    // …and give it the pad's radial kick in rel terms too (launchTiles)
    vel.x += dirW[0] * type.arcade.launchTiles * tileRadius(entry.radius, body ? body.frequency : 1)
    vel.y += dirW[1] * type.arcade.launchTiles * tileRadius(entry.radius, body ? body.frequency : 1)
    vel.z += dirW[2] * type.arcade.launchTiles * tileRadius(entry.radius, body ? body.frequency : 1)
  }
  st.pos = pos
  st.vel = vel
  st.yaw = Math.atan2(dirW[0], dirW[2]) // facing straight up (radially outward)
  st.pitch = Math.asin(Math.max(-1, Math.min(1, dirW[1])))
  st.mode = 'space'
  captureCraftPose(rt)
  return st
}

/**
 * Eject the astronaut from a craft. Parked → on foot at the craft's anchor
 * point (dir in body-local, consumed by the Walker). Flying → adrift (EVA)
 * inheriting the craft's ABSOLUTE velocity (arcade rel-velocity is turned
 * back into world velocity with the dominant body's motion).
 */
export function ejectCraftState(craftId) {
  const rt = craftRuntime.get(craftId)
  if (!rt) return null
  const st = rt.state
  if (st.mode === 'park') {
    return { type: 'foot', bodyId: st.bodyId, dir: [st.dir[0], st.dir[1], st.dir[2]] }
  }
  const world = rt.world
  const dom = dominantBody(st.pos, world ? world.gravity : 40)
  const bv = (dom && dom.body.vel) || ZERO
  const vel =
    rt.doc.realism === 'real'
      ? { x: st.vel.x, y: st.vel.y, z: st.vel.z }
      : { x: st.vel.x + bv.x, y: st.vel.y + bv.y, z: st.vel.z + bv.z }
  return {
    type: 'eva',
    pos: { x: st.pos.x, y: st.pos.y, z: st.pos.z },
    vel,
    yaw: st.yaw,
    pitch: st.pitch,
  }
}

// ---------------------------------------------------------------------------
// the eva mover — the adrift astronaut. Real gravity ALWAYS (the astronaut
// is an object too); the jetpack's thrust is max(base, hoverRatio × local
// gravity), so it can hover on every body without tuning.
// ---------------------------------------------------------------------------

export const eva = { state: null } // { pos, vel, yaw, pitch }

/** The world the EVA/ambient steps run against (set by the scene each time
 *  the document changes; keeps motion.js store-free). */
let motionWorld = null
export function setMotionWorld(world) {
  motionWorld = world
}

/** Step the adrift astronaut. Returns a land event
 *  { type:'land', bodyId, dir } (dir body-LOCAL) when the fall ends, or null.
 *  On a land event the EVA state is cleared — the store takes over. */
export function stepEva(dt, input = null) {
  const s = eva.state
  if (!s || !motionWorld) return null
  const T = EVA_TUNING
  const g = gravityAt(s.pos, motionWorld.gravity)
  const gmag = Math.hypot(g.x, g.y, g.z)
  const base = (motionWorld.scale ? T.thrustMps2 / motionWorld.scale : T.thrustUps2) * (input && input.boost ? T.boost : 1)
  const thrust = Math.max(base, gmag * T.hoverRatio)
  const v = craftVectors(s.yaw, s.pitch)
  const fwdIn = (input?.fwd || 0) - (input?.back || 0)
  const strIn = (input?.right || 0) - (input?.left || 0)
  const vertIn = (input?.up || 0) - (input?.down || 0)
  const ax = v.forward[0] * thrust * fwdIn + v.right[0] * thrust * strIn + v.up[0] * thrust * vertIn + g.x
  const ay = v.forward[1] * thrust * fwdIn + v.right[1] * thrust * strIn + v.up[1] * thrust * vertIn + g.y
  const az = v.forward[2] * thrust * fwdIn + v.right[2] * thrust * strIn + v.up[2] * thrust * vertIn + g.z
  s.vel.x += ax * dt
  s.vel.y += ay * dt
  s.vel.z += az * dt
  s.pos.x += s.vel.x * dt
  s.pos.y += s.vel.y * dt
  s.pos.z += s.vel.z * dt
  if (input) {
    if (input.yaw) s.yaw += T.yawRate * input.yaw * dt
    if (input.pitch) s.pitch = Math.max(-1.45, Math.min(1.45, s.pitch + T.pitchRate * input.pitch * dt))
    if (input.lookDX) {
      s.yaw -= input.lookDX * 0.0032
      input.lookDX = 0
    }
    if (input.lookDY) {
      s.pitch = Math.max(-1.45, Math.min(1.45, s.pitch - input.lookDY * 0.0032))
      input.lookDY = 0
    }
  }
  // the fall ends on the dominant body's surface → on foot there
  const dom = dominantBody(s.pos, motionWorld.gravity)
  if (dom) {
    const d = dist3(s.pos, dom.body.pos)
    if (d - dom.body.radius <= 0.005 * dom.body.radius) {
      const dirW = norm3([s.pos.x - dom.body.pos.x, s.pos.y - dom.body.pos.y, s.pos.z - dom.body.pos.z])
      eva.state = null
      return { type: 'land', bodyId: dom.id, dir: rotateByQuat(dirW, invertQuat(dom.body.quat)) }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// shared side channels (the 60 Hz state the HUD polls, never React state)
// ---------------------------------------------------------------------------

/** Control input for the piloted craft / adrift astronaut. Components set
 *  the flags from key events and pointer drags; the step loops consume
 *  lookDX/lookDY (zeroed per frame) and read the rest. The headless harness
 *  drives it directly. */
export const flightInput = {
  fwd: 0,
  back: 0,
  left: 0,
  right: 0,
  up: 0,
  down: 0,
  boost: false,
  retro: false,
  yaw: 0,
  pitch: 0,
  lookDX: 0,
  lookDY: 0,
}
export function resetFlightInput() {
  flightInput.fwd = 0
  flightInput.back = 0
  flightInput.left = 0
  flightInput.right = 0
  flightInput.up = 0
  flightInput.down = 0
  flightInput.boost = false
  flightInput.retro = false
  flightInput.yaw = 0
  flightInput.pitch = 0
  flightInput.lookDX = 0
  flightInput.lookDY = 0
}

/** ASTRONAUT-ON-FOOT handoff: the store writes {bodyId, dir} (dir
 *  body-LOCAL) when the walker must spawn at a specific point (ejecting a
 *  parked craft, an EVA landing); the Walker consumes it once on mount. */
export const pendingFoot = { bodyId: null, dir: null }

/** HUD telemetry for craft / EVA sessions (walk mode keeps its own
 *  walkReadout in core/surface.js). Written by the step loops, polled at
 *  ~8 Hz by MotionHud — 60 Hz physics never flows through React state. */
export const motionReadout = {
  // piloted craft
  craftId: null,
  name: '',
  realism: '',
  mode: '', // 'park' | 'space'
  bodyName: null, // dominant (or anchor) body
  dominance: 0, // 0..1 share of total gravitational pull
  altitude: 0, // above the surface, units (terrain-corrected, throttled)
  relSpeed: 0, // body-relative speed, units/s
  lat: null,
  lon: null,
  // adrift astronaut
  evaSpeed: 0,
  evaBodyName: null,
  evaAltitude: 0,
}

let altFrame = 0
/** Refresh the motionReadout craft fields (called by the step loop for the
 *  piloted craft only — the HUD shows one session at a time). */
export function writeCraftReadout(craft) {
  const rt = craftRuntime.get(craft.id)
  const r = motionReadout
  if (!rt) return
  const st = rt.state
  r.craftId = craft.id
  r.name = craft.name
  r.realism = craft.realism
  r.mode = st.mode
  const world = rt.world
  if (st.mode === 'park') {
    const body = world.planets.find((q) => q.id === st.bodyId)
    r.bodyName = body ? body.name : null
    r.dominance = 1
    r.altitude = 0
    r.relSpeed = 0
    r.lat = null
    r.lon = null
    if (craft.kind === 'drive') {
      // a rover shows its throttle speed and its body-fixed lat/lon (the spin
      // axis spun back into the local frame); and — since it now obeys gravity
      // and can be airborne (falling off a ledge) — its altitude above the
      // rendered surface (0 when grounded, > 0 mid-fall)
      r.relSpeed = Math.abs(st.speed || 0)
      r.altitude = body ? Math.max(0, st.r - (planetRadius(body) + heightAtDir(body, st.dir))) : 0
      const entry = registry.bodies.get(st.bodyId)
      const spin = body && body.spin
      const hasSpin = entry && spin && (spin.x || spin.y || spin.z)
      const poleL = hasSpin ? rotateByQuat([spin.x, spin.y, spin.z], invertQuat(entry.quat)) : [0, 1, 0]
      const ll = latLonOf(st.dir, poleL)
      r.lat = ll.lat
      r.lon = ll.lon
    }
    return
  }
  const dom = dominantBody(st.pos, world.gravity)
  if (!dom) {
    r.bodyName = null
    r.dominance = 0
    r.altitude = 0
    r.relSpeed = Math.hypot(st.vel.x, st.vel.y, st.vel.z)
    r.lat = null
    r.lon = null
    return
  }
  const b = dom.body
  r.bodyName = bodyNameOf(world, dom.id)
  r.dominance = dom.share
  altFrame++
  // terrain-corrected altitude is a cell search — every 6th frame is plenty
  // for an 8 Hz HUD; the cheap flat number keeps the rest exact
  if (altFrame % 6 === 0) r.altitude = Math.max(0, altitudeOf(st.pos, b, b.planet))
  const bv = b.vel || ZERO
  r.relSpeed = Math.hypot(st.vel.x - bv.x, st.vel.y - bv.y, st.vel.z - bv.z)
  if (b.quat) {
    const dirW = norm3([st.pos.x - b.pos.x, st.pos.y - b.pos.y, st.pos.z - b.pos.z])
    const dirL = rotateByQuat(dirW, invertQuat(b.quat))
    const spin = (world.planets.find((q) => q.id === dom.id) || {}).spin || null
    const poleL = spin ? rotateByQuat([spin.x, spin.y, spin.z], invertQuat(b.quat)) : [0, 1, 0]
    const ll = latLonOf(dirL, poleL)
    r.lat = ll.lat
    r.lon = ll.lon
  }
}

let evaFrame = 0
/** Refresh the motionReadout EVA fields (called by the EVA step loop). */
export function writeEvaReadout() {
  const s = eva.state
  const r = motionReadout
  if (!s || !motionWorld) return
  const dom = dominantBody(s.pos, motionWorld.gravity)
  evaFrame++
  if (dom) {
    r.evaBodyName = bodyNameOf(motionWorld, dom.id)
    r.evaAltitude = evaFrame % 6 === 0 ? Math.max(0, altitudeOf(s.pos, dom.body, dom.body.planet)) : r.evaAltitude
  } else {
    r.evaBodyName = null
    r.evaAltitude = 0
  }
  r.evaSpeed = Math.hypot(s.vel.x, s.vel.y, s.vel.z)
}

function bodyNameOf(world, id) {
  const p = world.planets.find((q) => q.id === id)
  return p ? p.name : null
}
