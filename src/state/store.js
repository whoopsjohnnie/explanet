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
import {
  createEmptyWorld,
  createPlanet,
  createCraft,
  normalizeWorld,
  isPlanetStub,
} from '../core/worldSchema.js'
import { makeStarterWorld } from '../core/starter.js'
import { registry, orbitalSpeed } from '../core/physics.js'
import { planetMass, planetStats } from '../core/planetMath.js'
import { getHexSphere, getNeighborhood } from '../core/hexsphere.js'
import { fetchWorldDocument, fetchPlanetElements } from '../core/db.js'
import { patchPackedCell } from '../core/atoms.js'
import {
  craftRuntime,
  craftWorldPose,
  dominantBody,
  tileRadius,
  eva,
  launchCraftState,
  ejectCraftState,
  captureCraftPose,
  pendingFoot,
} from '../core/motion.js'

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

const hydrating = new Map() // planetId → Promise<boolean>

/**
 * Where the astronaut starts when a world is loaded: on foot at the first
 * landable body that carries a parked craft (the default mode for an avatar
 * is to walk — you arrive on the ground, near your shuttle); else on foot
 * at the first landable body; else free-cam (an empty or star-only world).
 */
function defaultPlayer(world) {
  const craft = (world.crafts || []).find((c) => c.pose && c.pose.anchor)
  const bodyId =
    (craft && craft.pose.anchor.bodyId) ||
    world.planets.find((p) => p.preset !== 'star')?.id
  return bodyId ? { kind: 'foot', bodyId } : { kind: 'freeCam' }
}

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
  // The ASTRONAUT's session (movement model: docs/flight.txt). Only the
  // session identity lives in the store; every live pose (walker, crafts,
  // the adrift astronaut) is mutable state in core/ — surface.js,
  // motion.js — same contract as the physics body registry.
  //   { kind: 'foot', bodyId }      on foot — walking (default at launch)
  //   { kind: 'craft', craftId }    piloting a craft
  //   { kind: 'eva' }               adrift in space (EVA)
  //   { kind: 'freeCam' }           the editor camera — the old
  //                                 OrbitControls mode, kept as a toggle
  player: { kind: 'freeCam' },
  selectedCraftId: null, // a craft selected in the scene/list (inspector)

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
        player: defaultPlayer(world),
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
        player: defaultPlayer(world),
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
        player: defaultPlayer(world),
        selectedCraftId: null,
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
      player: { kind: 'freeCam' },
      selectedCraftId: null,
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
      // the astronaut can't stay on a body that no longer exists
      player:
        s.player?.kind === 'foot' && s.player.bodyId === id ? { kind: 'freeCam' } : s.player,
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
    set({ selectedId, selectedCraftId: null })
    // selecting a body means looking at it — stream its atoms in
    get().hydratePlanet(selectedId)
  },
  /** Select a craft (inspector shows its panel). */
  selectCraft: (selectedCraftId) => set({ selectedCraftId }),
  setTool: (tool) => set({ tool }),
  setBrushType: (brushType) => set({ brushType, tool: brushType ? 'paint' : get().tool }),
  setBrushSize: (brushSize) => set({ brushSize }),
  setStrength: (strength) => set({ strength }),
  togglePlay: () => set((s) => ({ playing: !s.playing })),
  setPlaying: (playing) => set({ playing }),
  toggleFollow: () => set((s) => ({ followSelected: !s.followSelected })),
  setShowLabels: (showLabels) => set({ showLabels }),
  setShowAddDialog: (showAddDialog) => set({ showAddDialog }),

  // ------------------------------------------- astronaut / craft session ---
  // The astronaut is always one of: on foot, in a craft, adrift (EVA) or at
  // the free camera. Walking is triggered by LANDING (a craft's altitude
  // reaching the surface, or an EVA fall ending) — never by a button; the
  // buttons that used to drop you on a surface are gone (docs/flight.txt).
  //
  /**
   * Drop onto a planet and walk its surface (kept as the programmatic entry
   * point — the headless harness and landings use it). The Walker component
   * spawns the kinematic walker above the ground (so you fall and land),
   * takes over the camera and integrates the walk outside React state.
   * Walking reads the height field cell by cell, so a stubbed body's atoms
   * are awaited first (one async beat from the database).
   */
  landOnPlanet: async (planetId, dir = null) => {
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
    pendingFoot.bodyId = dir ? planetId : null
    pendingFoot.dir = dir ? [...dir] : null
    set({
      player: { kind: 'foot', bodyId: planetId },
      selectedId: planetId,
      statusMsg: `Descending onto ${p.name} — WASD move · Space jump · Shift sprint · Esc lift off`,
    })
  },

  /** The adrift astronaut's fall has ended on a surface (motion.stepEva) —
   *  on foot there, at the exact direction the fall hit. */
  evaLand: ({ bodyId, dir }) => {
    const p = get().world.planets.find((pl) => pl.id === bodyId)
    pendingFoot.bodyId = bodyId
    pendingFoot.dir = [...dir]
    set({
      player: { kind: 'foot', bodyId },
      statusMsg: p ? `You landed on ${p.name} — WASD walk · E board · Esc free-cam` : '',
    })
  },

  /** Board a craft. From the free camera: any craft (the P1 rule). From on
   *  foot: a craft parked on the body you're standing on. From adrift: use
   *  E (boardNearestCraft — proximity). */
  boardCraft: (craftId) => {
    const s = get()
    const craft = (s.world.crafts || []).find((c) => c.id === craftId)
    if (!craft) return
    if (s.player?.kind === 'foot') {
      const rt = craftRuntime.get(craftId)
      if (!rt || rt.state.mode !== 'park' || rt.state.bodyId !== s.player.bodyId) {
        set({ statusMsg: 'No craft parked here to board' })
        return
      }
    }
    set({
      player: { kind: 'craft', craftId },
      selectedCraftId: craftId,
      statusMsg: `Piloting ${craft.name} — W thrust · drag to aim · E eject · Esc free-cam`,
    })
  },

  /** Eject the astronaut from the piloted craft: parked → on foot at its
   *  anchor point; flying → adrift, inheriting its velocity. */
  ejectCraft: () => {
    const s = get()
    if (s.player?.kind !== 'craft') return
    const ev = ejectCraftState(s.player.craftId)
    if (!ev) {
      set({ player: { kind: 'freeCam' } })
      return
    }
    if (ev.type === 'foot') {
      pendingFoot.bodyId = ev.bodyId
      pendingFoot.dir = [...ev.dir]
      const p = s.world.planets.find((pl) => pl.id === ev.bodyId)
      set({
        player: { kind: 'foot', bodyId: ev.bodyId },
        statusMsg: p ? `On foot on ${p.name} — WASD walk · E board · Esc free-cam` : '',
      })
    } else {
      eva.state = { pos: { ...ev.pos }, vel: { ...ev.vel }, yaw: ev.yaw, pitch: ev.pitch }
      set({
        player: { kind: 'eva' },
        statusMsg: 'Adrift — WASD/R/F jetpack · drag to look · E board · Esc free-cam',
      })
    }
  },

  /** E key: board a craft. On foot → the craft parked on this body. Adrift →
   *  the nearest craft within reach (a generous ten host-body tiles). */
  boardNearestCraft: () => {
    const s = get()
    const crafts = s.world.crafts || []
    if (!crafts.length) return
    if (s.player?.kind === 'foot') {
      const c = crafts.find((q) => q.pose && q.pose.anchor?.bodyId === s.player.bodyId)
      if (c) s.boardCraft(c.id)
      else set({ statusMsg: 'No craft parked on this body' })
      return
    }
    if (s.player?.kind !== 'eva' || !eva.state) return
    const ev = eva.state
    const dom = dominantBody(ev.pos, s.world.gravity)
    const reach = dom ? 10 * tileRadius(dom.body.radius, dom.body.planet?.frequency || 1) : 10
    let best = null
    let bestD = Infinity
    for (const c of crafts) {
      const rt = craftRuntime.get(c.id)
      if (!rt) continue
      const pose = craftWorldPose(rt)
      if (!pose) continue
      const d = Math.hypot(ev.pos.x - pose.pos.x, ev.pos.y - pose.pos.y, ev.pos.z - pose.pos.z)
      if (d < bestD) {
        bestD = d
        best = c
      }
    }
    if (best && bestD <= reach) s.boardCraft(best.id)
    else set({ statusMsg: 'No craft within reach' })
  },

  /** Launch the piloted craft off its pad (parked → space). A stubbed
   *  anchor body is hydrated first — landing/launching a body streams it,
   *  never the camera. */
  launchCraft: async (craftId) => {
    const s = get()
    const craft = (s.world.crafts || []).find((c) => c.id === craftId)
    if (!craft) return
    const rt = craftRuntime.get(craftId)
    if (!rt || rt.state.mode !== 'park') return
    const body = s.world.planets.find((p) => p.id === rt.state.bodyId)
    if (body && isPlanetStub(body)) {
      set({ statusMsg: `Loading ${body.name} from the world database…` })
      const ok = await get().hydratePlanet(body.id)
      if (!ok) return
    }
    const st = launchCraftState(craftId)
    if (st) set({ statusMsg: `${craft.name} is off the pad — W thrust · drag to aim` })
  },

  /** Add a craft (TopBar): a shuttle parked on the selected body (or the
   *  first landable one), nose up. */
  addCraft: (opts = {}) => {
    const s = get()
    const world = s.world
    const anchor =
      (s.selectedId && world.planets.find((p) => p.id === s.selectedId && p.preset !== 'star')) ||
      world.planets.find((p) => p.preset !== 'star')
    const pose = anchor
      ? { anchor: { bodyId: anchor.id, dir: [0, 0.7, 0.7], r: null } }
      : { space: { pos: [30, 0, 0], vel: [0, 0, 0], yaw: 0, pitch: 0 } }
    const craft = createCraft({ ...opts, pose })
    set({
      world: { ...world, crafts: [...(world.crafts || []), craft] },
      selectedCraftId: craft.id,
      dirty: true,
      statusMsg: `${craft.name} added — select it in the list to pilot`,
    })
    return craft.id
  },

  removeCraft: (craftId) =>
    set((s) => ({
      world: { ...s.world, crafts: (s.world.crafts || []).filter((c) => c.id !== craftId) },
      selectedCraftId: s.selectedCraftId === craftId ? null : s.selectedCraftId,
      player: s.player?.kind === 'craft' && s.player.craftId === craftId ? { kind: 'freeCam' } : s.player,
      dirty: true,
    })),

  updateCraft: (craftId, patch) =>
    set((s) => ({
      world: {
        ...s.world,
        crafts: (s.world.crafts || []).map((c) => (c.id === craftId ? { ...c, ...patch } : c)),
      },
      dirty: true,
    })),

  /** Free camera — the editor's old OrbitControls mode (kept, toggled,
   *  disabled by default: the astronaut's default is to walk). */
  setFreeCam: () => set({ player: { kind: 'freeCam' } }),
  /** Kept name for the harness/docs: leaving the surface returns to the
   *  editor camera. */
  exitWalkMode: () => set({ player: { kind: 'freeCam' } }),

  /** Copy live craft poses back into the document (save path — a file
   *  round-trips where every craft is, flying or parked). */
  captureCrafts: () => {
    const { world } = get()
    if (!world.crafts?.length) return
    for (const craft of world.crafts) {
      const rt = craftRuntime.get(craft.id)
      if (rt) captureCraftPose(rt)
    }
  },

  markSaved: (fileName) => set({ dirty: false, fileName: fileName ?? get().fileName }),
}))
