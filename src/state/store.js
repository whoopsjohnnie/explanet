/**
 * store.js — global application state (zustand).
 *
 * Holds the world document plus editor UI state. Physics positions are NOT
 * stored here every frame (they live in core/physics.js registry); the store
 * only receives them on save or explicit "capture".
 */

import { create } from 'zustand'
import { createEmptyWorld, createPlanet, normalizeWorld } from '../core/worldSchema.js'
import { makeStarterWorld } from '../core/starter.js'
import { registry, orbitalSpeed } from '../core/physics.js'
import { planetMass, planetStats } from '../core/planetMath.js'
import { getHexSphere, getNeighborhood } from '../core/hexsphere.js'
import { fetchDefaultWorld } from '../core/fileIO.js'

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

export const useStore = create((set, get) => ({
  // ---------------------------------------------------------------- data ---
  world: createEmptyWorld(),
  ready: false,
  fileName: null,
  dirty: false,
  statusMsg: '',

  // ------------------------------------------------------------------ ui ---
  selectedId: null,
  tool: 'select', // select | paint | raise | lower
  brushType: 'grass',
  brushSize: 1, // 0..3 BFS rings
  strength: 0.18,
  playing: true,
  showLabels: true,
  followSelected: true,
  showAddDialog: false,

  // -------------------------------------------------------------- startup --
  init: async () => {
    let world = null
    try {
      world = normalizeWorld(await fetchDefaultWorld())
    } catch {
      world = makeStarterWorld()
    }
    if (!world.planets.length) world = makeStarterWorld()
    set({
      world,
      ready: true,
      selectedId: world.planets[0]?.id ?? null,
      fileName: 'world.json',
    })
  },

  // ------------------------------------------------------------ doc ops ---
  loadDoc: (doc, fileName) => {
    try {
      const world = normalizeWorld(doc)
      set({
        world,
        selectedId: world.planets[0]?.id ?? null,
        fileName: fileName || 'world.json',
        dirty: false,
        statusMsg: `Loaded ${world.planets.length} bodies from ${fileName || 'world.json'}`,
      })
    } catch (err) {
      set({ statusMsg: `Could not load world: ${err.message}` })
    }
  },

  newWorld: () =>
    set({
      world: createEmptyWorld('New World'),
      selectedId: null,
      dirty: true,
      statusMsg: 'New empty world — add a star to get started',
    }),

  renameWorld: (name) => set((s) => ({ world: { ...s.world, name }, dirty: true })),
  setGravity: (gravity) => set((s) => ({ world: { ...s.world, gravity }, dirty: true })),
  setStatus: (statusMsg) => set({ statusMsg }),

  // ----------------------------------------------------------- planets ----
  addPlanet: (opts = {}) => {
    const { world, selectedId } = get()
    let center = opts.center
    let velocity = opts.velocity

    const parent = opts.orbit ? world.planets.find((p) => p.id === (opts.orbit === true ? selectedId : opts.orbit)) : null
    if (parent) {
      const body = registry.bodies.get(parent.id)
      const pPos = body ? body.pos : parent.center
      const pVel = body ? body.vel : parent.velocity
      const dist = opts.orbitDistance ?? planetStats(parent).radius + 14
      center = { x: pPos.x + dist, y: pPos.y, z: pPos.z }
      const v = orbitalSpeed(world.gravity, planetMass(parent), dist)
      velocity = { x: pVel.x, y: pVel.y, z: pVel.z - v }
    }

    const planet = createPlanet({ ...opts, center, velocity })
    set((s) => ({
      world: { ...s.world, planets: [...s.world.planets, planet] },
      selectedId: planet.id,
      dirty: true,
      showAddDialog: false,
      statusMsg: `Added ${planet.name} (${planet.elements.length} hex cells, radius ${planetStats(planet).radius.toFixed(1)})`,
    }))
    return planet.id
  },

  removePlanet: (id) =>
    set((s) => ({
      world: { ...s.world, planets: s.world.planets.filter((p) => p.id !== id) },
      selectedId: s.selectedId === id ? (s.world.planets.find((p) => p.id !== id)?.id ?? null) : s.selectedId,
      dirty: true,
    })),

  duplicatePlanet: (id) => {
    const { world } = get()
    const p = world.planets.find((pl) => pl.id === id)
    if (!p) return
    const body = registry.bodies.get(id)
    const off = planetStats(p).radius * 2.4 + 6
    const copy = createPlanet({
      ...p,
      id: undefined,
      name: `${p.name} copy`,
      elements: p.elements.map((e) => ({ ...e })),
      center: { x: (body?.pos.x ?? p.center.x) + off, y: body?.pos.y ?? p.center.y, z: body?.pos.z ?? p.center.z },
      velocity: { ...(body ? body.vel : p.velocity) },
    })
    set((s) => ({
      world: { ...s.world, planets: [...s.world.planets, copy] },
      selectedId: copy.id,
      dirty: true,
    }))
  },

  updatePlanet: (id, patch) =>
    set((s) => ({
      world: {
        ...s.world,
        planets: s.world.planets.map((p) => (p.id === id ? { ...p, ...patch } : p)),
      },
      dirty: true,
    })),

  /** Pull live physics transforms back into the document. */
  capturePositions: () => {
    const { world } = get()
    set({
      world: {
        ...world,
        planets: world.planets.map((p) => {
          const body = registry.bodies.get(p.id)
          if (!body) return p
          return {
            ...p,
            center: { ...body.pos },
            velocity: { ...body.vel },
          }
        }),
      },
    })
  },

  // -------------------------------------------------------------- painting -
  /**
   * Apply the current tool to cells of a planet.
   * @param {string} planetId
   * @param {number} cellIndex  primary hit cell
   */
  applyBrush: (planetId, cellIndex) => {
    const { world, tool, brushType, brushSize, strength } = get()
    if (tool === 'select') return
    const idx = world.planets.findIndex((p) => p.id === planetId)
    if (idx === -1) return
    const planet = world.planets[idx]
    const hex = getHexSphere(planet.frequency)
    const cells = getNeighborhood(hex, cellIndex, brushSize)

    const elements = [...planet.elements]
    for (const ci of cells) {
      const el = { ...elements[ci] }
      switch (tool) {
        case 'paint':
          el.t = brushType
          delete el.c // custom tint no longer matches the terrain brush
          if (brushType === 'water' && el.h > 0) el.h = 0
          break
        case 'raise':
          el.h = clamp((el.h || 0) + strength, -0.5, 3.2)
          break
        case 'lower':
          el.h = clamp((el.h || 0) - strength, -0.5, 3.2)
          break
        default:
          break
      }
      elements[ci] = el
    }

    const planets = [...world.planets]
    planets[idx] = { ...planet, elements }
    set({ world: { ...world, planets }, dirty: true })
  },

  // ----------------------------------------------------------------- ui ----
  select: (selectedId) => set({ selectedId }),
  setTool: (tool) => set({ tool }),
  setBrushType: (brushType) => set({ brushType, tool: brushType ? 'paint' : get().tool }),
  setBrushSize: (brushSize) => set({ brushSize }),
  setStrength: (strength) => set({ strength }),
  togglePlay: () => set((s) => ({ playing: !s.playing })),
  setPlaying: (playing) => set({ playing }),
  toggleFollow: () => set((s) => ({ followSelected: !s.followSelected })),
  setShowLabels: (showLabels) => set({ showLabels }),
  setShowAddDialog: (showAddDialog) => set({ showAddDialog }),
  markSaved: (fileName) => set({ dirty: false, fileName: fileName ?? get().fileName }),
}))
