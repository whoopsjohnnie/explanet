/**
 * harness/index.mjs — headless ExPlanet: the REAL app pipeline in memory.
 *
 * Boots the actual React tree (@react-three/test-renderer, null GL) with the
 * actual Scene components, a real @react-three/cannon physics worker and the
 * real geometry module worker (both shimmed onto worker_threads by env.mjs),
 * then advances frames deterministically. Every frame is sampled at the
 * render point — after all useFrame subscribers ran, before the next worker
 * reply can land — which is exactly what a browser would put on screen.
 *
 * This is the headless alternative to browser automation (headless Firefox
 * hangs here — no GPU). Playwright-flavoured usage:
 *
 *   const w = await bootWorld({ world: 'sol-real', controls: true, follow: true })
 *   await w.set({ selectedId: w.planet('Earth').id, followSelected: true })
 *   await w.cameraNear('Earth', { offset: [0, 60, 220] })
 *   await w.frames(90)                       // let LOD/controls settle
 *   const t = w.track('Earth')               // anchor one hex vertex
 *   await w.frames(480, { jitter: true })    // RAF-jittered time
 *   t.stats() // { maxPxPerFrame, signFlips, maxHexCameraU, maxMeshEntryU, jumps, … }
 *   await w.board('Shuttle')                 // astronaut: board a craft
 *   await w.launch('Shuttle')                // …launch it off the pad
 *   w.fly({ fwd: 1 })                        // drive the shared flight input
 *   //    (what the cockpit keys do); w.player tracks { kind: 'foot' |
 *   //    'craft' | 'eva' | 'freeCam' } — landing flips it back to 'foot'
 *   await w.close()
 *
 * Trackers answer the questions that matter for a rendered world:
 *  - maxPxPerFrame / signFlips: does an anchored hex jitter on screen?
 *  - maxHexCameraU: per-frame slide of the hex in view space (weld quality)
 *  - maxMeshEntryU: |rendered mesh pose − physics registry| — must be 0
 *    (the float32-quantization contract, see Planet.jsx subscription)
 *  - jumps: large per-frame position/rotation discontinuities, NaN
 */

import { register } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { installEnv } from './env.mjs'

register('./loader.mjs', import.meta.url)
const { ops } = installEnv()

// ---- app modules (after the loader + browser stubs exist) -------------------
const React = (await import('react')).default
const TRT = (await import('@react-three/test-renderer')).default
const { act } = await import('@react-three/test-renderer')
const THREE = await import('three')
const { useFrame, useThree } = await import('@react-three/fiber')
const { Physics } = await import('@react-three/cannon')
const { OrbitControls } = await import('@react-three/drei')
const { useStore } = await import('../../src/state/store.js')
const { registry, stepGravity } = await import('../../src/core/physics.js')
const { makeStarterWorld } = await import('../../src/core/starter.js')
const { normalizeWorld, createPlanet, createCraft } = await import('../../src/core/worldSchema.js')
const { planetRadius, radiusForFrequency } = await import('../../src/core/planetMath.js')
const { animateTerrainMaterials } = await import('../../src/three/materials.js')
const Planet = (await import('../../src/components/Planet.jsx')).default
const Walker = (await import('../../src/components/Walker.jsx')).default
const CameraFollow = (await import('../../src/components/CameraFollow.jsx')).default
const AmbientCrafts = (await import('../../src/components/Crafts.jsx')).default
const CraftCockpit = (await import('../../src/components/CraftCockpit.jsx')).default
const EvaCam = (await import('../../src/components/EvaCam.jsx')).default
const { craftRuntime, eva, resetFlightInput, flightInput, pendingFoot } = await import(
  '../../src/core/motion.js'
)

/** Reset the motion framework's module state between boots (it is process-
 *  global: craftRuntime, the adrift astronaut, held keys, foot handoff). */
function resetMotionState() {
  craftRuntime.clear()
  eva.state = null
  resetFlightInput()
  pendingFoot.bodyId = null
  pendingFoot.dir = null
}

const h = React.createElement
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Sol Real ships ~1000 bodies; gravity-representative subset for tests. */
export const SOL_REAL_MAJOR = [
  'Sun', 'Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune',
]

/**
 * Synthetic single-planet flight fixture (spec 'testball'), built in code so
 * no world-data file is ever committed:
 *  - NO star — a star's pull dominates every planet in the toy-scale worlds
 *    (starter Earth: sun ≈ 1000× the planet at the surface), which makes
 *    "the EVA fall ends on a planet" physically unreachable there; true-scale
 *    worlds get it right but a real fall there takes minutes of sim time.
 *  - one static, spinless freq-12 earthlike body of TUNED mass so local
 *    gravity is strong: a few-unit EVA fall completes in ~1–3 s of frames.
 *  - one arcade shuttle parked on it — the full P1 chain (board → launch →
 *    fly → park → eject-on-foot; eject-flying → EVA → fall → land-on-foot)
 *    is deterministic here.
 */
export function makeTestballWorld() {
  const FREQ = 12
  const planet = createPlanet({
    id: 'p-testball',
    name: 'Testball',
    preset: 'earthlike',
    seed: 7, // fixed: the fixture is deterministic
    frequency: FREQ,
    center: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    spin: { x: 0, y: 0, z: 0 },
    isStatic: true,
    // tuned mass (≈120): v_esc ≈ 30 u/s ≈ 2× arcade cruise, g ≈ 40 u/s²
    density: 120 / ((4 / 3) * Math.PI * radiusForFrequency(FREQ) ** 3),
  })
  return {
    version: 1,
    name: 'Testball',
    gravity: 40,
    planets: [planet],
    crafts: [
      createCraft({
        id: 'c-testball-shuttle',
        name: 'Shuttle',
        kind: 'shuttle',
        realism: 'arcade',
        pose: { anchor: { bodyId: 'p-testball', dir: [0, 0.7, 0.7], r: null } },
      }),
    ],
  }
}

function loadWorld(spec) {
  if (spec === 'starter') return makeStarterWorld()
  if (spec === 'testball') return makeTestballWorld()
  let path = spec
  if (spec === 'sol-real') path = fileURLToPath(new URL('../../public/sol-real.json', import.meta.url))
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    if (spec === 'sol-real') throw new Error('public/sol-real.json missing — regenerate: node scripts/gen-sol-real.mjs')
    throw e
  }
  return JSON.parse(raw)
}

/**
 * Boot a world and mount the real tree (mirror of Scene.jsx minus presentation:
 * no starfield/fog/sky — physics, planets, controls, follow, walker, materials
 * are all real, mounted in Scene's exact order).
 */
export async function bootWorld(opts = {}) {
  const {
    world = 'starter', // 'starter' | 'sol-real' | path to a world document
    filter = null, // keep only these planet names (required-ish for sol-real)
    controls = false, // real drei <OrbitControls makeDefault>
    follow = false, // real <CameraFollow>
    store = {}, // extra initial store overrides
    camera: cam0 = {}, // { fov, near, far, position?, target? }
    settle = 60, // frames advanced before boot() returns
    verbose = false,
  } = opts

  const doc = loadWorld(world)
  const normalized = normalizeWorld({
    ...doc,
    planets: filter ? doc.planets.filter((p) => filter.includes(p.name)) : doc.planets,
  })

  resetMotionState() // module state is process-global; start clean every boot

  // store: fresh, deterministic starting point (Scene's own defaults); the
  // flight tests flip the player explicitly (board/launch/eject)
  useStore.setState({
    world: normalized,
    ready: true,
    showLabels: false,
    selectedId: null,
    followSelected: false,
    player: { kind: 'freeCam' },
    selectedCraftId: null,
    playing: true,
    ...store,
  })

  const sysR = (() => {
    let r = 80
    for (const p of normalized.planets) r = Math.max(r, Math.hypot(p.center.x, p.center.y, p.center.z))
    return r
  })()

  const probe = {}
  const trackers = []

  // ---- tree (component order == Scene.jsx: Physics, controls, follow, walker)
  function GravityRunner() {
    useFrame(() => {
      const s = useStore.getState()
      if (s.playing) stepGravity(s.world.gravity)
    })
    return null
  }
  function MaterialAnimator() {
    useFrame((_, delta) => animateTerrainMaterials(Math.min(delta, 0.05)))
    return null
  }
  function Probe() {
    const scene = useThree((s) => s.scene)
    const camera = useThree((s) => s.camera)
    const controls = useThree((s) => s.controls)
    React.useEffect(() => {
      probe.scene = scene
      probe.camera = camera
    }, [scene, camera])
    React.useEffect(() => {
      probe.controls = controls || null
    }, [controls])
    return null
  }
  function Tree() {
    const planets = useStore((s) => s.world.planets)
    const playing = useStore((s) => s.playing)
    const player = useStore((s) => s.player)
    return h(
      React.Fragment,
      null,
      h(
        Physics,
        { gravity: [0, 0, 0], isPaused: !playing, broadphase: 'SAP', allowSleep: false, iterations: 8 },
        planets.map((p) => h(Planet, { key: p.id, planet: p })),
        h(Probe),
        h(GravityRunner)
      ),
      // Scene's mount order == useFrame order: the crafts step BEFORE the
      // cameras (cockpit/EVA/walker) read them
      h(AmbientCrafts),
      controls &&
        h(OrbitControls, {
          makeDefault: true,
          enableDamping: true,
          dampingFactor: 0.09,
          minDistance: 1.5,
          maxDistance: Math.max(1600, sysR * 2.4),
          enabled: !player || player.kind === 'freeCam',
        }),
      follow && h(CameraFollow),
      player?.kind === 'craft' && h(CraftCockpit, { key: player.craftId, craftId: player.craftId }),
      player?.kind === 'eva' && h(EvaCam),
      player?.kind === 'foot' && h(Walker, { key: player.bodyId, planetId: player.bodyId }),
      h(MaterialAnimator)
    )
  }

  // ---- mount
  const inst = await TRT.create(h(Tree))
  await act(async () => {
    await sleep(50)
  })
  if (!probe.scene) throw new Error('harness probe did not mount')
  const scene = probe.scene
  const camera = probe.camera
  camera.fov = cam0.fov ?? 45
  camera.near = cam0.near ?? 0.1
  camera.far = cam0.far ?? 1e9
  camera.updateProjectionMatrix()
  if (cam0.position) {
    camera.position.set(...cam0.position)
    if (probe.controls) {
      probe.controls.target.set(...(cam0.target ?? [0, 0, 0]))
      probe.controls.update()
    }
  }

  // ---- frame pump (worker round-trip per frame, sampled at the render point)
  let lastReplies = ops.frames
  let totalMissed = 0
  async function waitForReply(timeoutTicks = 400) {
    for (let i = 0; i < timeoutTicks; i++) {
      await sleep(0)
      if (ops.frames > lastReplies) {
        lastReplies = ops.frames
        return true
      }
    }
    return false
  }

  async function frames(n, frameOpts = {}) {
    const { dt = 1 / 60, jitter = false, stallChance = 0.004, onFrame = null } = frameOpts
    let missed = 0
    for (let f = 0; f < n; f++) {
      let d = dt
      if (jitter) {
        d = (8 + Math.random() * 12) / 1000 // 8..20 ms like a real RAF
        if (Math.random() < stallChance) d = 0.12 // occasional GC hitch
      }
      await act(async () => {
        inst.advanceFrames(1, d)
        // RENDER POINT: in a browser, gl.render() runs in the same task as the
        // subscribers; no worker message can interleave. Sample synchronously.
        scene.updateMatrixWorld(true)
        camera.updateMatrixWorld()
        for (const t of trackers) t._sample(d)
        if (onFrame) onFrame()
        if (!(await waitForReply())) {
          missed++
          totalMissed++
        }
      })
    }
    return { missed }
  }

  // ---- helpers
  function planet(nameOrId) {
    const p = normalized.planets.find((q) => q.name === nameOrId || q.id === nameOrId)
    if (!p) throw new Error(`no planet "${nameOrId}" in this world`)
    return p
  }

  function findBodyMesh(id) {
    const entry = registry.bodies.get(id)
    if (!entry) return null
    const ep = new THREE.Vector3(entry.pos.x, entry.pos.y, entry.pos.z)
    const reach = Math.max((entry.radius ?? 1) * 1.5, 1)
    let best = null
    scene.traverse((o) => {
      if (!o.isMesh || !o.geometry?.attributes?.position) return
      const wp = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld)
      const d = wp.distanceTo(ep)
      if (d < reach && (!best || d < best.d)) best = { mesh: o, group: o.parent, d }
    })
    return best
  }

  /**
   * Anchor a tracker to one rendered vertex of a body (default vertex 0 of the
   * active LOD mesh — an arbitrary coastline corner) and sample it every frame.
   * Pumps frames while the geometry workers are still building if needed.
   */
  async function track(nameOrId, trackOpts = {}) {
    const { vertex = 0, jumpDistU = 3, jumpAngleRad = 0.25, waitFrames = 900 } = trackOpts
    const p = planet(nameOrId)
    let found = findBodyMesh(p.id)
    for (let i = 0; !found && i < waitFrames; i++) {
      await frames(1)
      found = findBodyMesh(p.id)
    }
    if (!found) throw new Error(`no rendered mesh found near ${p.name}`)
    const anchorLocal = new THREE.Vector3()
      .fromBufferAttribute(found.mesh.geometry.attributes.position, vertex)
      .applyMatrix4(found.mesh.matrixWorld)
    scene.updateMatrixWorld(true)
    found.group.worldToLocal(anchorLocal) // frozen in body-local space, forever
    const t = {
      label: p.name + (vertex ? `#${vertex}` : ''),
      id: p.id,
      mesh: found.mesh,
      group: found.group,
      anchorLocal,
      // state —
      n: 0,
      sumPx: 0,
      maxPx: 0,
      pxHistory: [],
      signFlips: 0,
      maxRelCam: 0,
      maxMeshEntry: 0,
      swaps: 0,
      jumps: [],
      _prev: null,
      _prevDx: null,
      _prevQ: null,
      _sample(dt = 1 / 60) {
        // Physics replies land between frames: the motion seen between sample
        // N-1 and N was stepped by frame N-1's dt, so the jump budget uses the
        // PREVIOUS sample's dt (a 0.12 s stall legitimately travels ≈ 7·dt).
        const stepDt = t._prev ? t._prev.dt : dt
        const posBudget = jumpDistU * stepDt * 60
        const angBudget = jumpAngleRad * stepDt * 60
        const entry = registry.bodies.get(p.id)
        const grpW = new THREE.Vector3().setFromMatrixPosition(t.group.matrixWorld)
        const hexW = t.anchorLocal.clone().applyMatrix4(t.group.matrixWorld)
        const ndc = hexW.clone().project(camera)
        const px = new THREE.Vector3(((ndc.x + 1) / 2) * 1280, ((1 - ndc.y) / 2) * 800, ndc.z)
        const q = new THREE.Quaternion().setFromRotationMatrix(t.group.matrixWorld)
        if (!t.mesh.parent) t.swaps++ // LOD remount; anchor remains a planet-fixed point
        if (t._prev) {
          t.n++
          const dPx = px.distanceTo(t._prev.px)
          t.sumPx += dPx
          t.maxPx = Math.max(t.maxPx, dPx)
          t.pxHistory.push(dPx)
          // view-space slide in the CAMERA frame: the world-frame hex→camera
          // vector rotates as a spinning planet carries both endpoints, so
          // differencing it in world space measures rotation, not weld error.
          const hexCamL = hexW.clone().sub(camera.position).applyQuaternion(camera.quaternion.clone().invert())
          t.maxRelCam = Math.max(t.maxRelCam, hexCamL.distanceTo(t._prev.hexRel))
          const dx = px.x - t._prev.px.x
          if (t._prevDx !== null && dx * t._prevDx < 0 && Math.abs(dx) > 1e-4) t.signFlips++
          t._prevDx = dx
          if (entry) t.maxMeshEntry = Math.max(t.maxMeshEntry, grpW.distanceTo(entry.pos))
          const dPos = grpW.distanceTo(t._prev.grpW)
          if (!(dPos <= posBudget)) t.jumps.push({ frame: t.n, kind: 'pos', dist: dPos, dt: stepDt })
          const dAng = t._prevQ.angleTo(q)
          if (!(dAng <= angBudget)) t.jumps.push({ frame: t.n, kind: 'spin', dist: dAng, dt: stepDt })
          if (Number.isNaN(dPos) || Number.isNaN(dPx)) t.jumps.push({ frame: t.n, kind: 'NaN' })
        }
        t._prevQ = q
        t._prev = {
          px,
          grpW,
          hexRel: hexW.clone().sub(camera.position).applyQuaternion(camera.quaternion.clone().invert()),
          dt,
        }
      },
      reset() {
        t.n = 0
        t.sumPx = 0
        t.maxPx = 0
        t.pxHistory = []
        t.signFlips = 0
        t.maxRelCam = 0
        t.maxMeshEntry = 0
        t.swaps = 0
        t.jumps = []
        t._prev = null
        t._prevDx = null
      },
      stats() {
        const sorted = t.pxHistory.slice().sort((a, b) => a - b)
        return {
          label: t.label,
          frames: t.n,
          medianPxPerFrame: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
          maxPxPerFrame: t.maxPx,
          signFlips: t.signFlips,
          maxHexCameraU: t.maxRelCam,
          maxMeshEntryU: t.maxMeshEntry,
          meshSwaps: t.swaps,
          jumps: t.jumps,
        }
      },
    }
    trackers.push(t)
    return t
  }

  // (track() above may pump frames itself while geometry builds)

  async function walk(nameOrId) {
    const p = planet(nameOrId)
    await act(async () => {
      await useStore.getState().landOnPlanet(p.id)
    })
  }

  // ---- the astronaut (docs/flight.txt): board / launch / eject / fly ------
  function craft(nameOrId) {
    const c = (normalized.crafts || []).find((q) => q.name === nameOrId || q.id === nameOrId)
    if (!c) throw new Error(`no craft "${nameOrId}" in this world`)
    return c
  }

  async function board(nameOrId) {
    const c = craft(nameOrId)
    await act(async () => {
      useStore.getState().boardCraft(c.id)
    })
  }

  async function launch(nameOrId) {
    const c = craft(nameOrId)
    await act(async () => {
      await useStore.getState().launchCraft(c.id)
    })
  }

  async function eject() {
    await act(async () => {
      useStore.getState().ejectCraft()
    })
  }

  /** Drive the shared flight input directly (what the cockpit keys do). */
  function fly(patch) {
    Object.assign(flightInput, patch)
  }

  function flyReset() {
    resetFlightInput()
  }

  async function set(patch) {
    await act(async () => {
      useStore.setState(patch)
    })
  }

  async function cameraNear(nameOrId, { offset = [0, 60, 220] } = {}) {
    const p = planet(nameOrId)
    const entry = registry.bodies.get(p.id)
    if (!entry) throw new Error(`no registry entry for ${p.name}`)
    camera.position.set(entry.pos.x + offset[0], entry.pos.y + offset[1], entry.pos.z + offset[2])
    if (probe.controls) {
      probe.controls.target.set(entry.pos.x, entry.pos.y, entry.pos.z)
      probe.controls.update()
    }
    camera.updateMatrixWorld()
  }

  async function close() {
    trackers.length = 0
    await act(async () => {
      await inst.unmount()
    })
    await Promise.all(ops.workers.splice(0).map((wk) => wk.terminate()))
    resetMotionState()
    useStore.setState({
      ready: false,
      player: { kind: 'freeCam' },
      selectedId: null,
      selectedCraftId: null,
      followSelected: false,
    })
  }

  if (settle > 0) await frames(settle)
  if (verbose) {
    console.log(
      `[harness] booted ${normalized.planets.length} bodies; workers=${ops.workers.length}; worker frames=${ops.frames}`
    )
  }

  return {
    world: normalized,
    scene,
    camera,
    THREE,
    registry,
    ops,
    get missedFrames() {
      return totalMissed
    },
    get player() {
      return useStore.getState().player
    },
    planet,
    craft,
    track,
    frames,
    walk,
    board,
    launch,
    eject,
    fly,
    flyReset,
    set,
    cameraNear,
    close,
  }
}
