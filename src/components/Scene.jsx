/**
 * Scene.jsx — the R3F canvas: cannon physics world (zero global gravity,
 * pairwise N-body attraction added per frame), the real-sky backdrop
 * (StarField.jsx), lights, controls.
 */

import { useMemo } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Physics } from '@react-three/cannon'
import { OrbitControls } from '@react-three/drei'
import { useStore } from '../state/store.js'
import { stepGravity } from '../core/physics.js'
import { planetRadius } from '../core/planetMath.js'
import { C } from '../core/constants.js'
import { animateTerrainMaterials } from '../three/materials.js'
import Planet from './Planet.jsx'
import Walker from './Walker.jsx'
import WalkSky from './WalkSky.jsx'
import StarField from './StarField.jsx'
import CameraFollow from './CameraFollow.jsx'
import AmbientCrafts from './Crafts.jsx'
import CraftCockpit from './CraftCockpit.jsx'
import EvaCam from './EvaCam.jsx'

function GravityRunner() {
  useFrame(() => {
    const s = useStore.getState()
    if (s.playing) stepGravity(s.world.gravity)
  })
  return null
}

function MaterialAnimator() {
  useFrame((_, delta) => animateTerrainMaterials(Math.min(delta, 0.05)))
  return null
}

export default function Scene() {
  const planets = useStore((s) => s.world.planets)
  const playing = useStore((s) => s.playing)
  const player = useStore((s) => s.player)

  // The viewport sizes itself to the system's own extent: for compact worlds
  // every constant below evaluates to its classic value (starfield 900 u,
  // fog 900–2400, far plane 5000, zoom-out 1600), while sprawling systems
  // (Pluto at ≈ 3,500 u) scale them up so the whole system stays zoomable,
  // inside the far plane, and only hazed at true depth.
  const sysR = useMemo(() => {
    let r = 80
    for (const p of planets) r = Math.max(r, Math.hypot(p.center.x, p.center.y, p.center.z))
    return r
  }, [planets])
  // same star predicate the atmosphere shaders use (WalkSky/AtmosphereGlow)
  const hasStar = useMemo(
    () => planets.some((p) => p.kind === 'star' || p.preset === 'star'),
    [planets]
  )
  const starR = Math.max(900, sysR * 2.7) // starfield sits beyond the zoom limit

  // Opening vantage OUTSIDE a true-size star: the classic camera position
  // above sits at ~450 u, which a real Sun (≈20,000 u at a 35 km anchor)
  // would swallow whole. Any star under ~140 u — every stored world to date
  // — keeps the classic vantage untouched (the factor is exactly 1).
  const camK = useMemo(() => {
    let sunR = 0
    for (const p of planets) if (p.isStatic) sunR = Math.max(sunR, planetRadius(p))
    return Math.max(1, (sunR * 3.2) / 450)
  }, [planets])

  // Walking under an atmosphere no longer hides the real sky: StarField
  // stays mounted and fades itself per-frame (WalkSky's day/night curve ×
  // opacity haze), so the Milky Way shows on the night side, washes out in
  // daylight, and the dome (rendered beneath it, additive points on top)
  // only carries the air's own color.

  return (
    <Canvas
      className="scene"
      // logarithmic depth: true-scale worlds put a 5 km asteroid and a 4e8 u
      // TNO orbit in one frustum — the classic hyperbolic buffer z-fights or
      // clips one of them; log windowing keeps both crisp.
      gl={{ logarithmicDepthBuffer: true, antialias: true }}
      camera={{ position: [222 * camK, 165 * camK, 355 * camK], fov: 45, near: 0.1, far: Math.max(5000, starR * 2.2) }}
      dpr={[1, 2]}
      onPointerMissed={() => {
        // clicking empty space with the select tool keeps the selection;
        // nothing to do — OrbitControls handles the drag.
      }}
    >
      <color attach="background" args={['#04060d']} />
      <fog attach="fog" args={['#04060d', Math.max(900, sysR * 1.2), Math.max(2400, sysR * 9)]} />
      <StarField radius={starR} />
      {/* The star's pointLight (in Planet.jsx) is the system's only key
          light: with one present the fill drops to a whisper floor, so night
          sides fall into near-darkness like real photos — Jupiter's backside
          reads as a silhouette, not a grey ball — and walk-mode ground
          darkens with the sky. A starless world keeps the classic
          ambient + hemisphere so it stays visible. */}
      {hasStar ? (
        <ambientLight intensity={C.sky.ambientFloor} />
      ) : (
        <>
          <ambientLight intensity={0.5} />
          <hemisphereLight args={['#9db8ff', '#201607', 0.3]} />
        </>
      )}

      <Physics
        gravity={[0, 0, 0]}
        isPaused={!playing}
        broadphase="SAP"
        allowSleep={false}
        iterations={8}
      >
        {planets.map((p) => (
          <Planet key={p.id} planet={p} />
        ))}
        <GravityRunner />
      </Physics>

      {/* The crafts step BEFORE the cameras read them (mount order = useFrame
          order): every craft integrates its mover, the piloted one fed the
          live input, and the player's craft renders among them. */}
      <AmbientCrafts />
      {/* the editor camera — the old orbit mode — is ONLY the freeCam
          session: walking, piloting and EVA each own the camera in first
          (or chase) person, and OrbitControls' world-Y azimuth fights them */}
      <OrbitControls makeDefault enableDamping dampingFactor={0.09} minDistance={1.5} maxDistance={Math.max(1600, sysR * 2.4)} enabled={!player || player.kind === 'freeCam'} />
      <CameraFollow />
      {player?.kind === 'craft' && <CraftCockpit key={player.craftId} craftId={player.craftId} />}
      {player?.kind === 'eva' && <EvaCam />}
      {player?.kind === 'foot' && <Walker key={player.bodyId} planetId={player.bodyId} />}
      {/* the sky rides along: mounted after Walker so its useFrame reads the
          camera pose the walker just wrote; renders only with an atmosphere */}
      {player?.kind === 'foot' && <WalkSky key={player.bodyId} planetId={player.bodyId} />}
      <MaterialAnimator />
    </Canvas>
  )
}
