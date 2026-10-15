/**
 * actions.js — UI-facing actions that wrap core operations + store updates.
 */

import { useStore } from '../../state/store.js'
import * as fileIO from '../../core/fileIO.js'

/** Serialize the live world (with captured physics positions). */
function snapshot() {
  const store = useStore.getState()
  store.capturePositions()
  const { world } = useStore.getState()
  return {
    version: world.version,
    name: world.name,
    gravity: world.gravity,
    planets: world.planets,
  }
}

export async function saveWorldUI(asNew = false) {
  const doc = snapshot()
  const res = await fileIO.saveWorld(doc, { forcePicker: asNew })
  if (res) {
    useStore.setState({ dirty: false, fileName: res.fileName, statusMsg: `Saved → ${res.fileName}` })
  }
  return res
}

export async function openWorldUI() {
  try {
    const res = await fileIO.openWorld()
    if (!res) return
    useStore.getState().loadDoc(res.doc, res.fileName)
  } catch (err) {
    useStore.setState({ statusMsg: `Open failed: ${err.message}` })
  }
}

/** Restore a remembered file handle on load (informational). */
export async function initFileHandle() {
  const restored = await fileIO.restoreHandle()
  if (restored) {
    useStore.setState({
      fileName: restored.handle.name,
      statusMsg: `Linked to ${restored.handle.name} — Ctrl+S writes straight to disk`,
    })
  }
}
