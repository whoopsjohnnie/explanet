#!/usr/bin/env node
/**
 * Sol Real / fetch — small-body orbits + physical data.
 *
 *  1. Asteroids: Wikidata SPARQL for dynamically classified asteroids (Q3863)
 *     orbiting the Sun with a diameter claim — name, diameter (normalized to
 *     km), class. Gives thousands of real objects in one query.
 *  2. Comets: Wikidata query (Q61066 subclasses) + curated fallback.
 *  3. TNOs/centaurs/asteroids missing from the WD result: curated SBDB list.
 *  4. Orbits: JPL Small-Body Database API (osculating elements, 1 req/sec).
 *
 * Output: scripts/sol-real/data/orbits.json
 *
 * Usage: node scripts/sol-real/fetch-small.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const UA = 'explanet-sol-real/1.0 (educational world generator)'
const WD_ENDPOINT = 'https://query.wikidata.org/sparql'
const SBDB = 'https://ssd-api.jpl.nasa.gov/sbdb.api'
const SLEEP_MS = 1100

// Curated famous asteroids / near-Earth objects to guarantee inclusion.
// [SBDB search string, fallback diameter km, note]
const CURATED_ASTEROIDS = [
  ['1 Ceres', 939, 'dwarf planet, main belt'],
  ['4 Vesta', 525, 'main belt'],
  ['2 Pallas', 512, 'main belt'],
  ['10 Hygiea', 434, 'main belt'],
  ['253 Mathilde', 53, 'main belt'],
  ['243 Ida', 39, 'main belt'],
  ['2867 Šteins', 5.7, 'main belt'],
  ['21 Lutetia', 100, 'main belt'],
  ['16 Psyche', 229, 'main belt, metallic'],
  ['121 Hermione', 190, 'main belt'],
  ['107 Camilla', 200, 'main belt'],
  ['433 Eros', 17, 'NEO Amor'],
  ['25143 Itokawa', 0.55, 'NEO Apollo, sampled'],
  ['99942 Apophis', 0.37, 'NEO Aten'],
  ['101955 Bennu', 0.49, 'NEO Apollo, sample returned'],
  ['1998 KY26', 0.01, 'tiny, flyby target'],
  ['162173 Ryugu', 0.9, 'NEO Apollo, sampled'],
  ['2024 YR4', 0.07, 'NEO, 2032 concern'],
  ['2025 QF360', 0.12, 'nearest 2025 flyby'],
  ['2024 PT5', 0.01, 'minimoon'],
  ['46610 Brouwer', 0.6, 'main belt'],
  ['5535 Annefrank', 4.5, 'main belt'],
  ['4 Vesta', 525.4, 'main belt'],
  ['29 Pafuris', 77, 'main belt'],
  ['2 Pallas', 512, 'main belt'],
  ['15 Eunomia', 268, 'main belt'],
  ['52 Europa', 315, 'main belt'],
  ['511 Davida', 284, 'main belt'],
  ['30 Lucretia Carpicus', 195, 'main belt'],
  ['65 Cybele', 237, 'main belt'],
  ['532 Herculina', 218, 'main belt'],
  ['246 Asporina', 118, 'main belt'],
  ['762 Pulcova', 114, 'main belt'],
  ['2005 UE8', 4, 'Phocaea'],
  ['1862 Apollo', 6.5, 'NEO'],
  ['1221 Amerigo', 5, 'NEO'],
  ['85989 2000 AG199', 300, 'cubewano'],
  ['343146 2009 BD', 0.1, 'Aten'],
  ['3552 Don Quixote', 17, 'Apollo'],
  ['55636 2002 UX25', 600, 'cold classical'],
  ['2002 MS4', 900, 'classical KBO'],
  ['2003 AZ84', 940, 'Plutino'],
  ['2004 GV9', 700, 'cold classical'],
  ['2002 UX25', 600, 'cold classical'],
  ['50000 Quaoar', 1110, 'TNO'],
  ['90482 Orcus', 910, 'Plutino'],
  ['90377 Sedna', 500, 'sednoid'],
  ['2018 VG18', 500, 'far TNO'],
  ['2012 VP113', 500, 'sednoid'],
  ['2015 RR245', 700, 'cold classical'],
  ['486958 Arrokoth', 36, 'KBO, flyby'],
  ['2013 SY99', 4, 'sednoid'],
  ['29145 Salacia', 850, 'cold classical'],
  ['2002 KX14', 500, 'cold classical'],
  ['55637 2002 UX25b', 0, 'skip'],
  ['2014 UZ224', 600, 'far TNO'],
  ['2015 TG387', 300, 'sednoid'],
  ['2016 NW65', 500, 'far TNO'],
  ['2015 BB519', 300, 'cold classical'],
  ['2015 FF323', 300, 'cold classical'],
  ['47171 Lempo', 390, 'PLuTINO'],
  ['2013 PS36', 700, 'scattered'],
  ['2013 RF98', 400, 'scattered'],
  ['2015 HM176', 200, 'detached'],
  ['2015 KX408', 400, 'sednoid'],
  ['2016 HO3', 0.046, 'quasi-satellite'],
  ['594913 Éollaraca', 7, 'Jupiter Trojan'],
  ['2020 XL5', 1.8, 'Earth Trojan'],
  ['2010 TK7', 0.5, 'Earth Trojan'],
  ['55536 2002 UX25', 0, 'skip'],
  ['2017 OF20', 60, 'sednoid'],
  ['2015 KH162', 500, 'far TNO'],
  ['2015 TB185', 6.5, 'TNO comet'],
  ['2015 UG407', 500, 'far TNO'],
  ['2015 UK194', 300, 'far TNO'],
  ['2016 NQ1', 600, 'far TNO'],
  ['2015 XX169', 0.3, 'Aten'],
  ['2015 BZ509', 6, 'Jupiter retrograde Trojan'],
  ['6478 Gault', 4, 'main belt'],
  ['1283 Comas Sola', 22, 'main belt'],
  ['2012 DA14', 0.03, 'NEO'],
  ['65803 Didymos', 0.78, 'NEO, DART'],
  ['2022 AP7', 1.5, 'Potentially hazardous'],
  ['2020 VV', 0.01, 'minimoon'],
  ['2006 JY23', 4, 'Phocaea'],
  ['2010 RF12', 0.007, 'tiny'],
  ['2020 SW', 0.005, 'tiny'],
  ['2019 OK', 0.1, 'Apollo'],
  ['2016 CA40', 0.04, 'Aten'],
  ['2020 QG', 0.002, 'closest flyby 2020'],
  ['1566 Icarus', 1.4, 'Apollo'],
  ['3200 Phaethon', 5.8, 'Apollo'],
  ['2005 YU55', 0.4, 'Apollo'],
  ['367943 Duende', 0.2, 'Apollo'],
  ['2011 LJ3', 0.05, 'Aten'],
  ['2023 DZ2', 0.045, 'Apollo'],
]

// Curated comets (SBDB names). Diameters from NCPList where known (km).
const COMETS = [
  ['1P/Halley', 11], ['2P/Encke', 4.7], ['4P/Faye', 3.5], ['6P/d\'Arrest', 3.3],
  ['8P/Tuttle', 4.5], ['9P/Tempel 1', 6], ['10P/Tempel 2', 14], ['15P/Finlay', 2],
  ['19P/Borrelly', 8], ['22P/Kopff', 4], ['24P/Schaumasse', 30], ['29P/Schwassmann-Wachmann', 60],
  ['38P/Stephan-Oterma', 5], ['41P/Tuttle-Giacobini-Kresak', 1.5], ['45P/Honda-Mrkos-Pajdusakova', 1.5],
  ['46P/Wirtanen', 1.2], ['47P/Pons-Winnecke', 8], ['50P/Arend-Rigaux', 8.5], ['51P/Harrington', 2],
  ['55P/Tempel-Tuttle', 3.6], ['59P/Kearns-Kwee', 5], ['62P/Tsuchinshan 1', 3.5], ['63P/Wild 1', 4.2],
  ['64P/Swift-Gehrels', 4.3], ['67P/Churyumov-Gerasimenko', 4], ['69P/Taylor', 5], ['70P/Churyumov-Gerasimenko 4', 1.5],
  ['71P/Clark', 3], ['72P/Denning-Fujikawa', 8], ['73P/Schwassmann-Wachmann 3', 5], ['74P/Busyfield', 1.5],
  ['78P/Gehrels 2', 4], ['79P/du Toit-Hartley', 1.5], ['81P/Wild 2', 4.4], ['85P/Boethin', 2.6],
  ['92P/Sanguin', 2], ['96P/Machholz', 6], ['103P/Hartley 2', 1.4], ['107P/Wilson-Harrington', 4],
  ['110P/Hartley 3', 1.5], ['114P/Wiseman-Skiff', 8], ['116P/Wild 4', 4], ['119P/Parker-Hartley', 1.6],
  ['122P/de Vico', 1.5], ['123P/Watt-Hartley', 1.8], ['126P/IRAS', 7], ['135P/Hellmuth', 3],
  ['141P/Machholz 2', 6], ['153P/Ikeya-Zhang', 7], ['161P/Hartley-IRAS', 1.5], ['162P/Siding Spring', 16],
  ['165P/LINEAR', 2], ['175P/Hrvath-Rojistakr-Kohoutek', 10], ['2060 Chiron', 218], ['5145 Pholus', 200],
  ['10199 Chariklo', 250], ['C/1995 O1 Hale-Bopp', 60], ['C/1996 B2 Hyakutake', 4], ['C/1997 L2 Yomiuri-Tsuchinshan', 50],
  ['C/2006 P1 McNaught', 40], ['C/2007 W1 McNaught', 6], ['C/2009 P1 Garradd', 4], ['C/2011 L4 PanSTARRS', 20],
  ['C/2012 S1 ISON', 4], ['C/2013 A1 Siding Spring', 1.4], ['C/2013 R1 Lovejoy', 70], ['C/2014 UN271 Bernardinelli-Bernstein', 120],
  ['C/2015 ER61 PanSTARRS', 4], ['C/2016 R2 PanSTARRS', 10], ['C/2017 T2 PanSTARRS', 10], ['C/2020 F3 NEOWISE', 5],
  ['C/2022 E3 ZTF', 4], ['C/2023 A3 Tsuchinshan-ATLAS', 40], ['C/1965 S1 Ikeya-Seki', 4], ['C/1983 H1 IRAS-Araki-Alcott', 5],
  ['C/1973 E1 Kohoutek', 30], ['C/1986 G3 Halley-type (Bradfield)', 8],
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function wdQuery(query) {
  const res = await fetch(`${WD_ENDPOINT}?format=json&query=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': UA, 'Accept': 'application/sparql-query+json' },
  })
  if (!res.ok) throw new Error(`WD HTTP ${res.status}`)
  return res.json()
}
/** SBDB API v1.3: elements arrive as [{label,value}] under `orbit`. */
function parseSbdb(j) {
  if (!j?.orbit?.elements) return null
  const el = {}
  for (const e of j.orbit.elements) {
    const v = parseFloat(e.value)
    if (Number.isFinite(v)) el[e.label] = v
  }
  if (!Number.isFinite(el.a) || !Number.isFinite(el.e)) return null
  const obj = j.object || {}
  return {
    name: obj.shortname || obj.des || '',
    longName: obj.fullname,
    klass: obj.orbit_class?.name || null,
    orbit: {
      e: el.e,
      a: el.a,
      q: el.q,
      i: el.i,
      om: el.node,
      w: el.peri,
      ma: el.M,
      tp: el.tp ?? null,
      epoch: j.orbit.epoch ? Number(j.orbit.epoch) : null,
      period: el.period ?? null, // days
    },
  }
}

function designationOf(name) {
  const t = name.trim().split(/\s+/)
  let m
  if ((m = t[0].match(/^(\d+[PDCX]?)\//))) return m[1] // '1P' from '1P/Halley'
  if (/^(C|X)\/\d/.test(t[0])) return t.length > 1 ? `${t[0]} ${t[1]}` : t[0] // C/2023 A3 …
  if (/^(C|P|D)\/\S+$/.test(t[0])) return t[0]
  return t[0].replace(/[()]/g, '') // '16' from '16 Psyche'
}

async function sbdbOnce(sstr) {
  const res = await fetch(`${SBDB}?sstr=${encodeURIComponent(sstr)}`, { headers: { 'User-Agent': UA } })
  if (!res.ok) {
    if (res.status === 300) {
      // ambiguous: caller retries with the bare designation
      const err = new Error('ambiguous')
      err.ambiguous = true
      throw err
    }
    return null
  }
  return parseSbdb(await res.json())
}

async function sbdb(name) {
  try {
    const r = await sbdbOnce(name)
    if (r) return r
  } catch (e) {
    if (!e.ambiguous) return null
  }
  const des = designationOf(name)
  if (des && des !== name) {
    try {
      return await sbdbOnce(des)
    } catch {
      /* give up */
    }
  }
  return null
}

async function main() {
  // --- 1. Wikidata asteroids ---
  let asteroids = []
  const qAst = `SELECT ?item ?itemLabel ?diam ?diamUnit ?classLabel WHERE {
  ?item wdt:P31/wdt:P279* wd:Q3863 ;
        wdt:P397 wd:Q525 .
  OPTIONAL { ?item wdt:P2386 ?diam . OPTIONAL { ?item p:P2386 ?st . ?st psv:P2386 ?vn . ?vn wikibase:quantityUnit ?diamUnit } }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,de,fr,zh". }
} LIMIT 30000`
  process.stderr.write('WD: querying asteroids…\n')
  try {
    const r = await wdQuery(qAst)
    const rows = r.results.bindings
    for (const b of rows) {
      const name = b.itemLabel?.value
      if (!name) continue
      let d = b.diam ? parseFloat(b.diam.value) : null
      if (d != null && b.diamUnit && !b.diamUnit.value.endsWith('Q828224')) d = d / 1000 // meters → km
      asteroids.push({ name, diameterKm: d })
    }
    process.stderr.write(`WD: ${asteroids.length} asteroids\n`)
  } catch (e) {
    process.stderr.write(`WD asteroid query failed: ${e.message}\n`)
  }

  // --- 2. Wikidata comets ---
  let comets = []
  const qCom = `SELECT ?item ?itemLabel ?diam ?diamUnit WHERE {
  ?item wdt:P31/wdt:P279* wd:Q61066 ;
        wdt:P397 wd:Q525 .
  OPTIONAL { ?item wdt:P2386 ?diam . OPTIONAL { ?item p:P2386 ?st . ?st psv:P2386 ?vn . ?vn wikibase:quantityUnit ?diamUnit } }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT 5000`
  process.stderr.write('WD: querying comets…\n')
  try {
    const r = await wdQuery(qCom)
    const rows = r.results.bindings
    for (const b of rows) {
      const name = b.itemLabel?.value
      if (!name) continue
      let d = b.diam ? parseFloat(b.diam.value) : null
      if (d != null && b.diamUnit && !b.diamUnit.value.endsWith('Q828224')) d = d / 1000
      comets.push({ name, diameterKm: d })
    }
    process.stderr.write(`WD: ${comets.length} comets\n`)
  } catch (e) {
    process.stderr.write(`WD comet query failed: ${e.message}\n`)
  }

  // --- 3. Curated fallback list (dedupe) ---
  for (const [name, d, note] of CURATED_ASTEROIDS) {
    if (note === 'skip' || d <= 0) continue
    if (!asteroids.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
      asteroids.push({ name, diameterKm: d, curated: true })
    }
  }
  for (const [name, d] of COMETS) {
    if (!comets.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      comets.push({ name, diameterKm: d, curated: true })
    }
  }

  // --- 4. SBDB orbits — budgeted (1 req/s). Keep the biggest + curated + comets.
  const MAX_ORBIT_FETCH = 360
  asteroids.sort((a, b) => (b.diameterKm ?? 0) - (a.diameterKm ?? 0))
  const want = new Set()
  for (const a of asteroids) if (a.curated) want.add(a.name)
  for (const a of asteroids) {
    if (want.size >= MAX_ORBIT_FETCH) break
    want.add(a.name)
  }
  for (const a of asteroids) a.wantOrbit = want.has(a.name)
  process.stderr.write(`SBDB: fetching ${want.size} asteroid orbits (${asteroids.length} total candidates)…\n`)

  const cacheFile = new URL('./data/orbits-cache.json', import.meta.url)
  const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {}
  const normalize = (c) =>
    c.orbit
      ? c
      : { name: c.fullName, orbit: { e: c.e, a: c.a, q: c.q, i: c.i, om: c.om, w: c.w, ma: c.ma, epoch: c.epoch, period: c.period ?? null } }
  const fetchOrbit = async (name, paid) => {
    const key = name.toLowerCase().trim()
    if (cache[key]) return normalize(cache[key])
    if (!paid) return null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await sbdb(name)
        if (r) { cache[key] = r; await sleep(SLEEP_MS); return r }
        break // definitive miss (not found), don't retry
      } catch (e) {
        await sleep(SLEEP_MS * 2) // transient error — retry once
      }
    }
    await sleep(SLEEP_MS)
    return null
  }

  for (const a of asteroids) {
    const o = await fetchOrbit(a.name, a.wantOrbit)
    if (o) {
      a.orbit = o.orbit
      if (o.klass && o.klass !== 'Not defined') a.sbClass = o.klass
    }
  }
  for (const c of comets) {
    const o = await fetchOrbit(c.name, true)
    if (o) {
      c.orbit = o.orbit
      if (o.klass && o.klass !== 'Not defined') c.sbClass = o.klass
    }
  }

  writeFileSync(cacheFile, JSON.stringify(cache))

  writeFileSync(
    new URL('./data/orbits.json', import.meta.url),
    JSON.stringify({ generatedBy: 'scripts/sol-real/fetch-small.mjs', asteroids, comets })
  )
  console.log(`orbits.json: ${asteroids.length} asteroids, ${comets.length} comets`)
}

main().catch((e) => { console.error(e); process.exit(1) })
