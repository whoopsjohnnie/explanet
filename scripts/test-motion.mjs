/**
 * test-motion.mjs — the craft & astronaut motion framework (core/motion.js),
 * tested exactly like the other core modules: pure node, no DOM, no three.
 *
 * Pins the contract docs/flight.txt promises:
 *  - the craft attitude basis is orthonormal and identity at zero
 *  - gravityAt is the EXACT softened law the bodies feel (matches the
 *    orbitalSpeed identity), zero with no mass
 *  - dominantBody's share is a true 0..1 fraction and picks the near body
 *  - craft documents normalize/repair leniently and round-trip through
 *    serializeWorld
 *  - the spaceflight mover: arcade eases to the input at tile speed with NO
 *    gravity and lands (parks) at altitude → 0; real integrates gravity and
 *    falls toward the body; launch gives a radial kick facing up
 *  - the EVA mover: the jetpack always outweighs gravity (hover), and a
 *    fall ending on a surface returns the land event (on foot)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orbitalSpeed, registry } from '../src/core/physics.js'
import {
  craftVectors,
  gravityAt,
  dominantBody,
  tileRadius,
  altitudeOf,
  latLonOf,
  rotateByQuat,
  invertQuat,
  craftRuntime,
  syncCraftRuntime,
  stepCraft,
  launchCraftState,
  ejectCraftState,
  craftWorldPose,
  setMotionWorld,
  stepEva,
  eva,
  flightInput,
  resetFlightInput,
  pendingFoot,
  writeCraftReadout,
  motionReadout,
} from '../src/core/motion.js'
import { normalizeWorld, serializeWorld, createCraft } from '../src/core/worldSchema.js'
import { makeSurface } from '../src/core/surface.js'
import { getHexSphere, dotCenter } from '../src/core/hexsphere.js'

// a tiny two-body field: a heavy body at the origin + a light one 100 away
const BODIES = new Map([
  ['b1', { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 }, mass: 1000, radius: 20, planet: null }],
  ['b2', { pos: { x: 100, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 }, mass: 10, radius: 5, planet: null }],
])

function makeWorld(crafts, extra = {}) {
  return {
    version: 1,
    name: 't',
    gravity: 40,
    scale: 100, // every world carries a scale (meters per unit); craft size resolves from it
    planets: [
      {
        id: 'b1',
        name: 'Body',
        preset: 'earthlike',
        frequency: 3,
        isStatic: true,
        center: { x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        spin: { x: 0, y: 0, z: 0 },
        elements: new Array(10 * 9 + 2).fill(null).map(() => ({ t: 'grass', h: 0 })),
      },
    ],
    crafts,
    ...extra,
  }
}
/** A stand-in for the physics worker's registry (swap in, restore after). */
function useBodies(map) {
  const saved = registry.bodies
  registry.bodies = map
  return () => {
    registry.bodies = saved
  }
}

test('craftVectors: orthonormal basis, identity at zero attitude', () => {
  for (const [yaw, pitch] of [[0, 0], [0.7, -0.4], [2.1, 1.2], [-3.0, 0.3]]) {
    const { forward, up, right } = craftVectors(yaw, pitch)
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    for (const v of [forward, up, right]) assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-12, 'unit')
    assert.ok(Math.abs(dot(forward, up)) < 1e-12)
    assert.ok(Math.abs(dot(forward, right)) < 1e-12)
    assert.ok(Math.abs(dot(up, right)) < 1e-12)
  }
  // (tolerance compare: the basis carries signed zeros, deepEqual would fight -0)
  const near = (a, b) => a.every((x, i) => Math.abs(x - b[i]) < 1e-15)
  const v0 = craftVectors(0, 0)
  assert.ok(near(v0.forward, [0, 0, 1]), `forward ${v0.forward}`)
  assert.ok(near(v0.up, [0, 1, 0]), `up ${v0.up}`)
  assert.ok(near(v0.right, [1, 0, 0]), `right ${v0.right}`)
})

test('rotateByQuat: unit quaternion round-trip (rotate then invert)', () => {
  // a NON-unit quaternion scales, so normalize first (registry quats are unit)
  const n = Math.hypot(0.1, 0.5, -0.2, 0.8)
  const q = { x: 0.1 / n, y: 0.5 / n, z: -0.2 / n, w: 0.8 / n }
  const v = [0.3, -0.6, 0.7]
  const back = rotateByQuat(rotateByQuat(v, q), invertQuat(q))
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(back[i] - v[i]) < 1e-12)
  // and a known 90° about +Z: +X → +Y
  const q90 = { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 }
  const r90 = rotateByQuat([1, 0, 0], q90)
  assert.ok(Math.abs(r90[0]) < 1e-15 && Math.abs(r90[1] - 1) < 1e-15 && Math.abs(r90[2]) < 1e-15, `got ${r90}`)
})

test('gravityAt: the exact softened law (orbital-speed identity) and zero mass', () => {
  const bodies = new Map([['m', { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, mass: 500, radius: 10 }]])
  const G = 40
  const r = 37
  const p = { x: r, y: 0, z: 0 }
  const g = gravityAt(p, G, bodies)
  // circular orbit: v²/r = G·M/(r²+ε²)  ⟹  a = v²/r, directed at the body
  const v = orbitalSpeed(G, 500, r)
  assert.ok(Math.abs(Math.hypot(g.x, g.y, g.z) - (v * v) / r) < 1e-9, 'magnitude = v²/r')
  assert.ok(Math.abs(g.y) < 1e-12 && g.x < 0, 'toward the body')
  // softened, not singular: finite at the center
  const gc = gravityAt({ x: 0, y: 0, z: 0 }, G, bodies)
  assert.ok(Number.isFinite(gc.x) && gc.x === 0)
  // no mass → no pull
  const none = gravityAt(p, G, new Map())
  assert.deepEqual(none, { x: 0, y: 0, z: 0 })
})

test('dominantBody: nearest heavy body wins; share is a 0..1 fraction', () => {
  const dom = dominantBody({ x: 1, y: 0, z: 0 }, 40, BODIES)
  assert.equal(dom.id, 'b1', 'the near heavy body dominates')
  assert.ok(dom.share > 0 && dom.share <= 1)
  const far = dominantBody({ x: 101, y: 0, z: 0 }, 40, BODIES)
  assert.ok(far.share > 0 && far.share <= 1)
  assert.ok(far.pull > 0)
})

test('tileRadius & altitudeOf: tile scales with radius; terrain-corrected alt', () => {
  const t1 = tileRadius(10, 3)
  assert.ok(t1 > 0)
  assert.ok(tileRadius(20, 3) > t1, 'bigger body, bigger tile')
  // flat-sphere fallback without elements
  const body = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, mass: 100, radius: 10, planet: null }
  assert.ok(Math.abs(altitudeOf({ x: 12, y: 0, z: 0 }, body, null) - 2) < 1e-9)
  // terrain-correct: a +1 hex under the point lowers the altitude to ~1. The
  // corrected surface is the rendered CHORD FAN (docs/surface.txt), which
  // sags at or below the per-cell sphere R+h — so alt ≥ 1, never less than
  // the flat-terrain 2, never exactly 1 off a cell center
  const planet = { frequency: 3, elements: new Array(10 * 9 + 2).fill(null).map(() => ({ t: 'grass', h: 1 })) }
  const alt = altitudeOf({ x: 12, y: 0, z: 0 }, body, planet)
  assert.ok(alt >= 1 && alt < 1.5, `alt over +1 terrain should be ~1 (chord fan), got ${alt}`)
})

test('latLonOf: poles at ±90°, equator at 0°, lon reference sane', () => {
  const pole = [0, 1, 0]
  assert.ok(Math.abs(latLonOf([0, 1, 0], pole).lat - 90) < 1e-9)
  assert.ok(Math.abs(latLonOf([0, -1, 0], pole).lat + 90) < 1e-9)
  assert.ok(Math.abs(latLonOf([1, 0, 0], pole).lat) < 1e-9)
  assert.ok(Math.abs(latLonOf([1, 0, 0], pole).lon) < 1e-9, 'reference meridian on +X')
})

test('craft documents: lenient normalize + serialize round-trip', () => {
  const world = {
    version: 1,
    name: 't',
    gravity: 40,
    scale: 100, // a world document always carries a scale (meters per unit)
    planets: [
      {
        id: 'p1',
        name: 'P1',
        preset: 'earthlike',
        frequency: 3,
        center: { x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        spin: { x: 0, y: 0.3, z: 0 },
        density: 0.05,
        elements: new Array(10 * 9 + 2).fill(null).map(() => ({ t: 'grass', h: 0 })),
      },
    ],
    crafts: [
      { id: 'c1', name: 'Good', kind: 'shuttle', realism: 'arcade', pose: { anchor: { bodyId: 'p1', dir: [0, 0.7, 0.7], r: 5 } } },
      { kind: 'bogus', pose: { anchor: { bodyId: 'nope', dir: [0, 0, 0] } } }, // unknown body, bad dir
      { id: 'c2', pose: { space: { pos: [1, 2, 3], vel: [0, 0, 0], yaw: 0.5, pitch: -0.2 } } },
      'garbage',
      null,
    ],
  }
  const w = normalizeWorld(world)
  assert.equal(w.crafts.length, 3, 'garbage dropped, the rest healed')
  const bad = w.crafts.find((c) => c.name !== 'Good' && c.pose?.anchor)
  assert.equal(bad.pose.anchor.bodyId, 'p1', 'unknown body re-anchors on the first landable')
  assert.equal(bad.kind, 'shuttle', 'unknown kind falls back to shuttle')
  const sp = w.crafts.find((c) => c.pose?.space)
  assert.deepEqual(sp.pose.space.pos, [1, 2, 3])
  // round-trip: serialize → normalize keeps every craft
  const back = normalizeWorld(serializeWorld(w))
  assert.equal(back.crafts.length, 3)
  assert.deepEqual(back.crafts[0].pose.anchor.dir, w.crafts[0].pose.anchor.dir)
  // createCraft defaults
  const c = createCraft({})
  assert.equal(c.kind, 'shuttle')
  assert.equal(c.realism, 'arcade')
})

// ---------------------------------------------------------------------------
// the movers (a stand-in registry entry plays the physics worker)
// ---------------------------------------------------------------------------

const BODY_ENTRY = {
  pos: { x: 0, y: 0, z: 0 },
  vel: { x: 0, y: 0, z: 0 },
  quat: { x: 0, y: 0, z: 0, w: 1 },
  mass: 500,
  radius: 10,
  planet: null,
}

test('spaceflight (arcade): eases to the input, no gravity, lands at alt → 0', () => {
  craftRuntime.clear()
  const world = makeWorld([
    { id: 'c1', name: 'S', kind: 'shuttle', realism: 'arcade', pose: { space: { pos: [0, 40, 0], vel: [0, 0, 0], yaw: 0, pitch: 0 } } },
  ])
  syncCraftRuntime(world)
  const body = { ...BODY_ENTRY, planet: world.planets[0] }
  const restore = useBodies(new Map([['b1', body]]))
  const craft = world.crafts[0]
  const st = craftRuntime.get('c1').state
  assert.equal(st.mode, 'space')

  // thrust up (yaw/pitch 0 → craft up is +Y): no gravity, monotonic climb
  let prevY = st.pos.y
  for (let i = 0; i < 600; i++) {
    stepCraft(craft, 1 / 60, { up: 1 })
    assert.ok(st.pos.y >= prevY - 1e-9, 'no gravity: altitude never decreases')
    prevY = st.pos.y
  }
  assert.ok(st.pos.y > 45, `arcade climbed, y=${st.pos.y}`)
  assert.ok(Math.abs(st.pos.x) < 1e-9, 'no lateral drift')

  // fall toward the body: thrust down until it parks (alt → 0)
  let parked = false
  for (let i = 0; i < 60 * 120 && !parked; i++) {
    stepCraft(craft, 1 / 60, { down: 1 })
    parked = craftRuntime.get('c1').state.mode === 'park'
  }
  const st2 = craftRuntime.get('c1').state
  assert.ok(parked, 'altitude → 0 must park the craft')
  assert.equal(st2.bodyId, 'b1')
  // parked r = body radius + terrain, where terrain is the rendered CHORD
  // FAN (docs/surface.txt): at or below the per-cell sphere, so r ≤ radius,
  // within the fan sag — the r:null → 0 trap is pinned by the headless launch
  assert.ok(st2.r > 9.9 && st2.r <= 10 + 1e-9, `parked at the body radius (chord fan), got ${st2.r}`)
  // parking persisted into the document pose
  assert.ok(craft.pose.anchor && craft.pose.anchor.bodyId === 'b1', 'doc pose is the anchor now')
  restore()
  craftRuntime.clear()
})

test('spaceflight (real): Newtonian — falls toward the body, launch faces up', () => {
  craftRuntime.clear()
  const world = makeWorld([
    { id: 'c1', name: 'S', kind: 'shuttle', realism: 'real', pose: { space: { pos: [0, 60, 0], vel: [0, 0, 0], yaw: 0, pitch: 0 } } },
    { id: 'c2', name: 'P', kind: 'shuttle', realism: 'real', pose: { anchor: { bodyId: 'b1', dir: [0, 1, 0], r: 12 } } },
  ])
  syncCraftRuntime(world)
  const body = { ...BODY_ENTRY, planet: world.planets[0] }
  const restore = useBodies(new Map([['b1', body]]))
  const craft = world.crafts[0]
  const st = craftRuntime.get('c1').state
  // coast with no input: gravity must pull it IN (toward the origin)
  for (let i = 0; i < 120; i++) stepCraft(craft, 1 / 60, null)
  const d = Math.hypot(st.pos.x, st.pos.y, st.pos.z)
  assert.ok(st.mode === 'space', 'still in space after 2 s')
  assert.ok(d < 60, `real gravity falls inward, r=${d.toFixed(2)}`)
  assert.ok(st.vel.y < 0, 'velocity gained toward the body')

  // launch: from a parked craft the velocity is radial + kick, facing up
  const st3 = launchCraftState('c2')
  assert.ok(st3, 'launch succeeded')
  assert.equal(st3.mode, 'space')
  assert.ok(st3.pos.y > 12, 'launched above the pad')
  assert.ok(st3.vel.y > 0, 'radial kick upward')
  // facing radially outward (up): forward ≈ +Y at this pose
  const v = craftVectors(st3.yaw, st3.pitch)
  assert.ok(Math.abs(v.forward[1] - 1) < 1e-6, `facing up, got ${v.forward}`)
  restore()
  craftRuntime.clear()
})

test('eject: parked → on foot at the anchor; flying → adrift with the velocity', () => {
  craftRuntime.clear()
  const world = makeWorld([
    { id: 'cp', name: 'P', kind: 'shuttle', realism: 'arcade', pose: { anchor: { bodyId: 'b1', dir: [0, 1, 0], r: 12 } } },
    { id: 'cf', name: 'F', kind: 'shuttle', realism: 'arcade', pose: { space: { pos: [0, 30, 0], vel: [0, 5, 0], yaw: 0, pitch: 0 } } },
  ])
  syncCraftRuntime(world)
  const foot = ejectCraftState('cp')
  assert.equal(foot.type, 'foot')
  assert.equal(foot.bodyId, 'b1')
  assert.deepEqual(foot.dir, [0, 1, 0])
  const evaEv = ejectCraftState('cf')
  assert.equal(evaEv.type, 'eva')
  assert.equal(evaEv.pos.y, 30)
  assert.equal(evaEv.vel.y, 5, 'arcade rel-velocity + body vel (0) = 5')
  craftRuntime.clear()
})

test('eva: jetpack outweighs gravity (hover), and a fall ends on foot', () => {
  craftRuntime.clear()
  const world = makeWorld([])
  setMotionWorld(world)
  const body = { ...BODY_ENTRY, planet: world.planets[0] }
  const restore = useBodies(new Map([['b1', body]]))

  // hover: thrust up must beat gravity → the astronaut rises
  eva.state = { pos: { x: 0, y: 30, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 }
  let prevY = 30
  let rose = false
  for (let i = 0; i < 120; i++) {
    stepEva(1 / 60, { up: 1 })
    if (eva.state && eva.state.pos.y > prevY + 1e-6) rose = true
    prevY = eva.state ? eva.state.pos.y : prevY
  }
  assert.ok(rose, 'jetpack overpowered gravity (hover)')

  // fall: no input → the land event fires on the surface
  eva.state = { pos: { x: 0, y: 12, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 }
  let ev = null
  for (let i = 0; i < 600 && !ev; i++) ev = stepEva(1 / 60, null)
  assert.ok(ev, 'the fall ends in a land event')
  assert.equal(ev.type, 'land')
  assert.equal(ev.bodyId, 'b1')
  assert.equal(eva.state, null, 'EVA state cleared on landing')
  restore()
  craftRuntime.clear()
})

test('craftWorldPose: parked pose composes from the registry (float32 stream)', () => {
  craftRuntime.clear()
  const world = makeWorld([
    { id: 'cp', name: 'P', kind: 'shuttle', realism: 'arcade', pose: { anchor: { bodyId: 'b1', dir: [0, 1, 0], r: 12 } } },
  ])
  syncCraftRuntime(world)
  const body = { ...BODY_ENTRY, pos: { x: 5, y: 0, z: 0 }, planet: world.planets[0] }
  const restore = useBodies(new Map([['b1', body]]))
  const rt = craftRuntime.get('cp')
  const pose = craftWorldPose(rt)
  assert.ok(pose, 'pose resolved')
  assert.ok(Math.abs(pose.pos.x - 5) < 1e-9, 'rides the body position')
  assert.ok(Math.abs(pose.pos.y - 12) < 1e-9, 'at r above the surface')
  restore()
  craftRuntime.clear()
})

// ---------------------------------------------------------------------------
// the drive mover (rover, P2) — a ground-locked vehicle that never flies
// ---------------------------------------------------------------------------

const DOT = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const ANGLE = (a, b) => Math.acos(Math.min(1, Math.max(-1, DOT(a, b))))

function driveWorld(overrides = {}) {
  const world = makeWorld([
    { id: 'cd', name: 'R', kind: 'drive', pose: { anchor: { bodyId: 'b1', dir: [0, 1, 0], r: null } } },
  ])
  return world
}

test('drive: drives along the surface, stays parked, eases the throttle', () => {
  craftRuntime.clear()
  const world = driveWorld()
  syncCraftRuntime(world)
  const body = { ...BODY_ENTRY, planet: world.planets[0] }
  const restore = useBodies(new Map([['b1', body]]))
  const craft = world.crafts[0]
  const st = craftRuntime.get('cd').state
  assert.equal(st.mode, 'park')
  const start = [0, 1, 0]
  const surface = makeSurface(world.planets[0], null)
  assert.ok(Math.abs(st.r - surface.heightAt(st.dir).radius) < 1e-12, 'sync resolved r onto the rendered surface')

  // full throttle for 1 s: the rover moves, NEVER leaves the ground
  for (let i = 0; i < 60; i++) {
    stepCraft(craft, 1 / 60, { fwd: 1 })
    assert.equal(craftRuntime.get('cd').state.mode, 'park', 'a rover never enters space mode')
  }
  const st2 = craftRuntime.get('cd').state
  assert.ok(st2.speed > 0, 'throttle eased up')
  const arc = ANGLE(start, st2.dir)
  assert.ok(arc > 0.5 && arc < 2.5, `the rover drove along the surface (arc ${arc.toFixed(2)} rad)`)
  // the WELD: the anchor r is the rendered surface radius at the new dir
  assert.ok(Math.abs(st2.r - surface.heightAt(st2.dir).radius) < 1e-12, 'r tracks the chord fan (weld)')

  // release the throttle: the speed eases back down
  for (let i = 0; i < 60; i++) stepCraft(craft, 1 / 60, {})
  assert.ok(Math.abs(craftRuntime.get('cd').state.speed) < 1, 'the throttle eases back to 0')

  // the HUD side channel: throttle speed + body-fixed lat/lon in park
  writeCraftReadout(craft)
  assert.ok(motionReadout.relSpeed >= 0 && motionReadout.lat != null, 'drive readout carries speed + lat/lon')
  restore()
  craftRuntime.clear()
})

test('drive: steering turns the heading; the nose stays on the horizon', () => {
  craftRuntime.clear()
  const world = driveWorld()
  syncCraftRuntime(world)
  const restore = useBodies(new Map([['b1', { ...BODY_ENTRY, planet: world.planets[0] }]]))
  const craft = world.crafts[0]
  // a long UNSTEERED drive (the rover loops the small freq-3 body a few
  // times, so accumulate the path, not the net angle): the
  // parallel-transported heading must stay tangent to the surface (the
  // pre-fix bug left it behind, h·d → sin θ)
  let arc = 0
  let prev = [0, 1, 0]
  for (let i = 0; i < 300; i++) {
    stepCraft(craft, 1 / 60, { fwd: 1 })
    const d = craftRuntime.get('cd').state.dir
    arc += ANGLE(prev, d)
    prev = d
  }
  const st2 = craftRuntime.get('cd').state
  assert.ok(arc > 8, `unsteered drive covers the sphere (path ${arc.toFixed(1)} rad)`)
  assert.ok(Math.abs(DOT(st2.heading, st2.dir)) < 0.05, `heading stays tangent to the surface (dot ${DOT(st2.heading, st2.dir).toFixed(3)})`)

  // steer: the heading rotates about the local up and the path curves
  const h0 = [...st2.heading]
  for (let i = 0; i < 60; i++) stepCraft(craft, 1 / 60, { fwd: 1, yaw: 1 })
  const st3 = craftRuntime.get('cd').state
  assert.ok(ANGLE(h0, st3.heading) > 0.5, `steering turned the heading (${ANGLE(h0, st3.heading).toFixed(2)} rad)`)
  assert.ok(Math.abs(DOT(st3.heading, st3.dir)) < 0.05, 'steered heading stays tangent too')
  restore()
  craftRuntime.clear()
})

test('drive: launchCraftState refuses a rover; eject drops you on foot where it drove', () => {
  craftRuntime.clear()
  const world = driveWorld()
  syncCraftRuntime(world)
  const restore = useBodies(new Map([['b1', { ...BODY_ENTRY, planet: world.planets[0] }]]))
  const craft = world.crafts[0]
  const st0 = craftRuntime.get('cd').state
  const dir0 = [...st0.dir]
  for (let i = 0; i < 60; i++) stepCraft(craft, 1 / 60, { fwd: 1 })
  const st = craftRuntime.get('cd').state
  assert.ok(ANGLE(dir0, st.dir) > 0.3, 'it drove')
  assert.equal(launchCraftState('cd'), null, 'a drive craft has no launch')
  assert.equal(craftRuntime.get('cd').state.mode, 'park', '…and it is still parked')
  const ev = ejectCraftState('cd')
  assert.equal(ev.type, 'foot')
  assert.equal(ev.bodyId, 'b1')
  assert.deepEqual(ev.dir, st.dir, 'eject lands on foot at the (moved) anchor')
  restore()
  craftRuntime.clear()
})

test('drive: walls block steep relief; gentle steps are climbed', () => {
  const FREQ = 3
  const hex = getHexSphere(FREQ)
  const N = 10 * FREQ * FREQ + 2
  const wallDir = [0, 0, 1] // the cap of tall cells the rover drives into
  for (const [step, crosses] of [[3, false], [0.5, true]]) {
    craftRuntime.clear()
    const elements = new Array(N).fill(null).map((_, i) => ({
      t: 'grass',
      h: dotCenter(hex, i, wallDir) > 0.25 ? step : 0,
    }))
    const world = driveWorld()
    world.planets[0].elements = elements
    syncCraftRuntime(world)
    const restore = useBodies(new Map([['b1', { ...BODY_ENTRY, planet: world.planets[0] }]]))
    const craft = world.crafts[0]
    for (let i = 0; i < 360; i++) stepCraft(craft, 1 / 60, { fwd: 1 }) // 6 s of driving
    const st = craftRuntime.get('cd').state
    const z = st.dir[2]
    if (crosses) assert.ok(z > 0.5, `a ${step} step climbs (rover crossed the ring, z=${z.toFixed(2)})`)
    else assert.ok(z < 0.4, `a ${step} step is a wall (rover held at z=${z.toFixed(2)})`)
    restore()
    craftRuntime.clear()
  }
})

test('drive: obeys gravity — it falls off a ledge instead of teleporting down (no lift)', () => {
  const FREQ = 3
  const hex = getHexSphere(FREQ)
  const N = 10 * FREQ * FREQ + 2
  craftRuntime.clear()
  // a raised cap around the north pole; the rover starts ON it and drives off
  // the edge (the ground drops by 3 units — far past the drop limit)
  const cap = [0, 1, 0]
  const elements = new Array(N).fill(null).map((_, i) => ({
    t: 'grass',
    h: dotCenter(hex, i, cap) > 0.5 ? 3 : 0,
  }))
  const world = driveWorld()
  world.planets[0].elements = elements
  syncCraftRuntime(world)
  const restore = useBodies(new Map([['b1', { ...BODY_ENTRY, planet: world.planets[0] }]]))
  const craft = world.crafts[0]
  const surface = makeSurface(world.planets[0], null)
  const st0 = craftRuntime.get('cd').state
  assert.ok(st0.grounded, 'a freshly synced rover is grounded on the surface')
  assert.ok(
    st0.r > surface.heightAt([0, 0, 1]).radius + 1,
    'it starts up on the plateau (h=3, ~3 units above the plain)'
  )

  // drive off the edge: it leaves the plateau, the ground drops away, it goes
  // AIRBORNE and falls under gravity — it does not snap to the hex below
  let airborne = false
  for (let i = 0; i < 240; i++) {
    stepCraft(craft, 1 / 60, { fwd: 1 })
    const st = craftRuntime.get('cd').state
    if (!st.grounded && st.r - surface.heightAt(st.dir).radius > 0.2) airborne = true
  }
  const st = craftRuntime.get('cd').state
  assert.ok(airborne, 'the rover went airborne when it drove off the ledge (no teleport-down)')
  assert.ok(st.grounded, '…and the fall ends: it lands back on the surface')
  assert.ok(
    Math.abs(st.r - surface.heightAt(st.dir).radius) < 1e-9,
    'it lands WELDED to the rendered surface'
  )
  restore()
  craftRuntime.clear()
})

test('drive: a gentle slope stays grounded (no spurious falling on flat terrain)', () => {
  const FREQ = 3
  const hex = getHexSphere(FREQ)
  const N = 10 * FREQ * FREQ + 2
  craftRuntime.clear()
  // a low 0.5-unit step everywhere — below the drop limit, so a grounded rover
  // tracks it (welded) and never goes airborne
  const elements = new Array(N).fill(null).map((_, i) => ({
    t: 'grass',
    h: dotCenter(hex, i, [0, 1, 0]) > 0.5 ? 0.5 : 0,
  }))
  const world = driveWorld()
  world.planets[0].elements = elements
  syncCraftRuntime(world)
  const restore = useBodies(new Map([['b1', { ...BODY_ENTRY, planet: world.planets[0] }]]))
  const craft = world.crafts[0]
  const surface = makeSurface(world.planets[0], null)
  for (let i = 0; i < 120; i++) {
    stepCraft(craft, 1 / 60, { fwd: 1 })
    const st = craftRuntime.get('cd').state
    assert.ok(st.grounded, 'a gentle step never launches the rover airborne')
    assert.ok(
      Math.abs(st.r - surface.heightAt(st.dir).radius) < 1e-9,
      '…and it stays welded to the chord fan'
    )
  }
  restore()
  craftRuntime.clear()
})

test('drive: an unattended rover rides its body (no surface, no motion)', () => {
  craftRuntime.clear()
  const world = driveWorld()
  syncCraftRuntime(world)
  const craft = world.crafts[0]
  const st0 = craftRuntime.get('cd').state
  const dir0 = [...st0.dir]
  const r0 = st0.r
  for (let i = 0; i < 60; i++) stepCraft(craft, 1 / 60, null)
  const st = craftRuntime.get('cd').state
  assert.deepEqual(st.dir, dir0, 'unattended: the anchor does not move (it rides the body analytically)')
  assert.equal(st.r, r0)
  craftRuntime.clear()
})

test('drive: the document round-trips the parked heading (lenient normalize)', () => {
  const world = {
    version: 1,
    name: 't',
    gravity: 40,
    scale: 100,
    planets: [
      {
        id: 'p1',
        name: 'P1',
        preset: 'earthlike',
        frequency: 3,
        center: { x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        spin: { x: 0, y: 0, z: 0 },
        elements: new Array(10 * 9 + 2).fill(null).map(() => ({ t: 'grass', h: 0 })),
      },
    ],
    crafts: [
      { id: 'c1', name: 'R', kind: 'drive', pose: { anchor: { bodyId: 'p1', dir: [0, 1, 0], r: 5, heading: [0, 0, 1] } } },
      { id: 'c2', name: 'B', kind: 'drive', pose: { anchor: { bodyId: 'p1', dir: [0, 1, 0], r: 5, heading: 'nonsense' } } },
    ],
  }
  const w = normalizeWorld(world)
  assert.equal(w.crafts.length, 2, 'both rovers survive')
  assert.deepEqual(w.crafts[0].pose.anchor.heading, [0, 0, 1], 'a good heading is kept')
  assert.equal(w.crafts[1].pose.anchor.heading, undefined, 'a bad heading is dropped (lazy-init on first drive)')
  // and the round-trip keeps it
  const back = normalizeWorld(serializeWorld(w))
  assert.deepEqual(back.crafts[0].pose.anchor.heading, [0, 0, 1])
})

test('flightInput & pendingFoot: side channels reset cleanly', () => {
  resetFlightInput()
  flightInput.fwd = 1
  flightInput.lookDX = 5
  resetFlightInput()
  assert.equal(flightInput.fwd, 0)
  assert.equal(flightInput.lookDX, 0)
  pendingFoot.bodyId = 'x'
  pendingFoot.dir = [0, 1, 0]
  pendingFoot.bodyId = null
  pendingFoot.dir = null
  assert.equal(pendingFoot.bodyId, null)
})
