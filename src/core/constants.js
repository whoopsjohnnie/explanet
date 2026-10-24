/**
 * constants.js — single source of truth for every tuned number in the engine.
 *
 * constants.json holds every constant, defined once:
 *   structural.<group>.<name> = <number>     invariants (physics softening, grid
 *                                     caps, frustum budgets) — no range, no dial,
 *                                     variants can never touch these
 *   tunables.<group>.<name> = { "value": n }                    single-defined, not dialed
 *                     = { "range": [at0, at1], "dial": "...", "gamma"?: g }
 *                         covariant: resolved as lerp(range[0], range[1], dial^gamma)
 *                         from a 0..1 dial in variants.json — direction is just the
 *                         range order, and several entries bound to ONE dial form a
 *                         covariant group that interplays together (e.g. skyGlow:
 *                         brighter band + wider bloom + lifted ambient floor)
 *
 * variants.json holds nothing but the dials — it is the fiddling file, the only
 * thing that should change while tuning a look.
 *
 * Validation runs at import time, EVERYWHERE the core loads (app, worker, node
 * tests, server): unknown/unused dials, out-of-range dial values, malformed
 * entries, non-finite numbers — all throw with a complete list.
 *
 * The gradientSteps dial is special: the loader consumes it itself, mapping
 * dial → band count (0 → 1 band, ~0.1 → ~9, 1 → quantization off entirely),
 * then scales per surface into C.gradient.steps.* so one float re-tunes every
 * gradient in the engine at once (bandize in JS mirrors core/glsl.js).
 *
 * Framework-free (JSON import attributes work in vite incl. workers, node ≥22,
 * and the headless harness loader).
 */

import raw from './constants.json' with { type: 'json' }
import dials from './variants.json' with { type: 'json' }

const errors = []
const usedDials = new Set()

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const isTunable = (v) => isObj(v) && ('value' in v || 'range' in v)

/** Read a 0..1 dial from variants.json (marks it used, validates range). */
function dialValue(name, path) {
  if (typeof name !== 'string') {
    errors.push(`${path}: range-bound tunable needs a "dial" name`)
    return 0.5
  }
  usedDials.add(name)
  const d = dials[name]
  if (!isNum(d) || d < 0 || d > 1) {
    errors.push(`variants.json: dial "${name}" must be a number in [0,1] (got ${JSON.stringify(d)})`)
    return 0.5
  }
  return d
}

/** Recursively resolve a section: tunables collapse to numbers, trees recurse. */
function resolve(node, path) {
  if (isTunable(node)) {
    if (node.range !== undefined) {
      const r = node.range
      if (!Array.isArray(r) || r.length !== 2 || !isNum(r[0]) || !isNum(r[1])) {
        errors.push(`${path}: range must be [number, number]`)
        return NaN
      }
      const gamma = node.gamma ?? 1
      if (!isNum(gamma) || gamma <= 0) {
        errors.push(`${path}: gamma must be a number > 0`)
        return NaN
      }
      const f = Math.pow(dialValue(node.dial, path), gamma)
      return r[0] + (r[1] - r[0]) * f
    }
    if (!isNum(node.value)) {
      errors.push(`${path}: tunable needs a numeric "value" or a "range" + "dial"`)
      return NaN
    }
    return node.value
  }
  if (Array.isArray(node)) return node.map((v, i) => resolve(v, `${path}[${i}]`))
  if (isObj(node)) {
    const out = {}
    for (const [k, v] of Object.entries(node)) if (!k.startsWith('_')) out[k] = resolve(v, `${path}.${k}`)
    return out
  }
  if (typeof node === 'number' && !isNum(node)) errors.push(`${path}: not a finite number`)
  return node
}

function deepMerge(a, b) {
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = isObj(out[k]) && isObj(v) ? deepMerge(out[k], v) : v
  return out
}

/** All constants, resolved to plain numbers, merged by group name. */
export const C = deepMerge(resolve(raw.structural || {}, 'structural'), resolve(raw.tunables || {}, 'tunables'))

// --- gradientSteps dial → per-surface band counts ---------------------------------------
// dial 0 → 1 band (no gradient, hard lines) … dial 1 → quantization fully OFF.
// The curve front-loads bands into the retro range (dial 0.1 → ≈9 bands at scale 1).
{
  const g = C.gradient || {}
  const d = dialValue('gradientSteps', 'gradient')
  const global = d >= 1 ? 0 : Math.max(1, Math.round(1 + (g.maxBands - 1) * Math.pow(d, g.curve)))
  const at = (scale) => (global === 0 ? 0 : Math.max(1, Math.round(global * scale)))
  g.steps = {
    global,
    skyZenith: at(g.scaleSkyZenith),
    skyDayNight: at(g.scaleSkyDayNight),
    sunGlare: at(g.scaleSunGlare),
    starDots: at(g.scaleStarDots),
    sunGlow: at(g.scaleSunGlow),
    limbGlow: at(g.scaleLimbGlow),
    airTerminator: at(g.scaleAirTerminator),
  }
}

// every dial in variants.json must be consumed — by a tunable binding above or
// by the gradient loader (typos in the fiddling file must not silently no-op)
for (const name of Object.keys(dials))
  if (!name.startsWith('_') && !usedDials.has(name))
    errors.push(`variants.json: dial "${name}" is not referenced by any tunable in constants.json`)

if (errors.length) throw new Error(`constants: ${errors.length} problem(s):\n  - ${errors.join('\n  - ')}`)

/**
 * JS mirror of core/glsl.js bandize() — quantize a 0..1 ramp to `steps` contour
 * bands (steps ≤ 0 = pass-through). Shared so a JS fade (StarField) and the GLSL
 * gradients step in lockstep with the same dial.
 */
export function bandize(x, steps) {
  if (!(steps > 0)) return x
  return Math.floor(Math.min(1, Math.max(0, x)) * steps + 0.5) / steps
}

/** Format a constant as a GLSL float literal for shader-string injection. */
export function gnum(v) {
  if (!isNum(v)) throw new Error(`gnum: ${JSON.stringify(v)} is not a finite number`)
  const s = String(v)
  if (/e/i.test(s)) return v.toFixed(9)
  return Number.isInteger(v) ? `${v}.0` : s
}
