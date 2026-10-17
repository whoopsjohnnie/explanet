/**
 * api.mjs — the /api HTTP handler for the world database.
 *
 * Framework-free (req, res, next) middleware, used by BOTH the Vite dev
 * server (vite.config.js plugin) and the standalone server (serve.mjs), so
 * dev and production speak the same endpoints:
 *
 *   GET /api/health                     → { ok, db, host }
 *   GET /api/worlds                     → { worlds: [...], defaultId }
 *   GET /api/worlds/default             → the default world's skeleton document
 *   GET /api/worlds/:id                 → skeleton document (?refresh=1 rebakes)
 *   GET /api/bodies/:dbId/elements      → compact atoms for one body
 *
 * The skeleton is the boot payload: bodies with real frequency/density (so
 * derived radius/mass and orbits stay exact) but atoms only for the small
 * bodies; giants arrive as stubs + a preview sample and stream their atoms
 * in later via /api/bodies/:id/elements.
 */
import { listWorlds, defaultWorldId, worldSkeleton, bodyPayload, getPool } from './db.mjs'

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

function send(res, status, body, headers = JSON_HEADERS) {
  res.writeHead(status, headers)
  res.end(body)
}

/** Serve a cached { text, gz } payload, gzipping by content negotiation. */
function sendPayload(req, res, payload) {
  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || '')))
    return send(res, 200, payload.gz, { ...JSON_HEADERS, 'content-encoding': 'gzip' })
  return send(res, 200, payload.text)
}

export async function apiHandler(req, res, next) {
  let path
  try {
    path = new URL(req.url, 'http://localhost').pathname
  } catch {
    return next ? next() : send(res, 400, '{"error":"bad url"}')
  }
  if (!path.startsWith('/api/')) return next ? next() : send(res, 404, '{"error":"not found"}')
  if (req.method !== 'GET' && req.method !== 'HEAD')
    return send(res, 405, JSON.stringify({ error: 'method not allowed' }))

  try {
    if (path === '/api/health') {
      return send(res, 200, JSON.stringify({ ok: true, db: await ping() }))
    }
    if (path === '/api/worlds') {
      const worlds = await listWorlds()
      return send(res, 200, JSON.stringify({ worlds, defaultId: worlds[0]?.id ?? null }))
    }
    if (path === '/api/worlds/default') {
      const id = await defaultWorldId()
      return sendPayload(req, res, await worldSkeleton(id))
    }
    const worldMatch = /^\/api\/worlds\/(\d+)$/.exec(path)
    if (worldMatch) {
      const refresh = new URL(req.url, 'http://localhost').searchParams.get('refresh') === '1'
      return sendPayload(req, res, await worldSkeleton(worldMatch[1], { refresh }))
    }
    const bodyMatch = /^\/api\/bodies\/(\d+)\/elements$/.exec(path)
    if (bodyMatch) {
      return sendPayload(req, res, await bodyPayload(bodyMatch[1]))
    }
    return send(res, 404, JSON.stringify({ error: `no api route ${path}` }))
  } catch (err) {
    const status = /no world|no bodies/.test(err.message) ? 404 : 500
    return send(res, status, JSON.stringify({ error: err.message }))
  }
}

async function ping() {
  try {
    const { rows } = await getPool().query(`SELECT current_database() AS db, current_schema() AS s`)
    return { database: rows[0].db, schema: rows[0].s }
  } catch (err) {
    return { error: err.message }
  }
}
