#!/usr/bin/env node
/**
 * fetch-terrain.mjs — Sol Real data pipeline: the Earth elevation seed.
 *
 * Downloads the NOAA ETOPO2022 60s global relief GeoTIFF (~445 MB) and
 * converts it ONCE to a plain row-major float32 grid — the pipeline form
 * the generators read (scripts/sol-real/etopo.mjs). PIL is the reference
 * decoder: the NOAA file's internal tile layout is non-standard (adobe
 * deflate float32 that tag 259 does not describe), so no Node-side TIFF
 * parsing is attempted; the .f32 is read with trivial indexing instead.
 *
 *   node scripts/sol-real/fetch-terrain.mjs        # download + convert
 *   node scripts/sol-real/fetch-terrain.mjs --tif  # download only
 *
 * Needs python3 + Pillow for the conversion step.
 *
 * Output (seed files — see DATA.md):
 *   scripts/sol-real/data/etopo2022-60s.tif  NOAA source (kept, re-convertible)
 *   scripts/sol-real/data/etopo2022-60s.f32  21600 × 10800 float32, meters
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'

const UA = { 'User-Agent': 'ExPlanetWorldBuilder/1.0 (world generator; contact: local)' }
const TIF_URL =
  'https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/60s/60s_surface_elev_gtif/ETOPO_2022_v1_60s_N90W180_surface.tif'
const dir = new URL('./data/', import.meta.url)
const tif = new URL('./data/etopo2022-60s.tif', import.meta.url).pathname
const f32 = new URL('./data/etopo2022-60s.f32', import.meta.url).pathname

const downloadOnly = process.argv.includes('--tif')

// --- download -----------------------------------------------------------------
const fresh = (p) => statSync(p).size > 1e8
if (!fresh(tif)) {
  mkdirSync(dir, { recursive: true })
  console.log(`Downloading ETOPO2022 60s GeoTIFF (~445 MB) …`)
  const res = await fetch(TIF_URL, { headers: UA })
  if (!res.ok) throw new Error(`NOAA download failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 1e8) throw new Error(`suspiciously small download: ${buf.length} bytes`)
  writeFileSync(tif, buf)
  console.log(`Wrote ${tif} (${buf.length.toLocaleString('en-US')} bytes)`)
} else {
  console.log(`Keeping existing ${tif}`)
}

if (downloadOnly) {
  console.log('--tif: skipping the .f32 conversion')
  process.exit(0)
}

// --- convert (.tif → plain float32 grid) --------------------------------------
console.log('Converting to a plain float32 grid (python3 + Pillow) …')
const py = `
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
im = Image.open(${JSON.stringify(tif)})
assert im.size == (21600, 10800), f'unexpected grid size {im.size}'
assert im.mode == 'F', f'unexpected mode {im.mode}'
data = im.tobytes()
with open(${JSON.stringify(f32)}, 'wb') as f:
    f.write(data)
print(f'wrote {f32} ({len(data):,} bytes)')
# orientation + spot checks straight from the RAW file
import struct
W, H = im.size
def at(lat, lon):
    row = max(0, min(H - 1, round((90 - lat) * 60)))
    col = max(0, min(W - 1, round((lon + 180) * 60)))
    return struct.unpack_from('<f', data, (row * W + col) * 4)[0]
checks = [
    ('Mariana (11.35N,142.2E)', 11.35, 142.2, -10426),
    ('Everest cell (27.99N,86.93E)', 27.99, 86.93, 7258),
    ('Iceland (65N,-18W) LAND', 65, -18, 852),
    ('Baltic (60N,20E) WATER', 60, 20, -12),
    ('Antarctica (75S,0E) ICE', -75, 0, 2874),
]
ok = True
for name, lat, lon, ref in checks:
    v = at(lat, lon)
    good = abs(v - ref) < 25
    ok &= good
    print(f'  {name:34s} {v:12.1f} m  {"OK" if good else "MISMATCH (expected " + str(ref) + ")"}')
if not ok:
    raise SystemExit('spot checks failed — refusing to write a wrong grid')
`
try {
  execFileSync('python3', ['-c', py], { stdio: 'inherit' })
} catch (e) {
  console.error('\nThe .tif → .f32 conversion needs python3 with Pillow (pip install pillow).')
  console.error('The .tif is already downloaded — re-run this script once Pillow is available.')
  process.exit(1)
}
console.log('Done: scripts/sol-real/data/etopo2022-60s.f32')
