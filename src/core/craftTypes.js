/**
 * craftTypes.js
 * ---------------------------------------------------------------------------
 * The CRAFT CATALOG: what each `kind` of craft is, how big it is, and how it
 * flies in each realism mode (core/motion.js runs the movers over these).
 *
 * A craft is a world object with its own position and momentum (see
 * worldSchema.js `crafts[]` and docs/flight.txt). Its `kind` picks the
 * mover + tuning from this table; its `realism` picks the column:
 *
 *   • arcade — NON-Newtonian plug-and-play: no gravity, velocity eases
 *     toward the control input, speeds are TILE-ANCHORED (a fraction of the
 *     host body's hex-tile size per doc second) so a craft crosses terrain
 *     at game scale on any world, true-scale included. The craft's velocity
 *     is RELATIVE to the body it is under (body-relative flight): parked
 *     = rel velocity 0, riding the body for free.
 *   • real — Newtonian: the craft feels the world's softened gravity
 *     (core/physics.js law, ε² = 4), has inertia, can be captured, slingshot
 *     and land. Thrust is in m/s² on true-scale worlds (world.scale) and in
 *     units/s² on game worlds. Speeds are physical — a cruise between
 *     moons is a patient, honest burn.
 *
 * The astronaut (always) flies with EVA_TUNING when adrift: real gravity
 * plus a jetpack whose thrust always outweighs the local gravity (1.6×),
 * so EVA can hover on any body — that is what a jetpack is for.
 *
 * Tuning lives here in code (like the SURFACE walk ratios in surface.js),
 * not in constants.json: it is craft-model data, not a world dial.
 */

export const CRAFT_TYPES = {
  shuttle: {
    label: 'Shuttle',
    icon: '🚀',
    // size in host-body hex-tile units: a game object, visible at any scale
    // (≈ 4.8 km on the Moon at true scale, ≈ 0.05 u on the starter world)
    sizeTiles: 0.22,
    arcade: {
      speedTiles: 24, // top speed, tiles per doc second (body-relative)
      ease: 0.25, // seconds for velocity to settle onto the target
      yawRate: 1.7, // rad/s of attitude per full stick
      pitchRate: 1.3,
      launchTiles: 2, // vertical rel-velocity kick off the pad, tiles/s
      boost: 2, // Shift multiplier
    },
    real: {
      thrustMps2: 6, // main engine, true-scale worlds (m/s²)
      thrustUps2: 0.4, // …game worlds (units/s²)
      kickMps2: 20, // launch kick off the pad (m/s), true-scale
      kickUps2: 0.6, // …game worlds
      boost: 3,
      yawRate: 0.8,
      pitchRate: 0.6,
    },
  },
  // P2/P4 slots: drive (rover/cruiser — surface driving, park), aircraft
  // (atmosphere dynamics), bouncy (elastic hops). A mover is a plugin in
  // core/motion.js; add its kind here and its step there.
}

export const CRAFT_KINDS = Object.keys(CRAFT_TYPES)

/** Adrift astronaut (EVA): jetpack over real gravity. */
export const EVA_TUNING = {
  thrustMps2: 1.8, // base jetpack, true-scale worlds (m/s²)
  thrustUps2: 0.12, // …game worlds (units/s²)
  boost: 3, // Shift multiplier
  hoverRatio: 1.6, // jetpack thrust = max(base, hoverRatio × local gravity)
  yawRate: 1.9,
  pitchRate: 1.5,
}
