/**
 * geometry.worker.js — render geometry built off the main thread.
 *
 * Takes a planet's packed atom arrays (core/atoms.js), rebuilds the element
 * view, and runs the app's own LOD chain through core/geometry.js — the same
 * code path the synchronous build uses, which core's framework-free rule
 * makes importable here. Every level of the chain is built (coarse → fine)
 * and streamed back, one postMessage per level, so the main thread assembles
 * BufferGeometry (and the GPU uploads) while finer levels are still cooking.
 *
 * Jobs carry a monotonically increasing `seq`; a newer job for the same
 * `key` supersedes an older one, checked at level boundaries — a stale build
 * stops between levels instead of finishing a 5M-triangle chain nobody will
 * look at.
 */

import { buildLodGeometryData, computeFaceNormals } from '../core/geometry.js'
import { elementsFromPacked } from '../core/atoms.js'
import { lodChain } from '../core/lod.js'

const latest = new Map() // key → newest seq seen

self.onmessage = async ({ data }) => {
  const { key, seq, frequency, scale, packed } = data
  const prev = latest.get(key)
  if (prev !== undefined && seq < prev) return // already superseded
  latest.set(key, seq)

  const planet = { frequency, elements: elementsFromPacked(packed), scale }
  const chain = lodChain(frequency)
  // coarse → fine: the levels a distant camera uses land first
  for (let i = chain.length - 1; i >= 0; i--) {
    if (latest.get(key) !== seq) return // superseded mid-build
    const built = buildLodGeometryData(planet, chain[i])
    const batches = []
    const transfer = []
    for (const [type, d] of built) {
      const normals = computeFaceNormals(d.positions)
      batches.push({ type, positions: d.positions, colors: d.colors, uvs: d.uvs, normals, cellByTri: d.cellByTri })
      transfer.push(
        d.positions.buffer,
        d.colors.buffer,
        d.uvs.buffer,
        normals.buffer,
        d.cellByTri.buffer
      )
    }
    self.postMessage({ key, seq, levelIndex: i, level: { frequency: chain[i], batches } }, transfer)
    // yield to the message queue so a newer job for this key can supersede
    await new Promise((r) => setTimeout(r, 0))
  }
  latest.delete(key)
}
