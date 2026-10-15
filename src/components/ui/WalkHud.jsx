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
  const exitWalkMode = useStore((s) => s.exitWalkMode)

  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 120)
    return () => clearInterval(t)
  }, [])

  if (!planetId) return null
  const r = walkReadout
  const airborne = !r.grounded

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
          {airborne ? 'falling' : 'grounded'} · alt {r.alt.toFixed(2)} · ↕ {r.vel.toFixed(1)}
          {r.sprint ? ' · sprint' : ''}
        </span>
      </div>
      <div className="walk-hud-keys">W A S D move · Shift sprint · Space jump · drag look · scroll zoom</div>
    </div>
  )
}
