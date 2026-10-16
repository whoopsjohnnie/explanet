# ExPlanet — agent notes

Hexagonal world builder: React 19 + Vite + three/@react-three/fiber + @react-three/cannon.
Plain JS (no TypeScript), ESM throughout. Single package, no workspaces, no lint/typecheck/CI — do not go looking for them.
Design rationale: `docs/design.txt` (explains WHY), usage: `README.md`.

## Commands

- `npm run dev` — dev server (add `-- --host 0.0.0.0` for LAN testing)
- `npm test` — runs the three node test scripts; a single one is just `node scripts/test-hexsphere.mjs` (or `test-geometry.mjs` / `test-surface.mjs`)
- `npm run build` — production build; this + `npm test` is the **entire** verification loop
- `npm run gen:world` — regenerates `public/world.json` (the bundled demo world)

No browser automation is available here: headless Firefox **hangs** (no GPU). Do not attempt screenshots/browser smoke tests; verify via `npm test` + `npm run build`.

## Architecture invariants (violating these breaks things subtly)

- **`src/core/*` must stay framework-free** (no `three` import, no DOM at module load). That is what lets the node test scripts exercise hex math, generators, geometry, and schema. `terrain.js` may touch `document` only inside functions. Components in `src/components` are the only place three.js enters.
- **Element identity is positional**: `planet.elements[i]` corresponds to hex cell `i` of `getHexSphere(frequency)`; `elements.length` MUST equal `cellCountForFrequency(frequency)` = `10n²+2`. Grids are deterministically regenerated from `frequency` alone — never store per-cell coordinates.
- **Radius/mass/volume are derived** (`core/planetMath.js`), never stored in the world document. Radius = `√(cells/4π) · planet.scale`; `scale` (default 1) is a stored *size factor*, not a stored radius — elements stay at their grid's natural relief, so shrinking a world must scale `h` too.
- `public/world.json` is generated from `core/starter.js` — after changing schema, starter, or generators run `npm run gen:world` (tests compare against it).
- **Physics**: cannon world runs with zero global gravity; pairwise N-body is added per frame in `core/physics.js` with softening `eps² = 4`. `orbitalSpeed()` must stay consistent with that softened force law or spawned orbits destabilize.
- **Live body positions/velocities live in the mutable registry in `core/physics.js`, outside React state.** Never route 60 Hz physics through zustand; the store holds only the document + UI state.
- **StrictMode is intentionally removed** from `main.jsx` — it double-mounts effects and duplicates cannon bodies in the worker. Do not re-enable.
- **Picking is analytic** (`intersectHeightfield` in `core/surface.js`): terrain batches share one ray→heightfield march (mounted on the first batch mesh only; the rest use `raycast={() => null}`) that returns the DOCUMENT cell directly — R3F raycasts on every pointer move AND wheel tick, so never route picking back through per-triangle `cellByTri` lookups (kept on geometry as inert fallback data). Planet geometry rebuilds on `[planet.elements, planet.frequency]` identity changes — keep element updates copy-on-write or memoization silently breaks.
- **Render LOD** (`core/lod.js` + `Planet.jsx`): the document always keeps its full-frequency grid; render levels are coarser grids *sampled* from it, and `buildLodGeometryData` remaps their `cellByTri` to fine document-cell indices (inert fallback data since picking went analytic). Only the active level is mounted (draw cost falls off with camera distance; pick cost is LOD-independent). Never persist a sampled grid — regenerate with `sampleLodElements`.
- **Surface mode (land & walk) is kinematic, not a cannon body** (`core/surface.js`): the walker integrates against the hex height field `r(dir)=R+h(cell)` in the planet-LOCAL frame and rides spin/orbit for free. Its live pose is a mutable object stepped in `Walker.jsx` (also outside React state); world pose composes the registry's `pos`+`quat` (Planet.jsx must keep publishing `quat`). Don't add a rigid body or route walk state through zustand.

## Testing quirks

- `scripts/test-hexsphere.mjs` asserts hard geometric truths (exactly 12 pentagons, symmetric adjacency, total area = 4π, near-equal cell areas). If a `hexsphere.js` change fails these, the math is wrong — historically two real bugs surfaced exactly here; do not weaken the assertions.
- Loading must heal corrupt world files (`normalizeWorld`) rather than throw — keep that lenient contract.

## Repo gotchas

- `ses_*.json` files at repo root are stray OpenCode session dumps — gitignored, never commit, don't delete without asking.
- Git: `master`, no remote configured; the user expects direct commits when asked.
- Dev server may still be running in a background shell from a previous session (`pgrep -f "[v]ite"` to check before binding ports).
