#!/usr/bin/env node
/**
 * fetch-moons.mjs — Sol Real data pipeline (1/3): the moon catalog.
 *
 * Scrapes the "Moons of <planet>" list articles on Wikipedia (wikitext) and
 * parses their big sortable table: every confirmed moon with diameter, mass,
 * semi-major axis, period, inclination and eccentricity. That single table
 * per planet is the most complete public catalog of natural satellites there
 * is (Jupiter ~100, Saturn ~270, Uranus 28, Neptune 16, Pluto 5).
 *
 * Output: scripts/sol-real/data/moons.json (seed file — uploaded to S3 after
 * a refresh, see DATA.md; generation is then deterministic and offline;
 * re-run only to refresh the catalog).
 *
 *   node scripts/sol-real/fetch-moons.mjs
 */

import { writeFileSync } from 'node:fs'

const UA = { 'User-Agent': 'ExPlanetWorldBuilder/1.0 (world generator; contact: local)' }

const PAGES = [
  { page: 'Moons of Jupiter', parent: 'Jupiter' },
  { page: 'Moons of Saturn', parent: 'Saturn' },
  { page: 'Moons of Uranus', parent: 'Uranus' },
  { page: 'Moons of Neptune', parent: 'Neptune' },
  // Mars (2 moons) and Pluto (5 moons) are hardcoded in gen-sol-real.mjs —
  // too few to be worth scraping (their article tables use colspan layouts).
]

async function wikitext(title) {
  const url = new URL('https://en.wikipedia.org/w/api.php')
  url.searchParams.set('action', 'parse')
  url.searchParams.set('page', title)
  url.searchParams.set('prop', 'wikitext')
  url.searchParams.set('redirects', '1')
  url.searchParams.set('format', 'json')
  const res = await fetch(url, { headers: UA })
  if (!res.ok) throw new Error(`${title}: HTTP ${res.status}`)
  const j = await res.json()
  if (!j.parse?.wikitext?.['*']) throw new Error(`${title}: no wikitext`)
  return j.parse.wikitext['*']
}

// --- wikitext table surgery -------------------------------------------------

/** All wikitable starts in the document. */
function findTables(wt) {
  const out = []
  const re = /\{\|\s*class=?"?[^\n"]*wikitable[^\n"]*"?/g
  let m
  while ((m = re.exec(wt))) {
    const end = wt.indexOf('\n|}', m.index)
    if (end !== -1) out.push(wt.slice(m.index, end + 3))
  }
  return out
}

function stripTags(s) {
  return s
    .replace(/<ref[^>]*?\/>/g, '')
    .replace(/<ref[\s\S]*?<\/ref>/g, '')
    .replace(/<br\s*\/?>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&thinsp;|&amp;|&#160;|&#8201;/g, ' ')
    .replace(/\u00a0|\u2009|\u2013|\u2212/g, (c) => (c === '\u2212' ? '-' : ' '))
    .trim()
}

/** Resolve {{sort|key|disp}} → key, {{val|n|...}} → n, {{shy|a|b}} → ab; drop others. */
function resolveTemplates(s) {
  let out = s
  for (let guard = 0; guard < 60; guard++) {
    const before = out
    // value-producing templates first; when one resolved, retry BEFORE any
    // template is dropped ({{sort|n|{{val|n}}}} only becomes flat one pass in)
    out = out.replace(/\{\{\s*(?:sort|val|cvt|convert|dsv)\s*\|([^{}]*)\}\}/gi, (_m, inner) => {
      const first = inner.split('|')[0].trim()
      return /^-?[\d.,]+(?:[eE][-+]?\d+)?$/.test(first) ? first : ''
    })
    out = out.replace(/\{\{\s*shy\s*\|([^{}]*)\}\}/gi, (_m, inner) => inner.replace(/\|/g, ''))
    out = out.replace(/\{\{\s*wbr\s*\}\}/gi, '')
    out = out.replace(/\{\{\s*br\s*\}\}/gi, ' ')
    out = out.replace(/\{\{\s*(?:ubl|nowrap|small|spaces)\s*\|([^{}]*)\}\}/gi, (_m, inner) => inner.replace(/\|/g, ' '))
    out = out.replace(/\{\{\s*sortkey\s*\|[^{}]*\}\}/gi, '')
    if (out !== before) continue
    out = out.replace(/\{\{[^{}]*\}\}/g, '') // nothing resolves: drop innermost template
    if (out === before) break
  }
  return out
}

function cleanText(cell) {
  let s = cell
    .replace(/(?:^|[\s|])style="[^"]*"/gi, ' ')
    .replace(/(?:^|[\s|])class="[^"]*"/gi, ' ')
    .replace(/^\s*\|/, '')
  s = resolveTemplates(s)
  s = s.replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1') // [[link|text]] → text
  s = stripTags(s)
  s = s.replace('{\'\'\'', '').replace('\'\'\'}', '').replace(/'''|''/g, '')
  s = s.replace(/[♠♣♦‡†★⧫◇]/g, ' ') // group-label glyphs from the row label
  s = s.replace(/~{3}/g, '').replace(/\s+/g, ' ').trim()
  return s
}

function cleanNum(cell) {
  const s = cleanText(cell)
  if (!s || /^[—?–]/.test(s)) return null
  const m = s.match(/-?\d+(?:[.,]\d+)?(?:[eE][-+]?\d+)?/)
  if (!m) return null
  return parseFloat(m[0].replace(',', '.'))
}

/** Column index map from the header row, keyed by concept. */
function headerMap(table) {
  // header cells are the leading '!' lines (|-/|+ separators may interleave)
  const cells = []
  for (const line of table.split('\n')) {
    const t = line.trim()
    if (t.startsWith('!')) cells.push(...t.replace(/^!/, '').split('!!'))
    else if (t.startsWith('|-') || t.startsWith('|+') || t.startsWith('{|') || t === '') continue
    else break
  }
  const map = {}
  cells.forEach((raw, i) => {
    // {{shy|Incli|nation}} splits words → drop whitespace before matching
    const h = cleanText(raw).toLowerCase().replace(/\s+/g, '')
    const set = (k) => {
      if (map[k] === undefined) map[k] = i
    }
    if (/semi-?major/.test(h)) set('sma')
    else if (/inclination/.test(h)) set('inc')
    else if (/eccentricity/.test(h)) set('ecc')
    else if (/diameter/.test(h)) set('diam')
    else if (/mass/.test(h)) set('mass15')
    else if (/period/.test(h)) set('period')
    else if (/^name/.test(h)) set('name')
    else if (/group/.test(h)) set('group')
    else if (/^label/.test(h)) set('label')
  })
  return { map, cellCount: cells.length }
}

function parseTable(table, parent) {
  const { map } = headerMap(table)
  if (map.sma === undefined || map.inc === undefined || map.name === undefined) return []
  // data rows: blocks after the header, each starting with |-
  const body = table.slice(table.search(/\n\|-/) + 1, table.lastIndexOf('\n|}'))
  const rows = []
  for (const block of body.split(/\n\|-\n?/)) {
    if (!block.trim() || !/^\|/m.test(block)) continue
    const cells = []
    for (const line of block.split('\n')) {
      const t = line.trim()
      if (!t.startsWith('|')) continue
      t.replace(/^\|/, '').split('||').forEach((c) => cells.push(c))
    }
    if (cells.length < 4) continue
    let name = cleanText(cells[map.name] ?? '')
    // Pluto's Name header is colspan=2 ("Name (IPA)") — guard empty names
    if (!name && cells[map.name + 1]) name = cleanText(cells[map.name + 1])
    name = name.replace(/^\d+\.\s*/, '')
    if (!name || name.length > 60) continue
    if (/^(rings? of|moon of saturn|aegaeon ring|methone ring|pallene ring|mebee ring|co-orbital)/i.test(name)) continue
    const row = {
      parent,
      name,
      diam: cleanNum(cells[map.diam]),
      mass15: cleanNum(cells[map.mass15]),
      sma: cleanNum(cells[map.sma]),
      period: cleanNum(cells[map.period]),
      inc: cleanNum(cells[map.inc]),
      ecc: cleanNum(cells[map.ecc]),
      group: map.group !== undefined ? cleanText(cells[map.group] ?? '') || null : null,
      label: map.label !== undefined ? cleanText(cells[map.label] ?? '') : '',
    }
    if (row.sma == null || row.sma <= 0) continue // no orbit → unplaceable
    rows.push(row)
  }
  // dedupe by (parent, name)
  const seen = new Set()
  return rows.filter((r) => {
    const k = r.parent + '§' + r.name
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// --- run ---------------------------------------------------------------------

import { pathToFileURL } from 'node:url'

async function main() {
const all = []
for (const { page, parent } of PAGES) {
  process.stderr.write(`${page}: `)
  const wt = await wikitext(page)
  let best = []
  for (const t of findTables(wt)) {
    const rows = parseTable(t, parent)
    if (rows.length > best.length) best = rows
  }
  process.stderr.write(`${best.length} moons\n`)
  if (best.length < 2) throw new Error(`no moon table parsed on "${page}" — Wikipedia layout may have changed`)
  all.push(...best)
}

const out = new URL('./data/moons.json', import.meta.url)
writeFileSync(out, JSON.stringify(all, null, 1))
console.log(`wrote ${all.length} moons → ${out.pathname}`)
for (const p of PAGES) {
  const rows = all.filter((r) => r.parent === p.parent)
  const nd = rows.filter((r) => r.diam != null).length
  console.log(`  ${p.parent.padEnd(8)} ${String(rows.length).padStart(3)} rows, diam known: ${nd}`)
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()

export { wikitext, findTables, parseTable, cleanText, cleanNum, headerMap }
