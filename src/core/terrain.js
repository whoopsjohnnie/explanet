/**
 * terrain.js
 * ---------------------------------------------------------------------------
 * Terrain (landmass) type registry and procedural canvas textures. Every
 * hexagonal element stores a terrain key; the renderer looks up its default
 * colour and material here. Textures are generated at runtime on a <canvas>
 * so the project ships without binary assets.
 */

export const TERRAIN_TYPES = {
  grass: { label: 'Grass', color: '#5aa15d', roughness: 0.95, texture: 'speckle', accent: '#4a8c4e' },
  dirt: { label: 'Dirt', color: '#8a6a45', roughness: 0.98, texture: 'speckle', accent: '#755738' },
  rock: { label: 'Rock', color: '#8d8d93', roughness: 0.9, texture: 'crack', accent: '#6f6f76' },
  sand: { label: 'Sand', color: '#dcc481', roughness: 0.95, texture: 'speckle', accent: '#cbb26e' },
  snow: { label: 'Snow', color: '#eef3f7', roughness: 0.75, texture: 'speckle', accent: '#d6e2ec' },
  water: { label: 'Water', color: '#2f7fd4', roughness: 0.15, metalness: 0.05, texture: 'wave', accent: '#2669b0', transparent: true, opacity: 0.82 },
  lava: { label: 'Lava', color: '#e05a1e', emissive: '#ff3c00', emissiveIntensity: 1.6, texture: 'crack', accent: '#a33a10' },
  void: { label: 'Void', color: '#3a3548', roughness: 1, texture: 'speckle', accent: '#2c2837' },
  star: { label: 'Star', color: '#ffd977', emissive: '#ffb13d', emissiveIntensity: 2.4, roughness: 1, texture: 'speckle', accent: '#ff9a2e' },
}

export const TERRAIN_KEYS = Object.keys(TERRAIN_TYPES)

export function terrainDefaults(key) {
  return TERRAIN_TYPES[key] || TERRAIN_TYPES.grass
}

// ---------------------------------------------------------------------------
// Procedural textures
// ---------------------------------------------------------------------------
// Canvas elements are cached per terrain type (reused if rebuilt).

function mulberry32(seed) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Paint a small tileable noise canvas for a terrain pattern.
 */
function makeTexture(kind, base, accent, seed = 1) {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  const rand = mulberry32(seed * 7919 + kind.length * 13)

  ctx.fillStyle = base
  ctx.fillRect(0, 0, size, size)

  if (kind === 'speckle') {
    for (let i = 0; i < 900; i++) {
      const x = rand() * size
      const y = rand() * size
      const r = 0.5 + rand() * 2.2
      ctx.fillStyle = accent
      ctx.globalAlpha = 0.05 + rand() * 0.22
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
      // wrap
      if (x < 4) ctx.fillRect(0, y, r, r)
      if (y < 4) ctx.fillRect(x, 0, r, r)
    }
  } else if (kind === 'crack') {
    ctx.globalAlpha = 0.35
    ctx.strokeStyle = accent
    for (let i = 0; i < 26; i++) {
      ctx.lineWidth = 0.6 + rand() * 1.4
      ctx.beginPath()
      let x = rand() * size
      let y = rand() * size
      ctx.moveTo(x, y)
      const steps = 4 + Math.floor(rand() * 5)
      for (let s = 0; s < steps; s++) {
        x += (rand() - 0.5) * 34
        y += (rand() - 0.5) * 34
        ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
    ctx.globalAlpha = 0.12
    for (let i = 0; i < 300; i++) {
      ctx.fillStyle = accent
      ctx.fillRect(rand() * size, rand() * size, 1.6, 1.6)
    }
  } else if (kind === 'wave') {
    ctx.globalAlpha = 0.22
    ctx.strokeStyle = accent
    for (let w = 0; w < 10; w++) {
      ctx.lineWidth = 1 + rand() * 2
      ctx.beginPath()
      const yBase = rand() * size
      const amp = 2 + rand() * 5
      for (let x = 0; x <= size; x += 4) {
        const y = yBase + Math.sin((x / size) * Math.PI * 4 + w) * amp
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
  }
  ctx.globalAlpha = 1
  return canvas
}

const THREE_TEXTURES = new Map()

/**
 * CanvasTexture per terrain type, created once (document/canvas must be
 * available — called lazily from the renderer).
 */
export function buildTerrainTextures(THREE) {
  const out = {}
  for (const key of TERRAIN_KEYS) {
    const def = TERRAIN_TYPES[key]
    if (!def.texture || def.texture === 'none') continue
    let canvas = THREE_TEXTURES.get(key)
    if (!canvas) {
      canvas = makeTexture(def.texture, def.color, def.accent, key.length + 3)
      THREE_TEXTURES.set(key, canvas)
    }
    const tex = new THREE.CanvasTexture(canvas)
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.repeat.set(4, 4)
    tex.anisotropy = 4
    tex.colorSpace = THREE.SRGBColorSpace
    out[key] = tex
  }
  return out
}
