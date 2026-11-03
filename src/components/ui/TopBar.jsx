/**
 * TopBar.jsx — title, world name, play/pause, follow, save/open, add planet.
 */

import { useStore } from '../../state/store.js'
import { saveWorldUI, openWorldUI } from './actions.js'

export default function TopBar() {
  const worldName = useStore((s) => s.world.name)
  const dirty = useStore((s) => s.dirty)
  const fileName = useStore((s) => s.fileName)
  const playing = useStore((s) => s.playing)
  const followSelected = useStore((s) => s.followSelected)
  const showLabels = useStore((s) => s.showLabels)
  const togglePlay = useStore((s) => s.togglePlay)
  const toggleFollow = useStore((s) => s.toggleFollow)
  const setShowLabels = useStore((s) => s.setShowLabels)
  const setShowAddDialog = useStore((s) => s.setShowAddDialog)
  const renameWorld = useStore((s) => s.renameWorld)
  const planetCount = useStore((s) => s.world.planets.length)
  const player = useStore((s) => s.player)
  const setFreeCam = useStore((s) => s.setFreeCam)
  const addCraft = useStore((s) => s.addCraft)

  return (
    <div className="topbar">
      <div className="brand">
        <span className="brand-mark">⬡</span>
        <span className="brand-name">ExPlanet</span>
      </div>

      <input
        className="world-name"
        value={worldName}
        onChange={(e) => renameWorld(e.target.value)}
        spellCheck={false}
        aria-label="World name"
      />
      <span className="file-chip">
        {fileName || 'world.json'}
        {dirty ? ' •' : ''}
      </span>
      <span className="count-chip">{planetCount} bodies</span>

      <div className="topbar-spacer" />

      <button className={`btn ${playing ? 'btn-primary' : ''}`} onClick={togglePlay} title="Space">
        {playing ? '⏸ Pause' : '▶ Play'}
      </button>
      <button
        className={`btn ${followSelected ? 'btn-on' : ''}`}
        onClick={toggleFollow}
        title="Keep the camera locked to the selected body"
      >
        ⌖ Follow
      </button>
      <button
        className={`btn ${showLabels ? 'btn-on' : ''}`}
        onClick={() => setShowLabels(!showLabels)}
        title="L"
      >
        🏷 Labels
      </button>
      {/* The astronaut's default is to walk; this is the escape hatch back to
          the editor's free orbit camera (the old mode, kept and toggled). */}
      <button
        className={`btn ${!player || player.kind === 'freeCam' ? 'btn-on' : ''}`}
        onClick={setFreeCam}
        title="The editor's free orbit camera"
      >
        🎥 Free cam
      </button>
      <button className="btn btn-accent" onClick={() => setShowAddDialog(true)} title="Add a planet">
        + Add Planet
      </button>
      <button
        className="btn"
        onClick={(e) => {
          e.currentTarget.blur()
          addCraft()
        }}
        title="Add a craft — parked in front of you (on foot), or on the selected body"
      >
        🚀 Add Craft
      </button>

      <div className="topbar-divider" />
      <button className="btn" onClick={openWorldUI} title="Open world.json">
        Open
      </button>
      <button className="btn" onClick={() => saveWorldUI(false)} title="Ctrl+S">
        Save
      </button>
      <button className="btn" onClick={() => saveWorldUI(true)} title="Save as…">
        Save As
      </button>
    </div>
  )
}
