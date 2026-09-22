import assert from 'node:assert/strict'
import test from 'node:test'
import { CONFIG, NodeSubprocess } from './helpers.mjs'
import { WhyAiActions, WhyAiCliRunner } from '../lib/index.js'

function fakeRunner(overrides = {}) {
  return {
    async runTask(_signal, task) {
      return task(new AbortController().signal)
    },
    async invokeRaw(args, _stdin, _signal) {
      if (overrides.invokeRaw) return overrides.invokeRaw(args)
      return { exitCode: 0, stdout: 'ok', stderr: '' }
    },
    async invoke(args, _stdin, _signal) {
      if (overrides.invoke) return overrides.invoke(args)
      return { exitCode: 0, value: { logged_in: true }, hadWarning: false }
    },
    async version(_signal) {
      if (overrides.version) return overrides.version()
      return '0.5.8'
    },
  }
}

test('WhyAiActions exports are accessible from plugin entrypoint', () => {
  assert.equal(typeof WhyAiActions, 'function')
  const instance = new WhyAiActions(new NodeSubprocess(), CONFIG, fakeRunner())
  assert.equal(typeof instance.install, 'function')
  assert.equal(typeof instance.login, 'function')
  assert.equal(typeof instance.logout, 'function')
})

test('WhyAiActions prevents concurrent execution of actions', async () => {
  const actions = new WhyAiActions(new NodeSubprocess(), CONFIG, fakeRunner())
  actions.inFlight = true
  const installResult = await actions.install()
  assert.equal(installResult.status, 'error')
  assert.match(installResult.message, /already in progress/)

  const loginResult = await actions.login()
  assert.equal(loginResult.status, 'error')
  assert.match(loginResult.message, /already in progress/)

  const logoutResult = await actions.logout()
  assert.equal(logoutResult.status, 'error')
  assert.match(logoutResult.message, /already in progress/)
  actions.inFlight = false
})

test('logout fails when CLI exits non-zero, does not report fake success', async () => {
  let stateChanged = 0
  const runner = fakeRunner({
    invokeRaw: async (args) => {
      assert.deepEqual(args, ['logout'])
      return { exitCode: 1, stdout: '', stderr: 'session revoke failed' }
    },
  })
  const actions = new WhyAiActions(new NodeSubprocess(), CONFIG, runner, () => { stateChanged++ })
  const result = await actions.logout()
  assert.equal(result.status, 'error')
  assert.match(result.message, /exit code 1/)
  assert.equal(stateChanged, 0)
})

test('logout succeeds and triggers onStateChanged when exit code is 0', async () => {
  let stateChanged = 0
  const runner = fakeRunner({
    invokeRaw: async (args) => {
      assert.deepEqual(args, ['logout'])
      return { exitCode: 0, stdout: 'logged out', stderr: '' }
    },
  })
  const actions = new WhyAiActions(new NodeSubprocess(), CONFIG, runner, () => { stateChanged++ })
  const result = await actions.logout()
  assert.equal(result.status, 'ok')
  assert.equal(stateChanged, 1)
})

test('login fails when CLI command exits non-zero without being masked by --help', async () => {
  let stateChanged = 0
  const runner = fakeRunner({
    invokeRaw: async () => ({ exitCode: 2, stdout: '', stderr: 'browser auth timed out' }),
  })
  const actions = new WhyAiActions(new NodeSubprocess(), CONFIG, runner, () => { stateChanged++ })
  const result = await actions.login()
  assert.equal(result.status, 'error')
  assert.match(result.message, /exit code 2/)
  assert.equal(stateChanged, 0)
})

test('login fails if command exits 0 but status verification indicates not logged in', async () => {
  let stateChanged = 0
  const runner = fakeRunner({
    invokeRaw: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    invoke: async (args) => {
      assert.deepEqual(args, ['--json', 'status'])
      return { exitCode: 0, value: { logged_in: false }, hadWarning: false }
    },
  })
  const actions = new WhyAiActions(new NodeSubprocess(), CONFIG, runner, () => { stateChanged++ })
  const result = await actions.login()
  assert.equal(result.status, 'error')
  assert.match(result.message, /not logged in/)
  assert.equal(stateChanged, 0)
})

test('login succeeds and triggers onStateChanged when exit code is 0 and status is verified', async () => {
  let stateChanged = 0
  const runner = fakeRunner({
    invokeRaw: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    invoke: async () => ({ exitCode: 0, value: { logged_in: true }, hadWarning: false }),
  })
  const actions = new WhyAiActions(new NodeSubprocess(), CONFIG, runner, () => { stateChanged++ })
  const result = await actions.login()
  assert.equal(result.status, 'ok')
  assert.equal(stateChanged, 1)
})
