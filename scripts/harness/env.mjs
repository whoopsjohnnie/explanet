/**
 * harness/env.mjs — make Node look like a browser, well enough to run the
 * real app pipeline in memory. Install BEFORE importing any app module.
 *
 *   - window/document/canvas stubs (drei's detect-gpu, terrain textures,
 *     r3f's event plumbing all poke these)
 *   - URL.createObjectURL + Worker shim: @react-three/cannon builds its
 *     physics worker as a blob bundle; we capture the blob text and run it
 *     on a real worker_threads thread. Real ESM module workers (the geometry
 *     worker) are spawned through modworker-glue.mjs.
 *
 * Returns the shared `ops` telemetry handle: counts of every message op,
 * worker 'frame' replies, and every ShimWorker instance (for teardown).
 */

import { Worker as NTWorker } from 'node:worker_threads'

// runs the r3f-cannon worker bundle (self-contained IIFE using self.onmessage)
const EVAL_GLUE = `
const { parentPort, workerData } = require('node:worker_threads')
globalThis.self = { postMessage: (m, t) => parentPort.postMessage(m, t || []), onmessage: null }
parentPort.on('message', (m) => { if (self.onmessage) self.onmessage({ data: m }) })
eval(workerData.src)
`

const WATCHED_OPS = new Set([
  'addBodies', 'removeBodies', 'add', 'remove', 'clear',
  'setPosition', 'setQuaternion', 'setRotation', 'setAngularVelocity', 'setMass',
])

let installed = null

export function installEnv() {
  if (installed) return installed

  const ops = {
    counts: new Map(), // op name → times sent to a worker
    recv: new Map(), // worker message type → times received
    events: [], // watched body-state ops (with frame stamp)
    frames: 0, // worker 'frame' replies seen
    workers: [], // every ShimWorker, for teardown
  }
  globalThis.__ops = ops
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const blobTexts = new Map()
  let blobSeq = 0
  URL.createObjectURL = function (blob) {
    blobSeq += 1
    const url = `blob:shim-${blobSeq}`
    blobTexts.set(url, blob)
    return url
  }
  URL.revokeObjectURL = function () {}

  class ShimWorker {
    constructor(url, opts) {
      ops.workers.push(this)
      this.onmessage = null
      this.onerror = null
      this.queue = []
      this.thread = null
      this.terminated = false
      this.label = String(url).startsWith('file:') ? 'geometry' : 'physics'
      const boot = (async () => {
        const blob = blobTexts.get(url)
        if (blob) {
          this.thread = new NTWorker(EVAL_GLUE, { eval: true, workerData: { src: await blob.text() } })
        } else if (String(url).startsWith('file:')) {
          this.thread = new NTWorker(new URL('./modworker-glue.mjs', import.meta.url), { workerData: { url: String(url) } })
        } else {
          throw new Error('ShimWorker: unknown worker url: ' + url)
        }
        this.thread.on('message', (m) => {
          if (m && m.op === 'frame') ops.frames += 1
          const t = (m && (m.op || m.type)) || '?'
          ops.recv.set(t, (ops.recv.get(t) || 0) + 1)
          if (this.onmessage) this.onmessage({ data: m })
        })
        this.thread.on('error', (e) => {
          if (this.terminated) return
          console.error(`[${this.label} worker error]`, e && e.message ? e.message : e)
          if (this.onerror) this.onerror(e)
        })
        for (const [m, t] of this.queue.splice(0)) this.thread.postMessage(m, t || [])
      })()
      this._boot = boot
    }
    postMessage(m, t) {
      if (this.terminated) return
      const op = m && m.op
      ops.counts.set(op, (ops.counts.get(op) || 0) + 1)
      if (WATCHED_OPS.has(op)) ops.events.push({ frame: ops.frames, op, uuid: m.uuid })
      if (this.thread) this.thread.postMessage(m, t || [])
      else this.queue.push([m, t])
    }
    addEventListener(type, fn) {
      if (type === 'message') this.onmessage = fn
    }
    terminate() {
      this.terminated = true
      return this._boot.then(() => this.thread && this.thread.terminate())
    }
  }
  globalThis.Worker = ShimWorker

  const winListeners = new Map()
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    navigator: { userAgent: 'node-harness', platform: 'linux', maxTouchPoints: 0 },
    screen: { width: 1280, height: 800 },
    location: { href: 'http://localhost/', protocol: 'http:', host: 'localhost' },
    addEventListener(t, f) {
      if (!winListeners.has(t)) winListeners.set(t, [])
      winListeners.get(t).push(f)
    },
    removeEventListener(t, f) {
      const a = winListeners.get(t)
      if (a) {
        const i = a.indexOf(f)
        if (i > -1) a.splice(i, 1)
      }
    },
  }

  // 2D canvas API surface used by core/terrain.js texture builder
  const ctx2d = {
    fillStyle: '', strokeStyle: '', globalAlpha: 1, lineWidth: 1,
    fillRect() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
    moveTo() {}, lineTo() {}, save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    createLinearGradient: () => ({ addColorStop() {} }),
  }
  const canvasEl = () => ({
    width: 1, height: 1, style: {}, clientWidth: 1280, clientHeight: 800,
    addEventListener() {}, removeEventListener() {},
    // three-stdlib's OrbitControls.dispose() unwinds listeners via ownerDocument
    ownerDocument: { addEventListener() {}, removeEventListener() {} },
    appendChild() {}, removeChild() {}, setAttribute() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1280, bottom: 800, x: 0, y: 0, width: 1280, height: 800 }),
    getContext(id) {
      if (String(id).startsWith('webgl') && globalThis.WebGL2RenderingContext) return new globalThis.WebGL2RenderingContext(this)
      return ctx2d
    },
  })
  globalThis.document = {
    createElement: () => canvasEl(),
    addEventListener() {}, removeEventListener() {},
  }
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })

  installed = { ops }
  return installed
}
