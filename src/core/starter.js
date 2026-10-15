/**
 * starter.js
 * ---------------------------------------------------------------------------
 * Builds the demo solar system: one star, two planets on circular orbits and
 * a moon. Used as the app's initial world and by scripts/gen-sample-world.mjs
 * to (re)generate public/world.json. Node-importable (no DOM access).
 */

import { createEmptyWorld, createPlanet } from './worldSchema.js'
import { planetMass } from './planetMath.js'
import { orbitalSpeed } from './physics.js'

/** Tangential velocity for a circular orbit around the origin-ish point. */
function tangential(pos, speed) {
  const rx = pos.x, rz = pos.z
  const l = Math.hypot(rx, rz) || 1
  // ω ŷ × r → (rz, 0, -rx)
  return { x: (rz / l) * speed, y: 0, z: (-rx / l) * speed }
}

export function makeStarterWorld() {
  const world = createEmptyWorld('Helios System')
  const G = world.gravity

  const star = createPlanet({
    name: 'Helios',
    preset: 'star',
    frequency: 8,
    seed: 1207,
    isStatic: true,
    spin: { x: 0, y: 0.08, z: 0 },
    center: { x: 0, y: 0, z: 0 },
  })
  world.planets.push(star)

  const mStar = planetMass(star)

  const aqua = createPlanet({
    name: 'Aqua',
    preset: 'earthlike',
    frequency: 6,
    seed: 42,
    spin: { x: 0, y: 0.5, z: 0 },
    center: { x: 46, y: 0, z: 0 },
  })
  aqua.velocity = tangential(aqua.center, orbitalSpeed(G, mStar, 46))
  world.planets.push(aqua)

  const rust = createPlanet({
    name: 'Rust',
    preset: 'desert',
    frequency: 5,
    seed: 77,
    density: 0.045,
    spin: { x: 0, y: -0.3, z: 0 },
    center: { x: 0, y: 0, z: -78 },
  })
  rust.velocity = tangential(rust.center, orbitalSpeed(G, mStar, 78))
  world.planets.push(rust)

  const mRust = planetMass(rust)
  const moonOffset = { x: 12, y: 0, z: 0 }
  const moon = createPlanet({
    name: 'Pebble',
    preset: 'moon',
    frequency: 3,
    seed: 999,
    density: 0.04,
    spin: { x: 0, y: 0.2, z: 0 },
    center: {
      x: rust.center.x + moonOffset.x,
      y: rust.center.y,
      z: rust.center.z + moonOffset.z,
    },
  })
  const moonOrbit = tangential(moonOffset, orbitalSpeed(G, mRust, 12))
  moon.velocity = {
    x: rust.velocity.x + moonOrbit.x,
    y: rust.velocity.y + moonOrbit.y,
    z: rust.velocity.z + moonOrbit.z,
  }
  world.planets.push(moon)

  return world
}
