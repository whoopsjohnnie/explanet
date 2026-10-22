/**
 * atmospheres.js
 * ---------------------------------------------------------------------------
 * Catalog of the REAL Solar System atmospheres, shared by the starter world
 * (core/starter.js) and the Sol Real generator (scripts/gen-sol-real.mjs) so
 * both worlds agree on which bodies have air and what it looks like.
 *
 * Authored in human units; atmosphereFor() converts the heights to the
 * document form (multiples of the body radius, see worldSchema.js):
 *
 *   topKm        where the atmosphere effectively ends (exobase-ish height)
 *   heightKm     density scale height H = kT/mg — the "thickness" of the
 *                dense lower layer; sky pressure falls as e^(−z/H)
 *   pressure     surface pressure in atm (gas giants: at the 1-bar cloud deck)
 *   opacity      0..1 visual density of the sky (1 = fully opaque, Venus)
 *   colors       zenith / horizon / sun-glow tints for the walk-mode sky
 *
 * Bodies NOT listed (Moon, Mercury, Io…) have exospheres so thin they render
 * as vacuum — correctly: black sky, sunlit dark surface.
 */

export const SOL_ATMOSPHERES = {
  Earth:   { topKm: 600, heightKm: 8.5,  pressure: 1.013,  opacity: 0.62, zenith: '#2f63b4', horizon: '#b3cde8', glow: '#ffd9a0' },
  Venus:   { topKm: 250, heightKm: 15.9, pressure: 92,     opacity: 1.0,  zenith: '#b99f60', horizon: '#e2cf96', glow: '#fff0c0' },
  Mars:    { topKm: 160, heightKm: 11.1, pressure: 0.0064, opacity: 0.3,  zenith: '#a9825e', horizon: '#d9b58c', glow: '#ffd2a8' },
  Jupiter: { topKm: 800, heightKm: 27,   pressure: 1,      opacity: 0.75, zenith: '#93aec2', horizon: '#e8d9b8', glow: '#fff3d0' },
  Saturn:  { topKm: 800, heightKm: 59.5, pressure: 1,      opacity: 0.75, zenith: '#b3a271', horizon: '#ead9ae', glow: '#fff3cf' },
  Uranus:  { topKm: 900, heightKm: 27,   pressure: 1,      opacity: 0.7,  zenith: '#63a4b6', horizon: '#cfe8ea', glow: '#eaffff' },
  Neptune: { topKm: 900, heightKm: 20,   pressure: 1,      opacity: 0.7,  zenith: '#3a68bc', horizon: '#9fc0e8', glow: '#dceaff' },
  Titan:   { topKm: 480, heightKm: 17,   pressure: 1.45,   opacity: 1.0,  zenith: '#77522a', horizon: '#d99a4e', glow: '#ffd9a0' },
  Triton:  { topKm: 195, heightKm: 15,   pressure: 0.000014, opacity: 0.08, zenith: '#b8a0b0', horizon: '#d8c0c8', glow: '#ffe8f0' },
  Pluto:   { topKm: 300, heightKm: 55,   pressure: 0.00001, opacity: 0.1, zenith: '#a8b8c8', horizon: '#ccd8e4', glow: '#dfe8f0' },
}

/**
 * The document `atmosphere` descriptor for a body, or null when the catalog
 * has no atmosphere for that name. radiusKm is the body's true mean radius —
 * heights become multiples of it, matching the rings descriptor convention.
 */
export function atmosphereFor(name, radiusKm) {
  const a = SOL_ATMOSPHERES[name]
  if (!a || !(radiusKm > 0)) return null
  return {
    top: a.topKm / radiusKm,
    scaleHeight: a.heightKm / radiusKm,
    pressure: a.pressure,
    opacity: a.opacity,
    zenith: a.zenith,
    horizon: a.horizon,
    glow: a.glow,
  }
}
