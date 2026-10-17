/**
 * test-geometry.mjs — headless pipeline check: starter world → geometry data.
 * Run: node scripts/test-geometry.mjs
 */

import { makeStarterWorld } from '../src/core/starter.js'
import { buildPlanetGeometryData, buildLodGeometryData } from '../src/core/geometry.js'
import { lodChain, lodDistances, sampleLodElements } from '../src/core/lod.js'
import { cellCountForFrequency } from '../src/core/hexsphere.js'
import {
  planetRadius,
  planetMass,
  planetVolume,
  planetStats,
  planetCellCount,
  MAX_FREQUENCY,
  radiusForFrequency,
  frequencyForRadius,
  radiusForMass,
  frequencyForMass,
} from '../src/core/planetMath.js'
import { normalizeWorld, isPlanetStub, serializeWorld } from '../src/core/worldSchema.js'
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

// ------------------------------------------------------------- atom model --
// The ladder: frequencyForRadius inverts radiusForFrequency exactly.
let roundTrip = true
for (let f = 1; f <= MAX_FREQUENCY; f++) {
  if (frequencyForRadius(radiusForFrequency(f)) !== f) roundTrip = false
}
check(`frequencyForRadius ∘ radiusForFrequency = id on 1..${MAX_FREQUENCY}`, roundTrip)

// Every target radius gets the NEAREST grid, monotonically, clamped to legal.
let nearest = true
let prevF = 0
for (let r = 0.05; r <= 80; r += 0.01) {
  const f = frequencyForRadius(r)
  if (f < 1 || f > MAX_FREQUENCY || f < prevF) nearest = false
  prevF = f
  const d = Math.abs(radiusForFrequency(f) - r)
  for (const g of [f - 1, f + 1]) {
    if (g >= 1 && g <= MAX_FREQUENCY && Math.abs(radiusForFrequency(g) - r) < d - 1e-12) nearest = false
  }
}
check('frequencyForRadius is monotone and always picks the nearest grid', nearest)

// Mass targeting: mass → radius → ladder, consistent and monotone.
check(
  'frequencyForMass = frequencyForRadius(radiusForMass)',
  frequencyForMass(100, 0.05) === frequencyForRadius(radiusForMass(100, 0.05))
)
let massMono = true
let prevMF = 0
for (let m = 0.1; m <= 1e6; m *= 1.05) {
  const f = frequencyForMass(m, 0.05)
  if (f < prevMF) massMono = false
  prevMF = f
}
check('a heavier target mass never means fewer atoms', massMono)

// The starter world is strict atoms: scale 1, one universal hex size,
// frequencies derived from the true radii (Jupiter fills the top grid,
// Pluto is a 12-cell dodecahedron).
const ATOM_FREQ = {
  Sun: 76, Mercury: 7, Venus: 18, Earth: 18, Mars: 10,
  Jupiter: 203, Saturn: 169, Uranus: 74, Neptune: 71, Pluto: 3,
}
check(
  'starter: every planet is a scale-1 (atom) grid',
  world.planets.every((p) => p.scale === 1)
)
check(
  'starter: frequencies are exactly the atom-ladder resolution of the true radii',
  world.planets.every((p) => p.frequency === ATOM_FREQ[p.name])
)
const cellAreas = world.planets.map((p) => (4 * Math.PI * planetRadius(p) ** 2) / p.elements.length)
check(
  'starter: one hex covers one area unit on EVERY planet (universal atom size)',
  cellAreas.every((a) => Math.abs(a - 1) < 1e-9)
)
const massOf = (name) => planetMass(world.planets.find((p) => p.name === name))
check(
  'starter: mass order stays real across quantization (Jup > Sat > ... > Pluto)',
  massOf('Jupiter') > massOf('Saturn') &&
    massOf('Saturn') > massOf('Earth') &&
    massOf('Earth') > massOf('Venus') &&
    massOf('Venus') > massOf('Mars') &&
    massOf('Mars') > massOf('Mercury') &&
    massOf('Mercury') > massOf('Pluto')
)

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

// ---------------------------------------------------------------------------
// DB streaming model: skeleton planets with elements == null (stubs)
// ---------------------------------------------------------------------------
const stubDoc = {
  version: 1,
  name: 'Skeleton',
  gravity: 40,
  planets: [
    {
      dbId: 24, id: 'p-jup', name: 'Jupiter', preset: 'rocky', seed: 5, frequency: 203,
      scale: 1, center: { x: 800 }, velocity: { z: 1 }, spin: { y: 0.2 }, density: 0.05,
      isStatic: false, elements: null, stubAvgHeight: 0.02,
      preview: { frequency: 16, elements: [{ t: 'sand', h: 0.5 }, { t: 'nope', h: 'x' }] },
    },
    {
      dbId: 28, id: 'p-plu', name: 'Pluto', preset: 'rocky', frequency: 3, density: 0.05,
      elements: generateElements('rocky', 3, 7),
    },
  ],
}
const skel = normalizeWorld(stubDoc)
const stub = skel.planets[0]
const inline = skel.planets[1]
const stubVolume = planetVolume(stub)
const stubStats = planetStats(stub)
check('isPlanetStub sees stubs and only stubs',
  isPlanetStub(stub) && !isPlanetStub(inline) && !isPlanetStub({ elements: [] }))
check('stub stays a stub (elements null, dbId + preview kept)',
  stub.elements === null && stub.dbId === 24 && stub.preview?.frequency === 16)
check('stub cell count / radius are exact from the grid alone',
  planetCellCount(stub) === cellCountForFrequency(203) &&
    Math.abs(planetRadius(stub) - radiusForFrequency(203)) < 1e-12)
check('stub volume integrates the stored mean relief: (4/3)πR²(R+avg h)',
  Math.abs((4 / 3) * Math.PI * planetRadius(stub) ** 2 * (planetRadius(stub) + 0.02) -
    stubVolume) < 1e-9)
check('stub mass = density × that volume (orbit-grade without atoms)',
  Math.abs(planetMass(stub) / (0.05 * stubVolume) - 1) < 1e-12)
check('stub stats: terrain tallies unknown (null), not zero',
  stubStats.landCells === null && stubStats.seaCells === null && stubStats.cellCount === cellCountForFrequency(203))
check('preview sample is repaired to its full grid (padded + healed)',
  stub.preview.elements.length === cellCountForFrequency(16) &&
    stub.preview.elements[1].t === 'grass' && stub.preview.elements[1].h === 0.12)
check('small DB bodies inline whole', inline.elements.length === 92 && !inline.preview)
check('serializeWorld drops db internals (dbId/preview/stubAvgHeight)',
  ['dbId', 'preview', 'stubAvgHeight'].every((k) => !(k in serializeWorld(skel).planets[0])))
check('serializeWorld keeps elements of loaded bodies',
  serializeWorld(skel).planets[1].elements.length === 92)
// preview renders as a valid planet (Planet.jsx feeds it to the geometry pipeline)
const previewAsPlanet = { frequency: 16, elements: stub.preview.elements, scale: 1 }
check('preview grid builds geometry', buildPlanetGeometryData(previewAsPlanet).size > 0)

process.exit(failures === 0 ? 0 : 1)
