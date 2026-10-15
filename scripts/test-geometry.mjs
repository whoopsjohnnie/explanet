/**
 * test-geometry.mjs — headless pipeline check: starter world → geometry data.
 * Run: node scripts/test-geometry.mjs
 */

import { makeStarterWorld } from '../src/core/starter.js'
import { buildPlanetGeometryData } from '../src/core/geometry.js'
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
