/**
 * geometryService.js — main-thread side of the geometry worker.
 *
 * Planets bigger than ASYNC_MIN_CELLS build their LOD chain in the worker so
 * a giant's 5M-triangle mesh never blocks the render loop; smaller bodies are
 * cheaper inline than a worker round-trip would be. Builds are keyed per
 * planet: a new request for the same planet supersedes the previous one (the
 * worker drops it at the next level boundary), and results stream in one
 * level at a time, coarse first.
 *
 * Ownership: assembled THREE.BufferGeometry is delivered through onLevels
 * (full chain arrays, holes until a level lands) and disposed by the caller.
 * If the worker ever fails to boot or run, every build reports onError and
 * falls back to the synchronous path.
 */

import * as THREE from 'three'
import { packElements, packedForTransfer } from '../core/atoms.js'
import { lodChain } from '../core/lod.js'
import { C } from '../core/constants.js'

/** At this cell count a full LOD chain costs under a frame; above it, async. */
export const ASYNC_MIN_CELLS = C.lod.asyncMinCells

let worker = null
let workerBroken = false
let seq = 0
const jobs = new Map() // key → { seq, slots, onLevels, onError }

/**
 * Drop the module's worker reference and job table so the NEXT build starts a
 * fresh worker. The headless harness calls this in close(): it terminates the
 * worker THREADS itself (through its worker shim), and a boot must not reuse a
 * dead reference — a chunk build posted to a terminated worker never replies
 * (and never errors), so the fine region would never mount.
 */
export function resetGeometryWorker() {
  worker = null
  workerBroken = false
  seq = 0
  jobs.clear()
}

/** One worker batch (raw typed arrays) → an assembled { type, geometry } mesh. */
function assembleMesh(b, frequency) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(b.positions, 3))
  g.setAttribute('color', new THREE.BufferAttribute(b.colors, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(b.uvs, 2))
  g.setAttribute('normal', new THREE.BufferAttribute(b.normals, 3))
  g.userData.cellByTri = b.cellByTri
  g.userData.frequency = frequency // the grid this geometry was built at
  return { type: b.type, geometry: g }
}

function assembleLevel(level) {
  return {
    frequency: level.frequency,
    meshes: level.batches.map((b) => assembleMesh(b, level.frequency)),
  }
}

function startWorker() {
  worker = new Worker(new URL('./geometry.worker.js', import.meta.url), { type: 'module' })
  worker.onmessage = ({ data }) => {
    const job = jobs.get(data.key)
    if (!job || job.seq !== data.seq) return // superseded or cancelled
    if (data.type === 'chunk') {
      // a chunk is a single unit of work: one reply with all its batches
      job.onBatches(data.batches.map((b) => assembleMesh(b, data.frequency)))
      jobs.delete(data.key)
      return
    }
    job.slots[data.levelIndex] = assembleLevel(data.level)
    job.onLevels(job.slots.slice())
    if (job.slots.every(Boolean)) jobs.delete(data.key)
  }
  worker.onerror = () => {
    workerBroken = true
    for (const job of jobs.values()) job.onError(new Error('geometry worker failed'))
    jobs.clear()
    if (worker) worker.terminate()
    worker = null
  }
}

/**
 * Build renderPlanet's LOD chain off-thread. `atomsPacked` is the planet's
 * packed mirror when it has one (avoids re-reading the element objects).
 * Returns a cancel function; after cancel (or supersession by a newer build
 * for the same planet) the callbacks never fire again.
 */
export function buildLevelsAsync(planetId, renderPlanet, { atomsPacked, onLevels, onError, seed }) {
  if (workerBroken) {
    onError(new Error('geometry worker unavailable'))
    return () => {}
  }
  if (!worker) startWorker()
  const key = String(planetId)
  const chain = lodChain(renderPlanet.frequency)
  // a rebuild starts from whatever the caller displays so nothing blanks
  // while the new set streams in level by level
  const seedByFreq = new Map((seed || []).filter(Boolean).map((l) => [l.frequency, l]))
  const slots = chain.map((f) => seedByFreq.get(f) ?? null)
  const jobId = ++seq
  jobs.set(key, { seq: jobId, slots, onLevels, onError })

  const packed = atomsPacked || packElements(renderPlanet.elements)
  const transferable = packedForTransfer(packed)
  worker.postMessage(
    {
      key,
      seq: jobId,
      frequency: renderPlanet.frequency,
      scale: renderPlanet.scale ?? 1,
      packed: transferable.packed,
    },
    transferable.transfer
  )
  return () => {
    const job = jobs.get(key)
    if (job && job.seq === jobId) jobs.delete(key)
  }
}

/**
 * Build ONE fine chunk off-thread (docs/terrain.txt §3). Same worker, same
 * seq-supersede contract as the chain builds — but keyed per CHUNK (a newer
 * build of the same chunk key supersedes a stale one), and a chunk is a single
 * unit of work: one postMessage, one reply carrying all of its terrain batches
 * (`onBatches`), not a streamed level. The main thread owns the chunk's
 * identity and the fine→doc map; the worker returns geometry only.
 *
 * Returns a cancel function; after it (or supersession by a newer build of the
 * same chunk) `onBatches` never fires again.
 */
export function buildChunkAsync(planetId, chunkKey, renderPlanet, { atomsPacked, cells, onBatches, onError }) {
  if (workerBroken) {
    onError(new Error('geometry worker unavailable'))
    return () => {}
  }
  if (!worker) startWorker()
  const key = `${planetId}|chunk:${chunkKey}`
  const jobId = ++seq
  jobs.set(key, { seq: jobId, onBatches, onError })
  const packed = atomsPacked || packElements(renderPlanet.elements)
  const transferable = packedForTransfer(packed)
  worker.postMessage(
    {
      key,
      seq: jobId,
      type: 'chunk',
      frequency: renderPlanet.frequency,
      scale: renderPlanet.scale ?? 1,
      packed: transferable.packed,
      cells,
    },
    transferable.transfer
  )
  return () => {
    const job = jobs.get(key)
    if (job && job.seq === jobId) jobs.delete(key)
  }
}
