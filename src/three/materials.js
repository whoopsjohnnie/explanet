/**
 * materials.js — shared THREE materials per terrain type (built lazily,
 * once). Colors come from vertex colors, patterns from procedural canvas
 * textures (core/terrain.js).
 */

import * as THREE from 'three'
import { TERRAIN_KEYS, TERRAIN_TYPES, buildTerrainTextures } from '../core/terrain.js'
import { C, gnum } from '../core/constants.js'

let cache = null

/**
 * VGA specular quantizer: step the star's specular reflection into contour
 * bands (sunGlare dial) so water glints in discrete rings instead of a smooth
 * wash. Injected after three sums the direct specular for the (single) key
 * light, quantized by luminance so the band keeps the light's color. Only
 * attached when quantization is ON — the smooth default stays byte-identical
 * to an unpatched MeshStandardMaterial.
 */
function bandReflectiveSpecular(mat, label) {
  const steps = C.gradient.steps.sunGlare
  if (!(steps > 0)) return
  const n = gnum(steps)
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
      { // ${label}: discrete sun reflection
        float reflLum = max( max( reflectedLight.directSpecular.r, reflectedLight.directSpecular.g ), reflectedLight.directSpecular.b );
        if ( reflLum > 0.0 ) {
          float reflQ = floor( reflLum * ${n} + 0.5 ) / ${n};
          reflectedLight.directSpecular *= reflQ / reflLum;
        }
      }`
    )
  }
}

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
    // reflective surfaces (water) get the banded sun-glare treatment when the
    // gradientSteps dial is on; rough terrain has no specular worth stepping
    if (def.roughness !== undefined && def.roughness < 0.5) bandReflectiveSpecular(mat, key)
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
