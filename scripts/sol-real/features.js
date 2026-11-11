/**
 * Sol Real / features — real-world geographic and physical reference tables.
 *
 * Everything here is degrees / km / real units; the generators apply them to
 * hex cells through the shared lat/lon convention (lat = asin(y), lon =
 * atan2(-z, x) on the unit vector of a cell center — the minus is the
 * handedness that keeps the globe un-mirrored; see terrain.js).
 */



// Deserts as lat/lon ellipses (color hint on top of the climate model).
export const DESERTS = [
  { lat: 23.5, lon: 12.0, rLat: 10, rLon: 22, c: '#d8b26a' }, // Sahara
  { lat: 24.0, lon: 54.0, rLat: 7, rLon: 14, c: '#d9b877' }, // Arabian
  { lat: 28.0, lon: 68.0, rLat: 6, rLon: 8, c: '#d3b06d' }, // Thar
  { lat: -25.0, lon: 131.0, rLat: 9, rLon: 16, c: '#cf9f66' }, // Australian
  { lat: -24.0, lon: -69.0, rLat: 8, rLon: 6, c: '#caa06a' }, // Atacaca-ish / Monte
  { lat: 42.5, lon: 103.5, rLat: 6, rLon: 14, c: '#cbb382' }, // Gobi
  { lat: 39.5, lon: -111.5, rLat: 5, rLon: 9, c: '#c8a878' }, // Great Basin
  { lat: -23.0, lon: 17.5, rLat: 6, rLon: 6, c: '#d2ac74' }, // Namib/Kalahari
]

// Earth's great lakes as water-color ellipses stamped over LAND cells
// (the Caspian is below sea level in the ETOPO DEM, so it reads as ocean
// automatically and needs no stamp).
export const LAKES = [
  { lat: 1.2, lon: 33.0, rLat: 1.6, rLon: 1.4 }, // Victoria
  { lat: 45.5, lon: -83.0, rLat: 3.2, rLon: 3.6 }, // Great Lakes
]

// ---------------------------------------------------------------------------
// Mars
// ---------------------------------------------------------------------------
export const MARS = {
  // hemispheric dichotomy: south highlands, north low plains (boundary ~lat +2)
  dichotomy: { southH: 2.6, northH: -0.6 },
  volca: [
    { name: 'olympus', lat: 18.65, lon: -133.8, h: 21.2, r: 14 }, // edifice radius deg
    { name: 'ascraeus', lat: 20.0, lon: -119.6, h: 9.4, r: 7 },
    { name: 'pavonis', lat: 1.0, lon: -113.5, h: 6.0, r: 6 },
    { name: 'arsia', lat: -8.3, lon: -121.6, h: 11.3, r: 8 },
  ],
  // Tharsis bulge under the volcanoes
  bulge: { lat: 2.0, lon: -118.0, h: 7.0, r: 32 },
  rift: { name: 'valles', lat: -10.5, lon: -59.2, h: -6.0, rLat: 4.5, rLon: 24 }, // Valles Marineris
  impact: [
    { name: 'hellas', lat: -42.4, lon: 70.5, h: -8.0, r: 21, rim: 3.5 }, // Hellas basin
    { name: 'argyre', lat: -49.7, lon: -43.5, h: -4.5, r: 18, rim: 2.2 },
    { name: 'isidis', lat: 12.9, lon: 87.5, h: -2.5, r: 13, rim: 1.5 },
  ],
  polar: { northR: 13, southR: 16, h: 1.6, c: '#e8e4de' }, // CO2/H2O caps (seasonal-ish mean)
  color: '#b45c38', // mean dusty surface
  colorDark: '#7d4630',
  colorBright: '#cba27c',
}

// ---------------------------------------------------------------------------
// Moon — near-side maria (central lat/lon deg, radius deg) + crater tint.
// ---------------------------------------------------------------------------
export const MOON = {
  maria: [
    { lat: 32.8, lon: -15.6, r: 14 }, // Imbrium
    { lat: 24.3, lon: -1.0, r: 7 }, // Serenitatis
    { lat: 12.5, lon: 17.5, r: 8 }, // Fecunditatis
    { lat: -1.0, lon: 5.5, r: 7.5 }, // Tranquillitatis
    { lat: -13.5, lon: 2.5, r: 4 }, // Nectaris
    { lat: -22.0, lon: 30.0, r: 6 }, // Australe
    { lat: 12.0, lon: 50.0, r: 6 }, // Crisium
    { lat: 42.0, lon: 46.0, r: 4 }, // Frigoris (narrow → blob)
    { lat: 36.0, lon: 58.0, r: 3.5 }, // Vaporem? approx
    { lat: 22.0, lon: 42.0, r: 2.5 }, // Medii
  ],
  color: '#8e8d8b',
  colorMaria: '#54545a',
  colorHighland: '#a5a4a1',
  craterSeed: 777,
}

// ---------------------------------------------------------------------------
// Mercury — Caloris basin + gray palette (Maria-like but bluish-gray, no maria).
// ---------------------------------------------------------------------------
export const MERCURY = {
  caloris: { lat: 31.0, lon: 190.0 - 360, r: 13 }, // 110°W→190E convention: 31N, 191E
  color: '#8f8b86',
  colorDark: '#6c6864',
}

// ---------------------------------------------------------------------------
// Venus — highland plateets (Ishtar/Laphetia/Aphrodite) & lowland plains.
// ---------------------------------------------------------------------------
export const VENUS = {
  highlands: [
    { lat: 65.0, lon: 3.0, r: 12, h: 2.0 }, // Ishtar Terra (Maxwell 11 km)
    { lat: 66.0, lon: 20.0, r: 5, h: 1.5 }, // Maxwell Montes
    { lat: 15.0, lon: 340.0, r: 18, h: 1.0 }, // Aphrodite Terra (spans antimeridian)
    { lat: 8.0, lon: 350.0, r: 10, h: 0.8 },
    { lat: 25.0, lon: 300.0, r: 8, h: 0.7 }, // Lada
  ],
  color: '#d9a351',
  colorHigh: '#caa27a',
  day: 243.02,
  tilt: 177.36,
}

// ---------------------------------------------------------------------------
// Icy / volcanic moons: palette per family. c = base color, c2 = accent.
// ---------------------------------------------------------------------------
export const MOON_PALETTES = {
  io: { c: '#d8c05a', c2: '#a84c22', spots: 0.35, noise: 2.6 }, // sulfur, volcanic pits
  europa: { c: '#d9d4cc', c2: '#9c6b4f', linea: true }, // ice crust + ridges
  ganymede: { c: '#948b80', c2: '#c9c4bd', grooves: true },
  callisto: { c: '#6e655c', c2: '#b7b3ac', craters: 0.5 },
  titan: { c: '#c98f3c', c2: '#8a5a24', dunes: true },
  rhea: { c: '#cfd2d4', c2: '#8f9396' },
  iapetus: { c: '#7a7268', c2: '#c9ccc9' }, // leading/trailing split handled in code
  enceladus: { c: '#eef4f8', c2: '#c8d8e4', tiger: true },
  mimas: { c: '#c5c8ca', c2: '#9aa0a4' },
  dione: { c: '#c9ccce', c2: '#8d9194' },
  tethys: { c: '#d2d5d7', c2: '#969a9d' },
  phoebe: { c: '#4e4740', c2: '#6a625a' },
  triton: { c: '#cfc6d2', c2: '#a6849a' }, // nitrogen frost + cantaloupe
  charon: { lat: null, c: '#9d9790', c2: '#6d6760' },
  uranusMoon: { c: '#a9aeb2', c2: '#7c8185' },
  neptuneMoon: { c: '#9aa0aa', c2: '#6f7580' },
  saturnMoon: { c: '#cfd3d5', c2: '#929799' },
  jupiterMoon: { c: '#a89a8a', c2: '#7a6f63' },
  marsMoon: { c: '#6f6257', c2: '#574d45' },
}

// ---------------------------------------------------------------------------
// Asteroid taxonomy → albedo color (Bus/DeMeo simplified + famous ones).
// ---------------------------------------------------------------------------
export const TAXA = {
  C: '#5c5347', // carbonaceous, most common
  B: '#64605a',
  G: '#6b655c',
  S: '#9d8b6c', // silicaceous
  Q: '#a89878',
  A: '#b0a080',
  M: '#8e8f93', // metallic
  E: '#cfc9bd', // enstatite
  V: '#b5ac9c', // basaltic (Vesta)
  T: '#5a4f42',
  D: '#4f463c', // very dark (outer)
  P: '#57504a',
  default: '#6f665c',
}

// Bodies whose color we force (overrides taxonomy heuristics).
export const NAMED_COLORS = {
  vesta: '#b5ac9c',
  psyche: '#9a948c',
  ceres: '#a5a096',
  henry: '#6f665c',
  bennu: '#4f4a44',
  ryugu: '#433f3a',
  apophis: '#7d6f5d',
  eros: '#9c8c6e',
  itokawa: '#6e6156',
  didymos: '#98897a',
  phaethon: '#8a8272',
  arrokoth: '#b98d6b', // tholins
  'ul-tima': '#a2795c',
  chariklo: '#7d7365',
  pholus: '#4e4441',
  chiron: '#7a6f66',
  sedna: '#b06a4a', // extremely red
  quaoar: '#9d958d',
  orcus: '#b8ae9f',
  eris: '#d8d6d2',
  makemake: '#c98a5e',
  haumea: '#d3d1cd',
  pluto: '#cfc2b0',
  charon: '#9d9790',
}

// ---------------------------------------------------------------------------
// Hardcoded moon tables (Wikipedia tables that don't parse: Mars, Pluto).
//   diam km, mass (×10^15 kg), sma km, period d, inc deg, ecc
// ---------------------------------------------------------------------------
export const EXTRA_MOONS = [
  { parent: 'Earth', name: 'Moon', diam: 3474.8, mass15: 73420000, sma: 384400, period: 27.321661, inc: 5.145, ecc: 0.0549, group: 'Large', label: 'I' },
  { parent: 'Mars', name: 'Phobos', diam: 22.5, mass15: 7.04, sma: 9376, period: 0.3189, inc: 1.08, ecc: 0.0151, group: 'Natural', label: 'I' },
  { parent: 'Mars', name: 'Deimos', diam: 12.4, mass15: 1.48, sma: 23463, period: 1.2624, inc: 1.79, ecc: 0.0002, group: 'Natural', label: 'II' },
  { parent: 'Pluto', name: 'Charon', diam: 1212, mass15: 158600, sma: 19591, period: 6.3872, inc: 0.08, ecc: 0.0001, group: 'Large', label: 'I' },
  { parent: 'Pluto', name: 'Styx', diam: 16, mass15: 1.8, sma: 42656, period: 20.16, inc: 0.81, ecc: 0.0059, group: 'Small', label: 'V' },
  { parent: 'Pluto', name: 'Nix', diam: 35, mass15: 16, sma: 48694, period: 24.85, inc: 0.13, ecc: 0.002, group: 'Small', label: 'IV' },
  { parent: 'Pluto', name: 'Kerberos', diam: 19, mass15: 1.6, sma: 57783, period: 32.17, inc: 0.39, ecc: 0.0033, group: 'Small', label: 'II' },
  { parent: 'Pluto', name: 'Hydra', diam: 50, mass15: 45, sma: 64738, period: 38.2, inc: 0.22, ecc: 0.0008, group: 'Small', label: 'III' },
  // Haumea system (Haumea itself is a dwarf entry)
  { parent: 'Haumea', name: 'Hiʻiaka', diam: 310, mass15: 10000, sma: 49880, period: 49.12, inc: 126.8, ecc: 0.22, group: 'Large', label: 'I' },
  { parent: 'Haumea', name: 'Namaka', diam: 170, mass15: 2700, sma: 25657, period: 18.28, inc: 13.7, ecc: 0.2, group: 'Small', label: 'II' },
  // Orcus / Quaoar / Salacia single moons
  { parent: 'Orcus', name: 'Vanth', diam: 440, mass15: 11000, sma: 9000, period: 9.54, inc: 107.9, ecc: 0.26, group: 'Large', label: 'I' },
  { parent: 'Quaoar', name: 'Weywot', diam: 81, mass15: 270, sma: 13300, period: 12.435, inc: 14.0, ecc: 0.011, group: 'Small', label: 'I' },
  { parent: 'Salacia', name: 'Actaea', diam: 144, mass15: 1000, sma: 5600, period: 5.31, inc: 90.0, ecc: 0.13, group: 'Large', label: 'I' },
  { parent: 'Eris', name: 'Dysnomia', diam: 685, mass15: 26000, sma: 37375, period: 15.77, inc: 79.0, ecc: 0.013, group: 'Large', label: 'I' },
]

// ---------------------------------------------------------------------------
// Planet physical table for the eight + Pluto (mu = GM_sun-relative = m/M☉,
// day = sidereal rotation days, tilt = obliquity deg, rKm = mean radius).
// ---------------------------------------------------------------------------
export const PLANETS = [
  { name: 'Mercury', rKm: 2439.7, mu: 1.6603e-7, day: 58.646, tilt: 0.034, seed: 101 },
  { name: 'Venus', rKm: 6051.8, mu: 2.4479e-6, day: -243.025, tilt: 177.36, seed: 202 },
  { name: 'Earth', rKm: 6371.009, mu: 3.0035e-6, day: 0.99727, tilt: 23.44, seed: 42 },
  { name: 'Mars', rKm: 3389.5, mu: 3.2271e-7, day: 1.02595, tilt: 25.19, seed: 303 },
  { name: 'Jupiter', rKm: 69911, mu: 9.5411e-4, day: 0.41354, tilt: 3.13, seed: 404 },
  { name: 'Saturn', rKm: 58232, mu: 2.8588e-4, day: 0.44401, tilt: 26.73, seed: 505 },
  { name: 'Uranus', rKm: 25362, mu: 4.3662e-5, day: -0.71833, tilt: 97.77, seed: 606 },
  { name: 'Neptune', rKm: 24622, mu: 5.1514e-5, day: 0.67125, tilt: 28.32, seed: 707 },
  { name: 'Pluto', rKm: 1188.3, mu: 6.6e-9, day: -6.3872, tilt: 122.53, seed: 808 },
]

// Dwarf planets / large TNOs stored with procedural terrain (a,e,i in deg;
// om/w/M0 at J2000 from JPL fact sheets).
export const DWARFS = [
  { name: 'Ceres', rKm: 469.7, mu: 4.72e-10, a: 2.7675, e: 0.076, i: 10.59, om: 80.3, w: 73.6, M0: 95.99, day: 0.3775, tilt: 4.0, seed: 901, taxon: 'C' },
  { name: 'Eris', rKm: 1163, mu: 8.28e-9, a: 67.864, e: 0.4416, i: 44.04, om: 35.87, w: 151.09, M0: 204.16, day: 0.6884, tilt: 78, seed: 902, taxon: 'ice' },
  { name: 'Haumea', rKm: 620, mu: 2.02e-9, a: 43.218, e: 0.1956, i: 28.19, om: 122.23, w: 239.03, M0: 217.61, day: 0.10746, tilt: 90, seed: 903, taxon: 'ice', elongate: 0.72 },
  { name: 'Makemake', rKm: 715, mu: 1.6e-9, a: 45.792, e: 0.1559, i: 29.0, om: 79.6, w: 297.1, M0: 165.5, day: 0.4446, tilt: 60, seed: 904, taxon: 'red' },
  // Dwarf-planet candidates hosting known moons (Vanth/Weywot/Actaea).
  // mu derives from the moon's own sma+period (4π²a³/P² ÷ GM☉) so the
  // two-body pair is exactly self-consistent. Orbits: SBDB (recent epoch).
  { name: 'Orcus', rKm: 458.5, mu: 3.19e-10, a: 39.42, e: 0.221, i: 20.6, om: 268.3, w: 73.6, M0: 189, day: 0.3977, tilt: 33, seed: 905, taxon: 'ice' },
  { name: 'Quaoar', rKm: 555, mu: 6.06e-10, a: 43.694, e: 0.041, i: 7.99, om: 189, w: 163, M0: 301.1, day: 0.368, tilt: 53, seed: 906, taxon: 'ice' },
  { name: 'Salacia', rKm: 445, mu: 2.48e-10, a: 42.16, e: 0.105, i: 23.9, om: 280, w: 309, M0: 135, day: 0.5, tilt: 30, seed: 907 },
  { name: 'HaumeaDummy', skip: true },
]

// Ring systems (radii × body radius; tiltDeg = tilt from orbital plane).
export const RINGS = {
  Saturn: {
    inner: 1.244,
    outer: 2.27,
    tiltDeg: 26.73,
    bands: [
      { from: 0.0, to: 0.06, color: '#4e463d', alpha: 0.32 }, // D ring
      { from: 0.06, to: 0.34, color: '#8a7a63', alpha: 0.55 }, // C ring
      { from: 0.34, to: 0.5, color: '#e3d3ae', alpha: 0.94 }, // inner B
      { from: 0.5, to: 0.72, color: '#d9c8a4', alpha: 0.97 }, // outer B
      { from: 0.72, to: 0.78, color: '#5a5147', alpha: 0.12 }, // Cassini division
      { from: 0.78, to: 0.95, color: '#b3a288', alpha: 0.62 }, // A ring
      { from: 0.95, to: 0.965, color: '#3f3a33', alpha: 0.05 }, // Encke gap
      { from: 0.965, to: 1.0, color: '#b8a88e', alpha: 0.5 }, // outer A + F
    ],
  },
  Jupiter: {
    inner: 1.33,
    outer: 1.79,
    tiltDeg: 3.13,
    bands: [
      { from: 0.0, to: 0.5, color: '#6a6058', alpha: 0.16 }, // halo
      { from: 0.5, to: 1.0, color: '#7d7266', alpha: 0.24 }, // main ring
    ],
  },
  Uranus: {
    inner: 1.62,
    outer: 2.0,
    tiltDeg: 97.77,
    bands: [
      { from: 0.0, to: 0.15, color: '#5d6166', alpha: 0.14 }, // zeta
      { from: 0.15, to: 0.55, color: '#4f5358', alpha: 0.1 }, // inner ringlets
      { from: 0.55, to: 0.9, color: '#6a6e73', alpha: 0.2 }, // epsilon core
      { from: 0.9, to: 1.0, color: '#54585d', alpha: 0.1 }, // nu
    ],
  },
}
