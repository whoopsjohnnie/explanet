/**
 * starsky.js — the real sky in the engine frame.
 *
 * The backdrop is not decorative noise: it is the actual sky. Bright stars
 * come from the Yale Bright Star Catalog (J2000 RA/Dec, core/starCatalog.js,
 * generated) and the faint Milky Way band is procedural dust sampled in
 * GALACTIC coordinates — and every direction is projected into the engine
 * frame the whole world already lives in: the ecliptic is the XZ plane and
 * +Y is ecliptic north (the exact map kepler.js uses), so the constellations,
 * the galactic band (~62.9° off the orbital plane) and the planetary orbits
 * all hold their true mutual angles for free.
 *
 * Chain: catalog RA/Dec (equatorial, J2000) ──ε=23.439°──> ecliptic ──> engine
 *        galactic (l, b) ──J2000 pole/GC basis──> equatorial ──same──> engine
 *
 * Framework-free (no three, no DOM): the same math runs in the node tests.
 */

import { C } from './constants.js'

const DEG = Math.PI / 180
const TWO_PI = Math.PI * 2

/** Mean obliquity of the ecliptic at J2000 (deg). */
export const OBLIQUITY_J2000 = 23.4392911

// Galactic pole + center, IAU 1958 system expressed in J2000 equatorial coords.
const NGP_RA = 192.85948 * DEG // galactic north pole
const NGP_DEC = 27.12825 * DEG
const GC_RA = 266.40497 * DEG // galactic center (l = 0, b = 0)
const GC_DEC = -28.93617 * DEG

const CE = Math.cos(OBLIQUITY_J2000 * DEG)
const SE = Math.sin(OBLIQUITY_J2000 * DEG)

/** Equatorial unit vector (x, y, z) → engine frame (pure rotation + map). */
function eqVecToEngine(x, y, z, out) {
  // rotate about X by the obliquity: equatorial → ecliptic
  const Y = y * CE + z * SE
  const Z = -y * SE + z * CE
  // ecliptic → engine, the kepler.js map: (X, Y, Znorth) → (x, z, −y)
  out[0] = x
  out[1] = Z
  out[2] = -Y
  return out
}

/** Unit direction for equatorial (ra, dec in DEGREES, J2000), engine frame. */
export function radecToEngine(raDeg, decDeg, out = [0, 0, 0]) {
  const c = Math.cos(decDeg * DEG)
  return eqVecToEngine(c * Math.cos(raDeg * DEG), c * Math.sin(raDeg * DEG), Math.sin(decDeg * DEG), out)
}

// Galactic basis in equatorial unit vectors: x̂ toward the center, ẑ the pole,
// ŷ = ẑ × x̂ (l = 90°). Orthonormal up to the constants' shared precision.
const gcEq = (() => {
  const c = Math.cos(GC_DEC)
  return [c * Math.cos(GC_RA), c * Math.sin(GC_RA), Math.sin(GC_DEC)]
})()
const poleEq = (() => {
  const c = Math.cos(NGP_DEC)
  return [c * Math.cos(NGP_RA), c * Math.sin(NGP_RA), Math.sin(NGP_DEC)]
})()
const l90Eq = [
  poleEq[1] * gcEq[2] - poleEq[2] * gcEq[1],
  poleEq[2] * gcEq[0] - poleEq[0] * gcEq[2],
  poleEq[0] * gcEq[1] - poleEq[1] * gcEq[0],
]

/** Galactic (l, b in RADIANS) → equatorial unit vector (shared by project + dust). */
function galVecToEq(lRad, bRad, out) {
  const cb = Math.cos(bRad)
  const cl = Math.cos(lRad)
  const sl = Math.sin(lRad)
  const sb = Math.sin(bRad)
  out[0] = cb * (cl * gcEq[0] + sl * l90Eq[0]) + sb * poleEq[0]
  out[1] = cb * (cl * gcEq[1] + sl * l90Eq[1]) + sb * poleEq[1]
  out[2] = cb * (cl * gcEq[2] + sl * l90Eq[2]) + sb * poleEq[2]
  return out
}

/** Unit direction for galactic (l, b in DEGREES), engine frame. */
export function galacticToEngine(lDeg, bDeg, out = [0, 0, 0]) {
  const e = galVecToEq(lDeg * DEG, bDeg * DEG, [0, 0, 0])
  return eqVecToEngine(e[0], e[1], e[2], out)
}

/**
 * Equatorial (deg, J2000) → ecliptic { lonDeg ∈ [0,360), latDeg }. The engine
 * frame's own spherical coordinates (λ measured from the vernal equinox,
 * β = engine latitude) — stored per star in the DB, verified by
 * scripts/test-starfield.mjs against galacticToEngine/radecToEngine.
 */
export function radecToEcliptic(raDeg, decDeg) {
  const c = Math.cos(decDeg * DEG)
  const x = c * Math.cos(raDeg * DEG)
  const y = c * Math.sin(raDeg * DEG)
  const z = Math.sin(decDeg * DEG)
  const Y = y * CE + z * SE
  const Z = -y * SE + z * CE
  const X = x
  let lonDeg = Math.atan2(Y, X) / DEG
  if (lonDeg < 0) lonDeg += 360
  return { lonDeg, latDeg: Math.asin(Math.max(-1, Math.min(1, Z))) / DEG }
}

/**
 * Equatorial (deg, J2000) → galactic { lDeg ∈ [0,360), bDeg } in the IAU 1958
 * system (same pole/center constants as galacticToEngine — exact inverse).
 */
export function radecToGalactic(raDeg, decDeg) {
  const c = Math.cos(decDeg * DEG)
  const x = c * Math.cos(raDeg * DEG)
  const y = c * Math.sin(raDeg * DEG)
  const z = Math.sin(decDeg * DEG)
  // project onto the galactic basis: x̂ = center, ŷ = l=90°, ẑ = pole
  const xg = x * gcEq[0] + y * gcEq[1] + z * gcEq[2]
  const yg = x * l90Eq[0] + y * l90Eq[1] + z * l90Eq[2]
  const zg = x * poleEq[0] + y * poleEq[1] + z * poleEq[2]
  let lDeg = Math.atan2(yg, xg) / DEG
  if (lDeg < 0) lDeg += 360
  return { lDeg, bDeg: Math.asin(Math.max(-1, Math.min(1, zg))) / DEG }
}

// ---------------------------------------------------------------------------
// Bright-star catalog (generated module: Int32 quads, base64)
// ---------------------------------------------------------------------------

/**
 * sRGB (0..1) → linear light — three's working space is linear and our star
 * shaders tone-map/encode by hand (like WalkSky), so colors are stored linear.
 */
export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/**
 * Linear-light tints per spectral class (0=O … 6=M, 7=uncatalogued white).
 * Pushed a step past blackbody so the classes read as COLOR at point sizes —
 * long-exposure astrophoto saturation, not textbook swatches.
 */
export const SPECTRAL_COLORS = [
  '#7d9dff', // O — deep blue
  '#93b4ff', // B — Rigel
  '#bcd2ff', // A — Vega
  '#f4f3ff', // F — Procyon
  '#ffe6b8', // G — the Sun, golden
  '#ffbe73', // K — Arcturus, orange
  '#ff8f4d', // M — Betelgeuse, red-orange
  '#dfe3f0', // ?  — no class in catalog
].map((hex) => [
  srgbToLinear(parseInt(hex.slice(1, 3), 16) / 255),
  srgbToLinear(parseInt(hex.slice(3, 5), 16) / 255),
  srgbToLinear(parseInt(hex.slice(5, 7), 16) / 255),
])

/**
 * Decode the packed catalog. Returns parallel arrays in the catalog's own
 * J2000 frame — project each star with radecToEngine at render build time.
 */
export function decodeBrightStars(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const words = new Int32Array(bytes.buffer)
  const n = words.length / 4
  const ra = new Float32Array(n)
  const dec = new Float32Array(n)
  const mag = new Float32Array(n)
  const spec = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    ra[i] = words[i * 4] / 1000
    dec[i] = words[i * 4 + 1] / 1000
    mag[i] = words[i * 4 + 2] / 100
    spec[i] = words[i * 4 + 3]
  }
  return { count: n, ra, dec, mag, spec }
}

/** Point size (CSS px) for a visual magnitude: Sirius ≈ 5.8, mag 6.5 ≈ 1.1. */
export function starSizePx(mag) {
  const t = Math.max(0, Math.min(1, (C.sky.starSizeRefMag - mag) / C.sky.starSizeMagSpan))
  return C.sky.starSizeMin + C.sky.starSizeMax * Math.pow(t, C.sky.starSizeCurve)
}

/** Additive intensity (0..1) for a visual magnitude. */
export function starIntensity(mag) {
  const t = Math.max(0, Math.min(1, (C.sky.starSizeRefMag - mag) / C.sky.starSizeMagSpan))
  return C.sky.starIntenMin + C.sky.starIntenMax * Math.pow(t, C.sky.starIntenCurve)
}

// ---------------------------------------------------------------------------
// Milky Way dust — procedural unresolved stars, sampled in galactic coords
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const RAD = 180 / Math.PI

/**
 * Linear-light palettes for unresolved starlight — the astrophoto look:
 * blue-white arc-arm field stars, warm cream disk population, a golden
 * bulge glow at the center, ember accents for H-II regions. Mixed per
 * particle (additive blending sums light, so mixing happens in linear).
 */
const DUST_COOL = [0.42, 0.62, 1.0] // arc-arm blue-white
const DUST_CREAM = [1.0, 0.8, 0.55] // disk warm cream
const DUST_GOLD = [1.0, 0.56, 0.2] // bulge gold
const DUST_EMBER = [1.0, 0.34, 0.12] // emission-region orange

/**
 * Unnormalized acceptance density for galactic (l, b in radians): a
 * double-exponential disk (scale ~5°) brightened toward the galactic center
 * (the bulge), with the Great Rift carved as a dust shadow ringing the
 * center at mid latitude. Max over the sphere is (0.25+0.75)·(1+3) = 4.
 */
function diskDensity(bAbs, dGc) {
  const disk = Math.exp(-bAbs * RAD / 5)
  const bulge = 1 + 3 * Math.exp(-Math.pow(dGc * RAD / 16, 2))
  const rift = 1 - 0.6 * Math.exp(-Math.pow(dGc * RAD / 35, 2)) * Math.exp(-Math.pow((bAbs * RAD - 5) / 6, 2))
  return (0.25 + 0.75 * disk) * bulge * rift
}

/**
 * Procedural Milky Way: `count` unit directions (engine frame) drawn from the
 * galactic disk density, with weights 0..1 for dim unresolved stars and a
 * per-star LINEAR-LIGHT `tint` — warm cream/gold crowding toward the galactic
 * center (the bulge), blue-white in the outer band, ~5-13% ember-orange
 * emission patches, all mottled so the band reads as colored haze rather than
 * one flat glow. Seeded → deterministic (tints draw on their own stream, so
 * positions never shift when the palette changes).
 */
export function generateDust(count, seed = 7) {
  const rand = mulberry32(seed)
  const trand = mulberry32((seed ^ 0x9e3779b9) >>> 0) // tints only
  const dir = new Float32Array(count * 3)
  const w = new Float32Array(count)
  const tint = new Float32Array(count * 3)
  const v = [0, 0, 0]
  for (let i = 0; i < count; ) {
    const l = rand() * TWO_PI
    // double-sided exponential latitude: |b| = σ·ln(1/u), σ = 7°
    const b = ((rand() < 0.5 ? 1 : -1) * 7 * -Math.log(Math.max(rand(), 1e-9))) * DEG
    // angular distance to the galactic center (at l = 0, b = 0)
    const dGc = Math.acos(Math.max(-1, Math.min(1, Math.cos(b) * Math.cos(l))))
    if (rand() * 4 > diskDensity(Math.abs(b), dGc)) continue
    const e = galVecToEq(l, b, [0, 0, 0])
    eqVecToEngine(e[0], e[1], e[2], v)
    dir[i * 3] = v[0]
    dir[i * 3 + 1] = v[1]
    dir[i * 3 + 2] = v[2]
    w[i] = Math.pow(rand(), 2)

    // --- color: warm toward the center, cool in the outer band, mottled ---
    const warm = Math.exp(-dGc * RAD / 48) * Math.exp(-Math.abs(b) * RAD / 20) // 0..1
    let m = 0.18 + 0.85 * warm + 0.34 * (trand() - 0.5)
    m = m < 0 ? 0 : m > 1 ? 1 : m
    let r = DUST_COOL[0] + (DUST_CREAM[0] - DUST_COOL[0]) * m
    let g = DUST_COOL[1] + (DUST_CREAM[1] - DUST_COOL[1]) * m
    let bl = DUST_COOL[2] + (DUST_CREAM[2] - DUST_COOL[2]) * m
    // the bulge's heart goes full gold
    const gold = Math.max(0, warm - 0.45) * 1.6 * trand()
    r += (DUST_GOLD[0] - r) * gold
    g += (DUST_GOLD[1] - g) * gold
    bl += (DUST_GOLD[2] - bl) * gold
    // emission-region embers, likelier where the disk is dense
    const ember = trand() < 0.05 + 0.08 * warm ? 0.8 : 0
    r += (DUST_EMBER[0] - r) * ember
    g += (DUST_EMBER[1] - g) * ember
    bl += (DUST_EMBER[2] - bl) * ember
    tint[i * 3] = r
    tint[i * 3 + 1] = g
    tint[i * 3 + 2] = bl
    i++
  }
  return { dir, w, tint }
}
