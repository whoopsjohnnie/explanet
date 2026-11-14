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
import { buildChunkGeometryData } from '../core/finedisc.js'
import { buildFineGeometryData, fineHexDirs } from '../core/fineTerrain.js'
import { elementsFromPacked } from '../core/atoms.js'
import { lodChain } from '../core/lod.js'

const latest = new Map() // key → newest seq seen

/** Pack one built batch (Map value) into a postable + transferable form. */
function packBatch(built) {
  const batches = []
  const transfer = []
  for (const [type, d] of built) {
    const normals = computeFaceNormals(d.positions)
    batches.push({ type, positions: d.positions, colors: d.colors, uvs: d.uvs, normals, cellByTri: d.cellByTri })
    transfer.push(d.positions.buffer, d.colors.buffer, d.uvs.buffer, normals.buffer, d.cellByTri.buffer)
  }
  return { batches, transfer }
}

/**
 * A CHUNK job: one lattice block of the fine grid (docs/terrain.txt §3). The
 * fine cells are built from the planet's packed atoms with the document's cell
 * builder restricted to the block's cells (buildChunkGeometryData), so a chunk
 * is a self-contained, byte-identical cut-out of the document mesh (stage 1).
 * The main thread owns the chunk's identity (key) and the fine→doc map; the
 * worker returns only the geometry. One postMessage, one reply — a chunk is a
 * single unit of work, unlike a chain that streams a level at a time.
 */
function runChunkJob(data) {
  const { key, seq, frequency, scale, packed, cells } = data
  const prev = latest.get(key)
  if (prev !== undefined && seq < prev) return // already superseded
  latest.set(key, seq)
  const planet = { frequency, elements: elementsFromPacked(packed), scale }
  const { batches, transfer } = packBatch(buildChunkGeometryData(planet, { cells }))
  self.postMessage({ key, seq, type: 'chunk', frequency, batches }, transfer)
  latest.delete(key)
}

/**
 * A FINE CHUNK job (stage 2): one block of the fine (DEM-pixel) lattice
 * (docs/terrain.txt §3/§4). The main thread owns the §4.1 SYNTHESIS — it sees
 * the DEM tiles (it fetched them), the document grid (the fine→doc map) and
 * the feather, and it passes the per-hex FINAL heights (world units) — so the
 * worker is pure vertex math: the fine hexes' chord-fan geometry
 * (fineTerrain.js, imported unmodified). One postMessage, one reply — a chunk
 * is a single unit of work, as stage 1.
 *
 * The payload:
 *   R, patch, a   the body radius, the region patch, the fine hex edge
 *   hexes         the chunk's fine hexes [{ q, r, h, type, rgb, docCell }] —
 *                 h is the §4.1/§4.3/§5-composited final height (world units)
 *   halo          the one-hex ring around the block [{ q, r, h }] — the
 *                 neighbour heights a boundary wall closes against (a halo
 *                 hex never emits geometry of its own)
 */
function runFineChunkJob(data) {
  const { key, seq, R, patch, a, hexes, halo } = data
  const prev = latest.get(key)
  if (prev !== undefined && seq < prev) return // already superseded
  latest.set(key, seq)

  // the neighbour heights a boundary wall closes against: the chunk's hexes
  // plus its halo (the caller synthesized both with the same pure function, so
  // adjacent chunks agree on the shared boundary)
  const hTable = new Map()
  for (const h of halo) hTable.set(h.q + ',' + h.r, h.h)
  for (const h of hexes) hTable.set(h.q + ',' + h.r, h.h)

  const built = []
  for (const h of hexes) {
    const d = fineHexDirs(patch, h.q, h.r, a)
    built.push({
      q: h.q,
      r: h.r,
      c3: d.c3,
      corners: d.corners,
      h: h.h,
      type: h.type,
      rgb: h.rgb,
      docCell: h.docCell,
    })
  }
  const { batches, transfer } = packBatch(
    buildFineGeometryData(R, patch, a, built, (q, r) => hTable.get(q + ',' + r) ?? 0)
  )
  self.postMessage({ key, seq, type: 'finechunk', batches }, transfer)
  latest.delete(key)
}

self.onmessage = async ({ data }) => {
  if (data.type === 'chunk') return runChunkJob(data)
  if (data.type === 'finechunk') return runFineChunkJob(data)

  const { key, seq, frequency, scale, packed } = data
  const prev = latest.get(key)
  if (prev !== undefined && seq < prev) return // already superseded
  latest.set(key, seq)

  const planet = { frequency, elements: elementsFromPacked(packed), scale }
  const chain = lodChain(frequency)
  // coarse → fine: the levels a distant camera uses land first
  for (let i = chain.length - 1; i >= 0; i--) {
    if (latest.get(key) !== seq) return // superseded mid-build
    const { batches, transfer } = packBatch(buildLodGeometryData(planet, chain[i]))
    self.postMessage({ key, seq, levelIndex: i, level: { frequency: chain[i], batches } }, transfer)
    // yield to the message queue so a newer job for this key can supersede
    await new Promise((r) => setTimeout(r, 0))
  }
  latest.delete(key)
}
