/**
 * Scene.jsx — the R3F canvas: cannon physics world (zero global gravity,
 * pairwise N-body attraction added per frame), starfield, lights, controls.
 */

import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Physics } from '@react-three/cannon'
import { OrbitControls, Stars } from '@react-three/drei'
import { useStore } from '../state/store.js'
import { registry, stepGravity } from '../core/physics.js'
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

  return (
    <Canvas
      className="scene"
      camera={{ position: [70, 52, 112], fov: 45, near: 0.1, far: 5000 }}
      dpr={[1, 2]}
      onPointerMissed={() => {
        // clicking empty space with the select tool keeps the selection;
        // nothing to do — OrbitControls handles the drag.
      }}
    >
      <color attach="background" args={['#04060d']} />
      <fog attach="fog" args={['#04060d', 900, 2400]} />
      <Stars radius={900} depth={160} count={7000} factor={5} saturation={0} fade speed={0.3} />
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
      <OrbitControls makeDefault enableDamping dampingFactor={0.09} minDistance={1.5} maxDistance={1600} enabled={!walkMode} />
      <CameraFollow />
      {walkMode && <Walker key={walkMode.planetId} planetId={walkMode.planetId} />}
      <MaterialAnimator />
    </Canvas>
  )
}
