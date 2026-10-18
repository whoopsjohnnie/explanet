/**
 * db.js — browser client for the ExPlanet world database (the /api endpoints
 * served by server/api.mjs, in dev through Vite's middleware).
 *
 * Loading is staged so the scene boots on a skeleton and the atoms stream in
 * behind it:
 *
 *   fetchWorldDocument()   boot payload: every body's document fields, atoms
 *                          for the small ones, preview samples for the giants
 *   fetchPlanetElements()  one body's full atoms, rebuilt into document
 *                          { t, h, c } elements from the compact columnar
 *                          wire form (material dict + t/h columns + sparse
 *                          color overrides)
 */

import { TERRAIN_TYPES } from './terrain.js'
import { packFromWire } from './atoms.js'

async function getJson(path) {
  const res = await fetch(path)
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      message = (await res.json()).error || message
    } catch {
      /* keep the status text */
    }
    throw new Error(message)
  }
  return await res.json()
}

export async function listWorlds() {
  return (await getJson('/api/worlds')).worlds
}

/**
 * Load a world skeleton. World pick: explicit id → ?world=N in the URL →
 * the server default (EXPLANET_WORLD or the newest import).
 */
export async function fetchWorldDocument(worldId) {
  const id =
    worldId ??
    (typeof location !== 'undefined' ? new URLSearchParams(location.search).get('world') : null)
  return await getJson(`/api/worlds/${id == null ? 'default' : encodeURIComponent(id)}`)
}

/**
 * Full atoms for one DB body (planet.dbId), as document-shaped elements plus
 * their packed mirror (core/atoms.js) — the mirror rides along on the planet
 * as `atomsPacked` so geometry rebuilds feed the worker without re-reading
 * 400k element objects. Terrain keys are validated here so the store can
 * take the array as-is.
 *
 * The main thread pays for the JSON parse and the element assembly (~150 ms
 * for a Jupiter), so the loop yields every chunk between: the payload is
 * only wanted while the user waits on it, and a responsive world with the
 * atoms arriving a few frames later beats one long block. The heavy vertex
 * build that follows happens in the geometry worker.
 */
export async function fetchPlanetElements(dbId) {
  const res = await fetch(`/api/bodies/${dbId}/elements`)
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      message = (await res.json()).error || message
    } catch {
      /* keep the status text */
    }
    throw new Error(message)
  }
  const wire = await res.json()
  const { frequency, materials, t, h, c } = wire
  if (!Array.isArray(h) || !Array.isArray(t) || t.length !== h.length)
    throw new Error('malformed atoms payload')
  await new Promise((r) => setTimeout(r)) // let a frame through before assembling
  const colors = new Map(Array.isArray(c) ? c : [])
  const elements = new Array(h.length)
  for (let i = 0; i < h.length; i++) {
    const key = materials[t[i]]
    const col = colors.get(i)
    elements[i] = {
      t: TERRAIN_TYPES[key] ? key : 'grass',
      h: Number.isFinite(h[i]) ? h[i] : 0,
      ...(typeof col === 'string' ? { c: col } : {}),
    }
    if ((i & 0x3ffff) === 0x3ffff) await new Promise((r) => setTimeout(r))
  }
  return { frequency, elements, packed: packFromWire(wire) }
}
