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

function assembleLevel(level) {
  return {
    frequency: level.frequency,
    meshes: level.batches.map((b) => {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(b.positions, 3))
      g.setAttribute('color', new THREE.BufferAttribute(b.colors, 3))
      g.setAttribute('uv', new THREE.BufferAttribute(b.uvs, 2))
      g.setAttribute('normal', new THREE.BufferAttribute(b.normals, 3))
      g.userData.cellByTri = b.cellByTri
      return { type: b.type, geometry: g }
    }),
  }
}

function startWorker() {
  worker = new Worker(new URL('./geometry.worker.js', import.meta.url), { type: 'module' })
  worker.onmessage = ({ data }) => {
    const job = jobs.get(data.key)
    if (!job || job.seq !== data.seq) return // superseded or cancelled
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
