# ⬡ ExPlanet — Hexagonal World Builder

A React web app for building hexagonal planets and entire solar systems that
orbit each other under real N-body gravity — in the style of classic low-poly
"hex planet" generators (the sphere is always tiled by hexagons plus exactly
12 pentagons, like the reference asset on Fab).

All world data lives in a local **`world.json`** file: planets, their hex
elements, positions, velocities — everything.

```
npm install
npm run dev        # → http://localhost:5173
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
- **world.json everywhere** — Open, Save (Ctrl+S) and drag-&-drop. In
  Chrome/Edge the file handle is remembered (File System Access API +
  IndexedDB), so Ctrl+S writes to the same file on disk. Elsewhere it falls
  back to download/upload.
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
      "elements": [                    // one entry per hex cell, in fixed
        { "t": "grass", "h": 0.31 },   // grid order: {t, h, c?}
        { "t": "water", "h": 0, "c": "#1f6fc0" }
      ]
    }
  ]
}
```

`public/world.json` is the bundled demo system (the Sun and the nine planets
at true relative distances — each world's hex count derived from its real
radius, up to the frequency-203 cap: Jupiter 412,092 hexes, Earth 3,242,
Pluto a chunky 92). Regenerate it with `npm run gen:world`.

## Architecture

```
src/
  core/                 ← framework-free, unit-tested logic
    hexsphere.js        geodesic icosphere + dual hex/pent cells (areas, neighbors)
    geometry.js         elements → vertex batches (per terrain) w/ pick maps
    planetMath.js       radius / volume / mass derived from elements
    generators.js       seeded fBm terrain presets
    worldSchema.js      world.json shape, creation, validation & repair
    starter.js          demo system (also writes public/world.json)
    physics.js          N-body gravity step + live body registry
    surface.js          surface queries + kinematic walker (land & walk mode)
    terrain.js          terrain registry + procedural canvas textures
    fileIO.js           File System Access API + IndexedDB handle + fallbacks
  state/store.js        zustand: world document + editor state
  components/
    Scene.jsx           R3F canvas, cannon <Physics>, camera follow
    Planet.jsx          one planet = sphere body + per-terrain meshes + painting
    Walker.jsx          surface mode: walk integration, first-person eye camera
    ui/                 TopBar, PlanetList, Inspector, Palette, WalkHud, AddPlanetDialog
scripts/
  gen-sample-world.mjs  regenerates public/world.json
  test-hexsphere.mjs    grid correctness (12 pentagons, symmetry, equal areas)
  test-geometry.mjs     generators + geometry + schema round-trips
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
