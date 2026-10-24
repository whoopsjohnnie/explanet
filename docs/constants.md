# constants — the engine's tuned numbers, defined once

Everything the renderer and the sim are tuned by lives in two JSON files,
imported through one loader:

| File | Role |
|---|---|
| `src/core/constants.json` | every constant + its valid range + which variant dial drives it |
| `src/core/variants.json` | the dials themselves (0..1 floats) — the fiddling file ([variants.md](variants.md)) |
| `src/core/constants.js` | loader: resolves dials → numbers, validates, exports `C`, `bandize()`, `gnum()` |
| `src/core/glsl.js` | shared GLSL snippets (`BAND_FN`), injected into shader template literals |

**The rule:** a tuned number is written down exactly once. If a value appears
in two files (shaders count as files — the day/night curve once lived in JS
and GLSL simultaneously), it belongs in `constants.json` and both consumers
import it. Tuning a look means editing `variants.json` and nothing else.

## Entry format

`constants.json` has two sections:

**`structural.*` — plain numbers.** Invariants: physics softening, grid caps,
frustum budgets, shared geometry. No range, no dial — variants can never
touch these. Reference them as `C.<group>.<name>`.

**`tunables.* — objects, two shapes:**

```json
"bloomGain": { "value": 0.12 }                                  // fixed
"bloomGain": { "range": [0.02, 0.22], "dial": "skyGlow" }       // dialed
```

Resolution of a dialed entry: `lerp(range[0], range[1], dial^gamma)` with the
dial read from `variants.json` (`gamma` defaults to 1, shapes perceptual
response). Direction is just range order: `bloomSoft: { "range": [2.2, 1.0] }`
means *as the sky glows more, the bloom gets wider*. Several entries bound to
one dial form a **covariant group** — they interplay together as the dial
moves (that's how "brighter band + wider bloom + lifted ambient floor" stays
one decision).

Keys starting with `_` (`_note`, `_look`) are documentation and skipped by
the loader.

## Validation (at import time, everywhere)

`constants.js` self-validates in every environment that loads the core —
app, geometry worker, node tests, `server/`. It throws with a complete list:

- dial value not a number in `[0, 1]`
- `dial` name missing from `variants.json`
- **dial present but unused** (typos in the fiddling file fail loudly)
- malformed `range` / `value` / `gamma`, non-finite numbers

## Current constants

### structural

| Key | Value | What it governs |
|---|---|---|
| `physics.softeningEpsSq` | 4 | ε² of the softened gravity law — one number shared by `stepGravity`, `orbitalSpeed`, `surfaceGravity` |
| `atom.maxFrequency` | 203 | atom-ladder cap (re-exported as `MAX_FREQUENCY`) |
| `lod.switch` | 570 | render-LOD switch distance (× R / n) |
| `lod.asyncMinCells` | 20 000 | cell count above which LOD chains build in the worker |
| `server.previewFrequency` | 16 | giant preview-sample grid |
| `server.fullInlineCells` | 10 000 | cell count small enough to inline in the skeleton |
| `decor.domeWidthSegs` / `domeHeightSegs` | 48 / 24 | WalkSky dome + AtmosphereGlow shell tessellation |
| `sky.dustSeed` | 7 | Milky Way dust determinism (tests pin its outputs) |

### tunables — `skyFade` (no dial)

The day→night sun-elevation curve `smoothstep(sunDown, sunUp, sun·up)`,
**one definition consumed in two languages**: StarField's JS fade and WalkSky's
GLSL (injected via `gnum()`).

### tunables — `sky` (the `skyGlow` covariant group)

`skyGlow`-bound ranges are built around **0.5 = reference look**, so the
shipped `variants.json` reproduces the pre-constants render.

| Key | Range | At 0.5 | Drives |
|---|---|---|---|
| `coreSizeMul` / `coreGain` | 0.6 – 1.4 | 1 | crisp star pass size / gain |
| `coreSoft` | 2.5 – 5.5 | 4 | crisp gaussian falloff rate |
| `bloomSizeMul` | 3 – 7 | 5 | bloom pass point-size multiplier |
| `bloomGain` | 0.02 – 0.22 | 0.12 | bloom pass gain |
| `bloomSoft` | 2.2 – 1.0 | 1.6 | bloom falloff (inverted: more glow → wider) |
| `dustIntenBase` / `dustIntenSpan` | 0.01 – 0.08 / 0.06 – 0.26 | 0.045 / 0.16 | Milky Way dust brightness |
| `ambientFloor` | 0.02 – 0.10 | 0.06 | whisper ambient when a star is present |
| `dustCount` 38 000, `dustSizeBase` 1.1, `dustSizeSpan` 1.8, `starSize*`, `starInten*` (magnitude curves) | fixed | — | sky geometry & magnitude response |

### tunables — `gradient` (the quantizer family)

The `gradientSteps` dial turns every gradient in the engine into N contour
bands — the 90s-VGA look. Full semantics in [variants.md](variants.md).

Band counts are computed by the loader from one dial float:
`steps = dial ≥ 1 ? 0 : max(1, round(1 + (maxBands − 1) · dial^curve))`
with `maxBands: 24`, `curve: 0.45`. Each surface applies a `scale` of the
global count (a tight limb ring wants fewer bands than a wide sky ramp).

| Surface scale | → `C.gradient.steps.*` | Applied to | Site |
|---|---|---|---|
| `scaleSkyZenith` 1.0 | `skyZenith` | horizon→zenith gradient | WalkSky (GLSL) |
| `scaleSkyDayNight` 0.5 | `skyDayNight` | day/night light level | WalkSky + StarField fade (co-quantized — stars pop on schedule) |
| `scaleSunGlare` 0.5 | `sunGlare` | forward scatter + corona around the star | WalkSky (GLSL) |
| `scaleStarDots` 0.2 | `starDots` | point-sprite falloff (2 = center spot + one ring) | StarField (GLSL, both passes) |
| `scaleSunGlow` 0.55 | `sunGlow` | sun corona/haze sprites | `three/effects.js` glow DataTexture (CPU) |
| `scaleLimbGlow` 0.35 | `limbGlow` | fresnel limb glow | AtmosphereGlow (GLSL) |
| `scaleAirTerminator` 0.4 | `airTerminator` | atmosphere-shell terminator | AtmosphereGlow (GLSL) |

`bandize()` quantizes a 0..1 ramp: `steps ≤ 0` pass-through (smooth — the
dial's off state is mathematically a no-op), `1` binary, `N` N bands. It
exists twice by necessity — GLSL (`core/glsl.js`) and a JS mirror
(`core/constants.js`) so CPU-side math (star fade, glow textures) steps in
lockstep. Keep the two in sync.

## What stays out of constants.json

- **Astronomy** (obliquity, galactic pole/center) — invariants next to their
  math; not taste, never edited.
- **`SURFACE` walk ratios** (core/surface.js) — feel/physics mechanics, not
  rendering; values may migrate, the ratio-against-tile model stays code.
- **Per-body catalogs** (`core/atmospheres.js`, ring bands) — document data,
  already single-defined.
- **Anything affecting documents or physics stability.** Dials may only touch
  rendering and walk feel; a world must serialize and simulate identically
  under any variant. `structural` exists precisely so no dial can reach
  gravity, grids, or the wire format.

## Adding a constant

1. `constants.json` → add `value` (or `range` + `dial` for a covariant group;
   add the dial to `variants.json`).
2. Replace the literal with `C.<group>.<name>` at every site; GLSL sites take
   `${gnum(...)}`.
3. If the dial is consumed by loader code instead of a binding (like
   `gradientSteps`), call `dialValue()` there. Validation catches a dial that
   exists in one file only.

## Migration status

Migrated: gravity softening, atom/lod/server structural values, the whole
sky family (StarField, starsky magnitude curves, skyFade), walk sky,
atmosphere glow, star point sprites, sun glow texture, water specular.
**Still in code** (pass 2 candidates): WalkSky `DEFAULTS` colors, star
glow-sprite scales/opacities + pointLight in Planet.jsx, Scene fog/frustum
budgets, ring texture tuning in effects.js, label distance gates, the
`TERRAIN_TYPES` palette. Known smooth-gradient holdouts: the planet's own
Lambert day/night terminator (needs the deferred `MeshStandardMaterial`
diffuse patch — water specular already uses this pattern) and the
AtmosphereGlow `cres` sunward crescent.
