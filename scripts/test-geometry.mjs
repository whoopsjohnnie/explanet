/**
 * test-geometry.mjs — headless pipeline check: starter world → geometry data.
 * Run: node scripts/test-geometry.mjs
 */

import { makeStarterWorld } from '../src/core/starter.js'
import { buildPlanetGeometryData, buildLodGeometryData } from '../src/core/geometry.js'
import { lodChain, lodDistances, sampleLodElements } from '../src/core/lod.js'
import { cellCountForFrequency } from '../src/core/hexsphere.js'
import { normalizeWorld } from '../src/core/worldSchema.js'
import { generateElements, PRESETS } from '../src/core/generators.js'
import { readFileSync } from 'node:fs'

let failures = 0
const check = (name, cond) => {
  console.log(`${cond ? '✓' : '✗'} ${name}`)
  if (!cond) failures++
}

// generators for every preset
for (const preset of PRESETS) {
  const els = generateElements(preset.id, 5, 1234)
  const bad = els.some((e) => !e.t || !Number.isFinite(e.h) || e.h < -1 || e.h > 5)
  check(`generator "${preset.id}" produces ${els.length} valid elements`, !bad && els.length === 252)
}

// starter world geometry
const world = makeStarterWorld()
for (const planet of world.planets) {
  const data = buildPlanetGeometryData(planet)
  let tris = 0
  let nan = false
  for (const [type, d] of data) {
    tris += d.triangles
    for (const arr of [d.positions, d.colors, d.uvs]) {
      if (arr.some((v) => !Number.isFinite(v))) nan = true
    }
    if (d.positions.length % 9 !== 0) nan = true // whole triangles
    for (const ci of d.cellByTri) if (ci < 0 || ci >= planet.elements.length) nan = true
  }
  check(`${planet.name}: ${tris} triangles, ${data.size} terrain batches, finite, pickable`, tris > 100 && !nan)
}

// LOD: chains, sampling, pick-index remapping (resolution-agnostic)
check('lodChain(64) halves down to 4', lodChain(64).join(',') === '64,32,16,8,4')
check('lodChain stops for small worlds', lodChain(4).length === 1 && lodChain(3).length === 1)
const merc = world.planets.find((p) => p.name === 'Mercury')
const chain = lodChain(merc.frequency)
const coarseF = chain[1] ?? merc.frequency
const { elements: coarse, fineIndex } = sampleLodElements(merc, coarseF)
check(
  'LOD sampling produces exact coarse grids',
  coarse.length === cellCountForFrequency(coarseF) && fineIndex.length === coarse.length
)
const lodConsistent = coarse.every((e, i) => {
  const src = merc.elements[fineIndex[i]]
  return src && e.t === src.t && e.h === src.h
})
check('LOD cells copy terrain/height from their fine source cell', lodConsistent)
const lodData = buildLodGeometryData(merc, coarseF)
let lodOk = true
let lodTris = 0
for (const [, d] of lodData) {
  lodTris += d.triangles
  for (const arr of [d.positions, d.colors, d.uvs]) if (arr.some((v) => !Number.isFinite(v))) lodOk = false
  for (const ci of d.cellByTri) if (ci < 0 || ci >= merc.elements.length) lodOk = false
}
check(`LOD build (freq ${coarseF}): ${lodTris} tris, finite, picks map to document cells`, lodOk && lodTris > 100)
const thr = lodDistances(chain, 1)
check('LOD switch distances strictly increase', thr.length === chain.length - 1 && thr.every((v, i) => i === 0 || v > thr[i - 1]))

// world.json round trip
const raw = JSON.parse(readFileSync(new URL('../public/world.json', import.meta.url), 'utf8'))
const norm = normalizeWorld(raw)
check(
  'public/world.json normalizes identically',
  norm.planets.length === raw.planets.length &&
    norm.planets.every((p, i) => p.elements.length === raw.planets[i].elements.length)
)

// corrupt-file healing
const broken = normalizeWorld({ planets: [{ frequency: 3 }, { frequency: 'garbage', elements: [{ t: 'nope', h: 'x' }] }] })
check('corrupt worlds are healed with defaults', broken.planets.length === 2 && broken.planets[0].elements.length === 92)

process.exit(failures === 0 ? 0 : 1)
