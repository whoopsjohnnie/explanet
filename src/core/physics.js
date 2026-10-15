/**
 * physics.js
 * ---------------------------------------------------------------------------
 * N-body gravity on top of @react-three/cannon.
 *
 * The cannon world runs with zero global gravity. Every physics tick we
 * apply pairwise Newtonian forces  F = G · m1 · m2 / d²  between all planet
 * bodies, so planets orbit, slingshot and collide realistically. Body
 * positions/velocities are streamed into a mutable registry so the gravity
 * loop, the UI and the file saver can read them every frame without pushing
 * 60 Hz updates through React state.
 */

export const registry = {
  // id -> { api, pos:{x,y,z}, vel:{x,y,z}, quat:{x,y,z,w}, mass, isStatic, radius }
  // pos/vel/quat are live; the surface walker (core/surface.js) composes the
  // world pose of an on-surface avatar from pos + quat·(localDir·r).
  bodies: new Map(),
}

export function registerBody(id, entry) {
  registry.bodies.set(id, entry)
  return () => registry.bodies.delete(id)
}

export function getBody(id) {
  return registry.bodies.get(id)
}

/**
 * One gravity substep: pairwise force application.
 * Called from useFrame inside <Physics>.
 */
export function stepGravity(G) {
  const bodies = [...registry.bodies.values()]
  const n = bodies.length
  for (let i = 0; i < n; i++) {
    const a = bodies[i]
    if (!a.api) continue
    for (let j = i + 1; j < n; j++) {
      const b = bodies[j]
      const dx = b.pos.x - a.pos.x
      const dy = b.pos.y - a.pos.y
      const dz = b.pos.z - a.pos.z
      const distSq = dx * dx + dy * dy + dz * dz
      const dist = Math.sqrt(distSq)
      if (dist < 1e-6) continue
      // force magnitude on each body
      const F = (G * a.mass * b.mass) / (distSq + 4) // small softening
      const nx = dx / dist
      const ny = dy / dist
      const nz = dz / dist
      if (!a.isStatic) a.api.applyForce([F * nx, F * ny, F * nz], [a.pos.x, a.pos.y, a.pos.z])
      if (!b.isStatic) b.api.applyForce([-F * nx, -F * ny, -F * nz], [b.pos.x, b.pos.y, b.pos.z])
    }
  }
}

/** Circular orbit speed at distance r around a mass m, matching the
 *  softened force law used in stepGravity: v² / r = G·m / (r² + ε²). */
export function orbitalSpeed(G, mass, r) {
  return Math.sqrt((G * mass * r) / (r * r + 4))
}
