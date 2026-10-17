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
 * Full atoms for one DB body (planet.dbId), as document-shaped elements.
 * Terrain keys are validated here so the store can take the array as-is.
 */
export async function fetchPlanetElements(dbId) {
  const { frequency, materials, t, h, c } = await getJson(`/api/bodies/${dbId}/elements`)
  if (!Array.isArray(h) || !Array.isArray(t) || t.length !== h.length)
    throw new Error('malformed atoms payload')
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
  }
  return { frequency, elements }
}
