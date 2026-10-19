/**
 * kepler.js — two-body state vectors for scripted (non-N-body) orbiters.
 *
 * Small bodies — moons, asteroids, comets — don't need their own gravity:
 * a 400 m rock tugging on Jupiter is not physics, it's noise. They are
 * integrated as test particles on their osculating ellipse instead, which
 * keeps a 900-body world cheap. Positions are engine units; the ecliptic is
 * the engine's XZ plane (Y = ecliptic north, prograde = counterclockwise
 * seen from +Y), the same frame gen-solar-world places planets in.
 *
 * Element convention (all angles radians, engine frame applied internally):
 *   a    semi-major axis (units)        e   eccentricity
 *   inc  inclination                     node longitude of ascending node
 *   peri argument of periapsis           n   mean motion (rad/s)
 *   m0   mean anomaly at t = 0 (seconds of document time)
 */

const TWO_PI = Math.PI * 2

/** Solve Kepler's equation E − e·sinE = M (Newton, 4–6 iters is plenty). */
export function solveKepler(M, e) {
  M = M % TWO_PI
  if (M < 0) M += TWO_PI
  let E = e < 0.8 ? M : Math.PI
  for (let k = 0; k < 12; k++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E))
    E -= dE
    if (Math.abs(dE) < 1e-10) break
  }
  return E
}

/**
 * Keplerian state at time t (seconds since epoch t0 of the elements).
 * Returns { pos: [x,y,z], vel: [x,y,z] } in engine units (+ u/s).
 */
export function keplerState(el, t, out) {
  const e = el.e
  const n = el.n
  const M = el.m0 + n * t
  const E = solveKepler(M, e)
  const cosE = Math.cos(E)
  const sinE = Math.sin(E)
  const b = el.a * Math.sqrt(Math.max(1 - e * e, 1e-12)) // semi-minor
  // perifocal coords (origin at focus)
  const xp = el.a * (cosE - e)
  const yp = b * sinE
  // perifocal velocity: Ė = n/(1 − e·cosE)
  const Edot = n / Math.max(1 - e * cosE, 1e-9)
  const vxp = -el.a * sinE * Edot
  const vyp = b * cosE * Edot

  // rotate: perifocal → ecliptic by Rz(peri)·Rx(inc)·Rz(node), then map
  // ecliptic (X, Y, Znorth) to engine (x=X, y=Znorth, z=−Y)
  const cw = Math.cos(el.peri)
  const sw = Math.sin(el.peri)
  const ci = Math.cos(el.inc)
  const si = Math.sin(el.inc)
  const cn = Math.cos(el.node)
  const sn = Math.sin(el.node)
  // combined 3×3 (rows applied to (xp, yp, 0)) — precomputed ecliptic basis
  const px = xp * cw - yp * sw
  const py = xp * sw + yp * cw
  const qx = px * cn - py * ci * sn
  const qy = px * sn + py * ci * cn
  const qz = py * si
  const vxpx = vxp * cw - vyp * sw
  const vypx = vxp * sw + vyp * cw
  const vqx = vxpx * cn - vypx * ci * sn
  const vqy = vxpx * sn + vypx * ci * cn
  const vqz = vypx * si

  const o = out || { pos: [0, 0, 0], vel: [0, 0, 0] }
  o.pos[0] = qx
  o.pos[1] = qz // ecliptic north → engine +Y
  o.pos[2] = -qy
  o.vel[0] = vqx
  o.vel[1] = vqz
  o.vel[2] = -vqy
  return o
}

/**
 * Normalize an orbit descriptor from the world document (engine units) and
 * validate it. Returns null for anything degenerate (caller falls back to
 * a static placement).
 */
export function prepareOrbit(so) {
  if (!so) return null
  const { a, e, inc, node, peri, n, m0 } = so
  if (![a, e, inc, node, peri, n, m0].every((v) => Number.isFinite(v))) return null
  if (a <= 0 || n <= 0 || e < 0 || e >= 0.999) return null
  return { a, e, inc, node, peri, n, m0 }
}
