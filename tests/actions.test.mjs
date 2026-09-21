import assert from 'node:assert/strict'
import test from 'node:test'
import { WhyAiActions } from '../lib/index.js'

test('WhyAiActions prevents concurrent execution of actions', async () => {
  const actions = new WhyAiActions()
  // Mock internal inFlight flag to test concurrency lock
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

test('WhyAiActions exports are accessible from plugin entrypoint', () => {
  assert.equal(typeof WhyAiActions, 'function')
  const instance = new WhyAiActions()
  assert.equal(typeof instance.install, 'function')
  assert.equal(typeof instance.login, 'function')
  assert.equal(typeof instance.logout, 'function')
})
