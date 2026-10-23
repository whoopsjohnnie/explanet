// Node loader hook so the harness can import the app: maps the browser-only
// "@react-three/cannon" entry (package has only "module") to its ESM dist,
// and transpiles .jsx with esbuild. Registered by harness/index.mjs before
// any app module import.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'

export async function resolve(specifier, context, next) {
  if (specifier === '@react-three/cannon') {
    const u = new URL('../../node_modules/@react-three/cannon/dist/index.js', import.meta.url)
    return { url: u.href, format: 'module', shortCircuit: true }
  }
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (url.endsWith('.jsx')) {
    const src = await readFile(fileURLToPath(url), 'utf8')
    const out = transformSync(src, {
      loader: 'jsx',
      format: 'esm',
      jsx: 'automatic',
      target: 'node20',
      sourcefile: fileURLToPath(url),
    })
    return { format: 'module', source: out.code, shortCircuit: true }
  }
  return next(url, context)
}
