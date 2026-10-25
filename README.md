# ⬡ ExPlanet — Hexagonal World Builder

A React web app for building hexagonal planets and entire solar systems that
orbit each other under real N-body gravity — in the style of classic low-poly
"hex planet" generators (the sphere is always tiled by hexagons plus exactly
12 pentagons, like the reference asset on Fab).

All worlds live in a PostgreSQL database (the **world database**, schema in
`db/schema.sql`): planets, their hex atoms, positions, velocities —
everything. The app streams what it needs: the solar system opens instantly
from a skeleton, and each giant's atoms stream in when you approach, select
it, or land on it. `world.json` files remain the import/export format.
No world or seed data is committed — see `DATA.md` for where everything
lives (world database + S3 seeds) and how to fetch or regenerate it.

```
npm install
npm run dev        # → http://localhost:5173   (uses the world database; falls
                   #                            back to the built-in starter
                   #                            world if it is unreachable)
```

## What it does

- **Hexagonal planets** — each planet surface is a geodesic dual grid
  (Goldberg polyhedron): ~equal-area hexagonal cells + 12 pentagons. Cell
  counts follow `10n² + 2` (n = subdivision frequency).
- **Per-hex elements** — every element stores terrain type, height and an
  optional color override. Terrain: grass, dirt, rock, sand, snow, water,
  lava, void, star — each with a procedurally generated texture.
- **Derived physical properties — hexes are atoms** — a planet's radius,
  volume and mass come from its hex elements only:
  `R = √(cells / 4π)`, `V = Σ ⅓·Aᵢ·(R + hᵢ)`, `m = ρ·V`.
  One hex always covers exactly **one area unit on every planet**, so a hex
  is an atom of a universal size: heavier worlds are literally built from
  more hexes, and mass is quantized in whole atoms (the smallest possible
  world is a 12-cell dodecahedron). "Add Planet" asks for a target **mass**
  and resolves it to the nearest legal grid.
- **N-body gravity** — the cannon-es world runs with zero global gravity;
  every frame all bodies attract pairwise with
  `F = G·m₁·m₂ / (d² + ε²)`. Planets orbit, moons wobble, collisions bounce.
- **Land on a planet** — press 🚀 (PlanetList / Inspector) to descend onto any
  non-star world: you fall onto the surface and can then walk it —
  following the hex contours, stepping up ledges, blocked (and sliding)
  along cliffs, jumping, sprinting. All of it in first person: the camera
  sits at the astronaut's eyes through the fall, the walk and every jump,
  riding the planet's spin and orbit. Hold & drag to look around.
- **world.json import/export** — Open, Save (Ctrl+S) and drag-&-drop. Bodies
  whose atoms still live only in the database are streamed in before a save,
  so exported files are always complete (database-internal fields never leak
  into files). In Chrome/Edge the file handle is remembered (File System
  Access API + IndexedDB), so Ctrl+S writes to the same file on disk.
  Elsewhere it falls back to download/upload.
- **Live painting** — click or drag on a planet with the paint / raise /
  lower brushes (with brush size & power). Geometry updates instantly.
- **Procedural presets** — Earth-like, rocky, desert, ice, volcanic, gas
  giant, moon and star worlds, generated from seeded value-noise fBm.
- **Orbit helpers** — "Add Planet" spawns a body with the exact velocity for
  a circular orbit around the selected parent.

## Controls

| Key | Action |
| --- | --- |
| Left-drag | Orbit camera |
| Scroll | Zoom |
| Click planet | Select (with Select tool) |
| Click / drag on surface | Paint / raise / lower with active brush |
| `Space` | Pause / resume physics |
| `V B R F` | Select · Paint · Raise · Lower |
| `1…9` | Terrain brush |
| `[` `]` | Brush size − / + |
| `L` | Toggle labels |
| `Ctrl/Cmd + S` | Save world.json |

### Surface mode (landed on a planet)

Press 🚀 in the body list (or **Land on surface** in the Inspector) to drop
onto a planet. While landed:

| Key | Action |
| --- | --- |
| `W A S D` / arrows | Walk along the surface (camera-relative) |
| `Shift` | Sprint |
| `Space` | Jump |
| Left-drag / scroll | Look around / zoom (camera follows the walker) |
| `Esc` | Lift off — back to the editor camera |
| `Ctrl/Cmd + S` | Save (still works while walking) |

Bodies that carry an `atmosphere` descriptor get a real sky: a horizon →
zenith gradient in the body's own colors, glare around the sun, and a starry
night once it sets — the thicker the air, the more it swallows the stars.
Airless worlds keep the bare starfield, and the HUD reports surface pressure
(`atm 1.01` on Earth, `atm 92` on Venus, `no air` on the Moon). In flight the
same descriptor paints a sunlit limb shell around the planet, so worlds with
air read as "has air" from orbit. The real-world catalog lives in
`core/atmospheres.js`; the document shape is below.

## world.json format

```jsonc
{
  "version": 1,
  "name": "Helios System",
  "gravity": 40,                       // scaled gravitational constant G
  "planets": [
    {
      "id": "p-ab12cd34",
      "name": "Aqua",
      "preset": "earthlike",           // informational (generator seed type)
      "seed": 42,
      "frequency": 6,                  // geodesic frequency → 10n²+2 cells;
                                       // at scale 1 each cell = 1 area unit
      "scale": 1,                      // optional size factor (default 1)
      "center":   { "x": 46, "y": 0, "z": 0 },
      "velocity": { "x": 0,  "y": 0, "z": -13.8 },
      "spin":     { "x": 0,  "y": 0.5, "z": 0 },
      "density": 0.05,
      "isStatic": false,               // true → unaffected by gravity (stars)
      "atmosphere": {                  // optional air → walk-mode sky + HUD
        "top": 0.094,                  //   heights are MULTIPLES of body radius
        "scaleHeight": 0.0013,         //   density e-fold height (~8.5 km / R⊕)
        "pressure": 1.013,             //   surface pressure in atm — thickness
        "opacity": 0.62,               //   0..1 visual density (1 = opaque)
        "zenith": "#2f63b4", "horizon": "#b3cde8", "glow": "#ffd9a0"
      },
      "elements": [                    // one entry per hex cell, in fixed
        { "t": "grass", "h": 0.31 },   // grid order: {t, h, c?}
        { "t": "water", "h": 0, "c": "#1f6fc0" }
      ]
    }
  ]
}
```

`public/world.json` is the local demo system — generated with
`npm run gen:world` (from `core/starter.js`) and **not committed**: this repo
holds the engine and the world-building tools only, never world data (see
`DATA.md`). It is the Sun and the nine planets at true relative distances —
each world's hex count derived from its real radius, up to the
frequency-203 cap: Jupiter 412,092 hexes, Earth 3,242, Pluto a chunky 92.
Generate it, then import it into the world database with `npm run db:import`.

The **Sol Real** world (`node scripts/gen-sol-real.mjs && node
scripts/import-db.mjs public/sol-real.json`) is the full-scale version: all
8 planets, 5 dwarf planets, 467 moons, 453 asteroids and 70 comets on true
scale and true orbits — Earth with real continents and Everest at 8.849 km,
Saturn's rings, a glowing Sun, and real atmospheres (Earth's blue, Venus's
opaque ochre, Titan's orange, Pluto's thin haze) that render as skies in
walk mode. Small bodies ride scripted Keplerian orbits
as test particles (no N-body cost); the body list gets a search box and
collapsible groups. See `AGENTS.md` for the schema details.

## The world database

Worlds are stored relationally in PostgreSQL (your world database server;
schema in [`db/schema.sql`](db/schema.sql)): `worlds → bodies → atoms`, with
`materials` as the terrain palette. Because atoms are rows, a browser never
has to swallow the whole 90 MB document again:

- **Skeleton first** — on boot the app fetches every body's document fields
  with atoms only for the small bodies (≤ 10,000 cells); giants arrive as
  *stubs*: `elements: null`, a frequency-16 preview sample, and the DB's mean
  relief. Stub radius is exact (it depends only on cell count) and stub mass
  integrates the stored mean height, so orbits fly correctly before a single
  atom has loaded. Boot payload: ~220 KB gzipped instead of 90 MB.
- **Atoms stream in on intent** — selecting a body, landing on it, or making
  a paint stroke at it fetches that body's full atoms (Jupiter's 412,092 in
  ~350 ms warm); boot fetches the skeleton and nothing else. Flying past a
  giant never downloads it. Painting and walking always operate on the real
  grid; the preview only ever renders until the body is asked for.
- **API** (dev: mounted into Vite; prod: `npm run serve`, which also serves
  `dist/`):
  `GET /api/worlds`, `GET /api/worlds/:id` (skeleton, `?refresh=1` rebakes),
  `GET /api/bodies/:dbId/elements` (compact columnar atoms, gzipped),
  `GET /api/health`.
- **Connection**: `PGHOST`, `PGDATABASE`, `PGUSER` are **required** env vars —
  this repo ships no infrastructure names; `PGPORT` defaults to 5432 and the
  password comes from `PGPASSWORD` or `~/.pgpass`. The served world defaults
  to the newest import — pin one with `EXPLANET_WORLD=8` or `?world=8` in the
  browser URL.
- **Smoke test**: `node scripts/check-db-live.mjs` runs the real client path
  against a live API and reports the staged-load picture.

## Architecture

```
src/
  core/                 ← framework-free, unit-tested logic
    hexsphere.js        geodesic icosphere + dual hex/pent cells (areas, neighbors)
    geometry.js         elements → vertex batches (per terrain) w/ pick maps
    planetMath.js       radius / volume / mass derived from elements (stub-safe)
    generators.js       seeded fBm terrain presets
    worldSchema.js      world.json shape, creation, validation & repair (+ stubs)
    starter.js          demo system (also writes public/world.json)
    physics.js          N-body gravity step + live body registry
    kepler.js           scripted-orbit propagation + Cartesian state → elements fit
    surface.js          surface queries + kinematic walker (land & walk mode)
    lod.js              render LOD chains + sampled preview grids
    terrain.js          terrain registry + procedural canvas textures
    db.js               world-database client (skeleton + streamed atoms)
    atmospheres.js      real Solar System atmosphere catalog (walk-sky data)
    fileIO.js           File System Access API + IndexedDB handle + fallbacks
  state/store.js        zustand: world document + editor state + hydratePlanet()
  components/
    Scene.jsx           R3F canvas, cannon <Physics>, camera follow
    Planet.jsx          one planet = sphere body + per-terrain meshes + painting
    AtmosphereGlow.jsx  orbit-view atmosphere: additive limb shell on the dayside
    Walker.jsx          surface mode: walk integration, first-person eye camera
    WalkSky.jsx         walk-mode sky from the atmosphere descriptor
    ui/                 TopBar, PlanetList, Inspector, Palette, WalkHud, AddPlanetDialog
server/
  db.mjs                pg pool + skeleton/body queries + LRU + preview sampling
  api.mjs               /api endpoints (shared by the Vite dev middleware + serve)
  serve.mjs             production: static dist/ + /api on one port
scripts/
  gen-sample-world.mjs  regenerates public/world.json
  import-db.mjs         streams a world.json into the world database (COPY)
  check-db-live.mjs     end-to-end smoke test against a live /api
  score-kepler.mjs      scores the Cartesian→Kepler fit: document round-trip,
                        real JPL Horizons vectors, published planet elements
  run_s0.sh             stage-0 scoring run (node scripts/score-kepler.mjs; --offline)
  test-hexsphere.mjs    grid correctness (12 pentagons, symmetry, equal areas)
  test-geometry.mjs     generators + geometry + schema/stub round-trips
  test-surface.mjs      walker math (cell lookup, landing, walking, walls, jumps)
```

## Tests

```
npm test
```

verifies: cell counts (`10n²+2`), exactly 12 pentagons, symmetric adjacency,
near-equal cell areas (total = 4π, spread < 1%), all generators produce
valid elements, geometry batches are finite and fully pickable, corrupt
world files heal, and the surface walker's math (Voronoi under-foot lookup
matches brute force, falls terminate on the surface, walking never dips
through terrain, tall tiles block and slide, jumps arc to the target height,
and the integrator is deterministic + fuzz-safe).

`scripts/run_s0.sh` scores `core/kepler.js`'s inverse map — the Cartesian
state → orbital-elements fit — on every scripted body of the Sol Real
document, on real JPL Horizons state vectors (Halley, Ceres, Bennu…), and on
the N-body planets against their published J2000 elements. It exits with the
score; `--offline` drops only the Horizons suite.

## Notes & limits

- Hex cells are *near*-equal area (deviation < 1% for frequency ≥ 3 — that's
  the nature of covering a sphere with hexagons; the 12 pentagons are
  unavoidable per Euler's polyhedron formula).
- Gravity uses a small softening term (ε² = 4) so close encounters never
  blow up; orbital speeds in the UI account for it.
- Painting is paused-physics friendly; velocity edits apply instantly
  ("retro-burn").
- The File System Access API (true read-write to one file) requires
  Chrome/Edge; Firefox/Safari use download + upload instead.
