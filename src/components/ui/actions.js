/**
 * actions.js — UI-facing actions that wrap core operations + store updates.
 */

import { useStore } from '../../state/store.js'
import { isPlanetStub, serializeWorld } from '../../core/worldSchema.js'
import * as fileIO from '../../core/fileIO.js'

/**
 * Serialize the live world (with captured physics positions). Bodies whose
 * atoms are still in the database are streamed in first — a file save must
 * never write a stub.
 */
async function snapshot() {
  const store = useStore.getState()
  const stubs = store.world.planets.filter(isPlanetStub)
  if (stubs.length) {
    useStore.setState({
      statusMsg: `Streaming ${stubs.length} ${stubs.length === 1 ? 'body' : 'bodies'} from the database for export…`,
    })
    const done = await Promise.all(stubs.map((p) => store.hydratePlanet(p.id)))
    if (done.some((ok) => !ok)) throw new Error('could not load every body from the database')
  }
  store.capturePositions()
  return serializeWorld(useStore.getState().world)
}

export async function saveWorldUI(asNew = false) {
  let doc
  try {
    doc = await snapshot()
  } catch (err) {
    useStore.setState({ statusMsg: `Save failed: ${err.message}` })
    return null
  }
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
