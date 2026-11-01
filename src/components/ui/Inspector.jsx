/**
 * Inspector.jsx — right panel: selected body stats & editable properties,
 * plus world-level settings (G).
 */

import { useStore } from '../../state/store.js'
import { planetStats } from '../../core/planetMath.js'
import { registry } from '../../core/physics.js'
import { CRAFT_TYPES } from '../../core/craftTypes.js'
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

function CraftPanel({ craft }) {
  const updateCraft = useStore((s) => s.updateCraft)
  const removeCraft = useStore((s) => s.removeCraft)
  const boardCraft = useStore((s) => s.boardCraft)
  const ejectCraft = useStore((s) => s.ejectCraft)
  const launchCraft = useStore((s) => s.launchCraft)
  const player = useStore((s) => s.player)
  const world = useStore((s) => s.world)
  const inThis = player?.kind === 'craft' && player.craftId === craft.id
  const t = CRAFT_TYPES[craft.kind] || CRAFT_TYPES.shuttle
  const bodyName = (id) => world.planets.find((p) => p.id === id)?.name
  const parkedOn = craft.pose?.anchor ? bodyName(craft.pose.anchor.bodyId) : null

  return (
    <div className="inspector-body">
      <input
        className="text-input"
        value={craft.name}
        onChange={(e) => updateCraft(craft.id, { name: e.target.value })}
        spellCheck={false}
      />
      <div className="stat-grid">
        <div className="stat">
          <b>{t.icon} {t.label}</b>
          <span>kind</span>
        </div>
        <div className="stat">
          <b>{parkedOn ? `parked` : 'in space'}</b>
          <span>{parkedOn ? `on ${parkedOn}` : 'flying'}</span>
        </div>
      </div>

      <div className="field-row">
        <span className="field-label">Realism</span>
        <span className="field-value">
          <select value={craft.realism} onChange={(e) => updateCraft(craft.id, { realism: e.target.value })}>
            <option value="arcade">arcade — plug &amp; play</option>
            <option value="real">real — Newtonian</option>
          </select>
        </span>
      </div>
      <div className="hint">
        {craft.realism === 'real'
          ? 'Newtonian: gravity, inertia, capture, slingshot. Speeds are physical — cruises are patient burns.'
          : 'Arcade: no gravity, body-relative velocity eases to your input at tile-anchored speed. Plug & play.'}
      </div>

      <div className="surface-actions">
        {inThis ? (
          <>
            {craft.pose?.anchor && (
              <button className="btn btn-accent" onClick={(e) => (e.currentTarget.blur(), launchCraft(craft.id))}>
                🚀 Launch
              </button>
            )}
            <button className="btn" onClick={(e) => (e.currentTarget.blur(), ejectCraft())}>
              🧑‍🚀 Eject
            </button>
          </>
        ) : (
          <button className="btn btn-accent" onClick={(e) => (e.currentTarget.blur(), boardCraft(craft.id))}>
            🛸 Pilot
          </button>
        )}
        <button
          className="btn mini-btn--danger"
          onClick={(e) => {
            e.currentTarget.blur()
            removeCraft(craft.id)
          }}
        >
          ✕ Delete
        </button>
      </div>
    </div>
  )
}

export default function Inspector() {
  const world = useStore((s) => s.world)
  const selectedId = useStore((s) => s.selectedId)
  const selectedCraftId = useStore((s) => s.selectedCraftId)
  const updatePlanet = useStore((s) => s.updatePlanet)
  const setGravity = useStore((s) => s.setGravity)
  const capturePositions = useStore((s) => s.capturePositions)

  const craft = world.crafts?.find((c) => c.id === selectedCraftId)
  const planet = world.planets.find((p) => p.id === selectedId)
  const stats = planet ? planetStats(planet) : null

  return (
    <div className="panel panel-right">
      <div className="panel-title">Inspector</div>

      {craft && (
        <>
          <div className="section-label">Craft</div>
          <CraftPanel craft={craft} />
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
        </>
      )}

      {!craft && !planet && <div className="empty-hint">Select a body or craft in the scene or the list.</div>}

      {!craft && planet && (
        <div className="inspector-body">
          <input
            className="text-input"
            value={planet.name}
            onChange={(e) => updatePlanet(planet.id, { name: e.target.value })}
            spellCheck={false}
          />

          <div className="stat-grid">
            <div className="stat">
              <b>{stats.cellCount}</b>
              <span title="hex cells — atoms of one area unit each, the same size on every planet">atoms</span>
            </div>
            <div className="stat">
              <b>{stats.radius.toFixed(2)}</b>
              <span>radius</span>
            </div>
            <div className="stat">
              <b>{stats.mass.toFixed(1)}</b>
              <span>mass</span>
            </div>
            <div className="stat">
              <b>{stats.volume.toFixed(0)}</b>
              <span>volume</span>
            </div>
            <div className="stat">
              <b>{stats.landCells ?? '…'}</b>
              <span>land</span>
            </div>
            <div className="stat">
              <b>{stats.seaCells ?? '…'}</b>
              <span>sea</span>
            </div>
          </div>

          {!planet.elements && (
            <div className="hint">⏳ Streaming this body's atoms from the world database…</div>
          )}

          {planet.preset !== 'star' && (
            <div className="hint">
              {world.crafts?.some((c) => c.pose?.anchor?.bodyId === planet.id)
                ? 'A craft is parked here — pilot it and land to walk (E to eject).'
                : 'To walk here: launch a craft here and land it, then eject on the surface.'}
            </div>
          )}

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
