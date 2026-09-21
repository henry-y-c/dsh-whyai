import assert from 'node:assert/strict'
import test from 'node:test'
import { WhyAiCliError, WhyAiCliRunner } from '../lib/index.js'
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
