/**
 * Scene.jsx — the R3F canvas: cannon physics world (zero global gravity,
 * pairwise N-body attraction added per frame), starfield, lights, controls.
 */

import { useMemo } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Physics } from '@react-three/cannon'
import { OrbitControls, Stars } from '@react-three/drei'
import { useStore } from '../state/store.js'
import { registry, stepGravity } from '../core/physics.js'
import { planetRadius } from '../core/planetMath.js'
import { animateTerrainMaterials } from '../three/materials.js'
import Planet from './Planet.jsx'
import Walker from './Walker.jsx'

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

/**
 * Rigidly drags the camera along with the selected planet so orbit controls
 * keep working while worlds fly around.
 */
function CameraFollow() {
  const controls = useThree((s) => s.controls)
  const camera = useThree((s) => s.camera)
  useFrame(() => {
    if (!controls?.target) return
    if (useStore.getState().walkMode) return // surface walker owns the camera (first person)
    if (!useStore.getState().followSelected) return
    const id = useStore.getState().selectedId
    const body = id ? registry.bodies.get(id) : null
    if (!body) return
    const t = controls.target
    const dx = body.pos.x - t.x
    const dy = body.pos.y - t.y
    const dz = body.pos.z - t.z
    if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) < 1e-7) return
    camera.position.set(camera.position.x + dx, camera.position.y + dy, camera.position.z + dz)
    t.set(body.pos.x, body.pos.y, body.pos.z)
    controls.update()
  })
  return null
}

export default function Scene() {
  const planets = useStore((s) => s.world.planets)
  const playing = useStore((s) => s.playing)
  const walkMode = useStore((s) => s.walkMode)

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
  const starR = Math.max(900, sysR * 2.7) // starfield sits beyond the zoom limit
  const starCount = Math.min(16000, Math.round(7000 * Math.sqrt(starR / 900)))

  // Opening vantage OUTSIDE a true-size star: the classic camera position
  // above sits at ~450 u, which a real Sun (≈20,000 u at a 35 km anchor)
  // would swallow whole. Any star under ~140 u — every stored world to date
  // — keeps the classic vantage untouched (the factor is exactly 1).
  const camK = useMemo(() => {
    let sunR = 0
    for (const p of planets) if (p.isStatic) sunR = Math.max(sunR, planetRadius(p))
    return Math.max(1, (sunR * 3.2) / 450)
  }, [planets])

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
      <Stars radius={starR} depth={160} count={starCount} factor={5} saturation={0} fade speed={0.3} />
      <ambientLight intensity={0.5} />
      <hemisphereLight args={['#9db8ff', '#201607', 0.3]} />

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

      {/* disabled while walking: the surface walker drives the camera in
          first person, and OrbitControls' world-Y azimuth fights that */}
      <OrbitControls makeDefault enableDamping dampingFactor={0.09} minDistance={1.5} maxDistance={Math.max(1600, sysR * 2.4)} enabled={!walkMode} />
      <CameraFollow />
      {walkMode && <Walker key={walkMode.planetId} planetId={walkMode.planetId} />}
      <MaterialAnimator />
    </Canvas>
  )
}
