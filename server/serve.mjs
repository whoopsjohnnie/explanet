#!/usr/bin/env node
/**
 * serve.mjs — production server: static dist/ + the /api world database
 * endpoints (same handler the Vite dev server mounts in development).
 *
 *   npm run build && npm run serve     # → http://localhost:5174
 *
 * Env: PORT (default 5174), PGHOST/PGDATABASE/PGUSER (required — your world
 * database; this repo ships no infrastructure names), PGPORT (default 5432),
 * password via PGPASSWORD or ~/.pgpass.
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiHandler } from './api.mjs'

const DIST = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist')
const PORT = Number(process.env.PORT || 5174)

const missing = ['PGHOST', 'PGDATABASE', 'PGUSER'].filter((k) => !process.env[k])
if (missing.length) {
  console.error(`explanet serve: ${missing.join(', ')} not set — point the server at your world database (see README, "The world database")`)
  process.exit(1)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
  let file = resolve(DIST, `.${normalize(urlPath)}`)
  // stay inside dist/
  if (file !== DIST && !file.startsWith(DIST + sep)) {
    res.writeHead(403).end('forbidden')
    return
  }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html')
    const body = await readFile(file)
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': file === DIST ? 'no-cache' : 'immutable',
    })
    res.end(body)
  } catch {
    // SPA fallback: unknown non-asset paths render the app shell
    try {
      const html = await readFile(join(DIST, 'index.html'))
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' })
      res.end(html)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('dist/ not built — run `npm run build` first')
    }
  }
}

createServer((req, res) => {
  if (req.url.startsWith('/api/')) return apiHandler(req, res)
  return serveStatic(req, res)
}).listen(PORT, () => {
  console.log(`explanet serving ${DIST} + /api (db ${process.env.PGDATABASE}@${process.env.PGHOST}) on http://localhost:${PORT}`)
})
