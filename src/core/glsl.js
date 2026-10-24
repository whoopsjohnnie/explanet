/**
 * glsl.js — shared GLSL snippets, defined once and injected into every
 * shader template literal. Framework-free (plain strings); step counts arrive
 * as float literals from C.gradient.steps.* via gnum() in core/constants.js.
 */

/**
 * bandize — quantize a 0..1 ramp into `steps` contour bands:
 *   steps ≤ 0  → pass-through (smooth; the dial's "off" state)
 *   steps = 1  → binary (no gradient: hard lines)
 *   steps = N  → N bands (the DOS-gradient look)
 * JS mirror: bandize() in core/constants.js (keep in sync).
 */
export const BAND_FN = /* glsl */ `
float bandize(float x, float steps) {
  return steps <= 0.0 ? x : floor(clamp(x, 0.0, 1.0) * steps + 0.5) / steps;
}
`
