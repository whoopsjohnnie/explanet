/**
 * Sol Real / terrain — hex element builders with real geography.
 *
 * Every builder returns a plain elements array [{ t, h, c }] for a given
 * frequency, in ENGINE units (h is absolute). Heights come from real figures
 * (km × KM2U), so Everest is 8.849 km when you walk up it and nothing is
 * exaggerated. Colors ride per-cell `c`, so one planet paints continents,
 * maria, rust and sulfur without a material system.
 *
 * Sphere convention (matches hexsphere cell centers):
 *   y = sin(lat);  lon = atan2(z, x)  (degrees in tables, radians here)
 */

import { getHexSphere } from '../../src/core/hexsphere.js'
import { valueNoise, fbm } from '../../src/core/generators.js'
import { radiusForFrequency, MAX_FREQUENCY } from '../../src/core/planetMath.js'
import { MOUNTAINS, PEAKS, DESERTS, LAKES, MARS, MOON, MERCURY, VENUS, MOON_PALETTES } from './features.js'

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
  return { lat: Math.asin(clamp(y / n, -1, 1)), lon: Math.atan2(z / n, x / n), x: x / n, y: y / n, z: z / n }
}

/** Angular distance (radians) between a cell vector and a lat/lon point. */
function angDist(v, latR, lonR) {
  const d = v.x * Math.cos(latR) * Math.cos(lonR) + v.y * Math.sin(latR) + v.z * Math.cos(latR) * Math.sin(lonR)
  return Math.acos(clamp(d, -1, 1))
}

/** Great-circle corridor: min angular distance (rad) to the polyline. */
function corridorDist(v, pts) {
  let best = Infinity
  for (let s = 0; s < pts.length - 1; s++) {
    const [la1, lo1] = pts[s]
    const [la2, lo2] = pts[s + 1]
    const d = segmentDist(v, la1 * DEG, lo1 * DEG, la2 * DEG, lo2 * DEG)
    if (d < best) best = d
  }
  return best
}

function segmentDist(v, aLat, aLon, bLat, bLon) {
  // sample the segment densely enough for widths ≥ ~1° (fine at deg scale)
  let best = Infinity
  const n = 8
  for (let k = 0; k <= n; k++) {
    const t = k / n
    const la = lerp(aLat, bLat, t)
    const lo = lerp(aLon, bLon, t)
    const d = angDist(v, la, lo)
    if (d < best) best = d
  }
  return best
}

// ---------------------------------------------------------------------------
// Land/ocean mask from world-atlas TopoJSON (coastlines, 1:50m)
// ---------------------------------------------------------------------------

/** Decode all land rings (stitching arcs, honoring negative refs). */
export function landRings(topo) {
  const { scale, translate } = topo.transform
  const ptsOfArc = (idx) => {
    const rev = idx < 0
    const arc = topo.arcs[rev ? ~idx : idx]
    const out = []
    let x = 0
    let y = 0
    for (const [dx, dy] of arc) {
      x += dx
      y += dy
      out.push([x * scale[0] + translate[0], y * scale[1] + translate[1]])
    }
    return rev ? out.reverse() : out
  }
  const rings = []
  for (const g of topo.objects.land.geometries) {
    // Polygon.arcs = [ring,…]; MultiPolygon.arcs = [polygon,…]; ring = [arcIdx,…]
    const polys = g.type === 'MultiPolygon' ? g.arcs : [g.arcs]
    for (const poly of polys) {
      for (const ringIdx of poly) {
        let ring = []
        for (const idx of ringIdx) ring = ring.concat(ptsOfArc(idx))
        if (ring.length > 2) rings.push(ring)
      }
    }
  }
  return rings
}

/**
 * Rasterize rings to a lon/lat grid via even-odd scanline fill.
 * Grid: GW × GH, cell (ix, iy) covers lon −180 + (ix+0.5)·dlon,
 * lat −90 + (iy+0.5)·dlat. Returns Uint8Array (1 = land).
 */
export function rasterLandMask(rings, dlonDeg = 0.2) {
  const dlat = dlonDeg
  const GW = Math.round(360 / dlonDeg)
  const GH = Math.round(180 / dlat)
  const grid = new Uint8Array(GW * GH)
  // bucket edges by starting row: (xAtTop, dxPerRow, y1row)
  const buckets = new Array(GH)
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i]
      const [x2, y2] = ring[(i + 1) % ring.length]
      if (y1 === y2) continue
      const lo = Math.min(y1, y2)
      const hi = Math.max(y1, y2)
      let r0 = Math.max(0, Math.ceil((lo + 90) / dlat - 0.5))
      const r1 = Math.min(GH - 1, Math.floor((hi + 90) / dlat - 0.5))
      const slope = (x2 - x1) / (y2 - y1)
      for (let r = r0; r <= r1; r++) {
        const yRow = -90 + (r + 0.5) * dlat
        if (yRow < lo || yRow > hi) continue
        const xAt = x1 + (yRow - y1) * slope
        ;(buckets[r] || (buckets[r] = [])).push(xAt)
      }
    }
  }
  for (let r = 0; r < GH; r++) {
    const xs = buckets[r]
    if (!xs || xs.length < 2) continue
    xs.sort((a, b) => a - b)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let ix0 = Math.round((xs[k] + 180) / dlonDeg - 0.5)
      const ix1 = Math.round((xs[k + 1] + 180) / dlonDeg - 0.5)
      // fill spans (clamped; rings are cut at ±180 so no wrap merge needed)
      for (let ix = Math.max(0, ix0); ix <= Math.min(GW - 1, ix1); ix++) grid[r * GW + ix] = 1
    }
  }
  return { grid, GW, GH, dlat, dlon: dlonDeg }
}

/** Separable box blur ×k on a Uint8 grid → Float32 0..1. */
function blurMask(mask, passes = 3, radius = 3) {
  const { grid, GW, GH } = mask
  let src = new Float32Array(GW * GH)
  for (let i = 0; i < grid.length; i++) src[i] = grid[i]
  let dst = new Float32Array(GW * GH)
  for (let p = 0; p < passes; p++) {
    // horizontal (wrap longitude, clamp latitude)
    for (let y = 0; y < GH; y++) {
      let acc = 0
      const row = y * GW
      for (let x = -radius; x <= radius; x++) acc += src[row + ((x % GW) + GW) % GW]
      for (let x = 0; x < GW; x++) {
        dst[row + x] = acc / (2 * radius + 1)
        acc -= src[row + ((x - radius) % GW + GW) % GW]
        acc += src[row + ((x + radius + 1) % GW + GW) % GW]
      }
    }
    ;[src, dst] = [dst, src]
    // vertical
    for (let x = 0; x < GW; x++) {
      let acc = 0
      for (let y = -radius; y <= radius; y++) acc += src[clamp(y, 0, GH - 1) * GW + x]
      for (let y = 0; y < GH; y++) {
        dst[y * GW + x] = acc / (2 * radius + 1)
        acc -= src[clamp(y - radius, 0, GH - 1) * GW + x]
        acc += src[clamp(y + radius + 1, 0, GH - 1) * GW + x]
      }
    }
    ;[src, dst] = [dst, src]
  }
  return src
}

function maskSample(blur, GW, GH, latDeg, lonDeg) {
  const fx = (lonDeg + 180) / (360 / GW) - 0.5
  const fy = (latDeg + 90) / (180 / GH) - 0.5
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  const at = (x, y) => blur[clamp(y, 0, GH - 1) * GW + (((x % GW) + GW) % GW)]
  return lerp(lerp(at(x0, y0), at(x0 + 1, y0), tx), lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), tx), ty)
}

// ---------------------------------------------------------------------------
// Earth
// ---------------------------------------------------------------------------

export function buildEarth(frequency, mask, seed = 42) {
  const hex = getHexSphere(frequency)
  const blur = blurMask(mask, 4, 4)
  const { GW, GH } = mask
  const els = new Array(hex.cellCount)
  for (let i = 0; i < hex.cellCount; i++) {
    const p = latLon(hex, i)
    const lat = p.lat / DEG
    const lon = p.lon / DEG
    const landness = maskSample(blur, GW, GH, lat, lon)
    const nx = p.x * 3.1
    const ny = p.y * 3.1
    const nz = p.z * 3.1
    const detail = fbm(nx, ny, nz, seed, 5)
    const rough = fbm(nx * 2.7, ny * 2.7, nz * 2.7, seed + 99, 4)

    // --- mountain systems ---
    let ridge = 0
    for (const m of MOUNTAINS) {
      const d = corridorDist(p, m.pts) // rad
      const w = m.w * DEG
      if (d < w * 2.2) {
        const prof = Math.max(0, 1 - d / (w * 2.2))
        const ridged = 1 - Math.abs(fbm(p.x * 6, p.y * 6, p.z * 6, seed + 7, 4) * 2 - 1)
        ridge = Math.max(ridge, m.h * prof * (0.55 + 0.75 * ridged))
      }
    }
    let h, t, c // named peaks are stamped after the normalization pass
    if (landness < 0.5) {
      // ocean: latitude-tinted blue, shallow brightening near coast
      const shelf = smoothstep(landness * 2) // 0..1 within ocean side
      const warm = Math.max(0, 1 - Math.abs(lat) / 30)
      const cold = Math.max(0, (Math.abs(lat) - 45) / 45)
      c = mix('#0c4a8a', '#1668b4', warm * 0.8)
      c = mix(c, '#072a55', cold * 0.7)
      c = mix(c, '#2f86c9', shelf * 0.35)
      // sea ice
      const iceEdge = lat > 0 ? 74 - 6 * detail : 60 + 12 * detail
      if (Math.abs(lat) > iceEdge) {
        t = 'snow'
        c = mix('#dfeaf2', '#ffffff', detail)
      } else {
        t = 'water'
      }
      h = 0
    } else {
      // land: base relief from the continent mask, ridges on top; a summit
      // sets the ABSOLUTE height (its table value is above sea level), it
      // never stacks on top of the corridor ridge
      const base = 0.18 + 0.85 * smoothstep((landness - 0.5) * 2)
      let elev = base * (0.7 + 0.6 * detail) + ridge + (rough - 0.5) * 0.18
      if (elev < 0.02) elev = 0.02
      h = elev

      // snowline: falls with |lat|
      const snowline = 4.6 - Math.abs(lat) * 0.042
      if (elev > snowline + (rough - 0.5) * 0.3) {
        t = 'snow'
        c = mix('#e8eef4', '#b9c4cc', clamp((elev - snowline) / 3, 0, 1) * 0.5)
      } else if (Math.abs(lat) > 66 + detail * 6) {
        t = 'snow'
        c = mix('#dde6ea', '#9fb2a8', detail)
      } else {
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
        const al = Math.abs(lat)
        if (al < 13) c = mix('#2f6d2a', '#4a7d32', detail) // rainforest/jungle
        else if (al < 26) c = mix('#7d7a4a', '#a99a5e', detail) // savanna/steppe belt
        else if (al < 40) c = mix('#5d7a3e', '#7c8a4c', detail) // temperate
        else if (al < 55) c = mix('#4a6b3c', '#6d7f52', detail) // mixed forest
        else c = mix('#5b6f52', '#8a947f', rough) // boreal/tundra
        c = mix(c, '#d2b078', desert * 0.85)
        // lakes (freshwater ellipses punched into land)
        for (const lk of LAKES) {
          if (lk.name === 'dummy-skip') continue
          const dlat = (lat - lk.lat) / lk.rLat
          let dl = ((lon - lk.lon + 540) % 360) - 180
          dl /= lk.rLon
          if (dlat * dlat + dl * dl < 1) {
            t = 'water'
            c = '#175fa0'
            h = Math.max(0.01, elev + (lk.level || 0))
            break
          }
        }
        if (t !== 'water') t = elev < 0.08 && al < 30 ? 'sand' : 'grass'
      }
    }
    els[i] = { t, h, c } // km; scaled to engine units after the pass below
  }
  // True scale, enforced: overlapping corridors can stack past the real
  // ceiling at knots (Pamir, Tibet), so rescale the whole landmass so the
  // tallest pre-summit ground sits under the summit table (8.849 km), then
  // stamp the named peaks. Everest is exactly Everest, no stacking.
  let landMax = 0
  for (const el of els) if (el.h > landMax) landMax = el.h
  const k = landMax > 7.4 ? 7.4 / landMax : 1
  for (const el of els) {
    if (el.h <= 0) { el.h = 0; continue }
    el.h = Math.max(0.02, el.h * k) * KM2U
  }
  // named peaks: absolute km, stamped over the rescaled range
  for (const pk of PEAKS) {
    const w = pk.w * DEG
    for (let i = 0; i < hex.cellCount; i++) {
      if (!els[i] || els[i].h <= 0 || (els[i].t !== 'grass' && els[i].t !== 'sand' && els[i].t !== 'snow')) continue
      const p = latLon(hex, i)
      const d = angDist(p, pk.lat * DEG, pk.lon * DEG)
      if (d > w * 3) continue
      // flat top within w (the true summit is sub-hex), quadratic fade outside
      const prof = d < w ? 1 : Math.max(0, 1 - ((d - w) / (2 * w)) ** 2)
      const want = pk.h * prof
      if (want * KM2U > els[i].h) {
        els[i].h = want * KM2U
        if (want > 6.5) { els[i].t = 'snow'; els[i].c = mix('#e8eef4', '#b9c4cc', clamp((want - 6.5) / 2.3, 0, 1) * 0.6) }
      }
    }
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
