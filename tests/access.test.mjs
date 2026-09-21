import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { apply } from '../lib/index.js'
import { CONFIG, fakeContext, NodeSubprocess } from './helpers.mjs'

const bundle = await build({ stdin: { contents: "export * from './src/access.ts'; export * from './src/routes.ts'; export { WhyAiCliError, WhyAiCliRunner } from './src/runner.ts'", resolveDir: new URL('..', import.meta.url).pathname }, bundle: true, write: false, format: 'esm', platform: 'node' })
const { WhyAiAccess, installAccessRoute, WhyAiCliError, WhyAiCliRunner } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const accessValue = { eligible: true, available_percent: 75, valid_until: '2099-01-01T00:00:00Z' }
const summaryValue = { plan_source: 'subscription', plan_expires_at: '2099-02-01T00:00:00Z', next_reset_at: '2098-12-15T00:00:00Z' }
const ok = (value) => ({ exitCode: 0, value, hadWarning: false })
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }
const responseRunner = (access = accessValue, summary = summaryValue) => ({ invoke: async (args) => ok(args.at(-1) === 'access' ? access : summary) })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

function mount(runner, reject = () => undefined) {
  let route
  let cleanup
  installAccessRoute({
    connection: { requestRejection: reject },
    webServer: { register(value) { route = value; return () => { route = undefined } } },
    effect(fn) { cleanup = fn() },
  }, runner)
  return { get route() { return route }, dispose: () => cleanup() }
}
async function request(route, method = 'GET') {
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers }, end(body) { this.body = JSON.parse(body) } }
  await route.handler({ method }, res)
  return res
}

test('runner disposal remains distinguishable in public access errors', async () => {
  const access = new WhyAiAccess({ invoke: async () => { throw new WhyAiCliError('WhyAI plugin was disposed', 'WHYAI_DISPOSED') } })
  assert.deepEqual(await access.get(), { status: 'error', code: 'WHYAI_DISPOSED' })
  await access.dispose()
})

test('projection separates CLI validity, subscription expiry and explicit quota reset', async () => {
  const access = new WhyAiAccess(responseRunner({ ...accessValue, user: 'private' }, { ...summaryValue, remaining_percent: 99, body: 'private' }))
  assert.deepEqual(await access.get(), { status: 'ok', data: {
    ...accessValue, subscription_expires_at: summaryValue.plan_expires_at, next_reset_at: summaryValue.next_reset_at, billing_status: 'ok',
  } })
  await access.dispose()
  for (const summary of [
    { plan_source: 'subscription' },
    {}, { plan_source: null }, { plan_source: '' },
    { plan_source: 'grant', plan_expires_at: { ignored: true }, next_reset_at: null },
  ]) {
    const empty = new WhyAiAccess(responseRunner({ eligible: false, reset_at: '2099-01-01T00:00:00Z' }, summary))
    assert.deepEqual(await empty.get(), { status: 'ok', data: {
      eligible: false, available_percent: null, valid_until: null, subscription_expires_at: null, next_reset_at: null, billing_status: 'ok',
    } })
    await empty.dispose()
  }
})

test('used access and summary fields are strictly validated', async () => {
  for (const value of [{}, { eligible: 1 }, { eligible: true, available_percent: 101 }, { eligible: true, available_percent: NaN }, { eligible: true, valid_until: 'private body' }]) {
    const access = new WhyAiAccess(responseRunner(value))
    assert.deepEqual(await access.get(), { status: 'error', code: 'WHYAI_MALFORMED_OUTPUT' })
    await access.dispose()
  }
  for (const summary of [null, { plan_source: 123 }, { plan_source: 'x'.repeat(129) },
    { plan_source: 'subscription', plan_expires_at: 123 },
    { plan_source: 'subscription', plan_expires_at: 'secret' },
    { plan_source: 'grant', next_reset_at: 'secret' }]) {
    const access = new WhyAiAccess(responseRunner(accessValue, summary))
    assert.deepEqual(await access.get(), { status: 'ok', data: { ...accessValue,
      subscription_expires_at: null, next_reset_at: null, billing_status: 'unavailable' } })
    await access.dispose()
  }
})

test('30 second cache and singleflight share the ordered pair of fixed CLI invocations', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  const calls = []
  const firstCall = deferred()
  const access = new WhyAiAccess({ invoke(args, stdin, signal) {
    calls.push(args)
    assert.equal(stdin, undefined)
    assert.equal(signal.aborted, false)
    return calls.length === 1 ? firstCall.promise : Promise.resolve(ok(args.at(-1) === 'access' ? accessValue : summaryValue))
  } })
  const first = access.get()
  assert.equal(access.get(), first)
  await flush()
  assert.equal(calls.length, 1)
  firstCall.resolve(ok(accessValue))
  await first
  assert.deepEqual(calls, [['--json', 'billing', 'access'], ['--json', 'billing', 'summary']])
  t.mock.timers.tick(29_999)
  await access.get()
  assert.equal(calls.length, 2)
  t.mock.timers.tick(1)
  await access.get()
  assert.equal(calls.length, 4)
  await access.dispose()
})

test('deadline covers both commands and waits for runner cleanup before settlement', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  const accessCall = deferred()
  const summaryCall = deferred()
  let signal
  let calls = 0
  const access = new WhyAiAccess({ invoke(_args, _stdin, s) { signal = s; return ++calls === 1 ? accessCall.promise : summaryCall.promise } })
  let settled = false
  const pending = access.get().then((result) => { settled = true; return result })
  await flush()
  t.mock.timers.tick(6_000)
  accessCall.resolve(ok(accessValue))
  await flush()
  assert.equal(calls, 2)
  t.mock.timers.tick(4_000)
  assert.equal(signal.aborted, true)
  await flush()
  assert.equal(settled, false)
  // A runner settles only after process quiescence; even success after abort is discarded.
  summaryCall.resolve(ok(summaryValue))
  assert.deepEqual(await pending, { status: 'error', code: 'WHYAI_TIMEOUT' })
  assert.deepEqual(await access.get(), { status: 'error', code: 'WHYAI_TIMEOUT' })
  await access.dispose()
})

test('late access completion after deadline cannot start summary', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const call = deferred()
  let calls = 0
  const access = new WhyAiAccess({ invoke() { calls++; return call.promise } })
  const pending = access.get()
  await flush()
  t.mock.timers.tick(10_000)
  call.resolve(ok(accessValue))
  assert.equal((await pending).code, 'WHYAI_TIMEOUT')
  assert.equal(calls, 1)
  await access.dispose()
})

test('disposal aborts and waits for cleanup, consuming late rejection', async () => {
  const call = deferred()
  let signal
  const access = new WhyAiAccess({ invoke(_a, _i, s) { signal = s; return call.promise } })
  const pending = access.get()
  await flush()
  let disposed = false
  const disposal = access.dispose().then(() => { disposed = true })
  const repeated = access.dispose()
  assert.equal(signal.aborted, true)
  await flush()
  assert.equal(disposed, false)
  call.reject(new Error('sensitive private body'))
  await disposal
  await repeated
  assert.deepEqual(await pending, { status: 'error', code: 'WHYAI_DISPOSED' })
  assert.deepEqual(await access.get(), { status: 'error', code: 'WHYAI_DISPOSED' })
})

test('summary failure clears expired dates but preserves independent access facts without raw data', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  let failing = false
  const access = new WhyAiAccess({ invoke: async (args) => args.at(-1) === 'access' ? ok(accessValue)
    : failing ? { exitCode: 1, error: { message: 'private body', code: 'WHYAI_NOT_LOGGED_IN' } } : ok(summaryValue) })
  assert.equal((await access.get()).status, 'ok')
  failing = true
  t.mock.timers.tick(30_000)
  assert.deepEqual(await access.get(), { status: 'ok', data: { ...accessValue,
    subscription_expires_at: null, next_reset_at: null, billing_status: 'unavailable' } })
  await access.dispose()
  for (const error of [new Error('secret body'), new WhyAiCliError('secret', 'private-token')]) {
    const mounted = mount({ invoke: async () => { throw error } })
    assert.deepEqual((await request(mounted.route)).body, { status: 'error', code: 'WHYAI_COMMAND_FAILED' })
    await mounted.dispose()
  }
})

test('summary-local timeout or cancellation preserves validated access facts', async () => {
  for (const code of ['WHYAI_TIMEOUT', 'WHYAI_CANCELLED']) {
    const access = new WhyAiAccess({ invoke: async (args) => {
      if (args.at(-1) === 'access') return ok(accessValue)
      throw new WhyAiCliError('private summary failure', code)
    } })
    assert.deepEqual(await access.get(), { status: 'ok', data: { ...accessValue,
      subscription_expires_at: null, next_reset_at: null, billing_status: 'unavailable' } })
    await access.dispose()
  }
})

test('authentication precedes method and cache access; route unregisters and remounts fresh', async () => {
  let rejection
  let calls = 0
  const runner = { invoke: async (args) => { calls++; return ok(args.at(-1) === 'access' ? accessValue : summaryValue) } }
  const mounted = mount(runner, () => rejection)
  assert.equal(mounted.route.kind, 'exact')
  assert.equal(mounted.route.path, '/api/whyai/access')
  const success = await request(mounted.route)
  assert.equal(success.status, 200)
  assert.equal(success.headers['Cache-Control'], 'no-store')
  assert.equal(success.headers['X-Content-Type-Options'], 'nosniff')
  for (const code of [401, 403]) {
    rejection = code
    assert.equal((await request(mounted.route, 'POST')).status, code)
    assert.equal((await request(mounted.route)).status, code)
  }
  rejection = undefined
  assert.equal((await request(mounted.route, 'POST')).status, 405)
  assert.equal(calls, 2)
  await mounted.dispose()
  assert.equal(mounted.route, undefined)
  const next = mount(runner)
  await request(next.route)
  assert.equal(calls, 4)
  await next.dispose()
  const denied = mount(runner, () => { throw new Error('auth secret') })
  assert.deepEqual((await request(denied.route)).body, { status: 'error', code: 'WHYAI_FORBIDDEN' })
  await denied.dispose()
})

test('timeout includes the existing runner queue and removes queued access work', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  let release
  let resolves = 0
  const runner = new WhyAiCliRunner({
    resolveExecutable() { resolves++; return new Promise((done) => { release = done }) },
    spawn() { return { collected: { stdout: { readFrom: () => ({ text: '{}', lossy: false }) }, stderr: { readFrom: () => ({ text: '', lossy: false }) } }, done: Promise.resolve({ exitCode: 0, signal: null }), waitForExit: async () => true, terminate() {} } },
  }, { ...CONFIG, timeoutMs: 60_000 })
  const tool = runner.invoke(['--json', 'auth', 'status'], undefined, new AbortController().signal)
  await flush()
  const access = new WhyAiAccess(runner)
  const pending = access.get()
  await flush()
  t.mock.timers.tick(10_000)
  assert.equal((await pending).code, 'WHYAI_TIMEOUT')
  release('fixture')
  await tool
  await flush()
  assert.equal(resolves, 1)
  await access.dispose()
  await runner.dispose()
})

test('route disposal removes registration immediately but waits for active CLI cleanup', async () => {
  const call = deferred()
  let signal
  const mounted = mount({ invoke(_args, _stdin, value) { signal = value; return call.promise } })
  let settled = false
  const pending = request(mounted.route).then((value) => { settled = true; return value })
  await flush()
  const disposal = mounted.dispose()
  assert.equal(mounted.route, undefined)
  assert.equal(signal.aborted, true)
  await flush()
  assert.equal(settled, false)
  const fresh = mount(responseRunner({ eligible: false }))
  call.resolve(ok(accessValue))
  await disposal
  assert.deepEqual((await pending).body, { status: 'error', code: 'WHYAI_DISPOSED' })
  assert.equal((await request(fresh.route)).body.data.eligible, false)
  await fresh.dispose()
})

test('disposal before invocation releases timer without starting work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const access = new WhyAiAccess({ invoke: async () => { calls++; return ok(accessValue) } })
  const pending = access.get()
  await access.dispose()
  t.mock.timers.runAll()
  await flush()
  assert.equal(calls, 0)
  assert.equal((await pending).code, 'WHYAI_DISPOSED')
})

test('host requires only tools/subprocess and registers optional Web injection', async () => {
  const harness = fakeContext(new NodeSubprocess())
  let dependencies
  harness.ctx.inject = (services) => { dependencies = services }
  apply(harness.ctx, CONFIG)
  assert.deepEqual(dependencies, ['webServer', 'connection'])
  assert.equal(harness.tools.size, 4)
  await harness.dispose()
})
