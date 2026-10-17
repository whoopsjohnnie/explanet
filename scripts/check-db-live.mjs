#!/usr/bin/env node
/**
 * check-db-live.mjs — end-to-end smoke test of the DB data source.
 *
 * Runs the REAL client path (core/db.js + core/worldSchema.js + core/
 * planetMath.js) against a live API and prints the staged-load picture:
 * skeleton sizes, which bodies are stubs, radius/mass continuity across a
 * full atom hydration, and the walk-critical atoms of one body.
 *
 *   node scripts/check-db-live.mjs [base-url]     # default http://localhost:5173
 */
const BASE = process.argv[2] || 'http://localhost:5173'

// core/db.js fetches same-origin paths (as in the browser); resolve them here
const realFetch = globalThis.fetch
globalThis.fetch = (path, ...rest) => realFetch(path.startsWith('/') ? BASE + path : path, ...rest)

const { fetchWorldDocument, fetchPlanetElements } = await import('../src/core/db.js')
const { normalizeWorld, isPlanetStub } = await import('../src/core/worldSchema.js')
const { planetRadius, planetMass, planetStats } = await import('../src/core/planetMath.js')

const t0 = Date.now()
const doc = await fetchWorldDocument()
const world = normalizeWorld(doc)
const skeletonMs = Date.now() - t0

console.log(`${doc.name} — ${world.planets.length} bodies, skeleton in ${skeletonMs} ms (${doc.source})`)
let failed = false
for (const p of world.planets) {
  const stub = isPlanetStub(p)
  const stats = planetStats(p)
  console.log(
    `  ${p.name.padEnd(8)} ${stub ? `stub   preview f${p.preview?.frequency}` : 'loaded'} ` +
      `f${String(p.frequency).padStart(3)} cells ${String(stats.cellCount).padStart(6)} ` +
      `R ${stats.radius.toFixed(2).padStart(7)} M ${stats.mass.toExponential(3)}`
  )
  if (stub && !p.preview) {
    console.error('  ✗ stub without a preview sample')
    failed = true
  }
}

// hydrate every stub and verify continuity: radius must not move (cell count
// is exact from the grid); mass must stay close (avg relief vs the integral)
const { cellCountForFrequency } = await import('../src/core/hexsphere.js')
for (const p of world.planets) {
  if (!isPlanetStub(p)) continue
  const before = { r: planetRadius(p), m: planetMass(p) }
  const t = Date.now()
  const { elements } = await fetchPlanetElements(p.dbId)
  if (elements.length !== cellCountForFrequency(p.frequency))
    throw new Error(`${p.name}: hydrated ${elements.length} atoms, grid needs ${cellCountForFrequency(p.frequency)}`)
  const loaded = { ...p, elements, preview: null }
  const rAfter = planetRadius(loaded)
  const mRatio = planetMass(loaded) / before.m
  const ok = Math.abs(rAfter - before.r) < 1e-9 && Math.abs(mRatio - 1) < 0.01
  console.log(
    `  ${p.name}: hydrated ${elements.length} atoms in ${Date.now() - t} ms — ` +
      `Δradius ${Math.abs(rAfter - before.r).toExponential(1)}, mass ×${mRatio.toFixed(4)} ${ok ? '✓' : '✗'}`
  )
  if (!ok) failed = true
}
console.log(failed ? 'FAILED' : 'OK')
process.exit(failed ? 1 : 0)
