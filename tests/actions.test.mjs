import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { CONFIG } from './helpers.mjs'
const bundle = await build({ stdin: { contents: "export * from './src/actions.ts'; export * from './src/runner.ts'; export * from './src/routes.ts'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, bundle: true, write: false, format: 'esm', platform: 'node' })
const { WhyAiActions, WhyAiCliRunner, downloadInstaller, installActionRoutes } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const signal = () => new AbortController().signal
function runtime(options = {}) {
  const specs = []
  let logged = false
  return { specs,
    async resolveExecutable(command) { return command },
    spawn(spec) {
      specs.push(spec)
      let output = '', stderr = '', exitCode = 0
      if (spec.argv.includes('login')) { logged = true; stderr = 'https://oauth.invalid/?secret=NEVER-EXPOSE' }
      else if (spec.argv.includes('logout')) { logged = false; output = '{"logged_out":true}' }
      else if (spec.argv.includes('status')) { output = JSON.stringify({ logged_in: logged }); exitCode = logged ? 0 : 1 }
      else if (spec.argv.includes('--version')) output = '0.5.7'
      if (options.fail) { exitCode = 2; stderr = 'SECRET raw diagnostics' }
      const done = options.done?.(spec) ?? Promise.resolve({ exitCode, signal: null })
      return { done, collected: { stdout: { readFrom: () => ({ text: output, lossy: false }) }, stderr: { readFrom: () => ({ text: stderr, lossy: false }) } },
        terminate() { options.terminate?.() }, waitForExit: options.waitForExit ?? (async () => true) }
    },
  }
}
async function settled(actions) { await actions.pending; return actions.current }

test('real runner lease completes login and logout without reentrant deadlock; invalidates start and every terminal', async () => {
  const subprocess = runtime(), runner = new WhyAiCliRunner(subprocess, CONFIG)
  let invalidations = 0
  const actions = new WhyAiActions(subprocess, CONFIG, runner, () => invalidations++)
  assert.equal(actions.start('login').operation.phase, 'running')
  assert.equal((await settled(actions)).phase, 'succeeded')
  assert.equal(actions.start('logout').operation.phase, 'running')
  assert.equal((await settled(actions)).phase, 'succeeded')
  assert.equal(subprocess.specs.length, 4)
  assert.equal(invalidations, 4)
  assert.doesNotMatch(JSON.stringify(actions.current), /SECRET|oauth|stderr/)
  await actions.dispose(); await runner.dispose()
})

test('consultation is not cancelled by management; management rejects busy and consultations reject during management', async () => {
  let release
  const subprocess = runtime({ done: () => new Promise(resolve => { release = resolve }) })
  const runner = new WhyAiCliRunner(subprocess, CONFIG)
  const actions = new WhyAiActions(subprocess, CONFIG, runner)
  const consultation = runner.invokeRaw(['consult'], undefined, signal())
  assert.deepEqual(actions.start('login'), { status: 'error', code: 'WHYAI_BUSY' })
  while (!release) await Promise.resolve()
  assert.equal(subprocess.specs[0].signal.aborted, false)
  release({ exitCode: 0, signal: null }); await consultation
  const result = actions.start('login')
  await assert.rejects(runner.invokeRaw(['consult'], undefined, signal()), { code: 'WHYAI_BUSY' })
  actions.cancel(result.operation.id)
  await settled(actions)
  await actions.dispose(); await runner.dispose()
})

test('cancel is id fenced and stays running through actual cleanup', async () => {
  let quiet, terminated = false
  const subprocess = runtime({ done: () => new Promise(() => {}), terminate: () => { terminated = true }, waitForExit: () => new Promise(resolve => { quiet = resolve }) })
  const runner = new WhyAiCliRunner(subprocess, CONFIG), actions = new WhyAiActions(subprocess, CONFIG, runner)
  const { operation } = actions.start('login')
  while (!subprocess.specs.length) await Promise.resolve()
  assert.equal(actions.cancel('not-matching').code, 'WHYAI_OPERATION_NOT_FOUND')
  assert.equal(actions.cancel(operation.id).operation.phase, 'running')
  while (!quiet) await Promise.resolve()
  assert.equal(terminated, true); assert.equal(actions.current.phase, 'running')
  quiet(true)
  assert.equal((await settled(actions)).phase, 'cancelled')
  await actions.dispose(); await runner.dispose()
})

test('dispose bounds stalled resolver and redacts failures; failures invalidate twice', async () => {
  const subprocess = { resolveExecutable: () => new Promise(() => {}), spawn: () => assert.fail('late spawn') }
  const runner = new WhyAiCliRunner(subprocess, CONFIG), actions = new WhyAiActions(subprocess, CONFIG, runner)
  actions.start('login'); await actions.dispose(); await runner.dispose()
  assert.equal(actions.current.phase, 'cancelled')
  let invalidations = 0
  const bad = runtime({ fail: true }), badRunner = new WhyAiCliRunner(bad, CONFIG)
  const badActions = new WhyAiActions(bad, CONFIG, badRunner, () => invalidations++)
  badActions.start('login'); await settled(badActions)
  assert.equal(invalidations, 2)
  assert.equal(badActions.current.code, 'WHYAI_COMMAND_FAILED')
  assert.doesNotMatch(JSON.stringify(badActions.current), /SECRET|diagnostics/)
  await badActions.dispose(); await badRunner.dispose()
})

test('installer download is byte bounded, refuses redirects, handles oversized chunks and stalled reads', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.redirect, 'error')
    return new Response(new Uint8Array(1024 * 1024 + 1))
  })
  await assert.rejects(downloadInstaller(signal()), { code: 'WHYAI_INSTALL_TOO_LARGE' })
  globalThis.fetch = async () => new Response('ok', { status: 302, headers: { location: 'https://evil.invalid' } })
  await assert.rejects(downloadInstaller(signal()), { code: 'WHYAI_INSTALL_DOWNLOAD_FAILED' })
  globalThis.fetch = async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}) } }))
  const controller = new AbortController(), pending = downloadInstaller(controller.signal)
  await Promise.resolve(); controller.abort()
  await assert.rejects(pending, { code: 'WHYAI_CANCELLED' })
})

test('installer uses managed execution, verifies exact changed target and removes temp after quiescence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'whyai-test-home-'))
  const variable = process.platform === 'win32' ? 'LOCALAPPDATA' : 'HOME'
  const old = process.env[variable]; process.env[variable] = root
  t.after(async () => { if (old === undefined) delete process.env[variable]; else process.env[variable] = old; await rm(root, { recursive: true, force: true }) })
  t.mock.method(globalThis, 'fetch', async () => new Response('// fixture, never executed'))
  const target = process.platform === 'win32' ? join(root, 'WhyAI', 'bin', 'whyai.cmd') : join(root, '.local', 'bin', 'whyai')
  let script, quiet = false
  const subprocess = runtime({ done(spec) {
    if (!spec.argv[1]?.endsWith('install.mjs')) return undefined
    script = spec.argv[1]
    return (async () => {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, 'fixture')
      return { exitCode: 0, signal: null }
    })()
  }, waitForExit: async () => { quiet = true; return true } })
  const runner = new WhyAiCliRunner(subprocess, { ...CONFIG, cliPath: 'whyai' }), actions = new WhyAiActions(subprocess, { ...CONFIG, cliPath: 'whyai' }, runner)
  actions.start('install'); await settled(actions)
  assert.equal(quiet, true)
  await assert.rejects(access(script))
  if (process.platform !== 'win32') {
    assert.equal(actions.current.phase, 'succeeded')
    assert.equal(subprocess.specs.at(-1).argv[0], target)
  }
  await actions.dispose(); await runner.dispose()
  const custom = new WhyAiActions(subprocess, CONFIG, runner)
  assert.equal(custom.start('install').code, 'WHYAI_INSTALL_CUSTOM_PATH_UNSUPPORTED')
})

test('installer cannot use an unchanged old target to mask a no-op installer', async t => {
  const root = await mkdtemp(join(tmpdir(), 'whyai-test-old-'))
  const variable = process.platform === 'win32' ? 'LOCALAPPDATA' : 'HOME'
  const old = process.env[variable]; process.env[variable] = root
  t.after(async () => { if (old === undefined) delete process.env[variable]; else process.env[variable] = old; await rm(root, { recursive: true, force: true }) })
  t.mock.method(globalThis, 'fetch', async () => new Response('// fixture'))
  const target = process.platform === 'win32' ? join(root, 'WhyAI', 'bin', 'whyai.cmd') : join(root, '.local', 'bin', 'whyai')
  await mkdir(dirname(target), { recursive: true }); await writeFile(target, 'old CLI')
  const subprocess = runtime(), config = { ...CONFIG, cliPath: 'whyai' }
  const runner = new WhyAiCliRunner(subprocess, config), actions = new WhyAiActions(subprocess, config, runner)
  actions.start('install'); await settled(actions)
  assert.equal(actions.current.code, 'WHYAI_INSTALL_VERIFY_FAILED')
  assert.equal(subprocess.specs.length, 1)
  await actions.dispose(); await runner.dispose()
})

test('installer temp survives failed process quiescence; operation and runner fail closed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'whyai-test-orphan-'))
  const variable = process.platform === 'win32' ? 'LOCALAPPDATA' : 'HOME'
  const old = process.env[variable]; process.env[variable] = root
  let script
  t.after(async () => {
    if (old === undefined) delete process.env[variable]; else process.env[variable] = old
    await rm(root, { recursive: true, force: true })
    if (script) await rm(dirname(script), { recursive: true, force: true }) // Fake handle owns no actual process.
  })
  t.mock.method(globalThis, 'fetch', async () => new Response('// fixture'))
  const subprocess = runtime({ done(spec) { script = spec.argv[1]; return new Promise(() => {}) }, waitForExit: async () => false })
  const config = { ...CONFIG, cliPath: 'whyai', graceMs: 5 }
  const runner = new WhyAiCliRunner(subprocess, config), actions = new WhyAiActions(subprocess, config, runner)
  const result = actions.start('install')
  while (!script) await new Promise(resolve => setImmediate(resolve))
  actions.cancel(result.operation.id); await settled(actions)
  assert.equal(actions.current.phase, 'failed'); assert.equal(actions.current.code, 'WHYAI_PROCESS_FAILED')
  await access(script)
  assert.equal(actions.start('login').code, 'WHYAI_BUSY')
  await assert.rejects(actions.dispose(), { code: 'WHYAI_PROCESS_FAILED' }); await assert.rejects(runner.dispose())
  await access(script)
})

test('management routes authenticate, check methods/confirmation/query and use 202 operations/id cancel', async () => {
  const subprocess = runtime(), runner = new WhyAiCliRunner(subprocess, CONFIG), actions = new WhyAiActions(subprocess, CONFIG, runner)
  const routes = new Map(); let cleanup, rejection
  installActionRoutes({ connection: { requestRejection: () => rejection }, effect(fn) { cleanup = fn() }, webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } }, actions)
  async function request(path, method, query = '', headers = {}) {
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers }, end(body) { this.body = JSON.parse(body) } }
    await routes.get(`/api/whyai/${path}`).handler({ method, url: `/api/whyai/${path}${query}`, headers }, res)
    return res
  }
  rejection = 401; assert.equal((await request('login', 'POST', '?confirm=host')).status, 401)
  rejection = undefined; assert.equal((await request('login', 'GET')).status, 405)
  assert.equal((await request('login', 'POST')).body.code, 'WHYAI_CONFIRMATION_REQUIRED')
  assert.equal((await request('login', 'POST', '?confirm=host&confirm=host')).status, 400)
  assert.equal((await request('login', 'POST', '?confirm=host', { 'content-length': '10000000' })).status, 400)
  const accepted = await request('login', 'POST', '?confirm=host')
  assert.equal(accepted.status, 202); assert.equal(accepted.body.operation.phase, 'running')
  assert.equal((await request('operation/cancel', 'POST', '?id=00000000-0000-0000-0000-000000000000')).status, 404)
  assert.equal((await request('operation', 'GET')).body.operation.id, accepted.body.operation.id)
  const disposal = cleanup(); assert.equal(routes.size, 0); await disposal; await runner.dispose()
})
