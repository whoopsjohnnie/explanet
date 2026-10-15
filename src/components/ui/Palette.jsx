/**
 * Palette.jsx — bottom toolbar: tools, terrain brushes, brush size & power.
 */

import { useStore } from '../../state/store.js'
import { TERRAIN_TYPES, TERRAIN_KEYS } from '../../core/terrain.js'

const TOOLS = [
  { id: 'select', label: 'Select', key: 'V', icon: '⌖' },
  { id: 'paint', label: 'Paint', key: 'B', icon: '🖌' },
  { id: 'raise', label: 'Raise', key: 'R', icon: '▲' },
  { id: 'lower', label: 'Lower', key: 'F', icon: '▼' },
]

export default function Palette() {
  const tool = useStore((s) => s.tool)
  const setTool = useStore((s) => s.setTool)
  const brushType = useStore((s) => s.brushType)
  const setBrushType = useStore((s) => s.setBrushType)
  const brushSize = useStore((s) => s.brushSize)
  const setBrushSize = useStore((s) => s.setBrushSize)
  const strength = useStore((s) => s.strength)
  const setStrength = useStore((s) => s.setStrength)

  return (
    <div className="palette">
      <div className="palette-tools">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={`tool-btn ${tool === t.id ? 'tool-btn--active' : ''}`}
            onClick={() => setTool(t.id)}
            title={`${t.label} (${t.key})`}
          >
            <span className="tool-icon">{t.icon}</span>
            <span className="tool-name">{t.label}</span>
          </button>
        ))}
      </div>

      <div className="palette-divider" />

      <div className="terrain-grid">
        {TERRAIN_KEYS.map((key, i) => {
          const def = TERRAIN_TYPES[key]
          return (
            <button
              key={key}
              className={`terrain-chip ${tool === 'paint' && brushType === key ? 'terrain-chip--active' : ''}`}
              style={{ background: def.color }}
              onClick={() => setBrushType(key)}
              title={`${def.label} (${i + 1})`}
            >
              <span className="terrain-chip-label">{def.label}</span>
            </button>
          )
        })}
      </div>

      <div className="palette-divider" />

      <label className="slider-field">
        <span>Brush {brushSize === 0 ? '·' : brushSize}</span>
        <input
          type="range"
          min="0"
          max="3"
          step="1"
          value={brushSize}
          onChange={(e) => setBrushSize(parseInt(e.target.value))}
        />
      </label>
      <label className="slider-field">
        <span>Power {strength.toFixed(2)}</span>
        <input
          type="range"
          min="0.02"
          max="0.6"
          step="0.02"
          value={strength}
          onChange={(e) => setStrength(parseFloat(e.target.value))}
        />
      </label>
    </div>
  )
}
