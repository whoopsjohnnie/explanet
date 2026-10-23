#!/usr/bin/env node
/**
 * import-stars.mjs — load the real-sky star catalog into the stars table.
 *
 * Reads the vendored Yale Bright Star Catalog JSON (scripts/stars/data/
 * BSC.json, public domain) and streams every field into `stars`
 * (db/migrations/006-stars.sql): HR number, J2000 RA/Dec, epoch, proper
 * motions, V magnitude, spectral string + extracted OBAFGKM class — plus the
 * galactic (l, b) and ecliptic (λ, β) coordinates DERIVED with the app's own
 * core/starsky.js, so SQL can band-cut the sky without redoing the astronomy.
 *
 * Stars are reference data, not world content: one transaction that replaces
 * ALL rows of one catalog (idempotent — re-running refreshes in place, unlike
 * world imports which append a new world). A DO block re-checks the landed
 * count and derived-coordinate ranges before COMMIT.
 *
 * Usage:
 *   node scripts/import-stars.mjs [path/to/bsc.json] [--catalog BSC5]
 *
 * Requires psql on PATH; connection via standard libpq env vars / ~/.pgpass.
 */
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { lookupPgpass } from '../server/db.mjs'
import { radecToGalactic, radecToEcliptic } from '../src/core/starsky.js'

process.env.PGHOST ||= '<db-host>'
process.env.PGPORT ||= '5432'
process.env.PGDATABASE ||= '<db-name>'
process.env.PGUSER ||= '<db-user>'
if (!process.env.PGPASSWORD)
  process.env.PGPASSWORD =
    lookupPgpass(process.env.PGHOST, Number(process.env.PGPORT), process.env.PGDATABASE, process.env.PGUSER) || ''

const flags = process.argv.slice(2)
const catalogIdx = flags.indexOf('--catalog')
const CATALOG = catalogIdx >= 0 ? flags[catalogIdx + 1] : 'BSC5'
const src = flags.find((f) => !f.startsWith('--') && f !== CATALOG) || 'scripts/stars/data/BSC.json'

// ---------------------------------------------------------------------------
// Parse + derive (the same astronomy the renderer runs)
// ---------------------------------------------------------------------------
const parseRA = (s) => {
  const [h, m, sec] = s.split(':').map(Number)
  return (h + m / 60 + sec / 3600) * 15
}
const parseDec = (s) => {
  const sign = s.trimStart().startsWith('-') ? -1 : 1
  const [d, m, sec] = s.replace('+', '').split(':').map(Number)
  return sign * (Math.abs(d) + m / 60 + sec / 3600)
}
const numOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)

const raw = JSON.parse(readFileSync(src, 'utf8'))
if (!Array.isArray(raw) || !raw.length || raw[0]['harvard_ref_#'] == null) {
  console.error(`${src}: not a BSC star array`)
  process.exit(1)
}

const stars = []
let skipped = 0
for (const s of raw) {
  const ra = parseRA(s.RA)
  const dec = parseDec(s.DEC)
  const mag = parseFloat(s.MAG)
  const hr = Math.round(Number(s['harvard_ref_#']))
  if (!Number.isFinite(ra) || !Number.isFinite(dec) || !Number.isFinite(mag) || !Number.isFinite(hr)) skipped++
  else if (ra < 0 || ra >= 360 || dec < -90 || dec > 90) skipped++
  else {
    const spec = (((s['Title HD'] || '').match(/[OBAFGKM]/) || [null])[0] ?? null)
    const gal = radecToGalactic(ra, dec)
    const ecl = radecToEcliptic(ra, dec)
    stars.push({ hr, ra, dec, epoch: numOrNull(s.Epoch) ?? 2000,
      pmRa: numOrNull(s['RA PM']), pmDec: numOrNull(s['DEC PM']),
      mag, spectral: s['Title HD'] || null, spectralClass: spec,
      gal, ecl })
  }
}
stars.sort((a, b) => a.hr - b.hr)
const dupHr = stars.filter((s, i) => i && s.hr === stars[i - 1].hr).length
if (dupHr) {
  console.error(`${src}: ${dupHr} duplicate HR numbers — refusing`)
  process.exit(1)
}
console.error(
  `importing ${src}: ${stars.length} stars (${skipped} skipped) as catalog '${CATALOG}' → $PGDATABASE`
)

// ---------------------------------------------------------------------------
// COPY text-format escaping + payload (staging temp table → real table,
// all one transaction; psql reads COPY data until a lone "\.")
// ---------------------------------------------------------------------------
const cop = (v) => String(v).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
const copNum = (v) => (Number.isFinite(v) ? String(v) : '\\N')
const copText = (v) => (v == null ? '\\N' : cop(v))

const cols = `catalog, hr, ra_deg, dec_deg, epoch, pm_ra, pm_dec,
  mag, mag_band, b_v, spectral, spectral_class,
  gal_l, gal_b, ecl_lon, ecl_lat`

const colsTyped = `catalog text, hr integer, ra_deg double precision, dec_deg double precision,
  epoch double precision, pm_ra double precision, pm_dec double precision,
  mag double precision, mag_band text, b_v double precision, spectral text,
  spectral_class text, gal_l double precision, gal_b double precision,
  ecl_lon double precision, ecl_lat double precision`

const rows = stars
  .map((s) =>
    [
      cop(CATALOG), s.hr, copNum(s.ra), copNum(s.dec), copNum(s.epoch),
      copNum(s.pmRa), copNum(s.pmDec), copNum(s.mag), 'V', '\\N',
      copText(s.spectral), copText(s.spectralClass),
      copNum(s.gal.lDeg), copNum(s.gal.bDeg), copNum(s.ecl.lonDeg), copNum(s.ecl.latDeg),
    ].join('\t')
  )
  .join('\n')

const sql = `BEGIN;
SET LOCAL search_path = explanet;
SET LOCAL client_min_messages = warning;
SET LOCAL statement_timeout = 0;

CREATE TEMP TABLE st_stars (${colsTyped}) ON COMMIT DROP;

COPY st_stars (${cols}) FROM stdin;
${rows}
\\.

-- stars have a natural key: refresh this catalog in place
DELETE FROM stars WHERE catalog = '${CATALOG}';
INSERT INTO stars (${cols}) SELECT ${cols} FROM st_stars;

-- the whole file must have landed, and the derived coordinates must be sane
DO $do$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM stars WHERE catalog = '${CATALOG}';
  IF n <> ${stars.length} THEN
    RAISE EXCEPTION 'import aborted: catalog % has % stars, expected ${stars.length}', '${CATALOG}', n;
  END IF;
  IF EXISTS (SELECT 1 FROM stars WHERE catalog = '${CATALOG}'
             AND (gal_l IS NULL OR gal_l < 0 OR gal_l >= 360
                  OR gal_b IS NULL OR abs(gal_b) > 90
                  OR ecl_lon IS NULL OR ecl_lon < 0 OR ecl_lon >= 360
                  OR ecl_lat IS NULL OR abs(ecl_lat) > 90)) THEN
    RAISE EXCEPTION 'import aborted: derived coordinates out of range in catalog %', '${CATALOG}';
  END IF;
END
$do$;

COMMIT;
`

// ---------------------------------------------------------------------------
// Stream it to psql
// ---------------------------------------------------------------------------
const psql = spawn('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] })
let errBuf = ''
psql.stderr.on('data', (d) => (errBuf += d))
psql.stdout.resume()
// a failed psql closes stdin mid-stream; swallow the EPIPE and let the exit
// handler report psql's own message instead of crashing the script
psql.stdin.on('error', () => {})

async function send(chunk) {
  if (psql.stdin.writableNeedDrain) await once(psql.stdin, 'drain')
  psql.stdin.write(chunk)
}

const t0 = Date.now()
try {
  await send(sql)
  psql.stdin.end()
  const [code] = await once(psql, 'exit')
  if (code !== 0) throw new Error(errBuf.trim() || `psql exited ${code}`)
} catch (err) {
  psql.kill()
  console.error(`✗ ${err.message}`)
  process.exit(1)
}

console.error(
  `✓ catalog ${CATALOG}: ${stars.length} stars in ${((Date.now() - t0) / 1000).toFixed(2)}s ` +
    `(brightest ${stars.reduce((a, b) => (a.mag <= b.mag ? a : b)).mag})`
)
