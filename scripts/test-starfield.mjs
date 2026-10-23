/**
 * test-starfield.mjs — headless tests for the real sky (core/starsky.js +
 * the generated catalog): decode integrity, equatorial→ecliptic→engine
 * projection against known celestial landmarks, galactic-frame agreement
 * (the Milky Way must sit at its true ~60° to the ecliptic), and the band
 * concentration of the procedural dust.
 * Run: node scripts/test-starfield.mjs
 */

import { STAR_B64 } from '../src/core/starCatalog.js'
import {
  decodeBrightStars,
  radecToEngine,
  galacticToEngine,
  radecToGalactic,
  radecToEcliptic,
  OBLIQUITY_J2000,
  generateDust,
  starSizePx,
  starIntensity,
  SPECTRAL_COLORS,
} from '../src/core/starsky.js'

let failures = 0
const check = (name, cond) => {
  console.log(`${cond ? '✓' : '✗'} ${name}`)
  if (!cond) failures++
}

const DEG = Math.PI / 180
const norm = (v) => Math.hypot(v[0], v[1], v[2])
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const angBetween = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (norm(a) * norm(b))))) / DEG

// ---- catalog decode -------------------------------------------------------
const cat = decodeBrightStars(STAR_B64)
check(`catalog decodes (${cat.count} stars)`, cat.count === 9096)
let bad = 0
for (let i = 0; i < cat.count; i++) {
  if (!(cat.ra[i] >= 0 && cat.ra[i] < 360)) bad++
  if (!(cat.dec[i] >= -90 && cat.dec[i] <= 90)) bad++
  if (!(cat.mag[i] > -3 && cat.mag[i] < 8)) bad++
  if (!(cat.spec[i] >= 0 && cat.spec[i] <= 7)) bad++
}
check('every star in range (RA, Dec, mag, class)', bad === 0)

// every projected star sits on the unit sphere
let maxDev = 0
const v = [0, 0, 0]
for (let i = 0; i < cat.count; i++) maxDev = Math.max(maxDev, Math.abs(norm(radecToEngine(cat.ra[i], cat.dec[i], v)) - 1))
check(`projections unit-length (max dev ${maxDev.toExponential(1)})`, maxDev < 1e-5)

// ---- celestial landmarks --------------------------------------------------
// vernal equinox = ecliptic longitude 0 → engine +X
const equinox = radecToEngine(0, 0)
check('vernal equinox → engine +X', Math.abs(equinox[0] - 1) < 1e-6 && Math.abs(equinox[1]) < 1e-6 && Math.abs(equinox[2]) < 1e-6)
// ecliptic north pole (RA 270°, Dec +66.56°) → engine +Y
const enp = radecToEngine(270, 66.5607)
check('ecliptic north pole → engine +Y', Math.abs(enp[1] - 1) < 1e-4 && norm([enp[0], 0, enp[2]]) < 1e-4)
// celestial north pole (Dec +90) sits 90°−ε above the ecliptic → engine y = cos ε
const cnp = radecToEngine(42.36, 90)
check('celestial pole 90°−ε above the ecliptic', Math.abs(cnp[1] - Math.cos(23.4392911 * DEG)) < 1e-3)

// ---- galactic frame -------------------------------------------------------
const gcGal = galacticToEngine(0, 0)
const gcEq = radecToEngine(266.40497, -28.93617) // l=0 direction by its own equatorial route
check('galactic center: l,b route ≡ RA,Dec route', angBetween(gcGal, gcEq) < 0.01)
const sgrA = radecToEngine(266.4168, -28.9362) // Sgr A*, independent landmark
check(`l=0 points at Sgr A* (${angBetween(gcGal, sgrA).toFixed(3)}° off)`, angBetween(gcGal, sgrA) < 0.05)
const ngpGal = galacticToEngine(0, 90)
const ngpEq = radecToEngine(192.85948, 27.12825)
check('galactic pole: both routes agree', angBetween(ngpGal, ngpEq) < 0.01)
// the band's headline number: galactic plane vs ecliptic ≈ 60.2° between poles
check(`galactic pole ~60° off ecliptic north (${angBetween(ngpGal, [0, 1, 0]).toFixed(2)}°)`, Math.abs(angBetween(ngpGal, [0, 1, 0]) - 60.2) < 1.5)
// galactic center sits just 5.5° S of the ecliptic — the Sun passes beside it
// near every December solstice
check('galactic center just below the ecliptic', Math.abs(gcGal[1] - Math.sin(-5.53 * DEG)) < 0.02)

// catalog stars really cluster toward the galactic plane (uniform → 25.9%)
const ngpN = [ngpGal[0] / norm(ngpGal), ngpGal[1] / norm(ngpGal), ngpGal[2] / norm(ngpGal)]
const angFromPlane = (p) => Math.abs(90 - angBetween(p, ngpN)) // |galactic latitude|
let inBand = 0
for (let i = 0; i < cat.count; i++) {
  radecToEngine(cat.ra[i], cat.dec[i], v)
  if (angFromPlane(v) < 15) inBand++
}
const bandFrac = inBand / cat.count
check(`bright stars band-concentrated (${(bandFrac * 100).toFixed(1)}%, uniform ${(Math.sin(15 * DEG) * 100).toFixed(1)}%)`, bandFrac > 0.33)

// ---- derived columns (what import-stars.mjs stores in gal_/ecl_) ----------
// reverse projection of the galactic center lands at (l, b) = (0, 0)
const gcLB = radecToGalactic(266.40497, -28.93617)
check(`radecToGalactic(GC) → (0, 0) [got ${gcLB.lDeg.toFixed(3)}, ${gcLB.bDeg.toFixed(3)}]`,
  Math.abs(((gcLB.lDeg + 180) % 360) - 180) < 0.01 && Math.abs(gcLB.bDeg) < 0.01)
// reverse projection of the galactic pole → b = +90
const ngpLB = radecToGalactic(192.85948, 27.12825)
check('radecToGalactic(pole) → b = 90', Math.abs(ngpLB.bDeg - 90) < 0.01)
// ecliptic frame: the north ecliptic pole is at ecliptic latitude +90
const enpEcl = radecToEcliptic(270, 66.5607)
check('radecToEcliptic(ecliptic pole) → lat 90', Math.abs(enpEcl.latDeg - 90) < 1e-3)
// the solstice point (RA 6h, Dec +ε) lies ON the ecliptic
const solstice = radecToEcliptic(90, OBLIQUITY_J2000)
check('solstice point on the ecliptic', Math.abs(solstice.latDeg) < 1e-6 && Math.abs(solstice.lonDeg - 90) < 1e-6)
// round-trip: radecToGalactic then galacticToEngine ≡ radecToEngine, all stars
let maxRoundTrip = 0
for (let i = 0; i < cat.count; i++) {
  const lb = radecToGalactic(cat.ra[i], cat.dec[i])
  const a = radecToEngine(cat.ra[i], cat.dec[i], [0, 0, 0])
  const b = galacticToEngine(lb.lDeg, lb.bDeg, [0, 0, 0])
  maxRoundTrip = Math.max(maxRoundTrip, angBetween(a, b))
}
check(`galactic round-trip exact over all ${cat.count} stars (max ${maxRoundTrip.toExponential(1)}°)`, maxRoundTrip < 1e-4)
// the stored ecliptic latitude must equal the engine y-component's implied one
let maxEclLat = 0
for (let i = 0; i < cat.count; i++) {
  const e = radecToEcliptic(cat.ra[i], cat.dec[i])
  const y = radecToEngine(cat.ra[i], cat.dec[i], [0, 0, 0])[1] // engine y = sin(ecliptic lat)
  maxEclLat = Math.max(maxEclLat, Math.abs(Math.asin(Math.max(-1, Math.min(1, y))) / DEG - e.latDeg))
}
check(`ecliptic latitude consistent with engine +Y (max ${maxEclLat.toExponential(1)}°)`, maxEclLat < 1e-4)

// ---- procedural dust ------------------------------------------------------
const d1 = generateDust(4000, 7)
const d2 = generateDust(4000, 7)
check('dust is seeded-deterministic', d1.dir.every((x, i) => x === d2.dir[i]) && d1.w.every((x, i) => x === d2.w[i]))
let dustBad = 0
let dustBand = 0
let dustGc = 0
const gcN = [gcGal[0] / norm(gcGal), gcGal[1] / norm(gcGal), gcGal[2] / norm(gcGal)]
for (let i = 0; i < d1.dir.length / 3; i++) {
  const p = [d1.dir[i * 3], d1.dir[i * 3 + 1], d1.dir[i * 3 + 2]]
  if (Math.abs(norm(p) - 1) > 1e-5) dustBad++
  if (angFromPlane(p) < 10) dustBand++
  if (angBetween(p, gcN) < 25) dustGc++
}
check('dust on unit sphere', dustBad === 0)
check(`dust hugs the plane (${((dustBand / 4000) * 100).toFixed(1)}% within 10°)`, dustBand / 4000 > 0.55)
check(`dust brightens at the center (${((dustGc / 4000) * 100).toFixed(1)}% within 25°, uniform 3.8%)`, dustGc / 4000 > 0.08)

// ---- display mapping ------------------------------------------------------
check(
  'size/intensity monotone in magnitude',
  starSizePx(-1.5) > starSizePx(3) && starSizePx(3) > starSizePx(6.5) &&
    starIntensity(-1.5) > starIntensity(3) && starIntensity(3) > starIntensity(6.5)
)
check('sizes stay point-sized', starSizePx(-1.5) < 6 && starSizePx(6.5) < 1.6)
check('8 spectral tints, linear-light', SPECTRAL_COLORS.length === 8 && SPECTRAL_COLORS.every((c) => c.length === 3 && c.every((x) => x >= 0 && x <= 1)))
// M dwarfs redder than B stars in every channel ordering red > blue
const mRed = SPECTRAL_COLORS[6][0] / SPECTRAL_COLORS[6][2]
const bRed = SPECTRAL_COLORS[1][0] / SPECTRAL_COLORS[1][2]
check('M redder than B', mRed > 1.5 && bRed < 0.8)

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall starfield tests passed')
process.exit(failures ? 1 : 0)
