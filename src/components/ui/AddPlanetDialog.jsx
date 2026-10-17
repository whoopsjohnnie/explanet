/**
 * AddPlanetDialog.jsx — modal for spawning a new body.
 *
 * Size is specified as a TARGET MASS: the atom model resolves it to the
 * nearest legal hex grid (frequencyForMass), so every new planet is made
 * of the right number of same-size hexagonal atoms and its true mass is
 * quantized to that ladder.
 */

import { useState } from 'react'
import { useStore } from '../../state/store.js'
import { PRESETS } from '../../core/generators.js'
import { cellCountForFrequency } from '../../core/hexsphere.js'
import {
  planetStats,
  planetRadius,
  frequencyForMass,
  radiusForFrequency,
} from '../../core/planetMath.js'

const fmt = (v) =>
  v >= 1e5 || (v > 0 && v < 0.01) ? v.toExponential(1) : v >= 100 ? v.toFixed(0) : v.toFixed(2)

export default function AddPlanetDialog() {
  const setShowAddDialog = useStore((s) => s.setShowAddDialog)
  const addPlanet = useStore((s) => s.addPlanet)
  const planets = useStore((s) => s.world.planets)
  const selectedId = useStore((s) => s.selectedId)

  const [name, setName] = useState('New Planet')
  const [preset, setPreset] = useState('earthlike')
  const [massLog, setMassLog] = useState(3.2) // target mass = 10^massLog
  const [density, setDensity] = useState(0.05)
  const [spinY, setSpinY] = useState(0.4)
  const [orbit, setOrbit] = useState(true)
  const [orbitDistance, setOrbitDistance] = useState(28)

  const parent = planets.find((p) => p.id === selectedId)
  const isStar = preset === 'star'

  // mass → atom ladder: the grid (and every derived property) snaps to it
  const targetMass = 10 ** massLog
  const frequency = frequencyForMass(targetMass, density)
  const cells = cellCountForFrequency(frequency)
  const radius = radiusForFrequency(frequency)
  const achievedMass = density * (4 / 3) * Math.PI * radius ** 3

  const minOrbit = Math.ceil((parent ? planetRadius(parent) : 0) + radius + 2)
  const dist = Math.max(orbitDistance, minOrbit)

  const create = () => {
    addPlanet({
      name,
      preset,
      frequency,
      density,
      spin: { x: 0, y: spinY, z: 0 },
      orbit: !isStar && orbit && parent ? parent.id : null,
      orbitDistance: dist,
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
          <span>Mass ≈ {fmt(targetMass)}</span>
          <input
            type="range"
            min="0"
            max="8"
            step="0.02"
            value={massLog}
            onChange={(e) => setMassLog(parseFloat(e.target.value))}
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

        <div className="hint">
          ⬡ {cells.toLocaleString()} atoms · radius {radius.toFixed(2)} · mass quantizes to ≈{' '}
          {fmt(achievedMass)} — every hex is the same size on every planet, so mass sets the
          atom count.
        </div>

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
            <span>Orbit distance {dist}</span>
            <input
              type="range"
              min={minOrbit}
              max={Math.max(140, minOrbit + 100)}
              step="1"
              value={dist}
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
