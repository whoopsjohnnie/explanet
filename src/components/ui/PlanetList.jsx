/**
 * PlanetList.jsx — left panel: every body in the world with quick stats.
 */

import { useStore } from '../../state/store.js'
import { planetStats } from '../../core/planetMath.js'
import { TERRAIN_TYPES } from '../../core/terrain.js'

function dominantColor(planet) {
  const counts = new Map()
  for (const el of planet.elements) counts.set(el.t, (counts.get(el.t) || 0) + 1)
  let best = 'grass'
  let max = -1
  for (const [t, n] of counts) {
    if (n > max) {
      max = n
      best = t
    }
  }
  return TERRAIN_TYPES[best]?.color || '#5aa15d'
}

export default function PlanetList() {
  const planets = useStore((s) => s.world.planets)
  const selectedId = useStore((s) => s.selectedId)
  const select = useStore((s) => s.select)
  const removePlanet = useStore((s) => s.removePlanet)
  const duplicatePlanet = useStore((s) => s.duplicatePlanet)

  return (
    <div className="panel panel-left">
      <div className="panel-title">World Bodies</div>
      <div className="planet-list">
        {planets.length === 0 && (
          <div className="empty-hint">
            No bodies yet.
            <br />
            Add a star, then planets orbiting it.
          </div>
        )}
        {planets.map((p) => {
          const stats = planetStats(p)
          return (
            <div
              key={p.id}
              className={`planet-item ${p.id === selectedId ? 'planet-item--active' : ''}`}
              onClick={() => select(p.id)}
            >
              <span className="planet-dot" style={{ background: dominantColor(p) }} />
              <div className="planet-item-main">
                <div className="planet-item-name">
                  {p.name}
                  {p.isStatic && <span className="badge">static</span>}
                  {p.preset === 'star' && <span className="badge badge-star">star</span>}
                </div>
                <div className="planet-item-stats">
                  R {stats.radius.toFixed(1)} · M {stats.mass.toFixed(0)} · {stats.cellCount} hex
                </div>
              </div>
              <div className="planet-item-actions">
                <button
                  className="mini-btn"
                  title="Duplicate"
                  onClick={(e) => {
                    e.stopPropagation()
                    duplicatePlanet(p.id)
                  }}
                >
                  ⧉
                </button>
                <button
                  className="mini-btn mini-btn--danger"
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation()
                    removePlanet(p.id)
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
