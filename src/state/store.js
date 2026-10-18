/**
 * store.js — global application state (zustand).
 *
 * Holds the world document plus editor UI state. Physics positions are NOT
 * stored here every frame (they live in core/physics.js registry); the store
 * only receives them on save or explicit "capture".
 *
 * The world loads from the world DATABASE (server/api.mjs) in two stages:
 * init() gets the skeleton (bodies + previews, small bodies complete) and
 * becomes ready immediately; each giant's atoms stream in via hydratePlanet()
 * when the body is selected, approached, or landed on. In-flight hydration
 * promises live in a module map — like the physics registry, promise churn
 * has no business going through React state.
 */

import { create } from 'zustand'
import { createEmptyWorld, createPlanet, normalizeWorld, isPlanetStub } from '../core/worldSchema.js'
import { makeStarterWorld } from '../core/starter.js'
import { registry, orbitalSpeed } from '../core/physics.js'
import { planetMass, planetStats } from '../core/planetMath.js'
import { getHexSphere, getNeighborhood } from '../core/hexsphere.js'
import { fetchWorldDocument, fetchPlanetElements } from '../core/db.js'
import { patchPackedCell } from '../core/atoms.js'

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

const hydrating = new Map() // planetId → Promise<boolean>

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
  walkMode: null, // null | { planetId } — surface exploration session.
  // Only the session identity lives in the store; the walker's live pose is
  // mutable state in core/surface.js, same as the physics body registry.

  // -------------------------------------------------------------- startup --
  // The boot payload is the skeleton and NOTHING else: no body's atoms are
  // fetched until the editor asks for that body (select / land / paint).
  // Streaming only ever starts from hydratePlanet().
  init: async () => {
    try {
      const doc = await fetchWorldDocument()
      const world = normalizeWorld(doc)
      if (!world.planets.length) throw new Error('this world has no bodies')
      set({
        world,
        ready: true,
        selectedId: world.planets[0]?.id ?? null,
        fileName: doc.source || 'world database',
        statusMsg: `Loaded ${world.planets.length} bodies from ${doc.source || 'the world database'}`,
      })
    } catch (err) {
      // offline / empty database: the starter world keeps the app usable
      const world = makeStarterWorld()
      set({
        world,
        ready: true,
        selectedId: world.planets[0]?.id ?? null,
        fileName: 'world.json',
        statusMsg: `World database unavailable (${err.message}) — built-in starter world instead`,
      })
    }
  },

  /**
   * Stream one body's atoms in from the database. No-ops for loaded bodies;
   * concurrent requests share one promise. Resolves true when the planet in
   * THIS document now carries its atoms.
   */
  hydratePlanet: (planetId) => {
    if (!planetId) return Promise.resolve(false)
    const find = () => get().world.planets.find((p) => p.id === planetId)
    const planet = find()
    if (!isPlanetStub(planet)) return Promise.resolve(true)
    if (planet.dbId == null) {
      set({ statusMsg: `${planet.name} has no database source to load atoms from` })
      return Promise.resolve(false)
    }
    let inflight = hydrating.get(planetId)
    if (!inflight) {
      inflight = fetchPlanetElements(planet.dbId)
        .then(({ elements, packed }) => {
          const cur = find() // the world may have moved on (new doc loaded)
          if (cur && isPlanetStub(cur)) {
            set((s) => ({
              world: {
                ...s.world,
                planets: s.world.planets.map((p) =>
                  p.id === planetId ? { ...p, elements, atomsPacked: packed, preview: null } : p
                ),
              },
            }))
          }
          return true
        })
        .catch((err) => {
          set({ statusMsg: `Could not load ${planet.name}'s atoms: ${err.message}` })
          return false
        })
        .finally(() => hydrating.delete(planetId))
      hydrating.set(planetId, inflight)
    }
    return inflight
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
        walkMode: null,
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
      walkMode: null,
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
      statusMsg: `Added ${planet.name} (${planet.elements.length} atoms, radius ${planetStats(planet).radius.toFixed(1)})`,
    }))
    return planet.id
  },

  removePlanet: (id) =>
    set((s) => ({
      world: { ...s.world, planets: s.world.planets.filter((p) => p.id !== id) },
      selectedId: s.selectedId === id ? (s.world.planets.find((p) => p.id !== id)?.id ?? null) : s.selectedId,
      walkMode: s.walkMode && s.walkMode.planetId === id ? null : s.walkMode,
      dirty: true,
    })),

  duplicatePlanet: async (id) => {
    const ok = await get().hydratePlanet(id) // copies need the real atoms
    if (!ok) return
    const world = get().world
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
    if (isPlanetStub(planet)) {
      // painting counts as asking for the body: stream it in (deduped) so the
      // next stroke lands; this stroke has nothing to edit yet
      if (!hydrating.has(planetId))
        set({ statusMsg: `Loading ${planet.name}'s atoms — paint again once they arrive` })
      get().hydratePlanet(planetId)
      return
    }
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

    // keep the packed mirror (if any) consistent so the geometry worker is
    // fed without re-reading the element objects
    if (planet.atomsPacked)
      for (const ci of cells) patchPackedCell(planet.atomsPacked, ci, elements[ci])

    const planets = [...world.planets]
    planets[idx] = { ...planet, elements }
    set({ world: { ...world, planets }, dirty: true })
  },

  // ----------------------------------------------------------------- ui ----
  select: (selectedId) => {
    if (selectedId === get().selectedId) return
    set({ selectedId })
    // selecting a body means looking at it — stream its atoms in
    get().hydratePlanet(selectedId)
  },
  setTool: (tool) => set({ tool }),
  setBrushType: (brushType) => set({ brushType, tool: brushType ? 'paint' : get().tool }),
  setBrushSize: (brushSize) => set({ brushSize }),
  setStrength: (strength) => set({ strength }),
  togglePlay: () => set((s) => ({ playing: !s.playing })),
  setPlaying: (playing) => set({ playing }),
  toggleFollow: () => set((s) => ({ followSelected: !s.followSelected })),
  setShowLabels: (showLabels) => set({ showLabels }),
  setShowAddDialog: (showAddDialog) => set({ showAddDialog }),

  // ------------------------------------------------------- surface mode ---
  /**
   * Drop onto a planet and walk its surface. The Walker component spawns the
   * kinematic walker above the ground (so you fall and land), takes over the
   * camera and integrates the walk outside React state.
   *
   * Walking reads the height field cell by cell, so a stubbed body's atoms
   * are awaited first (one async beat from the database).
   */
  landOnPlanet: async (planetId) => {
    let p = get().world.planets.find((pl) => pl.id === planetId)
    if (!p) return
    if (p.preset === 'star') {
      set({ statusMsg: `You'd vaporize on ${p.name} — find a solid world to land on` })
      return
    }
    if (isPlanetStub(p)) {
      set({ statusMsg: `Loading ${p.name} (${planetStats(p).cellCount} atoms) from the world database…` })
      const ok = await get().hydratePlanet(planetId)
      p = get().world.planets.find((pl) => pl.id === planetId)
      if (!ok || !p || isPlanetStub(p)) return // hydratePlanet reported the failure
    }
    set({
      walkMode: { planetId },
      selectedId: planetId,
      statusMsg: `Descending onto ${p.name} — WASD move · Space jump · Shift sprint · Esc lift off`,
    })
  },

  exitWalkMode: () => set({ walkMode: null }),
  markSaved: (fileName) => set({ dirty: false, fileName: fileName ?? get().fileName }),
}))
