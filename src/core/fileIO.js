/**
 * fileIO.js
 * ---------------------------------------------------------------------------
 * world.json FILE persistence — save/open/export. (World LOADING happens
 * from the world database via core/db.js; picking a file stays available as
 * an import path, and saving to a file stays the way to carry a world out.)
 *
 * Uses the File System Access API when available (Chrome/Edge): the user
 * picks a real `world.json` once and the file handle is remembered in
 * IndexedDB, so subsequent saves (and Ctrl+S) write straight to disk.
 * Falls back to classic download / file-input elsewhere.
 */

const DB_NAME = 'explanet'
const STORE = 'kv'
const HANDLE_KEY = 'worldFileHandle'

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbSet(key, value) {
  try {
    const db = await idb()
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(value, key)
      tx.oncomplete = res
      tx.onerror = () => rej(tx.error)
    })
  } catch {
    /* IndexedDB unavailable — degrade gracefully */
  }
}

async function idbGet(key) {
  try {
    const db = await idb()
    return await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readonly')
      const r = tx.objectStore(STORE).get(key)
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------

export function supportsFileSystemAccess() {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

let savedHandle = null

/** Restore a previously chosen world.json handle (needs user gesture later). */
export async function restoreHandle() {
  if (savedHandle) return savedHandle
  const handle = await idbGet(HANDLE_KEY)
  if (handle) {
    try {
      const perm = await handle.queryPermission({ mode: 'readwrite' })
      savedHandle = handle
      return { handle, permission: perm }
    } catch {
      savedHandle = null
    }
  }
  return null
}

/**
 * Save the world document. If no file has been chosen yet a Save dialog
 * opens. Returns { fileName } or null when cancelled.
 */
export async function saveWorld(doc, { forcePicker = false } = {}) {
  const text = JSON.stringify(doc, null, 2)

  if (supportsFileSystemAccess()) {
    try {
      if (!savedHandle || forcePicker) {
        savedHandle = await window.showSaveFilePicker({
          suggestedName: 'world.json',
          types: [{ description: 'World JSON', accept: { 'application/json': ['.json'] } }],
        })
        await idbSet(HANDLE_KEY, savedHandle)
      }
      const perm = await savedHandle.requestPermission({ mode: 'readwrite' })
      if (perm !== 'granted') throw new Error('Permission denied')
      const writable = await savedHandle.createWritable()
      await writable.write(text)
      await writable.close()
      return { fileName: savedHandle.name }
    } catch (err) {
      if (err.name === 'AbortError') return null
      // fall through to download
    }
  }
  downloadText('world.json', text)
  return { fileName: 'world.json (downloaded)' }
}

/**
 * Open a world document. Returns { doc: object, fileName } or null.
 */
export async function openWorld() {
  if (supportsFileSystemAccess()) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'World JSON', accept: { 'application/json': ['.json'] } }],
        multiple: false,
      })
      const file = await handle.getFile()
      const doc = JSON.parse(await file.text())
      savedHandle = handle
      await idbSet(HANDLE_KEY, handle)
      return { doc, fileName: file.name }
    } catch (err) {
      if (err.name === 'AbortError') return null
      throw err
    }
  }
  // <input type="file"> fallback
  return await new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      try {
        const doc = JSON.parse(await file.text())
        resolve({ doc, fileName: file.name })
      } catch {
        resolve(null)
      }
    }
    input.click()
  })
}
