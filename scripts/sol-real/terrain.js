/**
 * Sol Real / terrain — hex element builders with real geography.
 *
 * Every builder returns a plain elements array [{ t, h, c }] for a given
 * frequency, in ENGINE units (h is absolute). Heights come from real
 * figures (km × KM2U), so nothing is exaggerated. Earth is special: its
 * h comes from the ETOPO2022 60s DEM — real coastlines, real mountain
 * heights, and seafloor DEPTH as negative h (sea level = 0). Colors ride
 * per-cell `c`, so one planet paints continents, maria, rust and sulfur
 * without a material system.
 *
 * Sphere convention (matches hexsphere cell centers):
 *   y = sin(lat);  lon = atan2(-z, x)  (degrees in tables, radians here)
 *
 * The minus on z is a HANDEDNESS requirement, not a style choice: the scene is
 * right-handed with north = +y, so a point at longitude L must sit at
 * (cos L, 0, -sin L) — then east (increasing L) runs COUNTERCLOCKWISE seen
 * from above the north pole, as on the real Earth. Using +sin L would make
 * east run clockwise and render the whole globe mirrored (Arabia west of
 * Africa, every coastline backwards). Every lat/lon ↔ direction conversion in
 * this file (latLon, angDist, the DEM pixel scan) must agree on this sign.
 */

import { getHexSphere } from '../../src/core/hexsphere.js'
import { valueNoise, fbm } from '../../src/core/generators.js'
import { radiusForFrequency, MAX_FREQUENCY } from '../../src/core/planetMath.js'
import { sampleAt, trigTables } from './etopo.mjs'
import { DESERTS, LAKES, MARS, MOON, MERCURY, VENUS, MOON_PALETTES } from './features.js'

// km → engine units (one hex ≈ 35 km on the f203 grid — the same anchor as
// the generators). ALL builders below take heights in real km from the
// tables and emit elements in engine units.
const KM2U = radiusForFrequency(MAX_FREQUENCY) / 6371.009

const DEG = Math.PI / 180
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const lerp = (a, b, t) => a + (b - a) * t
const smoothstep = (t) => t * t * (3 - 2 * t)

function mix(c1, c2, t) {
  t = clamp(t, 0, 1)
  const h = (s) => parseInt(s.length === 3 ? s.replace(/./g, '$&$&') : s.slice(1), 16)
  const a = h(c1)
  const b = h(c2)
  const r = Math.round(lerp((a >> 16) & 255, (b >> 16) & 255, t))
  const g = Math.round(lerp((a >> 8) & 255, (b >> 8) & 255, t))
  const bl = Math.round(lerp(a & 255, b & 255, t))
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`
}

/** Unit vector → { lat, lon } in radians. */
function latLon(hex, i) {
  const x = hex.centers[i * 3]
  const y = hex.centers[i * 3 + 1]
  const z = hex.centers[i * 3 + 2]
  const n = Math.hypot(x, y, z) || 1
  return { lat: Math.asin(clamp(y / n, -1, 1)), lon: Math.atan2(-z / n, x / n), x: x / n, y: y / n, z: z / n }
}

/** Angular distance (radians) between a cell vector and a lat/lon point. */
function angDist(v, latR, lonR) {
  // the lat/lon point's scene direction is (cos·cos, sin, -cos·sin) — the
  // minus on z is the handedness convention (see file header)
  const d = v.x * Math.cos(latR) * Math.cos(lonR) + v.y * Math.sin(latR) - v.z * Math.cos(latR) * Math.sin(lonR)
  return Math.acos(clamp(d, -1, 1))
}

// ---------------------------------------------------------------------------
// Earth — from the ETOPO2022 60s digital elevation model
// (scripts/sol-real/etopo.mjs): land elevation + seafloor depth in METERS,
// sea level = 0 — the same convention this world's `h` field uses.
//
// Every hex integrates the DEM pixels whose centers fall inside it (a
// 35 km hex covers ~360 px of the 1.85 km grid). Containment is the EXACT
// Voronoi test: a pixel direction p belongs to cell i iff p·c_i ≥ p·c_n for
// every neighbor n — the great circles p·(c_i − c_n) = 0 are the true cell
// edges (the stored corner ring is a face-CENTROID approximation of the
// Voronoi vertices, so corner great circles do not tile the sphere: they cut
// ~6 % inside the cells and leave polar caps unassigned). The pixel scan
// covers a geodesic disc about the cell center — a guaranteed superset of
// the cell, which reaches the pole when the cell does:
//   land  (mean ≥ 0):  h = (mean + max) / 2 — the hex's peak gets half credit
//   ocean (mean < 0):  h = (mean + min) / 2 — the hex's trench gets half credit
// (variation inside one hex is ≤ ~2 km, so the blend is a gentle
// peak/trench accent, not a cliff). Colors: climate belt + desert table +
// elevation modifiers for land; a depth ramp for the seafloor; an ice tint
// on high-latitude water. The ocean SURFACE at h = 0 is a render-time
// sphere (Planet.jsx), not a cell height.
// ---------------------------------------------------------------------------

/**
 * DEM stats for one hex: mean/max/min of the pixels whose centers fall
 * inside the cell. Returns null if the scan finds none (degenerate cell).
 */
export function hexDemStats(hex, i, geo, trig) {
  const c3 = i * 3
  const cx = hex.centers[c3]
  const cy = hex.centers[c3 + 1]
  const cz = hex.centers[c3 + 2]
  const cn = Math.hypot(cx, cy, cz) || 1
  const cLat = Math.asin(cy / cn)
  // the cell center's REAL longitude (handedness convention: lon = atan2(-z, x))
  const cLon = Math.atan2(-cz / cn, cx / cn)
  const sides = hex.sides[i]

  // exact Voronoi boundary: the great circle between cell i and neighbor k
  // is { p : p·(c_i − c_n) = 0 }; inside = p·(c_i − c_n) ≥ 0 (the center
  // itself scores 1 − cos θ > 0). Corners double as the disc radius: the
  // cell is convex with the center inside, so it is contained in the
  // geodesic disc of radius (max corner distance) — margin ×1.4 covers the
  // centroid-vs-circumcenter offset of the stored corner ring.
  const ex = new Float64Array(sides)
  const ey = new Float64Array(sides)
  const ez = new Float64Array(sides)
  let reach = 0
  for (let k = 0; k < sides; k++) {
    const nIdx = hex.neighbors[i * 6 + k]
    const o = nIdx * 3
    let nx = cx - hex.centers[o]
    let ny = cy - hex.centers[o + 1]
    let nz = cz - hex.centers[o + 2]
    const m = Math.hypot(nx, ny, nz) || 1
    ex[k] = nx / m
    ey[k] = ny / m
    ez[k] = nz / m
    const o0 = (i * 6 + k) * 3
    const d = Math.acos(clamp((hex.corners[o0] * cx + hex.corners[o0 + 1] * cy + hex.corners[o0 + 2] * cz) / cn, -1, 1))
    if (d > reach) reach = d
  }
  const r = reach * 1.4

  // pixel box: the geodesic disc, clamped to the grid. Longitude extent is
  // largest at the box's highest |latitude| (Δlon ≤ d / cos lat); a disc
  // that touches a pole covers every longitude.
  const latMin = cLat - r
  const latMax = cLat + r
  const rowMin = Math.max(0, Math.ceil((90 - latMax / DEG) * 60 - 0.5))
  const rowMax = Math.min(geo.H - 1, Math.floor((90 - latMin / DEG) * 60 - 0.5))
  const latEdge = Math.max(Math.abs(latMin), Math.abs(latMax))
  const lonHalf = r / Math.cos(Math.min(latEdge, Math.PI / 2 - 1e-6))
  let colMin
  let colMax
  if (lonHalf >= Math.PI) {
    colMin = 0
    colMax = geo.W - 1
  } else {
    colMin = Math.ceil(((cLon - lonHalf) / DEG + 180) * 60 - 0.5)
    colMax = Math.floor(((cLon + lonHalf) / DEG + 180) * 60 - 0.5)
  }

  let sum = 0
  let min = Infinity
  let max = -Infinity
  let count = 0
  for (let row = rowMin; row <= rowMax; row++) {
    const clat = trig.clat[row]
    const slat = trig.slat[row]
    const base = row * geo.W
    for (let colU = colMin; colU <= colMax; colU++) {
      const col = ((colU % geo.W) + geo.W) % geo.W
      // the pixel's scene direction: (cos·cos, sin, -cos·sin) — the minus on
      // z is the handedness convention, matching latLon/angDist (file header)
      const px = clat * trig.clon[col]
      const py = slat
      const pz = -clat * trig.slon[col]
      let inside = true
      for (let k = 0; k < sides; k++) {
        if (ex[k] * px + ey[k] * py + ez[k] * pz < -1e-9) {
          inside = false
          break
        }
      }
      if (!inside) continue
      const v = geo.data[base + col]
      sum += v
      if (v < min) min = v
      if (v > max) max = v
      count++
    }
  }
  return count ? { mean: sum / count, min, max, count } : null
}

export function buildEarth(frequency, dem, seed = 42) {
  const hex = getHexSphere(frequency)
  const trig = trigTables(dem)
  const els = new Array(hex.cellCount)
  for (let i = 0; i < hex.cellCount; i++) {
    const p = latLon(hex, i)
    const lat = p.lat / DEG
    const lon = p.lon / DEG
    const nx = p.x * 3.1
    const ny = p.y * 3.1
    const nz = p.z * 3.1
    const detail = fbm(nx, ny, nz, seed, 5)
    const rough = fbm(nx * 2.7, ny * 2.7, nz * 2.7, seed + 99, 4)

    // a cell that scans to zero pixels (degenerate) falls back to its center
    const st = hexDemStats(hex, i, dem, trig) || { mean: sampleAt(dem, lat, lon), min: 0, max: 0 }
    // meters; sea level = 0, the DEM's own convention
    const meanM = st.mean
    let hM, t, c
    if (meanM >= 0) {
      // land: the hex's peak gets half credit (real relief, no exaggeration)
      hM = 0.5 * (st.mean + st.max)
      const al = Math.abs(lat)
      // climate belts
      const dry = fbm(nx * 1.4 + 11, ny * 1.4, nz * 1.4, seed + 55, 3)
      let desert = 0
      for (const ds of DESERTS) {
        const dlat = (lat - ds.lat) / ds.rLat
        let dlon = ((lon - ds.lon + 540) % 360) - 180
        dlon /= ds.rLon
        const e = dlat * dlat + dlon * dlon
        if (e < 1.6) desert = Math.max(desert, 1 - e / 1.6)
      }
      desert = clamp(desert + (dry - 0.5) * 0.9, 0, 1)
      if (al < 13) c = mix('#2f6d2a', '#4a7d32', detail) // rainforest/jungle
      else if (al < 26) c = mix('#7d7a4a', '#a99a5e', detail) // savanna/steppe belt
      else if (al < 40) c = mix('#5d7a3e', '#7c8a4c', detail) // temperate
      else if (al < 55) c = mix('#4a6b3c', '#6d7f52', detail) // mixed forest
      else c = mix('#5b6f52', '#8a947f', rough) // boreal/tundra
      c = mix(c, '#d2b078', desert * 0.85)
      t = hM < 80 && al < 30 ? 'sand' : 'grass'
      // elevation modifiers on top of the belt color
      if (hM > 2800) c = mix(c, '#8d8d93', clamp((hM - 2800) / 2200, 0, 1) * 0.75) // rock
      // snowline falls with |lat|
      const snowline = 4600 - 42 * al
      if (hM >= snowline) {
        t = 'snow'
        c = mix('#e8eef4', '#b9c4cc', clamp((hM - snowline) / 3000, 0, 1) * 0.5)
      } else if (al > 66 + detail * 6) {
        t = 'snow'
        c = mix('#dde6ea', '#9fb2a8', detail)
      }
      // lakes (freshwater ellipses punched into land)
      for (const lk of LAKES) {
        const dlat = (lat - lk.lat) / lk.rLat
        let dl = ((lon - lk.lon + 540) % 360) - 180
        dl /= lk.rLon
        if (dlat * dlat + dl * dl < 1) {
          t = 'water'
          c = '#175fa0'
          break
        }
      }
    } else {
      // ocean: the hex's deepest point gets half credit (negative h = depth)
      hM = 0.5 * (st.mean + st.min)
      const depth = -hM
      c = mix('#2f8fc4', '#1c64a4', clamp(depth / 1500, 0, 1)) // shelf → slope
      c = mix(c, '#123f7c', clamp((depth - 1500) / 2500, 0, 1)) // slope → abyssal
      c = mix(c, '#0a2548', clamp((depth - 4000) / 3000, 0, 1)) // abyssal → hadal
      t = 'water'
      // sea ice (t stays 'water' — the stats count it as sea)
      const iceEdge = lat > 0 ? 74 - 6 * detail : 60 + 12 * detail
      if (Math.abs(lat) > iceEdge) c = mix('#dfeaf2', '#ffffff', detail)
    }
    els[i] = { t, h: (hM / 1000) * KM2U, c }
  }
  return els
}

// ---------------------------------------------------------------------------
// Mars
// ---------------------------------------------------------------------------

export function buildMars(frequency, seed = 303) {
  const hex = getHexSphere(frequency)
  const els = new Array(hex.cellCount)
  const M = MARS
  for (let i = 0; i < hex.cellCount; i++) {
    const p = latLon(hex, i)
    const lat = p.lat / DEG
    const lon = p.lon / DEG
    let h = 0
    // dichotomy + global texture
    h += lat < 0 ? M.dichotomy.southH * 0.5 : 0
    h += (fbm(p.x * 4, p.y * 4, p.z * 4, seed, 5) - 0.5) * 1.6
    // Tharsis bulge
    const db = angDist(p, M.bulge.lat * DEG, M.bulge.lon * DEG)
    if (db < M.bulge.r * DEG) h += M.bulge.h * Math.cos((db / (M.bulge.r * DEG)) * Math.PI * 0.5) ** 2
    // shield volcanoes
    for (const v of M.volca) {
      const d = angDist(p, v.lat * DEG, v.lon * DEG)
      if (d < v.r * DEG) {
        const s = 1 - d / (v.r * DEG)
        h += v.h * s * s * (0.85 + 0.3 * valueNoise(p.x * 30, p.y * 30, p.z * 30, seed + 3))
        if (s > 0.86) h -= v.h * 0.12 // summit caldera
      }
    }
    // Valles Marineris: elongated depression
    {
      const r = M.rift
      const dlat = (lat - r.lat) / r.rLat
      let dl = ((lon - r.lon + 540) % 360) - 180
      dl /= r.rLon
      const e = dlat * dlat + dl * dl
      if (e < 1.3) h += r.h * Math.max(0, 1 - e / 1.3)
    }
    // impacts
    for (const im of M.impact) {
      const d = angDist(p, im.lat * DEG, im.lon * DEG)
      const rr = im.r * DEG
      if (d < rr) {
        const s = d / rr
        h += im.h * Math.cos(s * Math.PI * 0.5) ** 2
        if (s > 0.82) h += im.rim * Math.exp(-((s - 0.9) ** 2) / 0.004)
      }
    }
    h += (fbm(p.x * 18, p.y * 18, p.z * 18, seed + 5, 3) - 0.5) * 0.35

    // polar caps
    let c = mix(M.colorDark, M.color, fbm(p.x * 7, p.y * 7, p.z * 7, seed + 2, 4))
    let t = 'dirt'
    const capN = (90 - lat) / M.polar.northR
    const capS = (lat + 90) / M.polar.southR
    if (Math.min(capN, capS) < 1 + (valueNoise(p.x * 9, p.y * 9, p.z * 9, seed) - 0.5) * 0.5) {
      h += M.polar.h
      t = 'snow'
      c = M.polar.c
    }
    // dark albedo features (Syrtis Major et al.)
    const dark = fbm(p.x * 2.2 + 40, p.y * 2.2, p.z * 2.2, seed + 31, 3)
    if (dark < 0.42) c = mix(c, '#5e3b2a', (0.42 - dark) * 1.6)
    if (h < 0.01) h = 0.01
    els[i] = { t, h: h * KM2U, c }
  }
  return els
}

// ---------------------------------------------------------------------------
// Moon
// ---------------------------------------------------------------------------

export function buildMoon(frequency, seed = 700) {
  const hex = getHexSphere(frequency)
  const els = new Array(hex.cellCount)
  const D = MOON
  for (let i = 0; i < hex.cellCount; i++) {
    const p = latLon(hex, i)
    const lat = p.lat / DEG
    const lon = p.lon / DEG
    // km, above the reference radius: far-side highlands ~+6, maria floor ~0
    let h = 3.2 + (fbm(p.x * 5, p.y * 5, p.z * 5, seed, 5) - 0.5) * 9
    let inMare = 0
    for (const m of D.maria) {
      const d = angDist(p, m.lat * DEG, m.lon * DEG)
      if (d < m.r * DEG) inMare = Math.max(inMare, 1 - d / (m.r * DEG))
    }
    if (inMare > 0) {
      h = h * (1 - smoothstep(inMare)) - 0.4 * smoothstep(inMare) // flooded basins
      h += (fbm(p.x * 14, p.y * 14, p.z * 14, seed + 8, 3) - 0.5) * 0.6
    }
    // crater field: ridged noise punched with circular basins
    const craters = 1 - Math.abs(fbm(p.x * 11, p.y * 11, p.z * 11, D.craterSeed, 4) * 2 - 1)
    h += craters * 1.8
    h += (valueNoise(p.x * 40, p.y * 40, p.z * 40, seed + 1) - 0.5) * 1.0
    let c = mix(D.colorHighland, D.color, clamp(fbm(p.x * 6, p.y * 6, p.z * 6, seed + 4, 4) * 1.2, 0, 1))
    c = mix(c, D.colorMaria, smoothstep(inMare) * 0.9)
    // polar bright spots
    if (Math.abs(lat) > 87) c = mix(c, '#e8e6e2', (Math.abs(lat) - 87) / 3)
    if (h < 0.01) h = 0.01
    els[i] = { t: 'rock', h: h * KM2U, c }
  }
  return els
}

// ---------------------------------------------------------------------------
// Mercury & Venus (simpler single-purpose builders)
// ---------------------------------------------------------------------------

export function buildMercury(frequency, seed = 101) {
  const hex = getHexSphere(frequency)
  const els = new Array(hex.cellCount)
  for (let i = 0; i < hex.cellCount; i++) {
    const p = latLon(hex, i)
    let h = (fbm(p.x * 5, p.y * 5, p.z * 5, seed, 5) - 0.45) * 2.4
    const craters = 1 - Math.abs(fbm(p.x * 12, p.y * 12, p.z * 12, 606, 4) * 2 - 1)
    h += craters * 0.3
    let c = mix(MERCURY.colorDark, MERCURY.color, fbm(p.x * 6, p.y * 6, p.z * 6, seed + 2, 4))
    const dCal = angDist(p, MERCURY.caloris.lat * DEG, MERCURY.caloris.lon * DEG)
    if (dCal < MERCURY.caloris.r * DEG) {
      const s = dCal / (MERCURY.caloris.r * DEG)
      h = h * (1 - smoothstep(1 - s * 1.4)) - 0.4 * (1 - s) // smooth lava floor
      c = mix(c, '#a09a92', (1 - s) * 0.7) // smooth bright plains
      if (s > 0.88 && s < 1) h += 0.9 * Math.exp(-((s - 0.94) ** 2) / 0.002)
    }
    if (h < 0.01) h = 0.01
    els[i] = { t: 'rock', h: h * KM2U, c }
  }
  return els
}

export function buildVenus(frequency, seed = 202) {
  const hex = getHexSphere(frequency)
  const els = new Array(hex.cellCount)
  for (let i = 0; i < hex.cellCount; i++) {
    const p = latLon(hex, i)
    let h = (fbm(p.x * 4, p.y * 4, p.z * 4, seed, 5) - 0.4) * 0.9
    for (const hl of VENUS.highlands) {
      const d = angDist(p, hl.lat * DEG, hl.lon * DEG)
      if (d < hl.r * DEG) h += hl.h * Math.cos((d / (hl.r * DEG)) * Math.PI * 0.5) ** 2
    }
    h += (fbm(p.x * 16, p.y * 16, p.z * 16, seed + 9, 3) - 0.5) * 0.2
    let c = mix('#c98f45', VENUS.color, fbm(p.x * 5, p.y * 5, p.z * 5, seed + 4, 4))
    if (h > 1.2) c = mix(c, VENUS.colorHigh, clamp((h - 1.2) / 2, 0, 1)) // highland "snow" (real: metal frost)
    if (h < 0.01) h = 0.01
    els[i] = { t: 'sand', h: h * KM2U, c }
  }
  return els
}

// ---------------------------------------------------------------------------
// Icy / volcanic moons & dwarf planets (palette-driven)
// ---------------------------------------------------------------------------

export function buildMoonByPalette(frequency, pal, seed = 500, opts = {}) {
  const hex = getHexSphere(frequency)
  const els = new Array(hex.cellCount)
  for (let i = 0; i < hex.cellCount; i++) {
    const p = latLon(hex, i)
    const lat = p.lat / DEG
    let h = (fbm(p.x * 4, p.y * 4, p.z * 4, seed, 5) - 0.45) * 1.4
    let c = mix(pal.c2, pal.c, clamp(fbm(p.x * 3.5, p.y * 3.5, p.z * 3.5, seed + 11, 4) * 1.3, 0, 1))

    if (pal.linea) {
      // Europa: reddish ridged crack bands
      const w = Math.sin(p.x * 22 + fbm(p.x * 4, p.y * 4, p.z * 4, seed + 21, 3) * 6) +
        Math.sin(p.y * 17 - p.z * 19 + fbm(p.z * 5, p.x * 5, p.y * 5, seed + 31, 3) * 5)
      if (Math.abs(w) < 0.28) c = mix(c, pal.c2, 1 - Math.abs(w) / 0.28)
    }
    if (pal.spots) {
      // Io: dark volcanic pits + orange patches
      const s = fbm(p.x * 8, p.y * 8, p.z * 8, seed + 13, 4)
      if (s > 0.62) c = mix(c, '#7a2d16', (s - 0.62) / 0.38)
      const s2 = fbm(p.x * 5 + 30, p.y * 5, p.z * 5, seed + 41, 3)
      if (s2 > 0.6) c = mix(c, '#e8a13a', (s2 - 0.6) / 0.4)
      h += (s - 0.5) * 2.5
    }
    if (pal.grooves) {
      const g = Math.sin(p.y * 30 + fbm(p.x * 5, p.y * 5, p.z * 5, seed + 51, 3) * 7)
      if (g > 0.55) c = mix(c, pal.c2, (g - 0.55) / 0.45) // bright grooved terrain
      else c = mix(c, '#6b6156', 0.35)
    }
    if (pal.craters) {
      const cr = 1 - Math.abs(fbm(p.x * 12, p.y * 12, p.z * 12, seed + 61, 4) * 2 - 1)
      h += cr * 0.3 * pal.craters
      if (cr > 0.8) c = mix(c, pal.c2, (cr - 0.8) / 0.2) // fresh ejecta
    }
    if (pal.dunes) {
      const d = Math.sin(p.y * 26 + p.x * 6 + fbm(p.x * 3, p.y * 3, p.z * 3, seed + 71, 3) * 8)
      if (d > 0.4) c = mix(c, pal.c2, (d - 0.4) / 0.6 * 0.8)
    }
    if (pal.tiger) {
      const t = Math.sin(p.lat ? lat * 0 : 0 + p.x * 8 + p.z * 6)
      if (Math.abs(p.y + 0.02 * t) < 0.09) c = mix(c, '#a8d4ea', 0.7) // south polar stripes
    }
    if (opts.polarCaps) {
      if (Math.abs(lat) > 72) c = mix(c, '#eef4f8', (Math.abs(lat) - 72) / 18)
    }
    if (opts.redPole) {
      // Iapetus-style: one hemisphere dark (leading side, crude)
      const side = p.x * Math.cos(0.4) + p.z * Math.sin(0.4)
      if (side < -0.15) c = mix(c, '#3a332c', clamp(-side, 0, 1) * 1.1)
    }
    if (opts.iceCaps) {
      if (Math.abs(lat) > 60) {
        c = mix(c, '#f0f4f6', (Math.abs(lat) - 60) / 30)
        h += 0.6 * Math.max(0, (Math.abs(lat) - 60) / 30)
      }
    }
    if (h < 0.01) h = 0.01
    els[i] = { t: pal.t || 'snow', h: h * KM2U, c }
  }
  return els
}

// ---------------------------------------------------------------------------
// Small bodies: asteroids & comets — chunky potatoes with real relative
// relief (a rubble pile is ~10-20% lumpy at ANY absolute scale).
// ---------------------------------------------------------------------------

export function buildPotato(frequency, { seed = 1, color = '#6f665c', lumpiness = 0.14, craters = 0.5, elongate = 0, scale = 1 } = {}) {
  const hex = getHexSphere(frequency)
  const els = new Array(hex.cellCount)
  for (let i = 0; i < hex.cellCount; i++) {
    const p = latLon(hex, i)
    let shape =
      fbm(p.x * 2.4, p.y * 2.4, p.z * 2.4, seed, 4) - 0.4 +
      0.5 * (fbm(p.x * 5, p.y * 5, p.z * 5, seed + 2, 3) - 0.5)
    if (elongate) shape += elongate * Math.abs(p.x)
    // relief is absolute engine units measured against the SCALED radius
    // (geometry and planetVolume treat h as absolute), so fraction the GRID
    // radius only when scale = 1; tiny escape-hatch bodies scale it too.
    const R = radiusForFrequency(frequency) * scale
    let h = shape * lumpiness * R
    if (craters > 0) {
      const cr = 1 - Math.abs(fbm(p.x * 9, p.y * 9, p.z * 9, seed + 7, 3) * 2 - 1)
      h -= cr * craters * 0.22 * R
    }
    const tint = (fbm(p.x * 8, p.y * 8, p.z * 8, seed + 4, 2) - 0.5) * 22
    const rgb = (s) => parseInt(s.slice(1), 16)
    const v = rgb(color)
    const c =
      '#' +
      [ (v >> 16) + tint, ((v >> 8) & 255) + tint, (v & 255) + tint ]
        .map((x) => clamp(Math.round(x), 0, 255).toString(16).padStart(2, '0'))
        .join('')
    els[i] = { t: 'rock', h, c }
  }
  return els
}
