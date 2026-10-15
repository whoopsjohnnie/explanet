/**
 * App.jsx — layout shell: 3D scene behind floating UI panels.
 */

import { useEffect } from 'react'
import { useStore } from './state/store.js'
import Scene from './components/Scene.jsx'
import TopBar from './components/ui/TopBar.jsx'
import PlanetList from './components/ui/PlanetList.jsx'
import Inspector from './components/ui/Inspector.jsx'
import Palette from './components/ui/Palette.jsx'
import WalkHud from './components/ui/WalkHud.jsx'
import AddPlanetDialog from './components/ui/AddPlanetDialog.jsx'
import { saveWorldUI, openWorldUI, initFileHandle } from './components/ui/actions.js'
import { TERRAIN_KEYS } from './core/terrain.js'

export default function App() {
  const ready = useStore((s) => s.ready)
  const init = useStore((s) => s.init)
  const statusMsg = useStore((s) => s.statusMsg)
  const showAddDialog = useStore((s) => s.showAddDialog)
  const walkMode = useStore((s) => s.walkMode)

  useEffect(() => {
    init()
    initFileHandle()
  }, [init])

  // status toast auto-dismiss
  useEffect(() => {
    if (!statusMsg) return
    const t = setTimeout(() => useStore.setState({ statusMsg: '' }), 4200)
    return () => clearTimeout(t)
  }, [statusMsg])

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const s = useStore.getState()
      if (s.walkMode) {
        // surface mode owns the keyboard (movement is handled in Walker.jsx):
        // Esc lifts off, Ctrl/Cmd+S still saves. Space is swallowed so a
        // focused button can't be re-triggered by the jump key.
        if (e.code === 'Space') e.preventDefault()
        else if (e.code === 'Escape') {
          e.preventDefault()
          s.exitWalkMode()
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault()
          saveWorldUI(false)
        }
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        s.togglePlay()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        saveWorldUI(false)
      } else if (e.key.toLowerCase() === 'v') s.setTool('select')
      else if (e.key.toLowerCase() === 'b') s.setTool('paint')
      else if (e.key.toLowerCase() === 'r') s.setTool('raise')
      else if (e.key.toLowerCase() === 'f') s.setTool('lower')
      else if (e.key === '[') s.setBrushSize(Math.max(0, s.brushSize - 1))
      else if (e.key === ']') s.setBrushSize(Math.min(3, s.brushSize + 1))
      else if (e.key.toLowerCase() === 'l') s.setShowLabels(!s.showLabels)
      else if (e.key === 'Escape') {
        if (s.showAddDialog) s.setShowAddDialog(false)
        else s.setTool('select')
      } else if (/^[1-9]$/.test(e.key)) {
        const key = TERRAIN_KEYS[parseInt(e.key) - 1]
        if (key) s.setBrushType(key)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // drag & drop a world.json anywhere onto the app
  useEffect(() => {
    const onDragOver = (e) => e.preventDefault()
    const onDrop = async (e) => {
      e.preventDefault()
      const file = e.dataTransfer?.files?.[0]
      if (!file) return
      try {
        const doc = JSON.parse(await file.text())
        useStore.getState().loadDoc(doc, file.name)
      } catch {
        useStore.setState({ statusMsg: 'That file is not a valid world.json' })
      }
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  return (
    <div className="app">
      {ready && <Scene />}
      {ready && (
        <>
          <TopBar />
          <PlanetList />
          <Inspector />
          {!walkMode && <Palette />}
          {walkMode && <WalkHud />}
          {showAddDialog && <AddPlanetDialog />}
          {statusMsg && <div className="toast">{statusMsg}</div>}
        </>
      )}
      {!ready && <div className="boot">Generating worlds…</div>}
    </div>
  )
}
