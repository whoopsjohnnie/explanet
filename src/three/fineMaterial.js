/**
 * fineMaterial.js — the document terrain shader's fine-region suppression
 * (docs/terrain.txt §4.4).
 *
 * The document mesh renders whole; where a fine chunk is mounted, the coarse
 * fan would otherwise double-render (and, in stage 2, a valley pixel under a
 * coarse average would read as a ceiling over the walker). So the document
 * terrain SHADER discards fragments whose chunk is mounted — O(1) per fragment
 * (a tangent-plane projection, a floor-divide to the chunk, one data-texture
 * lookup), zero geometry cost. The suppressed region EQUALS the mounted-chunk
 * set exactly: no gap, no double surface, no stale hole.
 *
 * The terrain materials are SHARED across every body (materials.js), but the
 * suppression is per-body (one body has the fine region at a time). So the
 * focus body gets its own CLONED material set carrying the discard + its
 * uniforms; every other body keeps the shared materials. The clones share the
 * same map/vertex-color/flat-shading state, so a suppressed body looks
 * byte-identical to an unsuppressed one outside the fine region.
 */

import * as THREE from 'three'

// The fragment's body-local (object-space) position, passed from the vertex
// stage — the mesh lives in the body's spin frame, so object space IS the
// body-local frame the cap and the chunk lattice are defined in.
const VERT_VARYING = 'varying vec3 fdLocalPos;\n'
const VERT_ASSIGN = '  fdLocalPos = position;\n'

// Injected at the very end of the standard fragment main (before dithering):
// project the fragment direction to the focus patch's tangent plane, recover
// the fine hex (cube round) and its chunk (floor-divide), and discard when
// that chunk is mounted in the data texture.
const FRAG_HEAD = `
varying vec3 fdLocalPos;
uniform vec2  fdFocusPlane; // the focus's tangent-plane point (plane units)
uniform float fdPatch;      // 0 = +Z patch, 1 = -Z patch
uniform float fdPlaneA;     // the fine hex edge (plane units, dimensionless)
uniform float fdChunkSide;  // fine hexes per chunk side
uniform vec2  fdTexOffset;  // (Imin, Jmin) of the mounted-chunk texture
uniform vec2  fdTexSize;    // (W, H) of the mounted-chunk texture
uniform float fdCapPlane;   // the cap radius (plane units) — bounding check
uniform sampler2D fdMounted; // 1 where a chunk is mounted
`;

const FRAG_BODY = `
{
  // only the focus body's document mesh ever runs this (fdCapPlane > 0);
  // for a radius-0 cap the body is unmounted and nothing is discarded
  if (fdCapPlane > 0.0) {
    vec3 d = normalize(fdLocalPos);
    float z = d.z;
    float pz = (abs(z) < 1e-6) ? ((fdPatch < 0.5) ? 1e-6 : -1e-6) : z;
    vec2 pp = (fdPatch < 0.5) ? vec2(d.x / pz, d.y / pz) : vec2(-d.x / pz, d.y / pz);
    // bounding check: the fragment must be near the cap (plane distance)
    if (length(pp - fdFocusPlane) <= fdCapPlane) {
      // fine hex (q, r) via cube round
      float qf = (1.7320508075688772 / 3.0 * pp.x - 1.0 / 3.0 * pp.y) / fdPlaneA;
      float rf = (2.0 / 3.0 * pp.y) / fdPlaneA;
      float cx = qf, cy = -qf - rf, cz = rf;
      float rx = round(cx), ry = round(cy), rz = round(cz);
      float ddx = abs(rx - cx), ddy = abs(ry - cy), ddz = abs(rz - cz);
      if (ddx > ddy && ddx > ddz) rx = -ry - rz;
      else if (ddy > ddz) ry = -rx - rz;
      float I = floor(rx / fdChunkSide);
      float J = floor(rz / fdChunkSide);
      vec2 texel = vec2(I - fdTexOffset.x, J - fdTexOffset.y);
      if (texel.x >= 0.0 && texel.x < fdTexSize.x && texel.y >= 0.0 && texel.y < fdTexSize.y) {
        float mounted = texture2D(fdMounted, (texel + 0.5) / fdTexSize).r;
        if (mounted > 0.5) discard;
      }
    }
  }
}
#include <dithering_fragment>
`

/**
 * Build a per-body CLONED set of terrain materials carrying the fine-region
 * suppression. Shares the source materials' map / vertex-color / flat-shading
 * state (so a suppressed body is byte-identical to an unsuppressed one outside
 * the fine region) and adds the §4.4 discard.
 *
 * Returns `{ materials, uniforms, mountedTexture }`. The caller updates
 * `uniforms` (the cap, the focus plane, and the mounted-chunk texture contents)
 * as the loaded set streams; `mountedTexture` is a small R8 DataTexture whose
 * texels are the mounted-chunk set.
 */
export function makeSuppressionMaterials(shared) {
  const materials = {}
  // one shared uniform set across the body's terrain types (the cap/texture are
  // the same for every terrain batch of the body)
  const mountedTexture = new THREE.DataTexture(new Uint8Array(1), 1, 1, THREE.RedFormat, THREE.UnsignedByteType)
  mountedTexture.magFilter = THREE.NearestFilter
  mountedTexture.minFilter = THREE.NearestFilter
  mountedTexture.needsUpdate = true

  const uniforms = {
    fdFocusPlane: { value: new THREE.Vector2(0, 0) },
    fdPatch: { value: 0 },
    fdPlaneA: { value: 0 },
    fdChunkSide: { value: 1 },
    fdTexOffset: { value: new THREE.Vector2(0, 0) },
    fdTexSize: { value: new THREE.Vector2(1, 1) },
    fdCapPlane: { value: 0 }, // 0 = unmounted (no discard)
    fdMounted: { value: mountedTexture },
  }

  for (const [key, src] of Object.entries(shared)) {
    const mat = src.clone()
    // clone() drops onBeforeCompile — re-apply the source's (the banded
    // sun-glare for water) so a suppressed body matches an unsuppressed one
    // outside the fine region, THEN add the §4.4 discard.
    const srcCompile = src.onBeforeCompile || null
    mat.onBeforeCompile = (shader) => {
      if (srcCompile) srcCompile(shader)
      shader.uniforms.fdFocusPlane = uniforms.fdFocusPlane
      shader.uniforms.fdPatch = uniforms.fdPatch
      shader.uniforms.fdPlaneA = uniforms.fdPlaneA
      shader.uniforms.fdChunkSide = uniforms.fdChunkSide
      shader.uniforms.fdTexOffset = uniforms.fdTexOffset
      shader.uniforms.fdTexSize = uniforms.fdTexSize
      shader.uniforms.fdCapPlane = uniforms.fdCapPlane
      shader.uniforms.fdMounted = uniforms.fdMounted
      shader.vertexShader = VERT_VARYING + shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n' + VERT_ASSIGN
      )
      shader.fragmentShader = FRAG_HEAD + shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        FRAG_BODY
      )
    }
    // a per-TYPE program key: the water's fragment (with the specular band)
    // differs from rock's, and both differ from the shared (unsuppressed) set
    mat.customProgramCacheKey = () => `finedisc-suppression-${key}`
    materials[key] = mat
  }

  return { materials, uniforms, mountedTexture }
}

/**
 * Resize + repopulate the mounted-chunk data texture to the current loaded set.
 * `chunks` is the loaded set's chunk array ({ I, J, ... }); the texture covers
 * their (I, J) bounding box, one byte per chunk (1 = mounted). Returns the
 * updated { Imin, Jmin, W, H } for the uniforms.
 */
export function setMountedTexture(mountedTexture, chunks) {
  if (!chunks.length) {
    mountedTexture.image.data = new Uint8Array([0])
    mountedTexture.image.width = 1
    mountedTexture.image.height = 1
    mountedTexture.needsUpdate = true
    return { Imin: 0, Jmin: 0, W: 1, H: 1 }
  }
  let Imin = Infinity, Jmin = Infinity, Imax = -Infinity, Jmax = -Infinity
  for (const c of chunks) {
    if (c.I < Imin) Imin = c.I
    if (c.J < Jmin) Jmin = c.J
    if (c.I > Imax) Imax = c.I
    if (c.J > Jmax) Jmax = c.J
  }
  const W = Imax - Imin + 1
  const H = Jmax - Jmin + 1
  const data = new Uint8Array(W * H)
  for (const c of chunks) data[(c.J - Jmin) * W + (c.I - Imin)] = 1
  mountedTexture.image.data = data
  mountedTexture.image.width = W
  mountedTexture.image.height = H
  mountedTexture.needsUpdate = true
  return { Imin, Jmin, W, H }
}
