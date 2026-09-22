import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const source = await build({ entryPoints: [fileURLToPath(new URL('../src/runner.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })
const { WhyAiCliError, WhyAiCliRunner } = await import(`data:text/javascript;base64,${Buffer.from(source.outputFiles[0].text).toString('base64')}`)
import { CONFIG, NodeSubprocess } from './helpers.mjs'

const liveSignal = () => new AbortController().signal

test('version and JSON invocation use explicit bounded specs', async () => {
  const subprocess = new NodeSubprocess()
  const runner = new WhyAiCliRunner(subprocess, CONFIG)
  assert.equal(await runner.version(liveSignal()), '0.5.7')
  const result = await runner.invoke(['--json', 'status'], undefined, liveSignal())
  assert.equal(result.exitCode, 0)
  assert.equal(result.value.logged_in, true)
  assert.deepEqual(subprocess.specs[1].argv, [CONFIG.cliPath, '--json', 'status'])
  assert.equal(subprocess.specs[1].stdio.stdout.maxBytes, CONFIG.stdoutMaxBytes)
  assert.equal(subprocess.specs[1].stdio.stderr.maxBytes, CONFIG.stderrMaxBytes)
  assert.equal(subprocess.specs[1].graceMs, CONFIG.graceMs)
  await runner.dispose()
})

test('success ignores plain stderr while reporting a generic warning', async () => {
  const runner = new WhyAiCliRunner(new NodeSubprocess(), CONFIG)
  const result = await runner.invoke(['--json', 'chat', '-', '--conversation', '33333333-3333-4333-8333-333333333333'], '__warning__', liveSignal())
  assert.equal(result.exitCode, 0)
  assert.equal(result.hadWarning, true)
  await runner.dispose()
})

test('nonzero exit parses the final stderr JSON error', async () => {
  const runner = new WhyAiCliRunner(new NodeSubprocess(), CONFIG)
  const result = await runner.invoke(['--json', 'chat', '-', '--conversation', '33333333-3333-4333-8333-333333333333'], '__error__', liveSignal())
  assert.equal(result.exitCode, 1)
  assert.equal(result.error.code, 'WHYAI_QUOTA_EXHAUSTED')
  assert.equal(result.error.message, 'WhyAI CLI quota is exhausted.')
  assert.equal(result.error.message.includes('secret-token'), false)
  assert.equal(result.error.message.includes('also-secret'), false)
  assert.equal(result.value, undefined)
  const unknown = await runner.invoke(['--json', 'chat', '-', '--conversation', '33333333-3333-4333-8333-333333333333'], '__unknown_error__', liveSignal())
  assert.equal(unknown.error.code, 'WHYAI_COMMAND_FAILED')
  assert.equal(unknown.error.message, 'WhyAI CLI command failed.')
  assert.equal(JSON.stringify(unknown.error).includes('session-secret'), false)
  assert.equal(JSON.stringify(unknown.error).includes('ATTACKER_CONTROLLED'), false)
  await runner.dispose()
})

test('malformed and lossy stdout fail closed', async () => {
  const base = ['--json', 'chat', '-', '--conversation', '33333333-3333-4333-8333-333333333333']
  const runner = new WhyAiCliRunner(new NodeSubprocess(), CONFIG)
  await assert.rejects(runner.invoke(base, '__malformed__', liveSignal()), (error) => error instanceof WhyAiCliError && error.code === 'WHYAI_MALFORMED_OUTPUT')
  await runner.dispose()

  const tiny = { ...CONFIG, stdoutMaxBytes: 128 }
  const overflow = new WhyAiCliRunner(new NodeSubprocess(), tiny)
  await assert.rejects(overflow.invoke(base, '__oversize__', liveSignal()), (error) => error instanceof WhyAiCliError && error.code === 'WHYAI_OUTPUT_OVERFLOW')
  await overflow.dispose()
})

test('abort terminates the mock CLI and dispose reaches quiescence', async () => {
  const subprocess = new NodeSubprocess()
  const runner = new WhyAiCliRunner(subprocess, CONFIG)
  const controller = new AbortController()
  const call = runner.invoke(['--json', 'chat', '-', '--conversation', '33333333-3333-4333-8333-333333333333'], '__hang__', controller.signal)
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(call, (error) => error instanceof WhyAiCliError && error.code === 'WHYAI_CANCELLED')
  await runner.dispose()
  assert.equal(subprocess.children.size, 0)
})

test('internal deadline terminates the CLI and reports timeout', async () => {
  const subprocess = new NodeSubprocess()
  const runner = new WhyAiCliRunner(subprocess, { ...CONFIG, timeoutMs: 50 })
  await assert.rejects(
    runner.invoke(['--json', 'chat', '-', '--conversation', '33333333-3333-4333-8333-333333333333'], '__hang__', liveSignal()),
    (error) => error.code === 'WHYAI_TIMEOUT',
  )
  await runner.dispose()
  assert.equal(subprocess.children.size, 0)
})

test('runner serializes concurrent CLI calls', async () => {
  const subprocess = new NodeSubprocess()
  const runner = new WhyAiCliRunner(subprocess, CONFIG)
  const controller = new AbortController()
  const first = runner.invoke(['--json', 'chat', '-', '--conversation', '33333333-3333-4333-8333-333333333333'], '__hang__', controller.signal)
  const second = runner.version(liveSignal())
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(subprocess.specs.length, 1)
  controller.abort()
  await assert.rejects(first)
  assert.equal(await second, '0.5.7')
  await runner.dispose()
})

test('dispose cancels active and queued calls before settling', async () => {
  const subprocess = new NodeSubprocess()
  const runner = new WhyAiCliRunner(subprocess, CONFIG)
  const active = runner.invoke(['--json', 'chat', '-', '--conversation', '33333333-3333-4333-8333-333333333333'], '__hang__', liveSignal())
  const queued = runner.version(liveSignal())
  const activeRejected = assert.rejects(active, (error) => error.code === 'WHYAI_DISPOSED')
  const queuedRejected = assert.rejects(queued, (error) => error.code === 'WHYAI_DISPOSED')
  await new Promise((resolve) => setTimeout(resolve, 40))
  await runner.dispose()
  await activeRejected
  await queuedRejected
  assert.equal(subprocess.children.size, 0)
})

test('resolution, spawn and provider failures are classified and quiesced', async () => {
  const missing = new WhyAiCliRunner({
    async resolveExecutable() { throw new Error('missing') },
    spawn() { throw new Error('unreachable') },
  }, CONFIG)
  await assert.rejects(missing.version(liveSignal()), (error) => error.code === 'WHYAI_EXECUTABLE_NOT_FOUND')
  await missing.dispose()

  const spawnFailure = new WhyAiCliRunner({
    async resolveExecutable() { return CONFIG.cliPath },
    spawn() { throw new Error('spawn failed') },
  }, CONFIG)
  await assert.rejects(spawnFailure.version(liveSignal()), (error) => error.code === 'WHYAI_PROCESS_FAILED')
  await spawnFailure.dispose()

  let terminated = false
  let waited = false
  const providerFailure = new WhyAiCliRunner({
    async resolveExecutable() { return CONFIG.cliPath },
    spawn() {
      return {
        collected: {},
        done: Promise.reject(new Error('provider failed')),
        terminate() { terminated = true },
        async waitForExit() { waited = true; return true },
      }
    },
  }, CONFIG)
  await assert.rejects(providerFailure.version(liveSignal()), (error) => error.code === 'WHYAI_PROCESS_FAILED')
  assert.equal(terminated, true)
  assert.equal(waited, true)
  await providerFailure.dispose()
})

test('termination does not settle until the managed process range is quiet', async () => {
  const waits = []
  let terminated = false
  const runner = new WhyAiCliRunner({
    async resolveExecutable() { return CONFIG.cliPath },
    spawn() {
      return {
        collected: {
          stdout: { readFrom: () => ({ text: '0.5.7\n', nextOffset: 6, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() { terminated = true },
        async waitForExit(signal) {
          waits.push(signal)
          return waits.length === 2
        },
      }
    },
  }, CONFIG)
  await assert.rejects(runner.version(liveSignal()), /shutdown grace/u)
  assert.equal(terminated, true)
  assert.equal(waits.length, 2)
  assert.notEqual(waits[0], undefined)
  assert.notEqual(waits[1], undefined)
  await runner.dispose()
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The guard fails old unbounded implementations without leaving live test work.
async function bounded(promise) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('runner did not settle within test bound')), 1_000)
    })])
  } finally { clearTimeout(timer) }
}

function memoryHandle(overrides = {}) {
  return {
    collected: {
      stdout: { readFrom: () => ({ text: '0.5.7\n', lossy: false }) },
      stderr: { readFrom: () => ({ text: '', lossy: false }) },
    },
    done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate() {},
    async waitForExit() { return true },
    ...overrides,
  }
}

const fastConfig = { ...CONFIG, timeoutMs: 30, graceMs: 10 }

function memoryRuntime(handle = memoryHandle()) {
  return { specs: [], async resolveExecutable(path) { return path }, spawn(spec) { this.specs.push(spec); return handle } }
}

test('exclusive lease admits immediately, rejects management and consultation overlap', async () => {
  const hold = deferred()
  const runtime = memoryRuntime()
  const runner = new WhyAiCliRunner(runtime, fastConfig)
  const task = runner.runTask(liveSignal(), async lease => {
    assert.equal(await lease.version(), '0.5.7')
    await hold.promise
    assert.equal(await lease.version('/exact/installed/whyai'), '0.5.7')
  })
  assert.equal(runner.isBusy, true)
  assert.equal(runner.managementBusy, true)
  await assert.rejects(runner.runTask(liveSignal(), async () => {}), { code: 'WHYAI_BUSY' })
  await assert.rejects(runner.version(liveSignal()), { code: 'WHYAI_BUSY' })
  hold.resolve()
  await task
  assert.equal(runtime.specs[1].argv[0], '/exact/installed/whyai')
  assert.equal(runner.managementBusy, false)
  assert.equal(runner.isBusy, false)
  assert.equal(runner.isQuiescent, true)
  await runner.dispose()
})

test('management cannot queue behind consultation and lease calls cannot reenter', async () => {
  const done = deferred()
  const runtime = memoryRuntime(memoryHandle({ done: done.promise }))
  const runner = new WhyAiCliRunner(runtime, CONFIG)
  const consult = runner.version(liveSignal())
  await assert.rejects(runner.runTask(liveSignal(), async () => {}), { code: 'WHYAI_BUSY' })
  done.resolve({ exitCode: 0, signal: null })
  await consult
  await runner.runTask(liveSignal(), async lease => {
    const first = lease.version()
    await assert.rejects(lease.version(), { code: 'WHYAI_BUSY' })
    await first
  })
  await runner.dispose()
})

test('task deadline/disposal bounds stalled callbacks and revoked leases never spawn', async () => {
  for (const dispose of [false, true]) {
    const runtime = memoryRuntime()
    const runner = new WhyAiCliRunner(runtime, fastConfig)
    const entered = deferred()
    const late = deferred()
    let saved
    const task = runner.runTask(liveSignal(), async lease => { saved = lease; entered.resolve(); return late.promise }, 20)
    const rejected = assert.rejects(task, { code: 'WHYAI_PROCESS_FAILED' })
    await entered.promise
    if (dispose) await bounded(assert.rejects(runner.dispose(), /cleanup failed/u))
    await bounded(rejected)
    assert.equal(runner.isBusy, true)
    assert.equal(runner.isQuiescent, false)
    await assert.rejects(saved.version())
    assert.equal(runtime.specs.length, 0)
    late.reject(new Error('private late callback failure'))
    await runner.dispose()
  }
})

test('cooperative deadline waits for callback finally cleanup without poisoning', async () => {
  const runner = new WhyAiCliRunner(memoryRuntime(), { ...fastConfig, graceMs: 30 })
  let cleaned = false
  await bounded(assert.rejects(runner.runTask(liveSignal(), async lease => {
    try {
      await new Promise(resolve => lease.signal.addEventListener('abort', resolve, { once: true }))
    } finally {
      await delay(10)
      cleaned = true
    }
  }, 10), { code: 'WHYAI_TIMEOUT' }))
  assert.equal(cleaned, true)
  assert.equal(runner.isBusy, false)
  assert.equal(runner.isQuiescent, true)
  await runner.dispose()
})

test('lease owns forgotten installer execution until shutdown and retains poison', async () => {
  const entered = deferred()
  let quiet = false
  const runtime = memoryRuntime(memoryHandle({ done: new Promise(() => {}), waitForExit: async () => quiet }))
  const original = runtime.spawn
  runtime.spawn = function(spec) { entered.resolve(); return original.call(this, spec) }
  const runner = new WhyAiCliRunner(runtime, fastConfig)
  await bounded(assert.rejects(runner.runTask(liveSignal(), async lease => {
    void lease.execute(['/fixed/node', '/fixed/install.mjs'], '/fixed/cwd').catch(() => {})
    await entered.promise
  }), { code: 'WHYAI_PROCESS_FAILED' }))
  assert.equal(runtime.specs[0].cwd, '/fixed/cwd')
  assert.deepEqual(runtime.specs[0].argv, ['/fixed/node', '/fixed/install.mjs'])
  assert.equal(runner.isQuiescent, false)
  assert.equal(runner.isBusy, true)
  await assert.rejects(runner.runTask(liveSignal(), async () => {}), { code: 'WHYAI_BUSY' })
  quiet = true
  await runner.dispose()
  assert.equal(runner.isQuiescent, true)
})

test('status exit one logged-out exception is command specific and logout JSON is retained', async () => {
  const make = (text, exitCode = 1, stderr = '') => new WhyAiCliRunner(memoryRuntime(memoryHandle({
    done: Promise.resolve({ exitCode, signal: null }),
    collected: { stdout: { readFrom: () => ({ text, lossy: false }) }, stderr: { readFrom: () => ({ text: stderr, lossy: false }) } },
  })), fastConfig)
  const runner = make('{"logged_in":false}')
  assert.deepEqual(await runner.invoke(['--json', 'status'], undefined, liveSignal()), { exitCode: 0, value: { logged_in: false }, hadWarning: false })
  await assert.rejects(runner.invoke(['--json', 'logout'], undefined, liveSignal()), { code: 'WHYAI_PROCESS_FAILED' })
  await runner.dispose()
  for (const [text, code, stderr] of [['{"logged_in":true}', 1, ''], ['{"logged_in":false}', 2, ''], ['{"logged_in":false}', 1, 'warning'], ['{"logged_in":false,"error":{}}', 1, '']]) {
    const invalid = make(text, code, stderr)
    await assert.rejects(invalid.invoke(['--json', 'status'], undefined, liveSignal()))
    await invalid.dispose()
  }
  const logout = make('{"logged_out":true}', 0)
  assert.deepEqual((await logout.runTask(liveSignal(), lease => lease.invoke(['--json', 'logout']))).value, { logged_out: true })
  await logout.dispose()
})

test('lease cancellation holds admission until process range is actually quiet', async () => {
  const done = deferred()
  const stopped = deferred()
  const quiet = deferred()
  const controller = new AbortController()
  const runtime = memoryRuntime(memoryHandle({ done: done.promise, terminate() { stopped.resolve() }, waitForExit: () => quiet.promise }))
  const runner = new WhyAiCliRunner(runtime, CONFIG)
  const task = runner.runTask(controller.signal, lease => lease.execute(['/fixed/node'], '/fixed/cwd'))
  const rejected = assert.rejects(task, { code: 'WHYAI_CANCELLED' })
  await delay(0)
  controller.abort()
  await stopped.promise
  assert.equal(runner.managementBusy, true)
  assert.equal(runner.isQuiescent, false)
  await assert.rejects(runner.runTask(liveSignal(), async () => {}), { code: 'WHYAI_BUSY' })
  quiet.resolve(true)
  await rejected
  assert.equal(runner.isBusy, false)
  assert.equal(runner.isQuiescent, true)
  done.reject(new Error('late provider outcome'))
  await runner.dispose()
})

test('lease raw timeout and stdin byte bounds include exact multibyte boundary', async () => {
  const runtime = memoryRuntime()
  const runner = new WhyAiCliRunner(runtime, { ...fastConfig, promptMaxBytes: 4 })
  await runner.runTask(liveSignal(), async lease => {
    await lease.invokeRaw(['status'], 'éé')
    await assert.rejects(lease.invokeRaw(['status'], 'ééa'), { code: 'WHYAI_INPUT_OVERFLOW' })
    await assert.rejects(lease.invokeRaw(['status'], undefined, Infinity), { code: 'WHYAI_INVALID_ARGUMENT' })
  })
  assert.equal(runtime.specs.length, 1)
  assert.deepEqual(runtime.specs[0].stdio.stdin, { data: 'éé' })
  await runner.dispose()
  const stalled = new WhyAiCliRunner(memoryRuntime(memoryHandle({ done: new Promise(() => {}) })), fastConfig)
  await bounded(assert.rejects(stalled.runTask(liveSignal(), lease => lease.invokeRaw(['status'], undefined, 10)), { code: 'WHYAI_TIMEOUT' }))
  assert.equal(stalled.isQuiescent, true)
  await stalled.dispose()
})

test('official Windows cmd maps to Node sibling without shell interpretation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whyai-runner-'))
  const sibling = join(directory, 'whyai')
  const runtime = memoryRuntime()
  const runner = new WhyAiCliRunner(runtime, fastConfig)
  try {
    await writeFile(sibling, '#!/usr/bin/env node\n// YAI CLI managed launcher\n')
    await writeFile(`${sibling}.cmd`, `@echo off\r\n@rem YAI CLI managed launcher\r\n"some node.exe" "${sibling.replace(/%/g, '%%')}" %*\r\n`)
    await runner.runTask(liveSignal(), lease => lease.version(`${sibling}.cmd`))
    assert.deepEqual(runtime.specs[0].argv, [process.execPath, sibling, '--version'])
    await writeFile(`${sibling}.cmd`, '@echo off\necho arbitrary command')
    await assert.rejects(runner.runTask(liveSignal(), lease => lease.version(`${sibling}.cmd`)), { code: 'WHYAI_EXECUTABLE_NOT_FOUND' })
    assert.equal(runtime.specs.length, 1)
  } finally { await runner.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('uncooperative cleanup is bounded, retains ownership and rejects queued and future work', async () => {
  const stalled = deferred()
  let quiet = false
  let spawns = 0
  let stops = 0
  const runner = new WhyAiCliRunner({
    async resolveExecutable() { return CONFIG.cliPath },
    spawn() {
      spawns += 1
      return memoryHandle({
        terminate() { stops += 1 },
        waitForExit() { return quiet ? Promise.resolve(true) : stalled.promise },
      })
    },
  }, fastConfig)
  const active = assert.rejects(runner.version(liveSignal()), (error) => error.code === 'WHYAI_PROCESS_FAILED')
  const queued = assert.rejects(runner.version(liveSignal()), (error) => error.code === 'WHYAI_PROCESS_FAILED')
  await bounded(Promise.all([active, queued]))
  await assert.rejects(runner.version(liveSignal()), /cleanup failure/u)
  assert.equal(spawns, 1)
  await bounded(assert.rejects(runner.dispose(), /process cleanup failed/u))
  assert.equal(stops, 2, 'dispose retries the retained handle')
  quiet = true
  stalled.reject(new Error('late private provider diagnostic'))
  await runner.dispose()
  assert.equal(stops, 3)
  await assert.rejects(runner.version(liveSignal()), (error) => error.code === 'WHYAI_DISPOSED')
})

test('uncooperative done is bounded and late rejection is consumed', async () => {
  const done = deferred()
  let stopped = false
  const runner = new WhyAiCliRunner({
    async resolveExecutable() { return CONFIG.cliPath },
    spawn() { return memoryHandle({ done: done.promise, terminate() { stopped = true } }) },
  }, fastConfig)
  await bounded(assert.rejects(runner.version(liveSignal()), (error) => error.code === 'WHYAI_TIMEOUT'))
  assert.equal(stopped, true)
  done.reject(new Error('late private provider failure'))
  await runner.dispose()
})

test('dispose remains bounded with both done and cleanup ignoring cancellation', async () => {
  const entered = deferred()
  const done = deferred()
  const quiet = deferred()
  let spawns = 0
  const runner = new WhyAiCliRunner({
    async resolveExecutable() { return CONFIG.cliPath },
    spawn() {
      spawns += 1
      entered.resolve()
      return memoryHandle({ done: done.promise, waitForExit: () => quiet.promise })
    },
  }, { ...CONFIG, graceMs: 10 })
  const active = assert.rejects(runner.version(liveSignal()), (error) => error.code === 'WHYAI_PROCESS_FAILED')
  const queued = assert.rejects(runner.version(liveSignal()), (error) => error.code === 'WHYAI_DISPOSED')
  await entered.promise
  await bounded(assert.rejects(runner.dispose(), /process cleanup failed/u))
  await Promise.all([active, queued])
  assert.equal(spawns, 1)
  done.reject(new Error('late secret outcome'))
  quiet.resolve(true)
  await runner.dispose()
})

test('resolver cancellation is bounded and late resolution never spawns', async () => {
  const resolution = deferred()
  let spawns = 0
  const runner = new WhyAiCliRunner({
    resolveExecutable() { return resolution.promise },
    spawn() { spawns += 1; return memoryHandle() },
  }, fastConfig)
  await bounded(assert.rejects(runner.version(liveSignal()), (error) => error.code === 'WHYAI_TIMEOUT'))
  resolution.resolve(CONFIG.cliPath)
  await delay(0)
  assert.equal(spawns, 0)
  await runner.dispose()
})

test('dispose bounds a stalled resolver and identifies active, queued and later disposal', async () => {
  const resolution = deferred()
  const entered = deferred()
  const runner = new WhyAiCliRunner({
    resolveExecutable() { entered.resolve(); return resolution.promise },
    spawn() { throw new Error('must not spawn') },
  }, CONFIG)
  const active = assert.rejects(runner.version(liveSignal()), (error) => error.code === 'WHYAI_DISPOSED')
  const queued = assert.rejects(runner.version(liveSignal()), (error) => error.code === 'WHYAI_DISPOSED')
  await entered.promise
  await bounded(runner.dispose())
  await Promise.all([active, queued])
  resolution.reject(new Error('late secret'))
  await assert.rejects(runner.version(liveSignal()), (error) => error.code === 'WHYAI_DISPOSED')
})

test('cancellation during executable resolution never spawns', async () => {
  const controller = new AbortController()
  let spawns = 0
  const runner = new WhyAiCliRunner({
    async resolveExecutable() { controller.abort(); return CONFIG.cliPath },
    spawn() { spawns += 1; return memoryHandle() },
  }, CONFIG)
  await assert.rejects(runner.version(controller.signal), (error) => error.code === 'WHYAI_CANCELLED')
  assert.equal(spawns, 0)
  await runner.dispose()
})

test('all provider exception boundaries redact diagnostics including cleanup and output reads', async () => {
  const secret = 'Bearer SECRET_TOKEN private-server-body'
  const fail = () => { throw new Error(secret) }
  const cases = [
    { resolveExecutable: fail, spawn: fail },
    { spawn: fail },
    { spawn: () => memoryHandle({ done: Promise.reject(new Error(secret)) }) },
    { spawn: () => memoryHandle({ waitForExit: fail }) },
    { spawn: () => memoryHandle({ waitForExit: () => Promise.resolve(false), terminate: fail }) },
    { spawn: () => memoryHandle({ collected: { stdout: { readFrom: fail } } }) },
  ]
  for (const provider of cases) {
    const runner = new WhyAiCliRunner({ async resolveExecutable() { return CONFIG.cliPath }, ...provider }, fastConfig)
    await assert.rejects(runner.version(liveSignal()), (error) => {
      assert.equal(error.message.includes(secret), false)
      assert.ok(error instanceof WhyAiCliError)
      return true
    })
    try { await runner.dispose() } catch (error) {
      assert.equal(error.message.includes(secret), false)
      for (const nested of error.errors ?? []) assert.equal(nested.message.includes(secret), false)
    }
  }
})
