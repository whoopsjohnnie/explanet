/**
 * WalkHud.jsx — floating strip while walking on a planet surface: what world
 * you're standing on, live altitude / vertical speed, control hints and a
 * detach button. Live numbers are polled from the core walker telemetry
 * side-channel at ~8 Hz so 60 Hz physics never flows through React state.
 */

import { useEffect, useState } from 'react'
import { useStore } from '../../state/store.js'
import { walkReadout } from '../../core/surface.js'

export default function WalkHud() {
  const planetId = useStore((s) => s.walkMode?.planetId)
  const planet = useStore((s) => s.world.planets.find((p) => p.id === planetId))
  const worldScale = useStore((s) => s.world.scale) // true-scale worlds show meters (scale = meters per unit)
  const exitWalkMode = useStore((s) => s.exitWalkMode)

  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 120)
    return () => clearInterval(t)
  }, [])

  if (!planetId) return null
  const r = walkReadout
  const airborne = !r.grounded
  const atmo = planet?.atmosphere
  // true-scale worlds (world.scale = meters per unit): the walker is a
  // human, so the readout is human meters — units × m/u, fixed decimals.
  const real = worldScale ? worldScale : null
  const toM = (v) => (real ? v * real : v)
  const fmt = real
    ? (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1))
    : (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(2))
  // surface pressure in atm: 92 / 1.01 / 0.0064 / 1e-5 — thin air goes
  // scientific, like everywhere else on a true-scale world
  const fmtAtm = (p) =>
    p === 0 ? '0' : p >= 100 ? String(Math.round(p)) : p >= 1 ? p.toFixed(2) : p >= 0.001 ? String(+p.toPrecision(2)) : p.toExponential(0)

  return (
    <div className="walk-hud">
      <div className="walk-hud-title">
        <span>🚀 Surface mode — {planet?.name ?? '…'}</span>
        <button
          className="btn"
          onClick={(e) => {
            e.currentTarget.blur()
            exitWalkMode()
          }}
          title="Return to the editor camera (Esc)"
        >
          Lift off · Esc
        </button>
      </div>
      <div className="walk-hud-stats">
        <span className={airborne ? 'walk-hud-air' : ''}>
          {airborne ? 'falling' : 'grounded'} · alt {fmt(toM(r.alt))}
          {real ? ' m' : ''} · ↕ {fmt(toM(r.vel))}
          {real ? ' m/s' : ''}
          {r.sprint ? ' · sprint' : ''}
        </span>
        <span className={atmo ? 'walk-hud-atmo' : 'walk-hud-atmo vacuum'} title={atmo ? 'Surface pressure' : 'No atmosphere — bare vacuum'}>
          {atmo ? `atm ${fmtAtm(atmo.pressure)}` : 'no air'}
        </span>
      </div>
      <div className="walk-hud-keys">W A S D move · Shift sprint · Space jump · Hold &amp; drag look</div>
    </div>
  )
}
