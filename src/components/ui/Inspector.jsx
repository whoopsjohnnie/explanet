/**
 * Inspector.jsx — right panel: selected body stats & editable properties,
 * plus world-level settings (G).
 */

import { useStore } from '../../state/store.js'
import { planetStats } from '../../core/planetMath.js'
import { registry } from '../../core/physics.js'
import { saveWorldUI } from './actions.js'

function Row({ label, children }) {
  return (
    <div className="field-row">
      <span className="field-label">{label}</span>
      <span className="field-value">{children}</span>
    </div>
  )
}

function NumInput({ value, onChange, step = 0.1, width = 62 }) {
  return (
    <input
      type="number"
      className="num-input"
      style={{ width }}
      value={Number.isFinite(value) ? Number(value.toFixed(3)) : 0}
      step={step}
      onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
    />
  )
}

function Vec3Editor({ label, value, onChange, step = 0.5 }) {
  return (
    <div className="vec3">
      <span className="vec3-label">{label}</span>
      {['x', 'y', 'z'].map((k) => (
        <NumInput key={k} value={value[k]} step={step} onChange={(v) => onChange({ ...value, [k]: v })} />
      ))}
    </div>
  )
}

export default function Inspector() {
  const world = useStore((s) => s.world)
  const selectedId = useStore((s) => s.selectedId)
  const updatePlanet = useStore((s) => s.updatePlanet)
  const setGravity = useStore((s) => s.setGravity)
  const capturePositions = useStore((s) => s.capturePositions)
  const landOnPlanet = useStore((s) => s.landOnPlanet)
  const exitWalkMode = useStore((s) => s.exitWalkMode)
  const walkingHere = useStore((s) => s.walkMode?.planetId)

  const planet = world.planets.find((p) => p.id === selectedId)

  return (
    <div className="panel panel-right">
      <div className="panel-title">Inspector</div>

      {!planet && <div className="empty-hint">Select a body in the scene or the list.</div>}

      {planet && (
        <div className="inspector-body">
          <input
            className="text-input"
            value={planet.name}
            onChange={(e) => updatePlanet(planet.id, { name: e.target.value })}
            spellCheck={false}
          />

          <div className="stat-grid">
            <div className="stat">
              <b>{planet.elements.length}</b>
              <span>hex cells</span>
            </div>
            <div className="stat">
              <b>{planetStats(planet).radius.toFixed(2)}</b>
              <span>radius</span>
            </div>
            <div className="stat">
              <b>{planetStats(planet).mass.toFixed(1)}</b>
              <span>mass</span>
            </div>
            <div className="stat">
              <b>{planetStats(planet).volume.toFixed(0)}</b>
              <span>volume</span>
            </div>
            <div className="stat">
              <b>{planetStats(planet).landCells}</b>
              <span>land</span>
            </div>
            <div className="stat">
              <b>{planetStats(planet).seaCells}</b>
              <span>sea</span>
            </div>
          </div>

          <div className="surface-actions">
            {planet.preset === 'star' ? (
              <div className="hint">Stars have no walkable surface.</div>
            ) : (
              <button
                className={`btn ${walkingHere === planet.id ? 'btn-on' : 'btn-accent'}`}
                onClick={(e) => {
                  e.currentTarget.blur()
                  if (walkingHere === planet.id) exitWalkMode()
                  else landOnPlanet(planet.id)
                }}
                title="Drop onto this planet and walk its surface"
              >
                {walkingHere === planet.id ? '🚁 Lift off' : '🚀 Land on surface'}
              </button>
            )}
          </div>

          <div className="section-label">Physical</div>
          <Row label={`Density ${planet.density.toFixed(3)}`}>
            <input
              type="range"
              min="0.01"
              max="0.3"
              step="0.005"
              value={planet.density}
              onChange={(e) => updatePlanet(planet.id, { density: parseFloat(e.target.value) })}
            />
          </Row>
          <Row label="Unmovable (static)">
            <input
              type="checkbox"
              checked={!!planet.isStatic}
              onChange={(e) => updatePlanet(planet.id, { isStatic: e.target.checked })}
            />
          </Row>

          <div className="section-label">Motion</div>
          <Vec3Editor
            label="Spin"
            step={0.05}
            value={planet.spin}
            onChange={(v) => updatePlanet(planet.id, { spin: v })}
          />
          <Vec3Editor
            label="Velocity"
            step={0.25}
            value={planet.velocity}
            onChange={(v) => updatePlanet(planet.id, { velocity: v })}
          />

          <div className="section-label">Position</div>
          <Vec3Editor
            label="Center"
            step={1}
            value={planet.center}
            onChange={(v) => updatePlanet(planet.id, { center: v })}
          />
          <div className="inspector-actions">
            <button className="btn" onClick={capturePositions} title="Copy live physics positions into the document">
              Capture live positions
            </button>
            <button className="btn" onClick={() => saveWorldUI(false)}>
              Save world
            </button>
          </div>

          <div className="hint">
            Live: x {(registry.bodies.get(planet.id)?.pos.x ?? NaN).toFixed(1)} · y{' '}
            {(registry.bodies.get(planet.id)?.pos.y ?? NaN).toFixed(1)} · z{' '}
            {(registry.bodies.get(planet.id)?.pos.z ?? NaN).toFixed(1)}
          </div>
        </div>
      )}

      <div className="section-label">World</div>
      <Row label={`Gravity G ${world.gravity.toFixed(0)}`}>
        <input
          type="range"
          min="5"
          max="200"
          step="1"
          value={world.gravity}
          onChange={(e) => setGravity(parseFloat(e.target.value))}
        />
      </Row>
      <div className="hint">
        Bodies attract with F = G·m₁·m₂/d². Mass & radius derive from hex cell counts + heights.
      </div>
    </div>
  )
}
