/**
 * AddPlanetDialog.jsx — modal for spawning a new body.
 */

import { useState } from 'react'
import { useStore } from '../../state/store.js'
import { PRESETS } from '../../core/generators.js'
import { cellCountForFrequency, radiusFromCellCount } from '../../core/hexsphere.js'
import { planetStats } from '../../core/planetMath.js'

export default function AddPlanetDialog() {
  const setShowAddDialog = useStore((s) => s.setShowAddDialog)
  const addPlanet = useStore((s) => s.addPlanet)
  const planets = useStore((s) => s.world.planets)
  const selectedId = useStore((s) => s.selectedId)

  const [name, setName] = useState('New Planet')
  const [preset, setPreset] = useState('earthlike')
  const [frequency, setFrequency] = useState(6)
  const [density, setDensity] = useState(0.05)
  const [spinY, setSpinY] = useState(0.4)
  const [orbit, setOrbit] = useState(true)
  const [orbitDistance, setOrbitDistance] = useState(28)

  const parent = planets.find((p) => p.id === selectedId)
  const cells = cellCountForFrequency(frequency)
  const isStar = preset === 'star'

  const create = () => {
    addPlanet({
      name,
      preset,
      frequency,
      density,
      spin: { x: 0, y: spinY, z: 0 },
      orbit: !isStar && orbit && parent ? parent.id : null,
      orbitDistance,
    })
  }

  return (
    <div className="modal-backdrop" onClick={() => setShowAddDialog(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Add Planet</div>

        <label className="form-field">
          <span>Name</span>
          <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
        </label>

        <label className="form-field">
          <span>Preset</span>
          <select className="text-input" value={preset} onChange={(e) => setPreset(e.target.value)}>
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label className="form-field">
          <span>
            Size — {cells} hex cells · radius {radiusFromCellCount(cells).toFixed(1)}
          </span>
          <input
            type="range"
            min="2"
            max="14"
            step="1"
            value={frequency}
            onChange={(e) => setFrequency(parseInt(e.target.value))}
          />
        </label>

        <label className="form-field">
          <span>Density {density.toFixed(3)}</span>
          <input
            type="range"
            min="0.01"
            max="0.3"
            step="0.005"
            value={density}
            onChange={(e) => setDensity(parseFloat(e.target.value))}
          />
        </label>

        <label className="form-field">
          <span>Spin (y) {spinY.toFixed(2)}</span>
          <input
            type="range"
            min="-1.5"
            max="1.5"
            step="0.05"
            value={spinY}
            onChange={(e) => setSpinY(parseFloat(e.target.value))}
          />
        </label>

        <div className="form-field form-field--row">
          <label className="checkbox-line">
            <input
              type="checkbox"
              disabled={isStar || !parent}
              checked={!isStar && orbit && !!parent}
              onChange={(e) => setOrbit(e.target.checked)}
            />
            Orbit “{parent ? parent.name : '—'}”
            {parent && (
              <span className="muted"> (M {planetStats(parent).mass.toFixed(0)})</span>
            )}
          </label>
        </div>

        {!isStar && orbit && parent && (
          <label className="form-field">
            <span>Orbit distance {orbitDistance}</span>
            <input
              type="range"
              min="8"
              max="140"
              step="1"
              value={orbitDistance}
              onChange={(e) => setOrbitDistance(parseInt(e.target.value))}
            />
          </label>
        )}

        <div className="hint">
          Orbital velocity is computed automatically for a circular orbit around the parent.
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={() => setShowAddDialog(false)}>
            Cancel
          </button>
          <button className="btn btn-accent" onClick={create}>
            Create
          </button>
        </div>
      </div>
    </div>
  )
}
