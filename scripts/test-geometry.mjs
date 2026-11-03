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
// silhouette invariance: a coarse level is the SAME planet seen at lower
// resolution — its outer radius must stay at the document radius (plus that
// level's sampled relief); the hexes grow, the ball does not shrink
const Rmerc = planetRadius(merc)
const silhouette = chain.map((f) => {
  const sel = f < merc.frequency ? sampleLodElements(merc, f).elements : merc.elements
  let maxH = -Infinity
  for (const e of sel) maxH = Math.max(maxH, e.h || 0)
  let mx = 0
  for (const [, b] of buildLodGeometryData(merc, f))
    for (let i = 0; i < b.positions.length; i += 3)
      mx = Math.max(mx, Math.hypot(b.positions[i], b.positions[i + 1], b.positions[i + 2]))
  return Math.abs(mx - (Rmerc + maxH)) < 1e-3
})
check('every LOD level keeps the document radius (hexes grow, silhouette does not)', silhouette.every(Boolean))
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

// starter world round trip — serialize to JSON text, parse, normalize. The
// starter is generated in core/starter.js; public/world.json is a generated,
// gitignored artifact, so this round trip runs fully in memory.
const raw = JSON.parse(JSON.stringify(world))
const norm = normalizeWorld(raw)
check(
  'starter world normalizes identically',
  norm.planets.length === raw.planets.length &&
    norm.planets.every((p, i) => p.elements.length === raw.planets[i].elements.length)
)

// corrupt-file healing (a world always carries a scale — the scale field
// itself is required, so these test documents set one)
const broken = normalizeWorld({ scale: 100, planets: [{ frequency: 3 }, { frequency: 'garbage', elements: [{ t: 'nope', h: 'x' }] }] })
check('corrupt worlds are healed with defaults', broken.planets.length === 2 && broken.planets[0].elements.length === 92)

// a world WITHOUT a scale is rejected (not healed): it can't be walked or
// filled with objects
let scalelessRejected = false
try {
  normalizeWorld({ name: 'X', planets: [{ frequency: 3, elements: [{ t: 'grass', h: 0 }] }] })
} catch {
  scalelessRejected = true
}
check('a scale-less world is rejected (scale is required)', scalelessRejected)

// ---------------------------------------------------------------------------
// DB streaming model: skeleton planets with elements == null (stubs)
// ---------------------------------------------------------------------------
const stubDoc = {
  version: 1,
  name: 'Skeleton',
  gravity: 40,
  scale: 1000,
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
check('serializeWorld keeps elements of loaded bodies',
  serializeWorld(skel).planets[1].elements.length === 92)
// preview renders as a valid planet (Planet.jsx feeds it to the geometry pipeline)
const previewAsPlanet = { frequency: 16, elements: stub.preview.elements, scale: 1 }
check('preview grid builds geometry', buildPlanetGeometryData(previewAsPlanet).size > 0)
inline.atomsPacked = { materials: ['grass'] } // hydration mirror must not leak
check('serializeWorld drops db internals (dbId/preview/stubAvgHeight/atomsPacked)',
  ['dbId', 'preview', 'stubAvgHeight', 'atomsPacked'].every((k) => !(k in serializeWorld(skel).planets[0])))

// ---------------------------------------------------------------------------
// Packed atoms + worker pipeline (core side): what geometry.worker.js runs
// ---------------------------------------------------------------------------
const { packElements, packFromWire, elementsFromPacked, patchPackedCell, hexToInt } =
  await import('../src/core/atoms.js')
const { computeFaceNormals } = await import('../src/core/geometry.js')
const THREE = await import('three')

// round trip: pack → unpack must reproduce the document semantics exactly
const mars = world.planets.find((p) => p.name === 'Mars')
const packed = packElements(mars.elements)
const revived = elementsFromPacked(packed)
const rtOk =
  revived.length === mars.elements.length &&
  revived.every((e, i) => {
    const o = mars.elements[i]
    if (e.t !== o.t || e.h !== (Number.isFinite(o.h) ? o.h : 0)) return false
    if (o.c === undefined) return e.c === undefined
    return hexToInt(e.c) === hexToInt(o.c) // color-equal, canonical spelling
  })
check('pack → unpack round-trips elements (terrain, height, color)', rtOk)

// wire form agrees with element packing, including validation + sparse colors
const wire = {
  materials: ['rock', 'bogus'],
  t: [0, 1, 0],
  h: [0.5, -1, Number.NaN],
  c: [[1, '#abc'], [2, '#112233'], [9, '#zzz']],
}
const fromWire = packFromWire(wire)
const wireEls = elementsFromPacked(fromWire)
check(
  'wire packing validates materials/heights/colors like the document path',
  fromWire.materials.join(',') === 'rock,grass' &&
    wireEls.every((e, i) =>
      [
        e.t === 'rock' && e.h === 0.5 && e.c === undefined,
        e.t === 'grass' && e.h === -1 && e.c === '#aabbcc',
        e.t === 'rock' && e.h === 0 && e.c === '#112233',
      ][i]
    )
)

// the worker's build path (elements from packed) is bit-identical to the
// synchronous document build across the whole LOD chain
const wp = { frequency: mars.frequency, elements: mars.elements, scale: 1 }
const wpPacked = { frequency: mars.frequency, elements: revived, scale: 1 }
let workerPathOk = true
for (const f of lodChain(mars.frequency)) {
  const a = buildLodGeometryData(wp, f)
  const b = buildLodGeometryData(wpPacked, f)
  if (a.size !== b.size) workerPathOk = false
  for (const [type, da] of a) {
    const db_ = b.get(type)
    if (!db_ || db_.triangles !== da.triangles) workerPathOk = false
    else
      for (const k of ['positions', 'colors', 'uvs', 'cellByTri'])
        for (let i = 0; i < da[k].length; i++)
          if (da[k][i] !== db_[k][i]) workerPathOk = false
  }
}
check('packed-fed LOD builds are identical to document-fed builds', workerPathOk)

// paint mirror patching keeps packed arrays current without re-reading
patchPackedCell(fromWire, 0, { t: 'lava', h: 2.5 })
check(
  'patchPackedCell adds new materials and writes heights',
  elementsFromPacked(fromWire)[0].t === 'lava' && fromWire.h[0] === 2.5
)
patchPackedCell(fromWire, 2, { t: 'rock', h: 1, c: '#00ff00' })
check('patch with el.c keeps writing color overrides', fromWire.rgb[2] === 0x00ff00 && fromWire.hasC[2] === 1)
patchPackedCell(fromWire, 2, { t: 'rock', h: 1 }) // paint deletes el.c
check('patch without el.c clears the color override', fromWire.hasC[2] === 0)

// face normals: unit-length, finite, and matching three's computeVertexNormals
const mdata = buildPlanetGeometryData(mars).get('rock') || buildPlanetGeometryData(mars).values().next().value
const fnorm = computeFaceNormals(mdata.positions)
let normalsOk = fnorm.length === mdata.positions.length
for (let i = 0; i < fnorm.length; i += 3) {
  const l = Math.hypot(fnorm[i], fnorm[i + 1], fnorm[i + 2])
  if (!Number.isFinite(l) || Math.abs(l - 1) > 1e-6) normalsOk = false
}
const refGeo = new THREE.BufferGeometry()
refGeo.setAttribute('position', new THREE.BufferAttribute(mdata.positions, 3))
refGeo.computeVertexNormals()
const refN = refGeo.getAttribute('normal').array
let maxNDiff = 0
for (let i = 0; i < refN.length; i++) maxNDiff = Math.max(maxNDiff, Math.abs(refN[i] - fnorm[i]))
check(`computeFaceNormals matches three computeVertexNormals (Δ≤${maxNDiff.toExponential(1)})`,
  normalsOk && maxNDiff < 1e-6)

process.exit(failures === 0 ? 0 : 1)
