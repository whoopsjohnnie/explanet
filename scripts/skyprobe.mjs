/**
 * skyprobe.mjs — evaluate what the WalkSky dome shader WOULD paint, without a GPU.
 *
 * The headless harness measures geometry, not pixels (null GL), so this probe is
 * the eyes for color/curve work: it ports the per-pixel math of
 * components/WalkSky.jsx (twilight + sunset palette + forward scatter, the
 * StarField.jsx visibility curve, and the walk ground-fill light) to JS,
 * reading the SAME src/core/constants.js dial resolution and the SAME
 * core/atmospheres.js catalog the app uses. If a number is off here, it is off
 * on screen.
 *
 * Pipeline fidelity (three r186 / R3F v9 defaults):
 *   hex color → linear (THREE.Color decodes sRGB, ColorManagement on)
 *   → shader math (mix/pow/bandize/forward-scatter/corona)
 *   → aces() → toSRGB() (the raw ShaderMaterial encodes itself)
 *   → normal blend over the black clear color with alpha = atmo.opacity
 *   (star pass: ADDITIVE in that same encoded space, on top).
 *
 * Usage:
 *   node scripts/skyprobe.mjs --body Earth --sun-elev 3
 *       vertical sky column at sun elevation 3°, table of sRGB hex per view
 *       elevation × azimuth-from-sun.
 *   node scripts/skyprobe.mjs --body Earth --sun-elev 2 --strip out.ppm --cols 0,90
 *       write a PPM strip (rows: view elev 90→0, one column per azimuth) —
 *       `convert out.ppm out.png` and compare against a photo crop.
 *   node scripts/skyprobe.mjs --body Earth --twilight
 *       sunset→night curve: horizon / 45° / zenith color as the sun sinks.
 *   Any body in the atmospheres.js catalog, or a custom one:
 *       --zenith '#2255aa' --horizon '#ccddee' --glow '#ffddaa' --opacity 0.6
 *
 * Reference photo side (ImageMagick is all that's needed):
 *   magick photo.jpg -crop 1x400+X+Y -scale! 1x64 txt:   # a pixel column
 *   magick photo.jpg -resize 64x! -colors 8 -unique-colors txt:
 */

import fs from 'node:fs'
import { C, bandize } from '../src/core/constants.js'
import { SOL_ATMOSPHERES, atmosphereFor } from '../src/core/atmospheres.js'

const D2R = Math.PI / 180

// --- color helpers -----------------------------------------------------------
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : Math.pow(c, 1 / 2.4) * 1.055 - 0.055)
const hexToLinear = (hex) => {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((b) => srgbToLinear(b / 255))
}

/** Narkowicz ACES fit — WalkSky.jsx/StarField.jsx verbatim. */
const aces = ([r, g, b]) => {
  const f = (x) => Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)))
  return [f(r), f(g), f(b)]
}
const encode = (lin) => lin.map((c) => Math.min(1, Math.max(0, linearToSrgb(Math.min(1, Math.max(0, c))))))
const hex8 = (enc) => '#' + enc.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b

// --- the walk sky's pass-2 constants (mirror of components/WalkSky.jsx) -----
const SUNSET_HORIZON = '#ff5a1f'
const SUNSET_ZENITH = '#f0ad60'
const FILL_DAY = 0.22
const FILL_SUNSET = 0.7
const FILL_REF_OPACITY = 0.62

// --- shader mirror -----------------------------------------------------------
/** WalkSky.jsx main(): view dir at (elevDeg, azimuth-from-sun deg), sun at sunElevDeg. */
export function walkSky(atmo, sunElevDeg, elevDeg, azimDeg) {
  const zen = hexToLinear(atmo.zenith)
  const hor = hexToLinear(atmo.horizon)
  const glow = hexToLinear(atmo.glow)
  const night = zen.map((c) => c * 0.04) // uniforms.uNight = zenith * 0.04
  const sHor = hexToLinear(SUNSET_HORIZON)
  const sZen = hexToLinear(SUNSET_ZENITH)

  const e = elevDeg * D2R
  const es = sunElevDeg * D2R
  const a = azimDeg * D2R
  const up = Math.max(Math.sin(e), 0) // dot(dir, uUpDir)
  const sd = Math.max(Math.cos(e) * Math.cos(a) * Math.cos(es) + Math.sin(e) * Math.sin(es), 0) // dot(dir, sun)
  const sunDotUp = Math.sin(es) // dot(sun, uUpDir)
  const hasSun = 1

  const steps = C.gradient.steps
  const mix = (x, y, t) => x.map((_, i) => x[i] + (y[i] - x[i]) * t)
  // twilight + sunset tint (WalkSky GLSL, mirrored)
  let light = smoothstep(C.skyFade.sunDown, 0, sunDotUp)
  const sunsetT = 1 - smoothstep(0, C.skyFade.sunUp, sunDotUp)
  light = bandize(light, steps.skyDayNight)
  const st = bandize(sunsetT, steps.skyDayNight)
  let day = mix(mix(hor, sHor, st), mix(zen, sZen, st), bandize(Math.pow(up, 0.55), steps.skyZenith))
  day = day.map((c, i) => c + glow[i] * bandize(Math.pow(sd, 7.0 - 4.0 * st), steps.sunGlare) * (0.4 + 1.1 * st) * hasSun)
  let col = mix(night, day, light)
  col = col.map((c, i) => c + glow[i] * bandize(Math.pow(sd, 250.0), steps.sunGlare) * (2.0 + 1.0 * st) * hasSun)

  // raw material encodes itself; normal blend over black clear with alpha=opacity
  const enc = encode(aces(col))
  return {
    linear: col,
    displayed: enc.map((c) => c * atmo.opacity), // what lands in the framebuffer
    hex: hex8(enc.map((c) => c * atmo.opacity)),
    light,
    sunsetT,
  }
}

const smoothstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** StarField.jsx uVis target for a walk (before the per-frame ease): stars vs. air. */
export function starVisibility(atmo, sunElevDeg) {
  const light = bandize(smoothstep(C.skyFade.sunDown, 0, Math.sin(sunElevDeg * D2R)), C.gradient.steps.skyDayNight)
  return (1 - light) * Math.pow(1 - Math.min(1, atmo.opacity ?? 0), 0.45)
}

/** WalkSky.jsx ground fill: the sky's own light on the terrain while the sun is low. */
export function groundFill(atmo, sunElevDeg) {
  const elev = Math.sin(sunElevDeg * D2R)
  const light = smoothstep(C.skyFade.sunDown, 0, elev)
  const tint = 1 - smoothstep(0, C.skyFade.sunUp, elev)
  const scale = Math.min(1, (atmo.opacity ?? 0) / FILL_REF_OPACITY)
  return { light, tint, intensity: light * (FILL_DAY + (FILL_SUNSET - FILL_DAY) * tint) * scale }
}

// --- CLI ---------------------------------------------------------------------
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt
}
const has = (name) => process.argv.includes(`--${name}`)
const list = (s) => s.split(',').map(Number)

function resolveAtmo() {
  if (has('zenith') || has('horizon')) {
    return {
      opacity: Number(arg('opacity', 0.62)),
      zenith: arg('zenith', '#2f63b4'),
      horizon: arg('horizon', '#b3cde8'),
      glow: arg('glow', '#ffd9a0'),
    }
  }
  const name = arg('body', 'Earth')
  const entry = SOL_ATMOSPHERES[name]
  if (!entry) {
    console.error(`no atmosphere "${name}" in the catalog: ${Object.keys(SOL_ATMOSPHERES).join(', ')}`)
    process.exit(1)
  }
  return entry // same shapes atmosphereFor() derives from
}

function main() {
  const atmo = resolveAtmo()
  console.log(`atmo: ${JSON.stringify({ opacity: atmo.opacity, zenith: atmo.zenith, horizon: atmo.horizon, glow: atmo.glow })}`)
  const s = C.gradient.steps
  console.log(`dial steps: skyZenith=${s.skyZenith} dayNight=${s.skyDayNight} sunGlare=${s.sunGlare} (0 = smooth)`)

  if (has('twilight')) {
    console.log('\nsun°  vis   horizon(e0.5)  45°        zenith(88)   [facing sun]')
    for (let es = 15; es >= -15; es -= 2.5) {
      const h = walkSky(atmo, es, 0.5, 0)
      const m = walkSky(atmo, es, 45, 0)
      const z = walkSky(atmo, es, 88, 0)
      const vis = starVisibility(atmo, es)
      const fill = groundFill(atmo, es)
      console.log(
        `${String(es).padStart(5)}  ${vis.toFixed(3)}  ${h.hex}  ${m.hex}  ${z.hex}  light=${h.light.toFixed(3)} fill=${fill.intensity.toFixed(2)}`
      )
    }
    return
  }

  const sunElev = Number(arg('sun-elev', 0))
  const elevs = list(arg('elev', '0,1,3,6,12,25,45,65,88'))
  const azims = list(arg('azim', '0,30,60,90,180'))

  console.log(`\nsun elev ${sunElev}° — view elevation down rows, azimuth from sun across (stars vis ${(starVisibility(atmo, sunElev) * 100).toFixed(1)}%)`)
  console.log('elev  ' + azims.map((a) => `azim ${String(a).padStart(3)}`).join(' '))
  for (const e of elevs) {
    const row = azims.map((a) => walkSky(atmo, sunElev, e, a).hex).join(' ')
    console.log(`${String(e).padStart(4)}  ${row}`)
  }

  if (has('strip')) {
    const cols = list(arg('cols', '0,45,90,180'))
    const hgt = Number(arg('rows', '192'))
    const wdt = cols.length
    const ppm = [`P6\n${wdt} ${hgt}\n255\n`]
    const bytes = new Uint8Array(wdt * hgt * 3)
    for (let y = 0; y < hgt; y++) {
      const e = 90 - (y / (hgt - 1)) * 90 // top = zenith, bottom = horizon
      cols.forEach((a, x) => {
        const c = walkSky(atmo, sunElev, e, a).displayed
        for (let k = 0; k < 3; k++) bytes[(y * wdt + x) * 3 + k] = Math.round(c[k] * 255)
      })
    }
    const buf = Buffer.concat([Buffer.from(ppm[0], 'ascii'), Buffer.from(bytes)])
    fs.writeFileSync(arg('strip'), buf)
    console.log(`\nstrip (${wdt}×${hgt}, azims ${cols.join(',')}, elev 90→0) → ${arg('strip')}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()
