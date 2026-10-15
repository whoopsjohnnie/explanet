/**
 * gen-sample-world.mjs — regenerates public/world.json (the bundled demo).
 * Run: node scripts/gen-sample-world.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { makeStarterWorld } from '../src/core/starter.js'
import { planetStats } from '../src/core/planetMath.js'

const world = makeStarterWorld()

mkdirSync(new URL('../public', import.meta.url), { recursive: true })
const out = new URL('../public/world.json', import.meta.url)
writeFileSync(out, JSON.stringify(world, null, 2))

console.log(`Wrote public/world.json — ${world.planets.length} bodies, G = ${world.gravity}`)
for (const p of world.planets) {
  const s = planetStats(p)
  console.log(
    `  ${p.name.padEnd(8)} preset=${p.preset.padEnd(10)} freq=${p.frequency} cells=${String(s.cellCount).padStart(5)} R=${s.radius.toFixed(2).padStart(6)} M=${s.mass.toFixed(1).padStart(8)} at (${p.center.x}, ${p.center.y}, ${p.center.z}) v=(${p.velocity.x.toFixed(2)}, ${p.velocity.y.toFixed(2)}, ${p.velocity.z.toFixed(2)})`
  )
}
