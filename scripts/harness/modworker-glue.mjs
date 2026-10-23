// worker_threads glue that lets a real ESM module worker file (e.g.
// src/three/geometry.worker.js, which uses self.onmessage/self.postMessage)
// run under Node's worker_threads. Spawned by harness/env.mjs's ShimWorker.
import { parentPort, workerData } from 'node:worker_threads'

globalThis.self = {
  postMessage: (m, t) => parentPort.postMessage(m, t || []),
  onmessage: null,
}
parentPort.on('message', (m) => {
  if (globalThis.self.onmessage) globalThis.self.onmessage({ data: m })
})
await import(workerData.url)
