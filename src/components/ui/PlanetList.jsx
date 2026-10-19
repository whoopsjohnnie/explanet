/**
 * PlanetList.jsx — left panel: every body in the world with quick stats.
 *
 * Built for catalog worlds (Sol Real has ~1000 bodies): a search box, a
 * collapsible hierarchy (top-level kinds first, then each parent's moons,
 * then the asteroid/comet pools), and O(cells) stats memoized per planet
 * version — planet elements are copy-on-write, so a WeakMap on the planet
 * object is exactly the right cache key.
 */

import { useMemo, useState } from 'react'
import { useStore } from '../../state/store.js'
import { planetStats } from '../../core/planetMath.js'
import { TERRAIN_TYPES } from '../../core/terrain.js'

function dominantColor(planet) {
  const counts = new Map()
  // stubbed bodies paint with their preview sample's colors
  for (const el of planet.elements ?? planet.preview?.elements ?? [])
    counts.set(el.t, (counts.get(el.t) || 0) + 1)
  let best = 'grass'
  let max = -1
  for (const [t, n] of counts) {
    if (n > max) {
      max = n
      best = t
    }
  }
  return TERRAIN_TYPES[best]?.color || '#5aa15d'
}

// planetStats() walks every cell (volume integral + terrain tally) — never
// run it per row per render on a 412k-cell Earth.
const infoCache = new WeakMap()
function planetInfo(planet) {
  let v = infoCache.get(planet)
  if (!v) {
    v = { stats: planetStats(planet), color: dominantColor(planet) }
    infoCache.set(planet, v)
  }
  return v
}

const KIND_SECTIONS = [
  ['star', 'Stars'],
  ['planet', 'Planets'],
  ['dwarf', 'Dwarf planets'],
]
const POOL_SECTIONS = [
  ['asteroid', 'Asteroids'],
  ['comet', 'Comets'],
]

export default function PlanetList() {
  const planets = useStore((s) => s.world.planets)
  const selectedId = useStore((s) => s.selectedId)
  const select = useStore((s) => s.select)
  const removePlanet = useStore((s) => s.removePlanet)
  const duplicatePlanet = useStore((s) => s.duplicatePlanet)
  const landOnPlanet = useStore((s) => s.landOnPlanet)
  const walkingHere = useStore((s) => s.walkMode?.planetId)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState(() => new Set())

  const q = query.trim().toLowerCase()
  const searching = q.length > 0

  // Group once per document change. `sections` = [{key, title, bodies}] in
  // display order; bodies with a `parent` cluster under that parent's name,
  // the rest fall into their kind section (or a plain list if unclassified).
  const sections = useMemo(() => {
    if (searching) {
      const hits = planets.filter((p) => p.name.toLowerCase().includes(q))
      return hits.length ? [{ key: '__search', title: `${hits.length} match${hits.length === 1 ? '' : 'es'}`, bodies: hits }] : []
    }
    const out = []
    const byKind = (kind) => planets.filter((p) => !p.parent && p.kind === kind)
    for (const [kind, title] of KIND_SECTIONS) {
      const bodies = byKind(kind)
      if (bodies.length) out.push({ key: kind, title, bodies })
    }
    // everything that is not a top-level kind section
    const claimed = new Set(out.flatMap((s) => s.bodies.map((p) => p.id)))
    const parentName = new Map(planets.map((p) => [p.id, p.name]))
    const groups = new Map() // parent display name → bodies, in document order
    const loose = []
    for (const p of planets) {
      if (claimed.has(p.id)) continue
      if (p.parent && parentName.has(p.parent)) {
        const name = parentName.get(p.parent)
        if (!groups.has(name)) groups.set(name, [])
        groups.get(name).push(p)
      } else if (p.kind && POOL_SECTIONS.some(([k]) => k === p.kind)) {
        const name = p.kind === 'asteroid' ? 'Asteroids' : 'Comets'
        if (!groups.has(name)) groups.set(name, [])
        groups.get(name).push(p)
      } else {
        loose.push(p)
      }
    }
    if (loose.length) out.push({ key: '__loose', title: groups.size ? 'Other' : 'Bodies', bodies: loose })
    for (const [name, bodies] of groups) {
      const pool = name === 'Asteroids' || name === 'Comets'
      out.push({ key: `g:${name}`, title: `${name}${pool ? '' : ' — moons'}`, bodies, foldDefault: pool || bodies.length > 8 })
    }
    return out
  }, [planets, q, searching])

  // foldDefault = start collapsed; `collapsed` holds the user's toggles,
  // each of which flips that default (set membership XOR foldDefault).
  const isCollapsed = (s) => !searching && (s.foldDefault ? !collapsed.has(s.key) : collapsed.has(s.key))

  const toggle = (s) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(s.key)) next.delete(s.key)
      else next.add(s.key)
      return next
    })

  const renderRow = (p) => {
    const { stats, color } = planetInfo(p)
    return (
      <div
        key={p.id}
        className={`planet-item ${p.id === selectedId ? 'planet-item--active' : ''}`}
        onClick={() => select(p.id)}
      >
        <span className="planet-dot" style={{ background: color }} />
        <div className="planet-item-main">
          <div className="planet-item-name">
            {p.name}
            {p.isStatic && <span className="badge">static</span>}
            {p.preset === 'star' && <span className="badge badge-star">star</span>}
          </div>
          <div className="planet-item-stats">
            R {stats.radius.toFixed(1)} · M {stats.mass.toFixed(0)} · {stats.cellCount} hex
          </div>
        </div>
        <div className="planet-item-actions">
          {p.preset !== 'star' && (
            <button
              className={`mini-btn ${walkingHere === p.id ? 'mini-btn--on' : ''}`}
              title="Land on surface"
              onClick={(e) => {
                e.stopPropagation()
                landOnPlanet(p.id)
              }}
            >
              🚀
            </button>
          )}
          <button
            className="mini-btn"
            title="Duplicate"
            onClick={(e) => {
              e.stopPropagation()
              duplicatePlanet(p.id)
            }}
          >
            ⧉
          </button>
          <button
            className="mini-btn mini-btn--danger"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation()
              removePlanet(p.id)
            }}
          >
            ✕
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="panel panel-left">
      <div className="panel-title">World Bodies</div>
      {planets.length > 12 && (
        <input
          className="planet-search"
          type="text"
          placeholder={`search ${planets.length} bodies…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      <div className="planet-list">
        {planets.length === 0 && (
          <div className="empty-hint">
            No bodies yet.
            <br />
            Add a star, then planets orbiting it.
          </div>
        )}
        {searching && sections.length === 0 && <div className="empty-hint">Nothing matches “{query}”.</div>}
        {sections.map((s) => (
          <div key={s.key}>
            <div
              className="planet-group-header"
              onClick={() => sections.length > 1 && toggle(s)}
            >
              {sections.length > 1 && <span className="planet-group-caret">{isCollapsed(s) ? '▸' : '▾'}</span>}
              {s.title}
              <span className="planet-group-count">{s.bodies.length}</span>
            </div>
            {!isCollapsed(s) && s.bodies.map(renderRow)}
          </div>
        ))}
      </div>
    </div>
  )
}
