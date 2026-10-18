# ExPlanet — agent notes

Hexagonal world builder: React 19 + Vite + three/@react-three/fiber + @react-three/cannon.
Plain JS (no TypeScript), ESM throughout. Single package, no workspaces, no lint/typecheck/CI — do not go looking for them.
Design rationale: `docs/design.txt` (explains WHY), usage: `README.md`.

## Commands

- `npm run dev` — dev server (add `-- --host 0.0.0.0` for LAN testing); mounts the `/api` world-database endpoints via a vite plugin
- `npm test` — runs the three node test scripts; a single one is just `node scripts/test-hexsphere.mjs` (or `test-geometry.mjs` / `test-surface.mjs`)
- `npm run build` — production build; this + `npm test` is the **entire** verification loop
- `npm run serve` — production server: `dist/` + `/api` on one port (build first)
- `npm run gen:world` — regenerates `public/world.json` (the bundled demo world)
- `npm run db:import` — streams `public/world.json` into the world database (psql/COPY; re-running imports a NEW world row)
- `node scripts/check-db-live.mjs` — live end-to-end smoke test of skeleton → hydrate against a running `/api`

No browser automation is available here: headless Firefox **hangs** (no GPU). Do not attempt screenshots/browser smoke tests; verify via `npm test` + `npm run build` (and `scripts/check-db-live.mjs` for the data source).

## World data source: PostgreSQL, streaming (`server/` + `core/db.js`)

Worlds live in the world database (PostgreSQL 15+ on **<db-host>**, database **<db-name>**, schema `explanet`; DDL `db/schema.sql`, password via `PGPASSWORD` or `~/.pgpass`). The browser talks to `/api` (dev: vite middleware, prod: `server/serve.mjs`) — never to postgres directly, and never to `public/world.json`. Loading is staged:

- Boot fetches a **skeleton** (`GET /api/worlds/:id`): small bodies (≤ 10k cells) arrive complete; giants are **stubs** — `elements: null`, `dbId`, `stubAvgHeight`, and a freq-16 `preview` sample built with the app's own `core/lod.js` (server imports it; that is what `core/*` framework-free buys).
- A stub's radius/mass must stay orbit-grade: cell count is exact from `frequency`, volume integrates `stubAvgHeight` — `planetMath` handles `elements == null`. **Never assume `planet.elements` exists** outside stub-aware code paths; test with `isPlanetStub()` (`worldSchema.js`). Walking/landing/duplicating/saving hydrate first; a paint stroke on a stub is dropped but kicks its stream (the next stroke lands).
- Atoms stream via `store.hydratePlanet()` — **only** from user intent: selecting a body, landing on it, a paint stroke at it (the stroke is dropped, the atoms come, the next one lands), or saving. **Never camera-driven and never at boot** — an LOD-matched proximity criterion looks right but fires at system-Overview distances for giants (a giant is always "closer than LOD_SWITCH·R/pf" at any reachable zoom), which quietly reloads the eager-everything behavior. Replacement is copy-on-write on the planet object (geometry memos depend on `planet.elements` identity); in-flight dedupe lives in a module Map, not zustand.
- **Geometry builds never block the main thread** (`src/three/geometryService.js` + `geometry.worker.js`): a planet's whole LOD chain is ~3.5 s of vertex math for a Jupiter, so chains over `ASYNC_MIN_CELLS` (20k) build in a Web Worker that imports the framework-free core unmodified and gets its atoms as packed transferables (`core/atoms.js` — a hydrated planet keeps them as `planet.atomsPacked`, an internal mirror that `applyBrush` patches cell-by-cell and `serializeWorld` strips; planets without a mirror pack from elements on demand). Levels stream back coarse→fine (`computeFaceNormals` = three's non-indexed normals, reproduced in core); the caller keeps the previous set visible until replacements land, disposes by identity difference, and falls back to the synchronous build if the worker dies. Never reintroduce a synchronous chain build for giants.
- `serializeWorld()` strips `dbId`/`preview`/`stubAvgHeight`/`atomsPacked`; `saveWorldUI` hydrates every stub before writing a file. Skeleton cache is per-server-process: after re-importing, restart the server or use `GET /api/worlds/:id?refresh=1`.

## Architecture invariants (violating these breaks things subtly)

- **`src/core/*` must stay framework-free** (no `three` import, no DOM at module load). That is what lets the node test scripts exercise hex math, generators, geometry, and schema. `terrain.js` may touch `document` only inside functions. Components in `src/components` are the only place three.js enters.
- **Element identity is positional**: `planet.elements[i]` corresponds to hex cell `i` of `getHexSphere(frequency)`; `elements.length` MUST equal `cellCountForFrequency(frequency)` = `10n²+2` — for loaded bodies (a DB stub carries no array at all; see the data source section). Grids are deterministically regenerated from `frequency` alone — never store per-cell coordinates.
- **Radius/mass/volume are derived** (`core/planetMath.js`), never stored in the world document. Radius = `√(cells/4π) · planet.scale`; `scale` (default 1) is a stored *size factor*, not a stored radius — elements stay at their grid's natural relief, so shrinking a world must scale `h` too.
- **Atom model (the canonical one, scale = 1):** one hex covers exactly one area unit on *every* planet, so hexes are universal atoms and mass quantizes with cell count. Target size/mass resolve to the nearest grid via `planetMath.frequencyForRadius`/`frequencyForMass` — nearest in **radius**, not in n (the ladder `R(n)=√((10n²+2)/4π)` is nonlinear; the function compares candidate radii). Cap: `MAX_FREQUENCY = 203` (412,092 cells). The starter world and Add Planet dialog are strict atoms (Jupiter fills the top grid, Pluto a chunky 92-cell ball; relief scales with radius). `scale ≠ 1` survives only as a legacy/fine-mesh escape hatch.
- **`core/hexsphere.js` grids are FLAT typed arrays** (`centers` Float64 / `corners` Float32 / `neighbors` Int32 padded to 6 slots with `-1` past `sides[i]` / `sides` Uint8 / `areas` Float64; read corner k of cell i at `(i*6+k)*3`). A per-cell object graph costs ~1.4 KB/cell — 0.5 GB for a freq-203 Jupiter — so never reintroduce `hex.cells[i].*` objects; use `dotCenter`/`hasNeighbor` and index math.
- `public/world.json` is generated from `core/starter.js` — after changing schema, starter, or generators run `npm run gen:world` (tests compare against it).
- **Physics**: cannon world runs with zero global gravity; pairwise N-body is added per frame in `core/physics.js` with softening `eps² = 4`. `orbitalSpeed()` must stay consistent with that softened force law or spawned orbits destabilize.
- **Live body positions/velocities live in the mutable registry in `core/physics.js`, outside React state.** Never route 60 Hz physics through zustand; the store holds only the document + UI state.
- **StrictMode is intentionally removed** from `main.jsx` — it double-mounts effects and duplicates cannon bodies in the worker. Do not re-enable.
- **Picking is analytic** (`intersectHeightfield` in `core/surface.js`): terrain batches share one ray→heightfield march (mounted on the first batch mesh only; the rest use `raycast={() => null}`) that returns the DOCUMENT cell directly — R3F raycasts on every pointer move AND wheel tick, so never route picking back through per-triangle `cellByTri` lookups (kept on geometry as inert fallback data). Planet geometry rebuilds on `[planet.elements, planet.frequency]` identity changes — keep element updates copy-on-write or memoization silently breaks.
- **Render LOD** (`core/lod.js` + `Planet.jsx`): the document always keeps its full-frequency grid (or is a stub, whose `preview` sample renders under the same machinery until hydration); render levels are coarser grids *sampled* from it, and `buildLodGeometryData` remaps their `cellByTri` to fine document-cell indices (inert fallback data since picking went analytic). Only the active level is mounted (draw cost falls off with camera distance; pick cost is LOD-independent). Never persist a sampled grid — regenerate with `sampleLodElements` (the server's preview samples are wire payloads for display, never document data).
- **Surface mode (land & walk) is kinematic, not a cannon body** (`core/surface.js`): the walker integrates against the hex height field `r(dir)=R+h(cell)` in the planet-LOCAL frame and rides spin/orbit for free. Its live pose is a mutable object stepped in `Walker.jsx` (also outside React state); world pose composes the registry's `pos`+`quat` (Planet.jsx must keep publishing `quat`). Don't add a rigid body or route walk state through zustand. All astronaut lengths (eye, stride, step, jump, spawn) are `SURFACE` ratios × the planet's hex-tile radius, resolved per-planet into `surface.metrics` — never hardcode absolute walk sizes (that's what made true-scale planets feel like small balls); `Walker.jsx` likewise lowers `camera.near` for the walk and restores it on lift-off.

## Testing quirks

- `scripts/test-hexsphere.mjs` asserts hard geometric truths (exactly 12 pentagons, symmetric adjacency, total area = 4π, near-equal cell areas). If a `hexsphere.js` change fails these, the math is wrong — historically two real bugs surfaced exactly here; do not weaken the assertions.
- Loading must heal corrupt world files (`normalizeWorld`) rather than throw — keep that lenient contract.

## Repo gotchas

- `ses_*.json` files at repo root are stray OpenCode session dumps — gitignored, never commit, don't delete without asking.
- Git: `master`, no remote configured; the user expects direct commits when asked.
- Dev server may still be running in a background shell from a previous session (`pgrep -f "[v]ite"` to check before binding ports).
