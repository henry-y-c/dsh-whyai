import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temp = await mkdtemp(join(root, '.tmp-pack-'))

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

try {
  const packOutput = run('npm', ['pack', '--json', '--cache', '.npm-cache', '--pack-destination', temp])
  const jsonStart = packOutput.lastIndexOf('\n[')
  if (jsonStart < 0) throw new Error(`npm pack did not emit JSON: ${packOutput.slice(-1_000)}`)
  const packed = JSON.parse(packOutput.slice(jsonStart + 1))[0]
  assert.equal(packed.entryCount > 0, true)
  const archive = join(temp, packed.filename)
  const extracted = join(temp, 'package')
  run('tar', ['-xzf', archive, '-C', temp])
  const installed = join(temp, 'node_modules', 'dsh-whyai')
  await mkdir(dirname(installed), { recursive: true })
  await rename(extracted, installed)

  const runtime = await import(pathToFileURL(join(installed, 'lib', 'index.js')).href)
  assert.equal(runtime.name, 'whyai')
  assert.equal(typeof runtime.apply, 'function')
  assert.equal('default' in runtime, false)

  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  assert.equal(manifest.dsh.client.platform, 'web')
  let client
  runInNewContext(await readFile(join(installed, 'lib/client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load(value) { client = value } } },
  })
  assert.equal(client.id, manifest.name)
  assert.equal(typeof client.factory, 'function')
  const browser = client.factory(id => {
    assert.equal(id, 'react', '仅 React 从宿主共享')
    return {}
  })
  assert.equal(typeof browser.apply, 'function')
  assert.ok(browser.inject.includes('slots'))

  const consumer = join(temp, 'consumer.ts')
  await writeFile(consumer, [
    "import { Config, apply, type WhyAiConfig } from 'dsh-whyai'",
    "import { apply as clientApply } from 'dsh-whyai/client'",
    'void clientApply',
    'declare const config: WhyAiConfig',
    'void Config',
    'void apply',
    'void config',
    '',
  ].join('\n'))
  run(process.execPath, [
    join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    consumer,
  ], temp)
  process.stdout.write('pack smoke passed: tarball import and NodeNext type consumer\n')
} finally {
  await rm(temp, { recursive: true, force: true })
}
