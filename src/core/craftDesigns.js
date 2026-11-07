/**
 * craftDesigns.js
 * ---------------------------------------------------------------------------
 * The CRAFT MODEL DESIGNS: the serialized mesh designs that define what a
 * craft looks like, one per craft KIND. Framework-free (no three, no DOM at
 * module load) — node tests exercise the normalizer, and the server side
 * (scripts/import-db.mjs) seeds the world-database `models` table from these
 * same objects.
 *
 * A design is a plain JSON document — exactly the shape that lives in the
 * world database's `models.design` jsonb column (migration 009):
 *
 *   {
 *     "length": 1.345,            // nose-to-tail span in MODEL units; the
 *                                 // mesh scales by rt.size / length so a
 *                                 // craft renders at its true meter size
 *     "parts": [                  // one entry per mesh (order = draw order)
 *       {
 *         "shape": "cylinder",    // box | cylinder | cone | sphere
 *         "size":   [0.26, 0.3, 0.9, 12],  // the geometry args (model units)
 *         "position": [0, 0, 0.15],        // optional, default [0,0,0]
 *         "rotation": [1.57, 0, 0],        // optional Euler XYZ, radians
 *         "material": {                     // optional; defaults below
 *           "color": "#cdd6e4",
 *           "metalness": 0.55,
 *           "roughness": 0.4,
 *           "emissive": "#ff3c00",          // optional
 *           "emissiveIntensity": 1.0        // optional
 *         }
 *       }
 *     ]
 *   }
 *
 * The renderer (src/components/Crafts.jsx) maps each part to the matching
 * three primitive. Editing the look of a craft is a data edit: change the
 * JSON in the `models` table (or in a world file's craft document, which
 * overrides the model) and the mesh rebuilds — no code change.
 *
 * DEFAULT_CRAFT_DESIGNS are the BUILT-IN designs: file worlds (and any craft
 * whose document carries no design) render these. The world-database seed
 * (db/schema.sql / migration 009) carries the SAME JSON, and
 * scripts/test-motion.mjs pins the two against each other so they can't
 * drift.
 */

/** The primitives a design part may use (see Crafts.jsx for the mapping). */
export const CRAFT_DESIGN_SHAPES = ['box', 'cylinder', 'cone', 'sphere']

const HEX = /^#[0-9a-fA-F]{3,8}$/

/**
 * Validate/repair ONE part. Returns null when the part is unusable (unknown
 * shape or a size that can't be read) — the lenient contract drops it
 * rather than rejecting the whole design.
 */
// The first ARG that is a segment count (three primitive arg lists):
//   box [w,h,d] · cylinder [rT,rB,h,radial?,height?] · cone [r,h,radial?,height?]
//   sphere [r,widthSeg?,heightSeg?]
const SEGMENT_FROM = { box: 3, cylinder: 3, cone: 2, sphere: 1 }

function normalizePart(p) {
  if (!p || typeof p !== 'object') return null
  if (!CRAFT_DESIGN_SHAPES.includes(p.shape)) return null
  const segFrom = SEGMENT_FROM[p.shape]
  const size = Array.isArray(p.size)
    ? p.size.slice(0, 6).map((v, i) => {
        const n = Number(v)
        if (!Number.isFinite(n)) return NaN // unusable — the part is dropped below
        // segment counts are positive integers ≥ 3 (three floors + clamps anyway)
        return i >= segFrom ? Math.max(3, Math.round(n)) : n
      })
    : null
  // a size that can't be read DROPS the part (its shape is the point of it);
  // placement (position/rotation) is healed to defaults instead
  if (!size || size.length < 3 || size.some((v) => !Number.isFinite(v) || v <= 0)) return null
  const vec = (v, d) => {
    const a = Array.isArray(v) ? v : d
    return [0, 1, 2].map((i) => {
      const n = Number(a[i])
      return Number.isFinite(n) ? n : d[i]
    })
  }
  const mat = p.material && typeof p.material === 'object' ? p.material : {}
  const num01 = (v, d) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : d
  }
  const material = {
    color: typeof mat.color === 'string' && HEX.test(mat.color) ? mat.color : '#8892a0',
    metalness: num01(mat.metalness, 0.5),
    roughness: num01(mat.roughness, 0.5),
  }
  if (typeof mat.emissive === 'string' && HEX.test(mat.emissive)) {
    const ei = Number(mat.emissiveIntensity)
    material.emissive = mat.emissive
    material.emissiveIntensity = Number.isFinite(ei) && ei >= 0 ? ei : 1
  }
  return {
    shape: p.shape,
    size,
    position: vec(p.position, [0, 0, 0]),
    rotation: vec(p.rotation, [0, 0, 0]),
    material,
  }
}

/**
 * Validate/repair a craft design document (the `models.design` / craft
 * `design` JSON). Lenient: corrupt PARTS are dropped, corrupt numbers healed
 * to defaults; a design with no `length` or no usable parts returns null and
 * the caller falls back to the built-in default for the kind.
 */
export function normalizeCraftDesign(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null
  const length = Number(d.length)
  if (!(length > 0)) return null
  const parts = (Array.isArray(d.parts) ? d.parts : []).map(normalizePart).filter(Boolean)
  if (!parts.length) return null
  return { length, parts }
}

/** The BUILT-IN designs, keyed by craft kind (core/craftTypes.js keys).
 *  Models: unit-scale, nose (drive heading) along +Z. The shuttle straddles
 *  its pad point (mostly a flying vehicle); the rover is modeled so the
 *  WHEELS' bottom is the origin (a rover is always grounded). */
export const DEFAULT_CRAFT_DESIGNS = {
  shuttle: {
    length: 1.345, // spans z = −0.3 … 1.045
    parts: [
      // fuselage (cylinder along +Z: rotated 90° about X) + nose cone
      {
        shape: 'cylinder',
        size: [0.26, 0.3, 0.9, 12],
        position: [0, 0, 0.15],
        rotation: [Math.PI / 2, 0, 0],
        material: { color: '#cdd6e4', metalness: 0.55, roughness: 0.4 },
      },
      {
        shape: 'cone',
        size: [0.3, 0.45, 12],
        position: [0, 0, 0.82],
        rotation: [Math.PI / 2, 0, 0],
        material: { color: '#9fb2cc', metalness: 0.6, roughness: 0.35 },
      },
      // delta wings
      {
        shape: 'box',
        size: [0.5, 0.05, 0.5],
        position: [-0.38, -0.02, -0.25],
        rotation: [0, 0, 0.5],
        material: { color: '#7d8aa0', metalness: 0.5, roughness: 0.5 },
      },
      {
        shape: 'box',
        size: [0.5, 0.05, 0.5],
        position: [0.38, -0.02, -0.25],
        rotation: [0, 0, -0.5],
        material: { color: '#7d8aa0', metalness: 0.5, roughness: 0.5 },
      },
    ],
  },
  drive: {
    length: 0.9, // body spans z = −0.45 … 0.45
    parts: [
      // chassis + survey mast + camera head
      {
        shape: 'box',
        size: [0.55, 0.24, 0.9],
        position: [0, 0.34, 0],
        rotation: [0, 0, 0],
        material: { color: '#c8a25e', metalness: 0.45, roughness: 0.5 },
      },
      {
        shape: 'cylinder',
        size: [0.02, 0.02, 0.34, 6],
        position: [0, 0.51, 0.12],
        rotation: [0, 0, 0],
        material: { color: '#9aa4b2', metalness: 0.6, roughness: 0.4 },
      },
      {
        shape: 'box',
        size: [0.12, 0.08, 0.12],
        position: [0, 0.7, 0.12],
        rotation: [0, 0, 0],
        material: { color: '#3a3f47', metalness: 0.4, roughness: 0.5 },
      },
      // four wheels
      {
        shape: 'cylinder',
        size: [0.16, 0.16, 0.12, 12],
        position: [-0.34, 0.16, 0.28],
        rotation: [0, 0, Math.PI / 2],
        material: { color: '#33373e', metalness: 0.3, roughness: 0.75 },
      },
      {
        shape: 'cylinder',
        size: [0.16, 0.16, 0.12, 12],
        position: [0.34, 0.16, 0.28],
        rotation: [0, 0, Math.PI / 2],
        material: { color: '#33373e', metalness: 0.3, roughness: 0.75 },
      },
      {
        shape: 'cylinder',
        size: [0.16, 0.16, 0.12, 12],
        position: [-0.34, 0.16, -0.28],
        rotation: [0, 0, Math.PI / 2],
        material: { color: '#33373e', metalness: 0.3, roughness: 0.75 },
      },
      {
        shape: 'cylinder',
        size: [0.16, 0.16, 0.12, 12],
        position: [0.34, 0.16, -0.28],
        rotation: [0, 0, Math.PI / 2],
        material: { color: '#33373e', metalness: 0.3, roughness: 0.75 },
      },
    ],
  },
}

/**
 * The design a craft renders with: the craft's own (healed) `design` — a
 * document override, e.g. streamed from the world database's `models` table
 * by the skeleton — else the BUILT-IN design for its kind. Never null: the
 * shuttle default is the last resort.
 */
export function craftDesignFor(craft) {
  const kind = craft && typeof craft === 'object' ? craft.kind : null
  const d = craft && normalizeCraftDesign(craft.design)
  if (d) return d
  // the built-ins are canonical (the normalizer is the identity on them)
  return normalizeCraftDesign(DEFAULT_CRAFT_DESIGNS[kind] || DEFAULT_CRAFT_DESIGNS.shuttle)
}
