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
 * Inverse of keplerState: osculating elements from a Cartesian state vector.
 * Position is engine units, velocity engine u/s, both around a primary with
 * gravitational parameter mu (engine u³/s² — the Sun is 4π²·AU³/yr², the
 * same constant gen-sol-real derives periods from). Returns the document
 * convention { a, e, inc, node, peri, n, m0 }, so a fit drops straight into
 * a body's `scripts` field; `t` is the document time of the state (J2000
 * = 0) and m0 is back-shifted to t = 0, exactly like stateFrom() shifts
 * perihelion-derived anomalies.
 *
 * Null for states the analytic integrator cannot hold: a ≤ 0 (unbound),
 * e ≥ 0.999 (prepareOrbit rejects the same), or zero angular momentum.
 */
export function cartesianToElements(pos, vel, mu, t = 0) {
  // engine frame (x, y=north, z=−Y) → ecliptic (X, Y, Znorth): the map
  // keplerState itself applies after Rz(peri)·Rx(inc)·Rz(node)
  const rx = pos[0], ry = -pos[2], rz = pos[1]
  const vx = vel[0], vy = -vel[2], vz = vel[1]

  const r = Math.hypot(rx, ry, rz)
  const v2 = vx * vx + vy * vy + vz * vz
  if (!(r > 0) || !(mu > 0)) return null

  // vis-viva: specific energy → axis; a ≤ 0 is escape (no analytic ellipse)
  const a = 1 / (2 / r - v2 / mu)
  if (!(a > 0)) return null

  // angular momentum + eccentricity vector (both frame-invariant fits)
  const hx = ry * vz - rz * vy
  const hy = rz * vx - rx * vz
  const hz = rx * vy - ry * vx
  const h = Math.hypot(hx, hy, hz)
  if (!(h > 0)) return null
  const rv = rx * vx + ry * vy + rz * vz
  const emu = (v2 - mu / r) / mu
  const ex = emu * rx - (rv / mu) * vx
  const ey = emu * ry - (rv / mu) * vy
  const ez = emu * rz - (rv / mu) * vz
  const e = Math.hypot(ex, ey, ez)
  if (e >= 0.999) return null

  const inc = Math.acos(Math.max(-1, Math.min(1, hz / h)))
  // node line n̂ = Ẑ × ĥ; vanishes for equatorial orbits → node 0 and peri
  // measured from the ecliptic X axis instead (degenerate but exact)
  const equatorial = Math.hypot(hx, hy) < 1e-12 * h
  const node = equatorial ? 0 : Math.atan2(hx, -hy)
  let peri
  if (e < 1e-10) peri = 0 // circular: phase carried by m0 instead
  else if (equatorial) peri = Math.atan2(ey, ex)
  else {
    // peri = angle node → e about ĥ: atan2(ĥ·(n̂×ê), n̂·ê); common 1/|n̂|
    // factors drop under atan2. (NOT the Ẑ component — that is the angle
    // about the wrong axis; it only agrees at zero inclination.)
    const sinp = ((hx * hx + hy * hy) * ez - hz * (hx * ex + hy * ey)) / h
    const cosp = hx * ey - hy * ex
    peri = Math.atan2(sinp, cosp)
  }

  // Eccentric anomaly by projection onto the perifocal pair (x̂p, yĥ×x̂p) —
  // robust for every e ∈ [0, 1) and consistent with the (node, peri) basis
  // chosen above, so propagating the result reproduces the input exactly.
  let px = ex, py = ey, pz = ez
  if (e < 1e-10) {
    // x̂p = node line, matching peri = 0; equatorial fallback = X axis
    const nLen = Math.hypot(hx, hy)
    if (equatorial || nLen <= 0) { px = 1; py = 0; pz = 0 }
    else { px = -hy / nLen; py = hx / nLen; pz = 0 }
  } else { px /= e; py /= e; pz /= e }
  const yxp = (hy * pz - hz * py) / h
  const yyp = (hz * px - hx * pz) / h
  const yzp = (hx * py - hy * px) / h
  const cosE = (rx * px + ry * py + rz * pz) / a + e
  const sinE = (rx * yxp + ry * yyp + rz * yzp) / (a * Math.sqrt(Math.max(1 - e * e, 1e-12)))
  const E = Math.atan2(sinE, cosE)
  const M = E - e * Math.sin(E)

  let m0 = (M - ((mu / (a * a * a)) ** 0.5) * t) % TWO_PI
  if (m0 < 0) m0 += TWO_PI
  return { a, e, inc, node, peri, n: (mu / (a * a * a)) ** 0.5, m0 }
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
