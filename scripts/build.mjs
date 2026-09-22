import { build } from 'esbuild'
import { rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await rm(resolve(root, 'lib'), { recursive: true, force: true })
const tscScript = resolve(root, 'node_modules/typescript/bin/tsc')
const declarations = existsSync(tscScript)
  ? spawnSync(process.execPath, [tscScript, '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' })
  : spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsc', '-p', 'tsconfig.json'], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
if (declarations.status !== 0) process.exit(declarations.status ?? 1)

await build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: false,
  external: ['@deepseek-ai/schemastery'],
  banner: { js: '/* dsh-whyai — Host plugin. Generated from src/. */' },
})

await build({
  absWorkingDir: root,
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['react'],
  banner: { js: 'window.__ModuleLoader__.load({ id: "dsh-whyai", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; }});' },
})

process.stdout.write('built lib/index.js and lib/client.js for dsh-whyai\n')
