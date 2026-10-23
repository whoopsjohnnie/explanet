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
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { bootWorld, SOL_REAL_MAJOR } from './harness/index.mjs'

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
