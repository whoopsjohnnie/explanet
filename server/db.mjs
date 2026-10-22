/**
 * db.mjs — PostgreSQL access for the ExPlanet world database (<db-host> / <db-name>).
 *
 * Read side of the schema in db/schema.sql. Two grains of reading, matching
 * how the app consumes worlds:
 *
 *   * skeleton — one world, every body's document fields WITHOUT atoms, plus
 *     a coarse preview grid (sampled with the app's own core/lod.js, which is
 *     framework-free and imports cleanly here) for bodies too big to inline.
 *     That is what the browser loads on boot: a few hundred KB instead of the
 *     90 MB world.json.
 *   * full body atoms — streamed per body on demand (selection / approach /
 *     landing), in a compact columnar JSON form: material dictionary + t/h
 *     columns + sparse color overrides.
 *
 * GENERATED bodies (bodies.generation, docs/scaling.txt §5): no atom rows
 * exist for them. loadBody synthesizes the surface from the descriptor
 * ({fn:'preset', preset, seed?, relief}) with the app's own
 * core/generators.js — deterministic, so preview, hydration and repeated
 * fetches agree. Everything downstream (preview sampling, wire payload,
 * LRU cache, skeleton stub) treats generated bodies exactly like stored
 * ones; the browser never learns the difference.
 *
 * Bodies are LRU-cached in compact form, so a skeleton build (which samples
 * every preview) warms the cache and later per-body requests are memory-only.
 *
 * Connection: standard libpq env vars (PGHOST/PGPORT/PGDATABASE/PGUSER),
 * defaulting to <db-host> / <db-name> / <db-user>; the password falls back to
 * ~/.pgpass (pg itself does not read that file — we do).
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { gzip } from 'node:zlib'
import pg from 'pg'
import { sampleLodElements } from '../src/core/lod.js'
import { generateElements } from '../src/core/generators.js'

const { Pool } = pg

const HOST = process.env.PGHOST || '<db-host>'
const PORT = Number(process.env.PGPORT || 5432)
const DATABASE = process.env.PGDATABASE || '<db-name>'
const USER = process.env.PGUSER || '<db-user>'

// bodies small enough to ship whole inside the skeleton (≈ frequency ≤ 31):
// everything above stays a stub with a preview sample
export const FULL_INLINE_CELLS = 10_000
export const PREVIEW_FREQUENCY = 16

// ---------------------------------------------------------------------------
// Pool (lazy — never connect at import time, e.g. during `vite build`)
// ---------------------------------------------------------------------------

export function lookupPgpass(host, port, database, user) {
  const file = process.env.PGPASSFILE || `${process.env.HOME || homedir()}/.pgpass`
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  for (const line of text.split('\n')) {
    const l = line.trim()
    if (!l || l.startsWith('#')) continue
    const fields = l.split(/(?<!\\):/).map((s) => s.replace(/\\:/g, ':').replace(/\\\\/g, '\\'))
    if (fields.length < 5) continue
    const [h, p, d, u] = fields
    // connect host '<db-host>' should match a '<db-host>.localdomain' entry
    const hostOk = h === '*' || h === host || h.split('.')[0] === host.split('.')[0]
    if (
      hostOk &&
      (p === '*' || p === String(port)) &&
      (d === '*' || d === database) &&
      (u === '*' || u === user)
    )
      return fields.slice(4).join(':')
  }
  return undefined
}

let pool = null
export function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      host: HOST,
      port: PORT,
      database: DATABASE,
      user: USER,
      password: process.env.PGPASSWORD || lookupPgpass(HOST, PORT, DATABASE, USER),
      max: 4,
      connectionTimeoutMillis: 15_000,
      options: '-c search_path=explanet',
    })
  }
  return pool
}

const cellCount = (frequency) => 10 * frequency * frequency + 2
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)

/** gzip without blocking the event loop on big bodies. */
async function gzipText(text) {
  const gz = await new Promise((res, rej) => gzip(text, { level: 5 }, (e, out) => (e ? rej(e) : res(out))))
  return gz
}

// ---------------------------------------------------------------------------
// Bodies — compact cached atom store
// ---------------------------------------------------------------------------

/**
 * Compact form for a GENERATED body (bodies.generation ≠ NULL, zero atom
 * rows): the surface is a pure function of (preset, seed, relief) evaluated
 * with the app's own core/generators.js — deterministic, so every fetch and
 * every preview of a generated body is the same world. Result matches
 * loadBody's compact shape exactly; downstream code cannot tell the origin.
 */
function synthesizeBody(dbId, frequency, bodySeed, generation) {
  const preset = typeof generation.preset === 'string' ? generation.preset : 'rocky'
  const relief = Number.isFinite(Number(generation.relief)) ? Number(generation.relief) : 1
  const seed = Number.isFinite(Number(generation.seed)) ? Number(generation.seed) : Number(bodySeed)
  const raw = generateElements(preset, frequency, seed || 1)
  const mats = []
  const matIndex = new Map()
  const t = new Array(raw.length)
  const h = new Array(raw.length)
  const colors = new Map()
  for (let i = 0; i < raw.length; i++) {
    const el = raw[i]
    let ti = matIndex.get(el.t)
    if (ti === undefined) {
      ti = mats.length
      matIndex.set(el.t, ti)
      mats.push(el.t)
    }
    t[i] = ti
    h[i] = Number.isFinite(el.h) ? el.h * relief : 0
    if (typeof el.c === 'string') colors.set(i, el.c)
  }
  return { dbId, frequency, count: raw.length, mats, t, h, colors, json: null }
}

/**
 * Compact in-memory atoms for one body: material dictionary + columns.
 *   { dbId, frequency, count, mats: string[], t: number[], h: number[],
 *     colors: Map<cell_index, string>, json?: string }
 */
async function loadBody(dbId) {
  const meta = await getPool().query(
    `SELECT frequency, seed, generation FROM bodies WHERE id = $1`,
    [dbId]
  )
  if (!meta.rows.length) throw new Error(`no body ${dbId} in ${DATABASE}@${HOST}`)
  if (meta.rows[0].generation)
    return synthesizeBody(dbId, meta.rows[0].frequency, meta.rows[0].seed, meta.rows[0].generation)
  const { rows } = await getPool().query(
    `SELECT a.cell_index, a.height, coalesce(m.key, 'grass') AS t, a.color
       FROM atoms a
       LEFT JOIN materials m ON m.id = a.material_id
      WHERE a.body_id = $1
      ORDER BY a.cell_index`,
    [dbId]
  )
  const mats = []
  const matIndex = new Map()
  const t = new Array(rows.length)
  const h = new Array(rows.length)
  const colors = new Map()
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    let ti = matIndex.get(r.t)
    if (ti === undefined) {
      ti = mats.length
      matIndex.set(r.t, ti)
      mats.push(r.t)
    }
    t[i] = ti
    h[i] = r.height ?? 0
    if (r.color) colors.set(r.cell_index, r.color)
  }
  return {
    dbId,
    frequency: meta.rows[0].frequency,
    count: rows.length,
    mats,
    t,
    h,
    colors,
    json: null,
  }
}

const MAX_BODIES = 8
const bodyCache = new Map() // dbId → Promise<compact>; insertion order = LRU

async function bodyEntry(dbId) {
  const id = Number(dbId)
  if (!Number.isInteger(id) || id <= 0) throw new Error(`bad body id ${dbId}`)
  if (bodyCache.has(id)) {
    const hit = bodyCache.get(id)
    bodyCache.delete(id)
    bodyCache.set(id, hit) // refresh recency
    return hit
  }
  const entry = loadBody(id).catch((err) => {
    bodyCache.delete(id)
    throw err
  })
  bodyCache.set(id, entry)
  if (bodyCache.size > MAX_BODIES) bodyCache.delete(bodyCache.keys().next().value)
  return entry
}

/** Compact columnar JSON (material dict + columns + sparse colors). */
export async function bodyElementsJson(dbId) {
  const b = await bodyEntry(dbId)
  if (!b.json) {
    b.json = JSON.stringify({
      frequency: b.frequency,
      materials: b.mats,
      t: b.t,
      h: b.h,
      c: [...b.colors.entries()].filter(([i]) => i < b.count),
    })
  }
  return b.json
}

/** Wire form: JSON text + its lazily built gzip (heights compress ~4×). */
export async function bodyPayload(dbId) {
  const b = await bodyEntry(dbId)
  const text = await bodyElementsJson(dbId)
  if (!b.gz) b.gz = await gzipText(text)
  return { text, gz: b.gz }
}

/** Plain document elements (objects), e.g. for geometry sampling. */
export async function bodyElements(dbId) {
  const b = await bodyEntry(dbId)
  const out = new Array(b.count)
  for (let i = 0; i < b.count; i++) {
    const c = b.colors.get(i)
    out[i] = c ? { t: b.mats[b.t[i]], h: b.h[i], c } : { t: b.mats[b.t[i]], h: b.h[i] }
  }
  return out
}

/** Coarse preview grid sampled from the body's atoms (core/lod.js). */
export async function bodyPreview(dbId, frequency = PREVIEW_FREQUENCY) {
  const b = await bodyEntry(dbId)
  if (frequency >= b.frequency) return null // body is already coarse: inline it
  const elements = await bodyElements(dbId)
  const { elements: sampled } = sampleLodElements({ frequency: b.frequency, elements }, frequency)
  return { frequency, elements: sampled }
}

// ---------------------------------------------------------------------------
// Worlds
// ---------------------------------------------------------------------------

export async function listWorlds() {
  const { rows } = await getPool().query(
    `SELECT w.id, w.name, w.gravity, w.updated_at,
            (SELECT count(*)::int FROM bodies b WHERE b.world_id = w.id) AS bodies
       FROM worlds w
      ORDER BY w.id DESC`
  )
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    gravity: r.gravity,
    bodies: r.bodies,
    updatedAt: r.updated_at,
  }))
}

export async function defaultWorldId() {
  if (process.env.EXPLANET_WORLD) return Number(process.env.EXPLANET_WORLD)
  const { rows } = await getPool().query(`SELECT max(id) AS id FROM worlds`)
  if (!rows[0].id) throw new Error(`no worlds imported into ${DATABASE}@${HOST}`)
  return Number(rows[0].id)
}

// skeleton cache: sampling previews reads every atom, so keep the built
// document around; imports are rare and ?refresh=1 bypasses
const SKELETON_TTL_MS = 5 * 60_000
const skeletonCache = new Map() // worldId → { json, at }

/**
 * The world document WITHOUT full atoms: every body carries its real
 * frequency (so radius/mass stay derived and orbits stay right), a stub
 * `elements: null` with the DB's mean relief for mass, and a preview sample
 * — or its complete elements when it fits FULL_INLINE_CELLS.
 * Returns { doc, text, gz }: the wire payload with a lazily built gzip.
 */
export async function worldSkeleton(worldId, { refresh = false } = {}) {
  const id = Number(worldId)
  const cached = skeletonCache.get(id)
  if (!refresh && cached && Date.now() - cached.at < SKELETON_TTL_MS) return cached

  const { rows: w } = await getPool().query(
    `SELECT id, name, gravity, doc_version FROM worlds WHERE id = $1`,
    [id]
  )
  if (!w.length) throw new Error(`no world ${id} in ${DATABASE}@${HOST}`)

  const { rows: bodies } = await getPool().query(
    `SELECT b.*, s.atom_rows, s.avg_height, p.doc_id AS parent_doc_id
       FROM bodies b
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS atom_rows, avg(a.height)::float8 AS avg_height
           FROM atoms a WHERE a.body_id = b.id
       ) s ON true
       LEFT JOIN bodies p ON p.id = b.parent_body_id
      WHERE b.world_id = $1
      ORDER BY b.sort_order, b.id`,
    [id]
  )

  const planets = []
  for (const b of bodies) {
    const frequency = b.frequency
    const planet = {
      dbId: Number(b.id),
      id: b.doc_id || `p-db-${b.id}`,
      name: b.name,
      preset: b.preset,
      seed: Number(b.seed),
      frequency,
      scale: b.scale,
      center: { x: b.center_x, y: b.center_y, z: b.center_z },
      velocity: { x: b.velocity_x, y: b.velocity_y, z: b.velocity_z },
      spin: { x: b.spin_x, y: b.spin_y, z: b.spin_z },
      density: b.density,
      isStatic: !!b.gravity_immune,
    }
    if (b.kind) planet.kind = b.kind
    if (b.parent_doc_id) planet.parent = b.parent_doc_id
    if (b.rings) planet.rings = b.rings
    if (b.atmosphere) planet.atmosphere = b.atmosphere
    if (b.scripts) planet.scriptsOrbit = b.scripts
    if (b.generation) {
      // generated body (docs/scaling.txt §5): always a stub — there are no
      // atom rows to inline; hydration synthesizes them. Frequency must be
      // > PREVIEW_FREQUENCY so the stub always has a preview to render.
      planet.elements = null
      planet.stubAvgHeight = Number.isFinite(Number(b.generation.avgHeight))
        ? Number(b.generation.avgHeight)
        : num(b.avg_height, 0)
      planet.preview = await bodyPreview(b.id, PREVIEW_FREQUENCY)
      planet.generated = b.generation // observability; normalizeWorld() strips it
    } else if (cellCount(frequency) <= FULL_INLINE_CELLS) {
      planet.elements = await bodyElements(b.id)
      planet.preview = null
    } else {
      planet.elements = null
      planet.stubAvgHeight = num(b.avg_height, 0)
      planet.preview = await bodyPreview(b.id, PREVIEW_FREQUENCY)
    }
    planets.push(planet)
  }

  const doc = {
    version: w[0].doc_version || 1,
    name: w[0].name,
    gravity: w[0].gravity,
    source: `db:${DATABASE}@${HOST} · ${w[0].name}`,
    planets,
  }
  const text = JSON.stringify(doc)
  const record = { doc, text, gz: await gzipText(text), at: Date.now() }
  skeletonCache.set(id, record)
  return record
}
