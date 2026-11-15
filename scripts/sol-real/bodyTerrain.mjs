/**
 * bodyTerrain.mjs — the per-body terrain source of the Sol Real world.
 * ---------------------------------------------------------------------------
 * The SINGLE source of truth for "which builder built this body, with what
 * parameters." Both consumers resolve a body through `terrainFor`:
 *
 *   • gen-sol-real.mjs — builds the DOCUMENT (the bounded geodesic grid in
 *     `atoms`) through elementsFromHexFn(tf, frequency);
 *   • import-hexcells.mjs — evaluates the SAME bound per-hex fn on the fine
 *     latitude-row grid (core/hexlattice.js) for the STORED high-res hexes.
 *
 * One function, two grids: the document and the stored high-res agree by
 * construction (no resampling, no drift). Earth is the only DEM-sourced body:
 * its terrain lives in the ETOPO2022 60s catalog, so it resolves to a special
 * `{ kind: 'earth' }` that each consumer handles with its own DEM path.
 *
 * The per-body parameters (palette, lumpiness, craters, elongate) are derived
 * here from the body's identity (name / kind / parent) + the seed tables
 * (moons.json / orbits.json) — exactly the values gen-sol-real.mjs used when
 * it built the document, so the stored hexes reproduce the document's surface
 * at the fine grid.
 */

import { MOON_PALETTES, NAMED_COLORS, TAXA, DWARFS } from './features.js'
import { marsHex, moonHex, mercuryHex, venusHex, moonPaletteHex, potatoHex } from './terrain.js'
import { radiusForFrequency, MAX_FREQUENCY } from '../../src/core/planetMath.js'

// km → engine units — the SAME constant gen-sol-real.mjs / terrain.js use
// (the freq-203 grid radius spans exactly one Earth radius), so a body's
// stored (frequency, scale) recovers its diameter in km: rKm = rU / KM2U.
const KM2U = radiusForFrequency(MAX_FREQUENCY) / 6371.009

/** deterministic hash in [0,1) from a string — stable node/peri/M0/color spread */
export function hash01(str, salt = 0) {
  let h = Math.imul(salt + 2654435761, 1) ^ str.length
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 1597334677)
  h ^= h >>> 15
  h = Math.imul(h, 2246822519)
  h ^= h >>> 13
  return ((h >>> 0) % 1000000) / 1000000
}

/** The named moons and their palettes (the rest of a moon's family is a
 * potato in the parent's family palette). */
export const MOON_TERRAIN = {
  Moon: { pal: null }, // built by the real-maria builder (special-cased in terrainFor)
  Io: { pal: MOON_PALETTES.io },
  Europa: { pal: MOON_PALETTES.europa },
  Ganymede: { pal: MOON_PALETTES.ganymede },
  Callisto: { pal: MOON_PALETTES.callisto },
  Titan: { pal: MOON_PALETTES.titan },
  Rhea: { pal: MOON_PALETTES.rhea },
  Iapetus: { pal: MOON_PALETTES.iapetus, opts: { redPole: true } },
  Dione: { pal: MOON_PALETTES.dione },
  Tethys: { pal: MOON_PALETTES.tethys },
  Enceladus: { pal: MOON_PALETTES.enceladus },
  Mimas: { pal: MOON_PALETTES.mimas },
  Phoebe: { pal: MOON_PALETTES.phoebe, cap: 10 },
  Titania: { pal: MOON_PALETTES.uranusMoon },
  Oberon: { pal: MOON_PALETTES.uranusMoon },
  Umbriel: { pal: { c: '#7e8286', c2: '#565a5e', t: 'snow' } },
  Ariel: { pal: { c: '#c3c8cc', c2: '#8b9094', t: 'snow' } },
  Miranda: { pal: { c: '#a9aeb2', c2: '#767b7f', t: 'snow' }, cap: 12 },
  Triton: { pal: MOON_PALETTES.triton },
  Charon: { pal: MOON_PALETTES.charon },
}

/** Unnamed moons take a potato in their parent's family palette. */
export const PARENT_FAMILY = {
  Jupiter: MOON_PALETTES.jupiterMoon,
  Saturn: MOON_PALETTES.saturnMoon,
  Uranus: MOON_PALETTES.uranusMoon,
  Neptune: MOON_PALETTES.neptuneMoon,
  Mars: MOON_PALETTES.marsMoon,
  Pluto: MOON_PALETTES.saturnMoon,
  Haumea: MOON_PALETTES.neptuneMoon,
  Orcus: MOON_PALETTES.saturnMoon,
  Quaoar: MOON_PALETTES.saturnMoon,
  Salacia: MOON_PALETTES.saturnMoon,
  Eris: MOON_PALETTES.neptuneMoon,
}

/** Real asteroid colors by SBDX class / name (the doc's per-cell tint base). */
export function asteroidColor(name, sbClass, aAU) {
  const lower = name.toLowerCase()
  for (const [k, c] of Object.entries(NAMED_COLORS)) if (lower.includes(k)) return c
  if (sbClass) {
    if (/centaur|transneptun|scattered|detached/i.test(sbClass)) return hash01(name, 3) < 0.5 ? TAXA.D : TAXA.P
    if (/trojan/i.test(sbClass)) return TAXA.D
    if (/apollo|amor|aten|arjuna|phocaea/i.test(sbClass)) return hash01(name, 4) < 0.7 ? TAXA.S : TAXA.C
  }
  if (aAU != null && aAU > 3.3) return TAXA.C
  return hash01(name, 5) < 0.7 ? TAXA.C : TAXA.S
}

const hexTf = (fn, unit, keys) => ({ kind: 'hex', fn, unit, keys })

/**
 * Resolve a body's terrain source.
 *
 * @param {object} body  { name, kind, parent, seed, frequency, scale }
 *   name      the body's document name
 *   kind      'star' | 'planet' | 'dwarf' | 'moon' | 'asteroid' | 'comet'
 *   parent    the parent body's NAME (moons), or null
 *   seed      the stored seed (the doc's — the same value the document used)
 *   frequency the DOCUMENT frequency (the potato relief radius reference)
 *   scale     the stored size factor (potato bodies: relief × this radius)
 * @param {object} tables  { small: Map<name, orbits.json entry> } — needed for
 *   asteroid/comet color + lumpiness (diameterKm, sbClass, orbit.a)
 * @returns {{kind:'earth'} | {kind:'hex', fn:(dir,latDeg,lonDeg)=>{t,c,h},
 *          unit:'km'|'u', keys:string[]}}
 *   `fn` returns { t, c, h }: h in KM (unit 'km', × KM2U for the document /
 *   × 1000 / world.scale for the stored hexes) or in ENGINE UNITS (unit 'u',
 *   as-is — the potato builder). `keys` = the material keys the fn can emit
 *   (the hexcells importer pre-flights them against the materials table).
 */
export function terrainFor(body, tables = {}) {
  switch (body.name) {
    case 'Earth':
      // the only DEM-sourced body — its relief lives in the ETOPO2022 60s
      // catalog; each consumer runs its own DEM path (document: buildEarth,
      // stored hexes: the identity 1.85 km sample + earthHex colors)
      return { kind: 'earth', keys: ['grass', 'sand', 'snow', 'water', 'rock'] }
    case 'Mars':
      return hexTf((d, la, lo) => marsHex(d, la, lo, body.seed), 'km', ['dirt', 'snow'])
    case 'Moon':
      return hexTf((d, la, lo) => moonHex(d, la, lo, body.seed), 'km', ['rock'])
    case 'Mercury':
      return hexTf((d, la, lo) => mercuryHex(d, la, lo, body.seed), 'km', ['rock'])
    case 'Venus':
      return hexTf((d, la, lo) => venusHex(d, la, lo, body.seed), 'km', ['sand'])
    case 'Pluto':
      return hexTf(
        (d, la, lo) => moonPaletteHex(d, la, lo, { c: '#cfc2b0', c2: '#8a7d6e', t: 'ice' }, body.seed, { iceCaps: true }),
        'km',
        ['ice']
      )
  }
  if (body.kind === 'dwarf') {
    const d = DWARFS.find((x) => x.name === body.name)
    if (!d) throw new Error(`terrainFor: unknown dwarf "${body.name}" (not in features.js DWARFS)`)
    let pal
    if (d.taxon === 'ice') pal = { c: '#d8d6d2', c2: '#8f9498', t: 'snow' }
    else if (d.taxon === 'red') pal = { c: '#c98a5e', c2: '#8f5a36', t: 'ice' }
    else pal = { c: '#a5a096', c2: '#706b62', t: 'rock', craters: 0.6 }
    return hexTf((d2, la, lo) => moonPaletteHex(d2, la, lo, pal, body.seed, { polarCaps: d.taxon === 'ice' }), 'km', [pal.t])
  }
  if (body.kind === 'moon') {
    const named = MOON_TERRAIN[body.name]
    if (named)
      return hexTf(
        (d, la, lo) => moonPaletteHex(d, la, lo, named.pal, body.seed, named.opts || { craters: 0.35 }),
        'km',
        [named.pal.t || 'snow']
      )
    // unnamed moon: a potato in the parent's family palette
    const pal = PARENT_FAMILY[body.parent] || MOON_PALETTES.saturnMoon
    const R = radiusForFrequency(body.frequency) * body.scale
    return hexTf((d) => potatoHex(d, R, { seed: body.seed, color: pal.c, lumpiness: 0.16, craters: 0.5 }), 'u', ['rock'])
  }
  if (body.kind === 'asteroid' || body.kind === 'comet') {
    const o = tables.small ? tables.small.get(body.name) : undefined
    const color =
      body.kind === 'comet' ? '#3f3a36' : asteroidColor(body.name, o ? o.sbClass : undefined, o && o.orbit ? o.orbit.a : undefined)
    // The lumpiness/craters BAND is banded by the body's DIAMETER. The exact
    // value is the body's STORED diameter_km (migration 012) — the same value
    // gen-sol-real.mjs used when it built the document, so the hexcells importer
    // (which reads bodies.diameter_km) rebuilds the document's band with no seed
    // table and no drift. sizeGrid maps a diameter onto (frequency, scale)
    // LOSSILY (scale = 1 leaves the true radius within 12 % of the grid radius),
    // so (frequency, scale) alone cannot recover the 200 / 300 km thresholds —
    // the stored diameter is authoritative. The (frequency, scale) derivation is
    // only a fallback for bodies imported without it.
    const rU = radiusForFrequency(body.frequency) * body.scale
    const diamKm = Number.isFinite(body.diameterKm) && body.diameterKm > 0 ? body.diameterKm : (2 * rU) / KM2U
    return hexTf(
      (d) =>
        potatoHex(d, rU, {
          seed: body.seed,
          color,
          lumpiness: body.kind === 'comet' ? 0.2 : diamKm >= 300 ? 0.07 : 0.15,
          craters: body.kind === 'comet' ? 0.25 : diamKm >= 200 ? 0.7 : 0.4,
          elongate: hash01(body.name, 12) < 0.25 ? 0.35 : 0,
        }),
      'u',
      ['rock']
    )
  }
  throw new Error(`terrainFor: no terrain source for ${body.kind} body "${body.name}"`)
}
