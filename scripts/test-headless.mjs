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
 *  - the drive (rover) chain on the same fixture: board → launch REFUSED
 *    (a drive craft never flies) → W drives along the surface, WELDED to the
 *    rendered chord fan when grounded → A/D steers → release + settle (it
 *    obeys gravity when it drives off a ledge but has no lift, so it ends
 *    back on the ground, welded) → eject → on foot
 *  - the stub-boot crash (harness makeStubWorld, spec 'stubworld'): the
 *    harness boots exactly like the app (player: defaultPlayer(world)), so
 *    a stub-FIRST world must boot without makeSurface dying on
 *    `planet.elements is null` — defaultPlayer skips the stub, a failed
 *    hydration bails, and a foot session on an unresolvable stub falls
 *    back to the free camera
 *  - LOD level selection against WORLD-unit thresholds (the R-normalized
 *    comparison made giants never coarsen): close → full resolution, far →
 *    coarsest level, back close → full again
 *  - the fine-terrain region (docs/terrain.txt, stage 2 — the fine grid IS
 *    the DEM pixel): the on-foot focus body streams its cap's DEM-pixel chunks
 *    and publishes the mounted set to the §6 dispatch; the walker welds to the
 *    FINE surface of record (the composite, not the document); the pick
 *    remap routes a fine hit to the document cell; a stroke composites
 *    (doc + edit overlay + same-frame chunk patch); the fine layer carries the
 *    DEM's relief (deep inside it is the DEM pixel exactly, at the cap edge it
 *    is the document exactly, and the chunk mesh carries the blended height);
 *    unmounting is clean (every chunk geometry disposed, no leak, the doc mesh
 *    survives) and restores byte-identical LOD rendering (doc terrain
 *    unsuppressed, same level, no chunks); the region also streams while
 *    FLYING low over the body (the flight focus gate — launch clears the doc
 *    anchor, so the gate rides the motion.js flightFocus fact, not the pose),
 *    and tears down when the craft climbs past the cap radius; and on the
 *    STORED-HEX source (the 'hexball' fixture, terrain2 §6.2) the fine layer
 *    carries the streamed hexes' relief exactly (a doc-faithful + perturbation
 *    hexcell set through the setHexTileProvider seam)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { act } from '@react-three/test-renderer'
import { bootWorld, SOL_REAL_MAJOR } from './harness/index.mjs'
import { walkReadout, walkerLocation, makeSurface, cellAtDirection } from '../src/core/surface.js'
import { craftRuntime, eva } from '../src/core/motion.js'
import { useStore } from '../src/state/store.js'
import { getHexSphere } from '../src/core/hexsphere.js'
import { planetRadius } from '../src/core/planetMath.js'
import { C } from '../src/core/constants.js'
import {
  setTerrainProviders,
  setHexTileProvider,
  dirToLatLon,
  fineHexDirs,
  demElevationAt,
  tileKeyFor,
} from '../src/core/fineTerrain.js'
import {
  highResGrid,
  rowForLat,
  rowLonRange,
  cellDir,
  cellLatLon,
  nearestCell,
} from '../src/core/hexlattice.js'
import {
  fineRegionOf,
  isFine,
  remapToDoc,
  fineEditFor,
  fineHexUnder,
  capRadiusU,
  surfaceOfRecord,
} from '../src/core/finedisc.js'

// ---------------------------------------------------------------------------
// The synthetic DEM for the 'testball' fixture (docs/terrain.txt stage 2).
//
// The fine-terrain pins need a DEM whose relief the document hexes smooth
// away — the whole point of stage 2. The harness has no world database, so the
// catalog ('TEST-DEM': 1° pixels, 120° tiles) is synthesized in code and
// swapped in through the provider seam (setTerrainProviders). The elevation is
// doc-faithful + a 140 m perturbation (a real mountain the f12 document
// averages out):
//
//     elev(lat,lon) = clamp_i16( round( hDoc(lat,lon)·scale + 140·cos2lat·cos2lon ) )
//
// (lat/lon in radians; hDoc is the live testball's document cell under
// (lat,lon)). The perturbation's worst-case spawn fall (120 + 140 = 260 m)
// stays inside the real-human 20 s landWalker budget. The fixture's relief is
// RESCALED (makeTestballWorld) so |hDoc·scale + 140 m| never reaches the int16
// clamp over the WHOLE body — at the atom scale the preset's ~1 u mountains
// are ~380 km, and a clamped pixel would leave the fine surface a continent
// below the document exactly where the drive chain ends (high terrain, far
// from the flat basins). No clamp is ever READ, so the w=1 identity pin below
// is exact everywhere. The provider is module-global (it persists across
// harness boots in one process) and reads the CURRENT boot's testball lazily;
// a boot without a testball yields no tile, so the synthesis falls back to
// the document height there.
// ---------------------------------------------------------------------------
const DEM_CATALOG = 'TEST-DEM'
const DEM_PIXEL_DEG = 1
const DEM_TILE_SIZE = 120

/** One DEM pixel (meters, int16) at (lat, lon), from the live testball. */
function testDemPixel(planet, scale, latDeg, lonDeg) {
  const lat = (latDeg * Math.PI) / 180
  const lon = (lonDeg * Math.PI) / 180
  const dir = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon)]
  const cell = cellAtDirection(getHexSphere(planet.frequency), dir)
  const hDoc = (planet.elements[cell] && planet.elements[cell].h) || 0
  const v = Math.round(hDoc * scale + 140 * Math.cos(2 * lat) * Math.cos(2 * lon))
  return Math.max(-32768, Math.min(32767, v))
}

/** One synthetic DEM tile (int16 meters), row 0 = the tile's north edge. */
const DEM_TILE = async (catalog, tileLat, tileLon) => {
  if (catalog !== DEM_CATALOG) return null
  const s = useStore.getState()
  const planet = s.world.planets.find((p) => p.id === 'p-testball')
  if (!planet || !Array.isArray(planet.elements)) return null
  const n = DEM_TILE_SIZE
  const arr = new Int16Array(n * n)
  const tileTop = tileLat + n * DEM_PIXEL_DEG
  for (let r = 0; r < n; r++) {
    const lat = tileTop - (r + 0.5) * DEM_PIXEL_DEG
    for (let c = 0; c < n; c++) {
      const lon = tileLon + (c + 0.5) * DEM_PIXEL_DEG
      arr[r * n + c] = testDemPixel(planet, s.world.scale, lat, lon)
    }
  }
  return arr
}

setTerrainProviders({
  catalogs: async () => ({
    catalogs: [{ catalog: DEM_CATALOG, pixelDeg: DEM_PIXEL_DEG, tileSize: DEM_TILE_SIZE }],
  }),
  tiles: DEM_TILE,
})

// ---------------------------------------------------------------------------
// The synthetic stored hexes for the 'hexball' fixture (terrain2 §6.2).
//
// hexball declares `hex_meters` + a body `dbId`, so its fine layer streams
// STORED hexcells (the row-keyed lat/lon rects of /hex/tile) instead of a DEM
// catalog. The harness has no world database, so the hexcells are synthesized
// in code through the setHexTileProvider seam, the same pattern as TEST-DEM.
// The height of a stored hex is doc-faithful + a perturbation the f12
// document smooths away (a 12° period against the ~9.5° doc cell — ~0.8
// cycles inside one cell, so a single doc `h` cannot express it):
//
//     h(row,col) = hDoc(cellAtDirection(cellDir(row,col))) + A·cos30lat·cos30lon
//
// (lat/lon the stored hex's center in RADIANS; A in WORLD UNITS — the stored
// datum, no scale division). A = 3.3e-4 u puts the spawn-basin value at
// |−0.62·A| ≈ 2.0e-4 u (≈ 77 m — the walker's spawn fall stays trivially in
// budget, as TEST-DEM's 140 m does) while the relief assertion below needs
// > 1e-4 u. The provider is module-global (like the DEM's): it reads the
// CURRENT boot's world and yields no rect unless it declares hex_meters and
// names a body with elements — a boot without the fixture finds no data and
// the synthesis falls back to the document height there.
// ---------------------------------------------------------------------------
const HEX_PERT_A = 3.3e-4

/** The height (WORLD UNITS) of stored hex (row, col), from the live hexball. */
function testHexHeight(planet, docGrid, grid, row, col) {
  const dir = cellDir(grid, row, col)
  const cell = cellAtDirection(docGrid, dir)
  const hDoc = (planet.elements[cell] && planet.elements[cell].h) || 0
  const { lat, lon } = cellLatLon(grid, row, col)
  return hDoc + HEX_PERT_A * Math.cos(30 * lat) * Math.cos(30 * lon)
}

/**
 * One synthetic stored-hex rect (Map<row,{col0,h:Float64Array}>, heights in
 * world units) — the /hex/tile row packing, per-row column selection via
 * rowLonRange (each row has its own column count).
 */
const HEX_TILE = async (dbId, lat0, lat1, lon0, lon1) => {
  const s = useStore.getState()
  const w = s.world
  if (!w || !(w.hex_meters > 0)) return null
  const planet = w.planets.find((p) => p.dbId === dbId)
  if (!planet || !Array.isArray(planet.elements) || planet.generated) return null
  const grid = highResGrid(planetRadius(planet) * w.scale, w.hex_meters)
  const docGrid = getHexSphere(planet.frequency)
  const DEG = Math.PI / 180
  const tiles = new Map()
  const r0 = rowForLat(grid, lat1 * DEG) // larger lat = smaller row index
  const r1 = rowForLat(grid, lat0 * DEG)
  for (let row = r0; row <= r1; row++) {
    const range = rowLonRange(grid, row, lon0, lon1)
    if (!range) continue
    const h = new Float64Array(range.j1 - range.j0 + 1)
    for (let col = range.j0; col <= range.j1; col++)
      h[col - range.j0] = testHexHeight(planet, docGrid, grid, row, col)
    tiles.set(row, { col0: range.j0, h })
  }
  return tiles
}

setHexTileProvider(HEX_TILE)

// The stage-2 fine pins spawn the walker at the shuttle's flat-basin anchor
// (document cell 849 center, h = 0 over ~9°). The boot camera points along
// this dir, so the Walker's camera-facing spawn lands there — the focus, the
// cap and every spawn fall are pinned to a known, flat, in-budget point.
const ANCHOR_DIR = [0.5, -0.309017, 0.809017]
const FINE_CAM = [ANCHOR_DIR[0] * 32, ANCHOR_DIR[1] * 32, ANCHOR_DIR[2] * 32]

/**
 * Settle the on-foot spawn fall (real human: a fixed 120 m drop at the
 * 15 m/s terminal ≈ 8 s) — a FIXED frame wait, not a `walkReadout.grounded`
 * latch: that flag (and `walkerLocation`) is module-global and survives
 * between boots, so a latch would return on the PREVIOUS test's landed walker.
 */
async function landWalker(w) {
  await w.frames(1200)
  assert.ok(walkReadout.grounded, 'the on-foot walker must land its spawn fall')
}

/**
 * Pump frames until a fine chunk is MOUNTED under the walker's direction (the
 * region publishes + its chunks stream in asynchronously through the worker;
 * landWalker's 1200 frames are more than enough, this is just belt-and-braces
 * so a slow worker reply never reads as a dispatch bug).
 */
async function waitForFine(w, bodyId, maxFrames = 600) {
  for (let i = 0; i < maxFrames; i++) {
    const region = fineRegionOf(bodyId)
    if (region && region.byHex.size > 0 && isFine(bodyId, walkerLocation.dir)) return true
    await w.frames(1)
  }
  return false
}

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
  await w.frames(1200) // real-human spawn: a fixed 120 m fall (~8 s at the 15 m/s terminal)
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
  await w.frames(1200) // real-human spawn: a fixed 120 m fall (~8 s at the 15 m/s terminal)
  assert.ok(walkReadout.grounded, 'the astronaut must be on the ground where the fall ended')
  await w.close()
})

test('drive: board rover → launch refused → drives + stays welded → eject → on foot', { timeout: 240_000 }, async () => {
  const w = await bootWorld({ world: 'testball' })
  await w.frames(30) // runtime sync (parked r resolves against the terrain)
  const id = w.craft('Rover').id
  const rt = craftRuntime.get(id)
  assert.ok(rt && rt.state.mode === 'park', 'rover must sync parked at boot')
  assert.ok(Number.isFinite(rt.state.r) && rt.state.r > 1, `parked r must be resolved to the surface (got ${rt.state.r})`)

  await w.board('Rover')
  assert.deepEqual(w.player, { kind: 'craft', craftId: id })

  // a rover is GROUND-LOCKED: launch is refused, it never leaves the pad
  await w.launch('Rover')
  assert.equal(craftRuntime.get(id).state.mode, 'park', 'a drive craft has no launch')

  // drive: W throttle — it moves along the surface...
  const dir0 = [...rt.state.dir]
  w.fly({ fwd: 1 })
  await w.frames(180) // 3 s at full throttle (ease 0.4 s)
  const st = craftRuntime.get(id).state
  assert.equal(st.mode, 'park', 'driving never enters space mode')
  const dot = st.dir[0] * dir0[0] + st.dir[1] * dir0[1] + st.dir[2] * dir0[2]
  const arc = Math.acos(Math.min(1, Math.max(-1, dot)))
  assert.ok(arc > 0.5, `the rover must drive along the surface (arc ${arc.toFixed(2)} rad)`)

  // it is WELDED to the rendered surface WHEN GROUNDED (the driveStep contract):
  // the anchor r is the chord-fan radius at its dir. Mid-fall — after it drove
  // off a ledge and obeys gravity (no lift) — it is legitimately above it.
  const surface = makeSurface(w.planet('p-testball'), null)
  if (st.grounded)
    assert.ok(
      Math.abs(st.r - surface.heightAt(st.dir).radius) < 1e-9,
      `grounded rover r (${st.r}) must equal the rendered surface radius at its dir (${surface.heightAt(st.dir).radius})`
    )

  // steer: A/D turns the heading (and the nose stays on the horizon)
  w.fly({ yaw: 1 })
  const h0 = [...st.heading]
  await w.frames(60)
  const st2 = craftRuntime.get(id).state
  const hdot = st2.heading[0] * h0[0] + st2.heading[1] * h0[1] + st2.heading[2] * h0[2]
  assert.ok(Math.acos(Math.min(1, Math.max(-1, hdot))) > 0.3, 'steering must turn the heading')
  const tang = st2.heading[0] * st2.dir[0] + st2.heading[1] * st2.dir[1] + st2.heading[2] * st2.dir[2]
  assert.ok(Math.abs(tang) < 0.05, `the nose stays on the horizon (heading·dir ${tang.toFixed(3)})`)

  // release + settle: the throttle eases to a stop, and any fall (it obeys
  // gravity when it drove off a ledge, but has NO lift) ends back on the ground
  w.flyReset()
  await w.frames(240) // 4 s: well past the longest fall + the stop
  const st3 = craftRuntime.get(id).state
  assert.ok(Math.abs(st3.speed) < 0.1, 'the throttle must ease back to 0')
  assert.ok(st3.grounded, 'the rover settles back on the ground (no lift)')
  assert.ok(
    Math.abs(st3.r - surface.heightAt(st3.dir).radius) < 1e-9,
    `grounded rover r (${st3.r}) must equal the rendered surface radius at its dir (${surface.heightAt(st3.dir).radius})`
  )

  // eject → on foot at where the rover drove to
  await w.eject()
  assert.deepEqual(w.player, { kind: 'foot', bodyId: 'p-testball' })
  await w.frames(1200) // real-human spawn: a fixed 120 m fall (~8 s at the 15 m/s terminal)
  assert.ok(walkReadout.grounded, 'the ejected astronaut must be on the ground')
  await w.close()
})

test('stubs: boot with a stub-first world (the elements-is-null crash)', { timeout: 240_000 }, async () => {
  // The DB skeleton serves giants as stubs (elements: null). Boot used to
  // drop the astronaut on the FIRST non-star body — a stub — and the
  // Walker's makeSurface died on `planet.elements.length`. The harness
  // boots exactly like the app's init() (player: defaultPlayer(world)),
  // so booting this fixture IS the regression:
  //  - defaultPlayer skips the stub and lands on the complete body
  //  - landOnPlanet(stub) hydrates first and bails when the atoms can't come
  //  - a foot session ON the stub (an EVA fall ends on the registry radius,
  //    which a stub has) kicks hydration, waits, gives up to the free cam
  const w = await bootWorld({ world: 'stubworld' })
  const stub = w.world.planets.find((p) => p.id === 'p-stub')
  assert.ok(stub.elements == null && stub.dbId != null, 'fixture sanity: the first body is a real stub')
  assert.deepEqual(w.player, { kind: 'foot', bodyId: 'p-little' }, 'defaultPlayer must skip the stub')
  await w.frames(60) // the walker spawns on the complete body — no crash

  // explicit landing on the stub: no database to answer dbId 999 → bail
  await w.walk('Stubby')
  await w.frames(10)
  assert.equal(w.player.bodyId, 'p-little', 'a failed stub hydration must not switch the session')

  // a foot session ON the stub (what an EVA land produces): the Walker must
  // kick the hydration, wait for atoms that never arrive, and give up
  await w.set({ player: { kind: 'foot', bodyId: 'p-stub' } })
  await w.frames(30)
  assert.deepEqual(w.player, { kind: 'foot', bodyId: 'p-stub' }, 'waiting for the streaming atoms')
  await w.frames(400) // ~300 frames of patience, then the free camera
  assert.equal(w.player.kind, 'freeCam', 'unresolvable stub must fall back to the free camera')
  await w.close()
})

// ---------------------------------------------------------------------------
// LOD level selection (lod.js / Planet.jsx): world-unit thresholds
// ---------------------------------------------------------------------------

test('lod: the mounted level coarsens with distance and refines up close', { timeout: 240_000 }, async () => {
  // testball: f12 document, chain [12, 6, 4], thresholds 95R / 142.5R
  // (×1.2 hysteresis). The level selection divided the camera distance by R
  // before comparing it against WORLD-unit thresholds, so every body stayed
  // at full resolution ~R-times longer than designed — a giant never
  // coarsened (Earth f203 out past the Moon) and a body in the sky never
  // rendered at its minimum level.
  const w = await bootWorld({ world: 'testball' })
  const entry = w.registry.bodies.get('p-testball')
  const R = entry.radius
  // The boot player is on FOOT (a parked shuttle): the Walker owns the camera
  // every frame and would clobber cameraNear. Free cam leaves it where we put it.
  await w.set({ player: { kind: 'freeCam' } })
  const camDist = () =>
    Math.hypot(
      w.camera.position.x - entry.pos.x,
      w.camera.position.y - entry.pos.y,
      w.camera.position.z - entry.pos.z
    )
  await w.cameraNear('Testball', { offset: [0, 0, R * 1.5] })
  await w.frames(30)
  assert.ok(camDist() < R * 3, `camera must hold the requested offset (got ${camDist().toFixed(2)}, want ${(R * 1.5).toFixed(2)})`)
  assert.equal(w.mountedFrequency('Testball'), 12, 'up close: full document resolution')
  await w.cameraNear('Testball', { offset: [0, 0, R * 300] })
  await w.frames(30)
  assert.ok(camDist() > R * 100, `camera must be far out (got ${camDist().toFixed(1)}, want ${(R * 300).toFixed(0)})`)
  assert.equal(w.mountedFrequency('Testball'), 4, 'far out: the coarsest level')
  await w.cameraNear('Testball', { offset: [0, 0, R * 1.5] })
  await w.frames(30)
  assert.equal(w.mountedFrequency('Testball'), 12, 'back close: refined to full resolution')
  await w.close()
})

// ---------------------------------------------------------------------------
// The fine-terrain region (docs/terrain.txt, stage 2). The fine grid IS the
// DEM pixel, so the fine surface is a COMPOSITE that differs from the document
// mesh — the pins below verify the machinery (lattice, streaming, dispatch,
// the stroke, clean teardown) AND the terrain reveal (the fine layer carries
// the DEM's relief, not the document's smoothed hexes). The 'testball' fixture
// boots on foot with a synthetic DEM (TEST-DEM, above): the real FineRegion
// streams the cap's DEM-pixel chunks and publishes the mounted set to
// core/finedisc.js. Every pin boots the camera along ANCHOR_DIR so the walker
// spawns at the flat-basin anchor (a known, in-budget focus).
// ---------------------------------------------------------------------------

test('finedisc (flight): the region streams while flying low, tears down past the cap', {
  timeout: 300_000,
}, async () => {
  const w = await bootWorld({ world: 'testball' })
  await w.frames(30) // runtime sync (parked r resolves against the terrain)
  const bodyId = w.planet('p-testball').id
  const id = w.craft('Shuttle').id
  await w.board('Shuttle')
  await w.launch('Shuttle')
  assert.equal(craftRuntime.get(id).state.mode, 'space', 'launch must put the craft off the pad')
  const cap = capRadiusU(w.world.scale)
  const R = planetRadius(w.planet(bodyId))
  // The launch point sits LAUNCH_LIFT·R above the pad — inside the cap radius.
  // (The regression this pin guards: launch clears the doc anchor, and the old
  // gate read ONLY the anchor — so the region tore down for the entire flight
  // and no streamed terrain was visible until the craft parked again.)
  const st = craftRuntime.get(id).state
  const d0 = Math.hypot(st.pos.x, st.pos.y, st.pos.z)
  assert.ok(
    d0 - R < cap,
    `the launch point must be inside the cap radius (got ${(d0 - R).toFixed(3)} u, cap ${cap.toFixed(3)} u)`
  )
  await w.frames(60)
  const region = fineRegionOf(bodyId)
  assert.ok(region, 'a craft flying low over the body must publish a fine region (the flight gate)')
  assert.ok(region.byHex.size > 0, 'chunks must stream in while flying low')
  // climb out of the cap radius → the per-frame proximity check (fineFocusFor)
  // must tear the region down even though the gate still holds the body
  w.fly({ fwd: 1 })
  let torn = false
  for (let i = 0; i < 60 * 120 && !torn; i++) {
    await w.frames(1)
    torn = fineRegionOf(bodyId) === null
  }
  w.flyReset()
  const st2 = craftRuntime.get(id).state
  const d1 = Math.hypot(st2.pos.x, st2.pos.y, st2.pos.z)
  assert.ok(d1 - R > cap, `the craft must be OUT of the cap radius by the end (got ${(d1 - R).toFixed(2)} u, cap ${cap.toFixed(3)} u)`)
  assert.ok(torn, 'flying past the cap radius must tear the region down')
  await w.close()
})

test('finedisc: the walker welds to the fine surface of record (chunks mounted)', {
  timeout: 300_000,
}, async () => {
  const w = await bootWorld({ world: 'testball', camera: { position: FINE_CAM } })
  await landWalker(w)
  const bodyId = w.planet('p-testball').id
  // the real FineRegion published its mounted set to the core dispatch
  assert.ok(fineRegionOf(bodyId), 'the on-foot focus body must publish a fine region')
  assert.ok(await waitForFine(w, bodyId), 'a chunk must be mounted under the walker')
  assert.ok(fineRegionOf(bodyId).byHex.size > 0, 'the published region must carry landed fine hexes')
  // §6 dispatch: the surface of record at the walker's dir is the FINE composite
  const surface = makeSurface(w.planet(bodyId), w.world.scale)
  const rec = surfaceOfRecord(surface, bodyId, walkerLocation.dir)
  assert.equal(rec.fine, true, 'the dispatch must report the fine branch under the walker')
  assert.notEqual(rec.surface, surface, 'stage 2: the fine surface is a COMPOSITE, not the document')
  // the weld: the walker's radius equals the fine surface-of-record radius at its dir
  const q = rec.surface.heightAt(walkerLocation.dir)
  assert.ok(
    Math.abs(walkerLocation.r - q.radius) < 1e-6,
    `walker r (${walkerLocation.r}) must equal the fine-surface radius at its dir (${q.radius})`
  )
  // and it holds across frames as the region streams/settles around the walker
  const t = await w.track('Testball')
  const { missed } = await w.frames(240, { jitter: true })
  const s = t.stats()
  await w.close()
  assert.equal(s.jumps.length, 0, `discontinuities: ${JSON.stringify(s.jumps.slice(0, 5))}`)
  assert.ok(s.maxHexCameraU < 0.05, `per-frame view-space slide ${s.maxHexCameraU.toExponential(2)} u — weld broken`)
  assert.ok(missed <= 3, `missed worker frames: ${missed}`)
})

test('finedisc: the pick remaps a fine hit to the document cell', { timeout: 300_000 }, async () => {
  const w = await bootWorld({ world: 'testball', camera: { position: FINE_CAM } })
  await landWalker(w)
  const bodyId = w.planet('p-testball').id
  const region = fineRegionOf(bodyId)
  assert.ok(region, 'the fine region must be published (the pick dispatch consults it)')
  assert.ok(await waitForFine(w, bodyId), 'a chunk must be mounted under the walker')
  // the fine hex under the walker's dir maps to the DOCUMENT cell under the
  // same dir — the fine→doc map is exact (the composite sample reports the
  // enclosing document cell, the brush/selection contract)
  const grid = getHexSphere(w.planet(bodyId).frequency)
  const e = fineHexUnder(region, walkerLocation.dir)
  assert.ok(e, 'a fine hex must be mounted under the walker')
  assert.equal(
    e.docCell,
    cellAtDirection(grid, walkerLocation.dir),
    'the fine→doc map must agree with the document Voronoi lookup'
  )
  // the pick remap is the pass-through contract point: with the stage-2
  // dispatch the hit's cell is ALREADY the document cell (the composite
  // applies the fine→doc map at the sample), so the remap is the identity
  assert.equal(remapToDoc(bodyId, e.docCell), e.docCell, 'remapToDoc is the identity pass-through')
  await w.close()
})

test('finedisc: a stroke composites — doc + overlay + same-frame chunk patch', { timeout: 300_000 }, async () => {
  const w = await bootWorld({ world: 'testball', camera: { position: FINE_CAM } })
  await landWalker(w)
  const bodyId = w.planet('p-testball').id
  assert.ok(await waitForFine(w, bodyId), 'a chunk must be mounted under the walker')
  const cell = walkerLocation.cell
  // the chunk mesh(es) covering the underfoot cell (before the stroke)
  const coveringBefore = w
    .terrainMeshes()
    .filter((m) => !m.suppressed)
    .filter((m) => m.geometry.userData.cellByTri.includes(cell))
  assert.ok(coveringBefore.length >= 1, 'a mounted chunk must cover the underfoot cell')
  const meshBefore = coveringBefore[0].object
  const geoBefore = coveringBefore[0].geometry
  const posBefore = Float32Array.from(geoBefore.attributes.position.array)
  const hBefore = useStore.getState().world.planets.find((p) => p.id === bodyId).elements[cell].h

  // the stroke: raise the underfoot cell (§5 steps 1-4)
  await act(async () => {
    useStore.setState({ tool: 'raise', strength: 0.5 })
    useStore.getState().applyBrush(bodyId, cell)
  })
  const hAfter = useStore.getState().world.planets.find((p) => p.id === bodyId).elements[cell].h
  assert.ok(hAfter !== hBefore, 'step 1: the document cell must be raised')
  // step 2: the sparse edit overlay records the stroke
  const edit = fineEditFor(bodyId, cell)
  assert.ok(edit && edit.h === hAfter, 'step 2: the overlay must record the raised height')
  // step 3: the covering chunk is rebuilt the SAME frame with the new height —
  // the patcher swaps in a fresh mesh + geometry (the weld invariant holds for
  // the fine layer exactly as for the document)
  const coveringAfter = w
    .terrainMeshes()
    .filter((m) => !m.suppressed)
    .filter((m) => m.geometry.userData.cellByTri.includes(cell))
  assert.ok(coveringAfter.length >= 1, 'the underfoot cell must still be covered by a chunk')
  const meshAfter = coveringAfter[0].object
  const geoAfter = coveringAfter[0].geometry
  assert.notEqual(meshAfter, meshBefore, 'step 3: the patcher must swap in a fresh chunk mesh')
  assert.notEqual(geoAfter, geoBefore, 'step 3: ...with a fresh geometry')
  const posAfter = Float32Array.from(geoAfter.attributes.position.array)
  let changed = posBefore.length !== posAfter.length
  if (!changed) for (let i = 0; i < posBefore.length; i++) if (posBefore[i] !== posAfter[i]) { changed = true; break }
  assert.ok(changed, 'step 3: the rebuilt chunk must carry the new height in its vertices')
  // stage 2: the published region's underfoot fine hex carries the painted
  // height too — the patcher re-synthesized the covering chunk (the edit
  // overlay is the synthesis input) and mutated the region's e in place, so
  // the dispatch reads the painted height on its next query
  const e = fineHexUnder(fineRegionOf(bodyId), walkerLocation.dir)
  assert.ok(e && e.h === hAfter, 'the region\'s underfoot fine hex must carry the painted height')
  await w.close()
})

test('finedisc: unmount is clean — chunks disposed, no leak, the doc mesh stays', { timeout: 300_000 }, async () => {
  const w = await bootWorld({ world: 'testball', camera: { position: FINE_CAM } })
  await landWalker(w)
  const bodyId = w.planet('p-testball').id
  assert.ok(await waitForFine(w, bodyId), 'a chunk must be mounted under the on-foot walker')
  // the mounted chunk meshes + their geometries (wrap dispose to count teardown)
  const chunks = w.terrainMeshes().filter((m) => !m.suppressed)
  assert.ok(chunks.length >= 1, 'chunks must be mounted under the on-foot walker')
  const geos = chunks.map((c) => c.geometry)
  const disposed = new Set()
  for (const g of geos) {
    const orig = g.dispose.bind(g)
    g.dispose = () => { disposed.add(g); orig() }
  }
  // the document terrain mesh (the suppression clone while focused) survives
  const docBefore = w.terrainMeshes().filter((m) => m.suppressed)
  assert.ok(docBefore.length >= 1, 'the focus body doc terrain renders with the suppression material')
  const docGeo = docBefore[0].geometry
  // unmount: leave the body (free cam) → every chunk evicts
  await w.set({ player: { kind: 'freeCam' } })
  await w.frames(30)
  for (const g of geos) assert.ok(disposed.has(g), 'an evicted chunk geometry must be disposed (no leak)')
  // chunks are identified by their captured geometries — after unmount the DOC
  // terrain is also unsuppressed, so a suppressed-flag filter can't tell them apart
  assert.equal(w.terrainMeshes().filter((m) => geos.includes(m.geometry)).length, 0, 'no chunk meshes remain after unmount')
  assert.ok(w.terrainMeshes().some((m) => m.geometry === docGeo), 'the document terrain mesh must survive the eviction')
  await w.close()
})

test('finedisc: unmount restores byte-identical LOD rendering (unsuppressed, same level)', {
  timeout: 300_000,
}, async () => {
  const w = await bootWorld({ world: 'testball', camera: { position: FINE_CAM } })
  await landWalker(w)
  const bodyId = w.planet('p-testball').id
  assert.ok(await waitForFine(w, bodyId), 'chunks must be mounted while walking')
  const lvlBefore = w.mountedFrequency('Testball')
  assert.ok(lvlBefore != null, 'a LOD level must be mounted while walking')
  const before = w.terrainMeshes()
  const docTypes = before.filter((m) => m.suppressed).length // the doc terrain's type batches
  const chunkCount = before.filter((m) => !m.suppressed).length
  assert.ok(docTypes >= 1 && chunkCount >= 1, 'focused: the doc terrain (suppressed) + the chunks (normal)')
  const docGeo = before.find((m) => m.suppressed).geometry
  const docFreq = docGeo.userData.frequency
  // unmount
  await w.set({ player: { kind: 'freeCam' } })
  await w.frames(30)
  // the region is cleared: the dispatch falls back to the document
  assert.equal(fineRegionOf(bodyId), null, 'the fine region must be cleared on unmount')
  const after = w.terrainMeshes()
  assert.ok(!after.some((m) => m.suppressed), 'the doc terrain must be UNSUPPRESSED after unmount')
  assert.equal(after.length, docTypes, 'only the doc terrain batches remain (every chunk is gone)')
  const docAfter = after.find((m) => m.geometry === docGeo)
  assert.ok(docAfter, 'the doc terrain mesh is back — the SAME geometry object (byte-identical)')
  assert.equal(docAfter.geometry.userData.frequency, docFreq, 'the LOD level is unchanged')
  assert.equal(w.mountedFrequency('Testball'), lvlBefore, 'the mounted LOD level is byte-identical')
  await w.close()
})

test('finedisc: the fine layer carries the DEM relief (blended, not the document)', {
  timeout: 300_000,
}, async () => {
  const w = await bootWorld({ world: 'testball', camera: { position: FINE_CAM } })
  await landWalker(w)
  const bodyId = w.planet('p-testball').id
  assert.ok(await waitForFine(w, bodyId), 'a chunk must be mounted under the walker')
  const planet = w.planet(bodyId)
  const region = fineRegionOf(bodyId)
  const R = region.R
  const scale = w.world.scale
  const capAngle = capRadiusU(scale) / R
  const inner = (1 - C.fineDisc.feather) * capAngle
  const focus = walkerLocation.dir

  // the DEM tile under the focus (the whole cap sits in one 120° tile) — the
  // SAME pixels the synthesis sampled, so the identity below is exact
  const fLL = dirToLatLon(focus)
  const [tl, ln] = tileKeyFor(fLL.latDeg, fLL.lonDeg, DEM_TILE_SIZE, DEM_PIXEL_DEG)
  const tile = await DEM_TILE(DEM_CATALOG, tl, ln)
  assert.ok(tile, 'the synthetic DEM tile under the focus must be present')
  const tileMap = new Map([[tl + ',' + ln, tile]])

  // (a) deep inside (w = 1): the fine hex's height IS the DEM pixel, exactly —
  // the int16 identity through the feather (1·x + 0·y, no interpolation)
  // (b) outside the cap (w = 0): the fine hex sits on the document, exactly —
  // the full blocks extend past the cap, so these hexes exist and must be the
  // document's own height (the seam is invisible there)
  let nW1 = 0
  let nW0 = 0
  for (const e of region.byHex.values()) {
    const c3 = fineHexDirs(region.patch, e.q, e.r, region.a).c3
    const { latDeg, lonDeg } = dirToLatLon(c3)
    const cosD = c3[0] * focus[0] + c3[1] * focus[1] + c3[2] * focus[2]
    const d = Math.acos(Math.min(1, Math.max(-1, cosD)))
    if (d <= inner) {
      const elev = demElevationAt(latDeg, lonDeg, tileMap, DEM_PIXEL_DEG, DEM_TILE_SIZE)
      assert.ok(elev != null, 'the DEM must answer for a deep-inside pixel')
      assert.equal(e.h, elev / scale, `w=1 hex (${e.q},${e.r}) must carry the DEM pixel exactly`)
      nW1++
    } else if (d >= capAngle) {
      assert.equal(e.h, (planet.elements[e.docCell].h || 0), `w=0 hex (${e.q},${e.r}) must sit on the document exactly`)
      nW0++
    }
  }
  assert.ok(nW1 > 0, 'there must be deep-inside (w=1) hexes in the region')
  assert.ok(nW0 > 0, 'there must be out-of-cap (w=0) hexes in the region (full blocks)')

  // (c) at the walker's dir the fine surface differs from the document — the
  // DEM's relief is on the surface of record, not the document's smoothed hex
  const surface = makeSurface(planet, scale)
  const qf = surfaceOfRecord(surface, bodyId, focus).surface.heightAt(focus)
  const qd = surface.heightAt(focus)
  assert.ok(
    Math.abs(qf.h - qd.h) > 1e-4,
    `the fine relief must differ from the document at the walker dir (got ${Math.abs(qf.h - qd.h)})`
  )

  // (d) the chunk MESH carries it: a top vertex sits at radius R + the fine
  // height (the chord-fan top is at R + h exactly, quantized to float32)
  const cell = qf.cell
  const covering = w
    .terrainMeshes()
    .filter((m) => !m.suppressed)
    .filter((m) => m.geometry.userData.cellByTri.includes(cell))
  assert.ok(covering.length >= 1, 'a chunk must cover the underfoot document cell')
  const target = R + qf.h
  let found = false
  for (const cm of covering) {
    const pos = cm.geometry.attributes.position
    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i)
      const vy = pos.getY(i)
      const vz = pos.getZ(i)
      if (Math.abs(Math.hypot(vx, vy, vz) - target) < 1e-4) {
        found = true
        break
      }
    }
    if (found) break
  }
  assert.ok(found, `the chunk mesh must carry a top vertex at R + the fine height (${target})`)
  await w.close()
})

test('finedisc (hex mode): the fine layer carries the stored-hex relief (blended, not the document)', {
  timeout: 300_000,
}, async () => {
  const w = await bootWorld({ world: 'hexball', camera: { position: FINE_CAM } })
  await landWalker(w)
  const bodyId = w.planet('p-testball').id
  assert.ok(await waitForFine(w, bodyId), 'a chunk must be mounted under the walker')
  const planet = w.planet(bodyId)
  const region = fineRegionOf(bodyId)
  const R = region.R
  const scale = w.world.scale
  const capAngle = capRadiusU(scale) / R
  const inner = (1 - C.fineDisc.feather) * capAngle
  const focus = walkerLocation.dir
  // the SAME grid the component builds (highResGrid is memoized per
  // (radiusM, hexMeters)) — the test's lookups and the synthesis's agree
  const grid = highResGrid(R * scale, w.world.hex_meters)
  const docGrid = getHexSphere(planet.frequency)

  // (a) deep inside (w = 1): the fine hex's height IS the STORED hex under it,
  // exactly — the nearest-point sample through the feather (1·x + 0·y)
  // (b) outside the cap (w = 0): the fine hex sits on the document, exactly
  let nW1 = 0
  let nW0 = 0
  for (const e of region.byHex.values()) {
    const c3 = fineHexDirs(region.patch, e.q, e.r, region.a).c3
    const cosD = c3[0] * focus[0] + c3[1] * focus[1] + c3[2] * focus[2]
    const d = Math.acos(Math.min(1, Math.max(-1, cosD)))
    if (d <= inner) {
      const { row, col } = nearestCell(grid, c3)
      const hStored = testHexHeight(planet, docGrid, grid, row, col)
      assert.equal(
        e.h,
        hStored,
        `w=1 hex (${e.q},${e.r}) must carry its stored hex exactly (got ${e.h}, want ${hStored})`
      )
      nW1++
    } else if (d >= capAngle) {
      assert.equal(e.h, (planet.elements[e.docCell].h || 0), `w=0 hex (${e.q},${e.r}) must sit on the document exactly`)
      nW0++
    }
  }
  assert.ok(nW1 > 0, 'there must be deep-inside (w=1) hexes in the region')
  assert.ok(nW0 > 0, 'there must be out-of-cap (w=0) hexes in the region (full blocks)')

  // (c) at the walker's dir the fine surface differs from the document — the
  // stored hexes' relief is on the surface of record, not the document's
  // smoothed hex. (This is the flat-terrain regression: a rect-keyed LRU
  // passed where a row-keyed lookup was expected made EVERY hex fall back to
  // the document, so the fine layer rendered exactly at document height.)
  const surface = makeSurface(planet, scale)
  const qf = surfaceOfRecord(surface, bodyId, focus).surface.heightAt(focus)
  const qd = surface.heightAt(focus)
  assert.ok(
    Math.abs(qf.h - qd.h) > 1e-4,
    `the fine relief must differ from the document at the walker dir (got ${Math.abs(qf.h - qd.h)})`
  )

  // (d) the chunk MESH carries it: a top vertex sits at radius R + the fine
  // height (the chord-fan top is at R + h exactly, quantized to float32)
  const cell = qf.cell
  const covering = w
    .terrainMeshes()
    .filter((m) => !m.suppressed)
    .filter((m) => m.geometry.userData.cellByTri.includes(cell))
  assert.ok(covering.length >= 1, 'a chunk must cover the underfoot document cell')
  const target = R + qf.h
  let found = false
  for (const cm of covering) {
    const pos = cm.geometry.attributes.position
    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i)
      const vy = pos.getY(i)
      const vz = pos.getZ(i)
      if (Math.abs(Math.hypot(vx, vy, vz) - target) < 1e-4) {
        found = true
        break
      }
    }
    if (found) break
  }
  assert.ok(found, `the chunk mesh must carry a top vertex at R + the fine height (${target})`)
  await w.close()
})
