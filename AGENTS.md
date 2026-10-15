# ExPlanet — agent notes

Hexagonal world builder: React 19 + Vite + three/@react-three/fiber + @react-three/cannon.
Plain JS (no TypeScript), ESM throughout. Single package, no workspaces, no lint/typecheck/CI — do not go looking for them.
Design rationale: `docs/design.txt` (explains WHY), usage: `README.md`.

## Commands

- `npm run dev` — dev server (add `-- --host 0.0.0.0` for LAN testing)
- `npm test` — runs both node test scripts; a single one is just `node scripts/test-hexsphere.mjs` (or `test-geometry.mjs`)
- `npm run build` — production build; this + `npm test` is the **entire** verification loop
- `npm run gen:world` — regenerates `public/world.json` (the bundled demo world)

No browser automation is available here: headless Firefox **hangs** (no GPU). Do not attempt screenshots/browser smoke tests; verify via `npm test` + `npm run build`.

## Architecture invariants (violating these breaks things subtly)

- **`src/core/*` must stay framework-free** (no `three` import, no DOM at module load). That is what lets the node test scripts exercise hex math, generators, geometry, and schema. `terrain.js` may touch `document` only inside functions. Components in `src/components` are the only place three.js enters.
- **Element identity is positional**: `planet.elements[i]` corresponds to hex cell `i` of `getHexSphere(frequency)`; `elements.length` MUST equal `cellCountForFrequency(frequency)` = `10n²+2`. Grids are deterministically regenerated from `frequency` alone — never store per-cell coordinates.
- **Radius/mass/volume are derived** (`core/planetMath.js`), never stored in the world document.
- `public/world.json` is generated from `core/starter.js` — after changing schema, starter, or generators run `npm run gen:world` (tests compare against it).
- **Physics**: cannon world runs with zero global gravity; pairwise N-body is added per frame in `core/physics.js` with softening `eps² = 4`. `orbitalSpeed()` must stay consistent with that softened force law or spawned orbits destabilize.
- **Live body positions/velocities live in the mutable registry in `core/physics.js`, outside React state.** Never route 60 Hz physics through zustand; the store holds only the document + UI state.
- **StrictMode is intentionally removed** from `main.jsx` — it double-mounts effects and duplicates cannon bodies in the worker. Do not re-enable.
- Painting/picking works via `cellByTri` (triangle→cell lookup baked into each geometry batch); planet geometry rebuilds on `[planet.elements, planet.frequency]` identity changes — keep element updates copy-on-write or memoization silently breaks.

## Testing quirks

- `scripts/test-hexsphere.mjs` asserts hard geometric truths (exactly 12 pentagons, symmetric adjacency, total area = 4π, near-equal cell areas). If a `hexsphere.js` change fails these, the math is wrong — historically two real bugs surfaced exactly here; do not weaken the assertions.
- Loading must heal corrupt world files (`normalizeWorld`) rather than throw — keep that lenient contract.

## Repo gotchas

- `ses_*.json` files at repo root are stray OpenCode session dumps — gitignored, never commit, don't delete without asking.
- Git: `master`, no remote configured; the user expects direct commits when asked.
- Dev server may still be running in a background shell from a previous session (`pgrep -f "[v]ite"` to check before binding ports).
