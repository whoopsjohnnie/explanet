# variants — tuning the look without touching code

`src/core/variants.json` is the fiddling file. It holds nothing but **dials**:
named floats in `0..1` that move groups of rendering constants across their
valid ranges together. Save the file and Vite HMR repaints the scene — no
code edits, no search through shaders.

The mechanism (ranges, resolution formula, validation) lives in
[constants.md](constants.md). This file is the user guide: which dials exist,
what they do, and known looks worth trying.

```json
{
  "skyGlow": 0.5,
  "gradientSteps": 1.0
}
```

## `skyGlow` — how much the sky glows

**0.5 = reference look.** The covariant group bound to this dial (ranges in
`constants.json`) moves together: Milky Way dust brightness, bloom pass gain
and width, crisp pass size/gain, and the whisper ambient floor. They share a
dial because they share one artistic decision — a brighter band must widen
its haze *and* lift the ambient floor, or the sky outshines the planets it
frames (the constraint the astrophoto pass dialed in).

| Dial | Sky | Ambient floor |
|---|---|---|
| 0.0 | near-dark band, tight stars | 0.02 |
| 0.5 | reference (current look) | 0.06 |
| 1.0 | blazing band, very wide bloom | 0.10 |

## `gradientSteps` — smooth ↔ 90s VGA

One float that turns every gradient in the engine into N contour bands. It
drives: the walk sky's zenith gradient, day/night shift and star-pop
schedule, the sun's glare rings and corona, the Milky Way star dots (center
spot + ring), the sun's glow sprites, the atmosphere limb glow and its
terminator, and water's specular reflection.

| Dial | Global bands | Look |
|---|---|---|
| `1.0` | **off** | smooth (quantization not just hidden — compiled off where possible, and CPU-side math is a literal pass-through) |
| `0.5` | 18 | almost smooth; faint contour on the sky |
| `0.2` | 12 | posterized |
| `0.1` | 9 | **90s VGA** — sky 9, day/night 5, glare 5, star dots 2 (spot+ring), sun glow 5, limb 3, terminator 4 |
| `0.05` | 7 | chunkier VGA |
| `0.0` | 1 | hard binary lines everywhere — no gradients at all |

Each surface scales the global count (`scale*` in `constants.json`), so the
look stays balanced at every dial — tight rings get fewer bands than wide
ramps. To re-balance one surface (chunkier sun rings, smoother sky) tune its
scale there, not the dial.

**Look recipes:**

- Normal reference — `skyGlow 0.5, gradientSteps 1.0`
- 90s VGA — `skyGlow 0.5, gradientSteps 0.1`
- Dim DOS night — `skyGlow 0.2, gradientSteps 0.1`
- Maximum posterization — `skyGlow 0.8, gradientSteps 0.0`

## Rules

- **Only dials live here.** A dial that nothing references — including
  misspellings — fails validation on load with a named error, as does any
  value outside `0..1`.
- **Rendering and walk feel only.** A variant may never affect what gets
  serialized, how physics runs, or how worlds load — a world must behave
  identically under any variant. Structural constants have no dial path by
  construction.
- **`_note` / `_look` keys are free-form** (skipped by the loader) — use
  `_look` to record what the current dial set is for.

## Adding a dial

1. Add the float to `variants.json`.
2. Bind at least one tunable in `constants.json` to it — either a
   `{ "range": [lo, hi], "dial": "name" }` entry (or several: that's a
   covariant group), or, for computed things like `gradientSteps`, in the
   loader.
3. Fiddle. Vite HMR applies on save; a page reload is never needed.

## Known gaps

- Named presets (`{ "presets": { "vga": { ...dials } } }`) are a natural next
  step — not built yet; recipes above are the poor man's version.
- The planet's own day/night terminator is still smooth at any dial (the
  diffuse-side follow-up to the water specular patch); see
  [constants.md](constants.md) §migration.
