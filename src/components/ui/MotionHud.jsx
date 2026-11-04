/**
 * MotionHud.jsx — the floating strip for the astronaut's session.
 *
 * One HUD for all three motion sessions, showing the live numbers from the
 * core side channels (walkReadout for on foot, motionReadout for craft /
 * EVA) polled at ~8 Hz — 60 Hz physics never flows through React state:
 *
 *   on foot  — where you stand, altitude / vertical speed, air, controls;
 *   in craft — the craft's name + realism, its mode (parked / flying), and
 *              the body-relative readout: the dominant body with its
 *              continuous dominance share (how deep you are in its
 *              influence), altitude above the terrain, body-relative speed
 *              and lat/lon — fading in as that share grows, no hard trigger;
 *   adrift   — the EVA speed and the nearest body's altitude.
 */

import { useEffect, useState } from 'react'
import { useStore } from '../../state/store.js'
import { walkReadout, walkerLocation } from '../../core/surface.js'
import { motionReadout } from '../../core/motion.js'

export default function MotionHud() {
  const player = useStore((s) => s.player)
  const worldScale = useStore((s) => s.world.scale) // true-scale worlds show meters (scale = meters per unit)
  const setFreeCam = useStore((s) => s.setFreeCam)
  const ejectCraft = useStore((s) => s.ejectCraft)
  const boardNearestCraft = useStore((s) => s.boardNearestCraft)
  const launchCraft = useStore((s) => s.launchCraft)
  const craft = useStore((s) =>
    s.player?.kind === 'craft' ? (s.world.crafts || []).find((c) => c.id === s.player.craftId) : null
  )
  const planet = useStore((s) =>
    s.player?.kind === 'foot' ? s.world.planets.find((p) => p.id === s.player.bodyId) : null
  )
  const craftHere = useStore(
    (s) =>
      s.player?.kind === 'foot' &&
      (s.world.crafts || []).some((c) => c.pose && c.pose.anchor?.bodyId === s.player.bodyId)
  )

  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 120)
    return () => clearInterval(t)
  }, [])

  if (!player || player.kind === 'freeCam') return null

  // true-scale worlds (world.scale = meters per unit): everything in human
  // meters — units × m/u, fixed decimals.
  const real = worldScale || null
  const toM = (v) => (real ? v * real : v)
  const fmt = real
    ? (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1))
    : (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(2))

  // ------------------------------------------------------------ on foot ---
  if (player.kind === 'foot') {
    const r = walkReadout
    const L = walkerLocation // the body-relative location, owned by the walker
    const airborne = !r.grounded
    const atmo = planet?.atmosphere
    const fmtAtm = (p) =>
      p === 0
        ? '0'
        : p >= 100
          ? String(Math.round(p))
          : p >= 1
            ? p.toFixed(2)
            : p >= 0.001
              ? String(+p.toPrecision(2))
              : p.toExponential(0)
    return (
      <div className="motion-hud">
        <div className="motion-hud-title">
          <span>🚶 On foot — {planet?.name ?? '…'}</span>
          {craftHere && (
            <button className="btn" onClick={(e) => (e.currentTarget.blur(), boardNearestCraft())} title="Board the craft parked here (E)">
              🛸 Board
            </button>
          )}
          <button className="btn" onClick={(e) => (e.currentTarget.blur(), setFreeCam())} title="Return to the editor camera (Esc)">
            Free cam · Esc
          </button>
        </div>
        <div className="motion-hud-stats">
          <span
            className="motion-hud-atmo"
            title="Your position on this body — geocentric latitude/longitude in its body-fixed frame (constant while you stand still, even as it spins and orbits)"
          >
            {Math.abs(L.lat).toFixed(1)}°{L.lat >= 0 ? 'N' : 'S'} {Math.abs(L.lon).toFixed(1)}°
            {L.lon >= 0 ? 'E' : 'W'}
          </span>
          <span className={airborne ? 'motion-hud-air' : ''}>
            {airborne ? 'falling' : 'grounded'} · alt {fmt(toM(r.alt))}
            {real ? ' m' : ''} · ↕ {fmt(toM(r.vel))}
            {real ? ' m/s' : ''}
            {r.sprint ? ' · sprint' : ''}
          </span>
          <span
            className={atmo ? 'motion-hud-atmo' : 'motion-hud-atmo vacuum'}
            title={atmo ? 'Surface pressure' : 'No atmosphere — bare vacuum'}
          >
            {atmo ? `atm ${fmtAtm(atmo.pressure)}` : 'no air'}
          </span>
        </div>
        <div className="motion-hud-keys">W A S D move · Shift sprint · Space jump · E board · Hold &amp; drag look</div>
      </div>
    )
  }

  // ------------------------------------------------------ in a craft -----
  if (player.kind === 'craft') {
    const r = motionReadout
    const isDrive = craft?.kind === 'drive'
    const parked = r.mode === 'park'
    return (
      <div className="motion-hud">
        <div className="motion-hud-title">
          <span>
            {isDrive ? `🚙 ${craft?.name ?? 'Rover'} · driving` : craft ? `${craft.name} · ${craft.realism}` : 'Craft'}
            {!isDrive && (parked ? ' · parked' : ' · flying')}
          </span>
          {!isDrive && parked && (
            <button className="btn btn-accent" onClick={(e) => (e.currentTarget.blur(), launchCraft(player.craftId))} title="Launch off the pad">
              🚀 Launch
            </button>
          )}
          <button className="btn" onClick={(e) => (e.currentTarget.blur(), ejectCraft())} title="Eject the astronaut (E)">
            Eject · E
          </button>
        </div>
        <div className="motion-hud-stats">
          {isDrive ? (
            <>
              {r.bodyName && <span>on {r.bodyName}</span>}
              <span title="Ground speed — tile-anchored game pace (a multiple of the body's hex-tile size)">{fmt(toM(r.relSpeed))}
                {real ? ' m/s' : ' u/s'}</span>
              {r.lat != null && (
                <span className="motion-hud-atmo">
                  {Math.abs(r.lat).toFixed(1)}°{r.lat >= 0 ? 'N' : 'S'} {Math.abs(r.lon).toFixed(1)}°
                  {r.lon >= 0 ? 'E' : 'W'}
                </span>
              )}
            </>
          ) : (
            <>
              {!parked && r.bodyName && (
                <span title="Share of the total gravitational pull this body exerts on the craft — the soft body-relative transition">
                  over {r.bodyName} · {(r.dominance * 100).toFixed(0)}%
                </span>
              )}
              <span>
                alt {fmt(toM(r.altitude))}
                {real ? ' m' : ''} · {fmt(toM(r.relSpeed))}
                {real ? ' m/s' : ' u/s'}
              </span>
              {r.lat != null && (
                <span className="motion-hud-atmo">
                  {Math.abs(r.lat).toFixed(1)}°{r.lat >= 0 ? 'N' : 'S'} {Math.abs(r.lon).toFixed(1)}°
                  {r.lon >= 0 ? 'E' : 'W'}
                </span>
              )}
            </>
          )}
        </div>
        <div className="motion-hud-keys">
          {isDrive
            ? 'W throttle · S brake · A/D steer · Shift boost · C chase · E eject · Esc free-cam'
            : parked
              ? '🚀 Launch (above) · Eject · Esc free-cam'
              : 'W thrust · S brake · A/D strafe · R/F up·down · Shift boost · Space retro · drag aim · C chase · E eject'}
        </div>
      </div>
    )
  }

  // ------------------------------------------------------------- adrift ---
  const r = motionReadout
  return (
    <div className="motion-hud">
      <div className="motion-hud-title">
        <span>🧑‍🚀 Adrift — EVA</span>
        <button className="btn" onClick={(e) => (e.currentTarget.blur(), boardNearestCraft())} title="Board the nearest craft within reach (E)">
          🛸 Board · E
        </button>
        <button className="btn" onClick={(e) => (e.currentTarget.blur(), setFreeCam())} title="Return to the editor camera (Esc)">
          Free cam · Esc
        </button>
      </div>
      <div className="motion-hud-stats">
        <span>
          {fmt(toM(r.evaSpeed))}
          {real ? ' m/s' : ' u/s'}
        </span>
        {r.evaBodyName && (
          <span title="Nearest body and your altitude above its surface — landing ends the EVA">
            over {r.evaBodyName} · alt {fmt(toM(r.evaAltitude))}
            {real ? ' m' : ''}
          </span>
        )}
      </div>
      <div className="motion-hud-keys">W A S D R F jetpack · Shift boost · drag look · E board · Esc free-cam</div>
    </div>
  )
}
