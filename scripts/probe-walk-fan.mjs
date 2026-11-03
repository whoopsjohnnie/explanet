/**
 * probe-walk-fan.mjs — regression probe for the rendered-surface walker.
 *
 * Confirms the walker is welded to the surface the RENDERER DRAWS (the
 * chord-triangle fans of the hex elements), not the invisible per-cell
 * sphere R + h(cell). Flat chord fans sag below that sphere by up to
 * apothem²/8R (~100 m on a true-scale 35 km grid); when the walker rode the
 * sphere the 1.6 m astronaut floated ~100 m over the drawn ground and the
 * walk view read as "looking at the ground from way up in the sky". This
 * probe is the guard against that split returning.
 *
 * Measured on true-scale Sol Real Ceres in the body-LOCAL frame (so the
 * float32 quantization of the registry's planet center stays out of it):
 *   - feet  == fanRadiusAt(dir)            (machine precision, grounded)
 *   - eye   == the real-human height above the rendered fan
 *   - craft anchor == fanRadiusAt(craft dir) (parked on the drawn ground)
 *
 * Needs the (gitignored) Sol Real world — generate it first:
 *   node scripts/gen-sol-real.mjs
 * Run:  node scripts/probe-walk-fan.mjs
 * Exits non-zero if any weld is broken.
 */
import { existsSync } from 'node:fs'
import { bootWorld } from './harness/index.mjs'
import { useStore } from '../src/state/store.js'
import { makeSurface, walkReadout, walkerLocation, fanRadiusAt, cellAtDirection } from '../src/core/surface.js'
import { craftRuntime } from '../src/core/motion.js'
import { planetRadius } from '../src/core/planetMath.js'
import { getHexSphere } from '../src/core/hexsphere.js'

const SOL_REAL = new URL('../public/sol-real.json', import.meta.url)
if (!existsSync(SOL_REAL)) {
  console.error('probe-walk-fan needs the Sol Real world (a gitignored generated artifact).')
  console.error('Generate it first:  node scripts/gen-sol-real.mjs')
  process.exit(1)
}

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures++
}

const w = await bootWorld({ world: 'sol-real', filter: ['Sun', 'Ceres'] })
const cere = w.planet('Ceres')
const SCALE = w.world.scale
const hex = getHexSphere(cere.frequency)
const R = planetRadius(cere)
const surface = makeSurface(cere, SCALE)

await w.walk('Ceres')
for (let i = 0; i < 3600 && !walkReadout.grounded; i++) await w.frames(1)
check('walker grounded on Ceres', walkReadout.grounded)

const i0 = walkerLocation.cell
const h0 = cere.elements[i0]?.h || 0
const fanR = fanRadiusAt(hex, i0, R + h0, walkerLocation.dir)

// camera in the body-LOCAL frame (registry quat inverse): radius = fan + eye
const entry = w.registry.bodies.get(cere.id)
const V3 = w.THREE.Vector3
const qInv = new w.THREE.Quaternion(entry.quat.x, entry.quat.y, entry.quat.z, entry.quat.w).invert()
const camLocal = new V3(w.camera.position.x - entry.pos.x, w.camera.position.y - entry.pos.y, w.camera.position.z - entry.pos.z).applyQuaternion(qInv)
const eyeRadLocal = camLocal.length()
const feetM = (walkerLocation.r - fanR) * SCALE
const eyeM = (eyeRadLocal - fanR) * SCALE
const expectedEyeM = surface.metrics.eye * SCALE

console.log('--- walker vs rendered surface (body-local, exact) ---')
console.log('Ceres R:                 ', (R * SCALE / 1000).toFixed(1), 'km')
console.log('feet above rendered fan: ', feetM.toExponential(2), 'm  (want 0 — welded to the drawn ground)')
console.log('eye above fan:           ', eyeM.toFixed(3), 'm  (real human =', expectedEyeM.toFixed(2), 'm)')
console.log('old walking sphere sag:  ', ((R + h0 - fanR) * SCALE).toFixed(1), 'm (the astronaut now stands ON this sag)')
check('feet welded to the rendered fan (machine precision)', Math.abs(feetM) < 1e-9, `Δ=${feetM.toExponential(2)} m`)
check('eye is a real human above the rendered fan', Math.abs(eyeM - expectedEyeM) < 0.02, `Δ=${(eyeM - expectedEyeM).toExponential(2)} m`)

const craftId = useStore.getState().addCraft()
for (let i = 0; i < 300; i++) await w.frames(1)
const st = craftRuntime.get(craftId).state
const ci = cellAtDirection(hex, st.dir)
const ch = cere.elements[ci]?.h || 0
const fanAtCraft = fanRadiusAt(hex, ci, R + ch, st.dir)
const craftAltM = (st.r - fanAtCraft) * SCALE
console.log('\n--- parked craft ---')
console.log('craft altitude over drawn ground:', craftAltM.toExponential(2), 'm  (want 0 — parked on the drawn ground)')
check('parked craft anchored on the rendered fan (machine precision)', Math.abs(craftAltM) < 1e-9, `Δ=${craftAltM.toExponential(2)} m`)

await w.close()

if (failures) {
  console.error(`\nprobe-walk-fan: ${failures} check(s) FAILED — the walker is not welded to the rendered surface`)
  process.exit(1)
}
console.log('\nprobe-walk-fan: PASS — the walker is welded to the rendered surface')
