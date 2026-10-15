/**
 * materials.js — shared THREE materials per terrain type (built lazily,
 * once). Colors come from vertex colors, patterns from procedural canvas
 * textures (core/terrain.js).
 */

import * as THREE from 'three'
import { TERRAIN_KEYS, TERRAIN_TYPES, buildTerrainTextures } from '../core/terrain.js'

let cache = null

export function getTerrainMaterials() {
  if (cache) return cache
  const textures = buildTerrainTextures(THREE)
  cache = {}
  for (const key of TERRAIN_KEYS) {
    const def = TERRAIN_TYPES[key]
    const mat = new THREE.MeshStandardMaterial({
      map: textures[key] || null,
      vertexColors: true,
      roughness: def.roughness ?? 0.95,
      metalness: def.metalness ?? 0,
      flatShading: true,
      transparent: !!def.transparent,
      opacity: def.transparent ? def.opacity : 1,
      emissive: def.emissive ? new THREE.Color(def.emissive) : new THREE.Color(0x000000),
      emissiveIntensity: def.emissiveIntensity ?? 0,
    })
    cache[key] = mat
  }
  return cache
}

/** Gentle animated shimmer for water / lava / star surfaces. */
export function animateTerrainMaterials(delta) {
  if (!cache) return
  const keys = ['water', 'lava', 'star']
  for (const k of keys) {
    const m = cache[k]
    if (m?.map) {
      m.map.offset.x += delta * (k === 'water' ? 0.012 : 0.006)
      m.map.offset.y += delta * 0.004
    }
  }
}
