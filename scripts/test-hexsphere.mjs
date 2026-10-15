/**
 * test-hexsphere.mjs — sanity checks for the hex grid construction.
 * Run: node scripts/test-hexsphere.mjs
 */

import { getHexSphere, cellCountForFrequency, getNeighborhood } from '../src/core/hexsphere.js'

let failures = 0
const check = (name, cond) => {
  console.log(`${cond ? '✓' : '✗'} ${name}`)
  if (!cond) failures++
}

for (const n of [1, 2, 3, 6, 8, 12]) {
  const hex = getHexSphere(n)
  const expected = cellCountForFrequency(n)
  check(`freq ${n}: cell count ${hex.cellCount} === 10n²+2 (${expected})`, hex.cellCount === expected)

  let pentagons = 0
  let ok = true
  for (const cell of hex.cells) {
    if (cell.sides === 5) pentagons++
    else if (cell.sides !== 6) ok = false
    if (cell.neighbors.length !== cell.sides) ok = false
    for (const nb of cell.neighbors) {
      if (nb == null || nb < 0 || nb >= hex.cellCount) ok = false
    }
  }
  check(`freq ${n}: exactly 12 pentagons (got ${pentagons})`, pentagons === 12)
  check(`freq ${n}: all other cells are hexagons with valid neighbours`, ok)

  // neighbour symmetry: if A lists B, B must list A
  let symmetric = true
  for (const cell of hex.cells) {
    for (const nb of cell.neighbors) {
      if (!hex.cells[nb].neighbors.includes(cell.index)) symmetric = false
    }
  }
  check(`freq ${n}: neighbour relation is symmetric`, symmetric)

  // equal area: sum should be 4π, spread should be small
  let sum = 0
  let min = Infinity
  let max = 0
  for (const cell of hex.cells) {
    sum += cell.area
    if (cell.area < min) min = cell.area
    if (cell.area > max) max = cell.area
  }
  const fourPi = 4 * Math.PI
  check(
    `freq ${n}: total area ${sum.toFixed(4)} ≈ 4π (${fourPi.toFixed(4)})`,
    Math.abs(sum - fourPi) < 0.01
  )
  console.log(
    `    cell area spread: min ${((min / fourPi) * 100).toFixed(2)}% … max ${((max / fourPi) * 100).toFixed(2)}% of equal share`
  )
}

// neighborhood expansion
const hex = getHexSphere(4)
const ring0 = getNeighborhood(hex, 100, 0)
const ring1 = getNeighborhood(hex, 100, 1)
check('neighborhood radius 0 = self', ring0.size === 1)
check(`neighborhood radius 1 = 6..7 cells (got ${ring1.size})`, ring1.size >= 6 && ring1.size <= 7)

process.exit(failures === 0 ? 0 : 1)
