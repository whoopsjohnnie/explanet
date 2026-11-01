/**
 * test-headless.mjs — regression suite for the rendered world, fully in
 * memory: real React tree, real physics + geometry workers, real Scene
 * components, deterministic frames sampled at the render point. This is the
 * headless stand-in for browser automation (headless Firefox hangs — no GPU).
 *
 *   npm run test:headless
 *
 * What is pinned here:
 *  - the pipeline itself (boot → bodies → geometry → stable orbits)
 *  - the walker's weld to the ground while standing still
 *  - the float32 contract: physics registry == rendered mesh pose, bit for
 *    bit (the camera-follow jitter / walking "tic tic tic" fix — a camera or
 *    walker riding any other stream drifts off the terrain and snaps back)
 *  - the real-human walker (world.scale, meters per unit): SURFACE_REAL
 *    metrics, the human near plane, the 120 m spawn fall, and the weld on
 *    35 km terrain
 *  - the astronaut flight chain on the synthetic 'testball' fixture
 *    (harness makeTestballWorld — starless, so landings are reachable in
 *    toy-scale gravity): board → launch → climb → brake → PARK (landing is
 *    altitude-driven, no button), then eject → on foot; and the EVA chain:
 *    eject mid-flight → adrift under real gravity → the fall ENDS on the
 *    surface → on foot (docs/flight.txt)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { bootWorld, SOL_REAL_MAJOR } from './harness/index.mjs'
import { walkReadout } from '../src/core/surface.js'
import { craftRuntime, eva } from '../src/core/motion.js'

const SOL_REAL_PRESENT = existsSync(new URL('../public/sol-real.json', import.meta.url))

test('pipeline: starter world orbits clean under RAF jitter; registry ≡ rendered mesh', { timeout: 240_000 }, async () => {
  const w = await bootWorld()
  const t = await w.track('Earth')
  const { missed } = await w.frames(480, { jitter: true })
  const s = t.stats()
  await w.close()
  assert.equal(s.jumps.length, 0, `discontinuities: ${JSON.stringify(s.jumps.slice(0, 5))}`)
  assert.ok(missed <= 3, `missed worker frames: ${missed}`)
  assert.equal(s.maxMeshEntryU, 0, 'registry pose must equal the rendered mesh pose (float32 contract)')
})

test('surface: walker welds to terrain while standing still', { timeout: 240_000 }, async () => {
  const w = await bootWorld()
  await w.walk('Earth')
  await w.frames(600) // spawn descent + walker/camera settle (10 s sim, as the original probe)
  const t = await w.track('Earth')
  await w.frames(360)
  const s = t.stats()
  await w.close()
  // measured ~0.0014 u/frame; a treadmill (camera untied from terrain) is ≫
  assert.ok(s.maxHexCameraU < 0.05, `per-frame view-space slide ${s.maxHexCameraU.toExponential(2)} u — weld broken`)
})

test('follow: locks terrain at Sol-Real scale (float32 sawtooth regression)', {
  skip: SOL_REAL_PRESENT ? false : 'needs public/sol-real.json (node scripts/gen-sol-real.mjs)',
  timeout: 360_000,
}, async () => {
  const w = await bootWorld({ world: 'sol-real', filter: SOL_REAL_MAJOR, controls: true, follow: true })
  const earth = w.planet('Earth')
  await w.set({ selectedId: earth.id, followSelected: true })
  await w.cameraNear('Earth', { offset: [0, 60, 220] }) // user zoomed in on the globe
  await w.frames(90) // LOD level + controls settle after the camera move
  const t = await w.track('Earth')
  await w.frames(480, { jitter: true })
  const s = t.stats()
  await w.close()
  // Earth sits at |pos| = 4.18e6 where the float32 quantum is 0.125u ≈ 1/8 hex:
  assert.equal(s.maxMeshEntryU, 0, 'registry must be bit-identical to the rendered mesh at 4.2e6')
  assert.equal(s.meshSwaps, 0, 'LOD level should be parked at this distance')
  // pre-fix this was a ±0.33 px sawtooth with ~88 direction flips per 300 frames:
  assert.ok(s.maxPxPerFrame < 0.05, `hex px jitter max ${s.maxPxPerFrame.toFixed(3)} px — sawtooth is back`)
  assert.ok(s.signFlips <= 2, `px direction flips ${s.signFlips} — sawtooth is back`)
})

test('surface (real mode): real-human walker welds on true-scale Earth (scale)', {
  skip: SOL_REAL_PRESENT ? false : 'needs public/sol-real.json (node scripts/gen-sol-real.mjs)',
  timeout: 360_000,
}, async () => {
  // world.scale (meters per unit) → the Walker must run SURFACE_REAL end to
  // end: a 120 m spawn fall under the physical 9.8 m/s², a human near
  // plane, and the camera welded to 35 km terrain while the planet flies at
  // true scale.
  const w = await bootWorld({ world: 'sol-real', filter: ['Sun', 'Earth'] })
  assert.ok(w.world.scale > 0, 'Sol Real document must carry scale')
  await w.walk('Earth')
  await w.frames(1200) // 120 m fall ≈ 8.8 s incl. the 15 m/s terminal, + settle
  // real-mode signatures: the near plane sits eye·0.08 ≈ 13 cm (u) under the
  // 1.6 m eye — tile mode would floor it at 0.002 u ≈ 70 m
  assert.ok(
    w.camera.near > 1e-7 && w.camera.near < 1e-5,
    `walk near plane ${w.camera.near} u — real-mode plumbing (world.scale → makeSurface) broken`
  )
  assert.ok(walkReadout.grounded, 'walker should have landed its 120 m spawn fall by 20 s')
  const t = await w.track('Earth')
  await w.frames(600, { jitter: true })
  const s = t.stats()
  await w.close()
  assert.equal(s.jumps.length, 0, `discontinuities: ${JSON.stringify(s.jumps.slice(0, 5))}`)
  // starter weld measures ~0.0014 u/frame at |pos| ~ 200 u; at 4.2e6 u the
  // pre-fround'd registry (the float32 contract) must keep it the same order
  assert.ok(s.maxHexCameraU < 0.05, `per-frame view-space slide ${s.maxHexCameraU.toExponential(2)} u — weld broken`)
})

// ---------------------------------------------------------------------------
// the astronaut flight chain (docs/flight.txt), on the 'testball' fixture
// ---------------------------------------------------------------------------

test('flight: launch → climb → brake → park on altitude → eject → on foot', { timeout: 240_000 }, async () => {
  const w = await bootWorld({ world: 'testball' })
  await w.frames(30) // runtime sync (parked r resolves against the terrain)
  const id = w.craft('Shuttle').id
  const rt = craftRuntime.get(id)
  assert.ok(rt && rt.state.mode === 'park', 'shuttle must sync parked at boot')
  assert.ok(Number.isFinite(rt.state.r) && rt.state.r > 1, `parked r must be resolved to the surface (got ${rt.state.r})`)

  await w.board('Shuttle')
  assert.deepEqual(w.player, { kind: 'craft', craftId: id })
  await w.launch('Shuttle')
  let st = craftRuntime.get(id).state
  assert.equal(st.mode, 'space', 'launch must put the craft off the pad')
  const d0 = Math.hypot(st.pos.x, st.pos.y, st.pos.z)
  assert.ok(d0 > rt.state.r, `launch point (${d0}) must be outside the surface (${rt.state.r}) — the r=null → 0 bug`)

  // climb: W thrusts radially out (launch attitude faces the sky)
  w.fly({ fwd: 1 })
  await w.frames(60)
  st = craftRuntime.get(id).state
  assert.ok(st.mode === 'space', 'still flying after the climb')
  assert.ok(Math.hypot(st.pos.x, st.pos.y, st.pos.z) > d0 + 1, 'the climb must gain altitude')

  // brake: S until the altitude → 0 landing parks it (no button, ever)
  w.fly({ fwd: 0, back: 1 })
  let parked = false
  for (let i = 0; i < 60 * 120 && !parked; i++) {
    await w.frames(1)
    parked = craftRuntime.get(id).state.mode === 'park'
  }
  w.flyReset()
  assert.ok(parked, 'braking to the surface must park the craft (altitude-driven landing)')
  const park = craftRuntime.get(id).state
  assert.equal(park.bodyId, 'p-testball')
  assert.ok(Number.isFinite(park.r), 'parking must persist the resolved r into the doc')

  // eject from parked → on foot at the pad (landing → walk, no button)
  await w.eject()
  assert.deepEqual(w.player, { kind: 'foot', bodyId: 'p-testball' })
  await w.frames(300) // spawn descent + settle
  assert.ok(walkReadout.grounded, 'the ejected astronaut must be on the ground')
  await w.close()
})

test('flight (EVA): eject mid-flight → adrift → the fall ends on foot', { timeout: 240_000 }, async () => {
  const w = await bootWorld({ world: 'testball' })
  await w.frames(30)
  const id = w.craft('Shuttle').id
  await w.board('Shuttle')
  await w.launch('Shuttle')
  w.fly({ fwd: 1 })
  await w.frames(60) // gain some air
  const st = craftRuntime.get(id).state
  assert.equal(st.mode, 'space')

  // eject IN FLIGHT → adrift, inheriting the craft's velocity
  await w.eject()
  w.flyReset()
  assert.deepEqual(w.player, { kind: 'eva' })
  assert.ok(eva.state, 'the adrift astronaut must have a live state')
  assert.equal(craftRuntime.get(id).state.mode, 'space', 'the empty craft keeps flying')

  // no input: real gravity must bring the fall to an END on the surface
  let landed = false
  for (let i = 0; i < 60 * 60 && !landed; i++) {
    await w.frames(1)
    landed = w.player.kind === 'foot'
  }
  assert.ok(landed, 'the EVA fall must end on the surface (the dist3 object-vs-array bug)')
  assert.equal(eva.state, null, 'the EVA state clears on landing')
  await w.frames(300) // spawn descent + settle
  assert.ok(walkReadout.grounded, 'the astronaut must be on the ground where the fall ended')
  await w.close()
})
