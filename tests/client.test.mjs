import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

async function load(entry, overrides = {}) {
  const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL(`../src/client/${entry}.ts`, import.meta.url))], bundle: true, platform: 'browser', format: 'cjs', external: ['react'], write: false })
  const module = { exports: {} }
  const context = { module, exports: module.exports, console, AbortController, TextDecoder, Uint8Array, setTimeout, clearTimeout, queueMicrotask, fetch,
    require: name => { assert.equal(name, 'react'); return { useId: () => 'test-popover', useState: (init) => [typeof init === 'function' ? init() : init, () => {}], createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) } }, ...overrides }
  vm.runInNewContext(outputFiles[0].text, context)
  return module.exports
}
const data = { available_percent: 42.25, eligible: true, valid_until: '2026-10-01T00:00:00Z', subscription_expires_at: '2026-11-01T00:00:00Z', next_reset_at: null, billing_status: 'ok' }
const response = (value = { status: 'ok', data }) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
function walk(node) { return !node || typeof node !== 'object' ? [] : [node, ...node.children.flatMap(walk)] }
function text(node) { return typeof node === 'string' ? node : node && typeof node === 'object' ? node.children.map(text).join(' ') : '' }
function environment(fetcher) {
  let sequence = 0
  const timers = new Map(), events = new Set()
  const document = { hidden: false, addEventListener: (name, fn) => { assert.equal(name, 'visibilitychange'); events.add(fn) }, removeEventListener: (_name, fn) => events.delete(fn) }
  return { timers, events, document, overrides: { fetch: fetcher, document, setTimeout: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, ms }); return id }, clearTimeout: id => timers.delete(id) },
    fire(ms) { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn() } },
    hide(hidden) { document.hidden = hidden; for (const fn of events) fn() } }
}

test('wire parsing preserves null and zero; rejects malformed and out-of-range values', async () => {
  const { parseAccess } = await load('store')
  for (const percent of [null, 0, 100, 12.5]) assert.equal(parseAccess({ status: 'ok', data: { ...data, available_percent: percent } }).available_percent, percent)
  for (const invalid of [-1, 101, '40', NaN, undefined]) assert.throws(() => parseAccess({ status: 'ok', data: { ...data, available_percent: invalid } }), /invalid/)
  assert.throws(() => parseAccess({ status: 'ok', data: { ...data, eligible: 'true' } }), /invalid/)
  assert.throws(() => parseAccess({ status: 'ok', data: { ...data, valid_until: 'secret text' } }), /invalid/)
  assert.throws(() => parseAccess({ status: 'error', code: 'WHYAI_AUTH_REQUIRED' }), /auth/)
  assert.throws(() => parseAccess({ status: 'error', code: 'WHYAI_NOT_LOGGED_IN' }), /auth/)
  assert.throws(() => parseAccess({ status: 'error', code: 'sensitive backend body' }), /unavailable/)
  assert.throws(() => parseAccess({ status: 'ok', data: { ...data, billing_status: 'invalid' } }), /invalid/)
  assert.equal(parseAccess({ status: 'ok', data: { ...data, billing_status: 'unavailable' } }).billing_status, 'unavailable')
  for (const key of ['subscription_expires_at', 'next_reset_at', 'billing_status']) {
    const missing = { ...data }; delete missing[key]
    assert.throws(() => parseAccess({ status: 'ok', data: missing }), /invalid/)
  }
  assert.throws(() => parseAccess({ status: 'ok', data: { ...data, next_reset_at: 'invalid' } }), /invalid/)
})

test('503 CLI authentication errors remain distinguishable without exposing body', async () => {
  const env = environment(async () => new Response(JSON.stringify({ status: 'error', code: 'WHYAI_NOT_LOGGED_IN' }), { status: 503 }))
  const { AccessStore } = await load('store', env.overrides)
  const store = new AccessStore(), off = store.subscribe(() => {})
  await flush()
  assert.equal(store.getSnapshot().error, 'auth')
  off()
})

test('wide summary has accurate progress, eligibility, validity and no fabricated reset', async () => {
  const { AccessSummary } = await load('summary')
  const { zh, en } = await load('locales')
  for (const dictionary of [zh, en]) {
    const node = AccessSummary({ wide: true, t: key => dictionary[key], useAccess: selector => selector({ loading: false, data }) })
    assert.match(text(node), /42.25%/)
    assert.ok(text(node).includes(dictionary.expiry))
    assert.ok(text(node).includes(dictionary.reset))
    const progress = walk(node).find(n => n.props.role === 'progressbar')
    assert.equal(progress.props['aria-valuenow'], 42.25)
    assert.deepEqual(walk(node).filter(n => n.type === 'time').map(n => n.props.dateTime), [data.subscription_expires_at, data.valid_until])
    assert.ok(text(node).includes(`${dictionary.reset}： ${dictionary.unknown}`))
    assert.ok(walk(node).some(n => n.props.title === dictionary.validityHint))
  }
  const node = AccessSummary({ wide: true, t: key => zh[key], useAccess: selector => selector({ loading: false, data: { ...data, available_percent: null, eligible: false } }) })
  assert.ok(text(node).includes(zh.ineligible))
  assert.equal(walk(node).find(n => n.props.role === 'progressbar').props['aria-valuenow'], undefined)
  assert.ok(!text(node).includes('0%'))
  const reset = '2026-09-30T12:00:00Z'
  const withReset = AccessSummary({ wide: true, t: key => zh[key], useAccess: selector => selector({ loading: false, data: { ...data, next_reset_at: reset } }) })
  assert.ok(walk(withReset).some(n => n.type === 'time' && n.props.dateTime === reset))
  const sameExpiry = AccessSummary({ wide: true, t: key => zh[key], useAccess: selector => selector({ loading: false, data: { ...data, subscription_expires_at: data.valid_until } }) })
  assert.equal(walk(sameExpiry).filter(n => n.type === 'time').length, 1)
  assert.ok(!text(sameExpiry).includes(zh.accessExpiry))
  assert.ok(!text(sameExpiry).includes(data.valid_until))
  assert.match(text(sameExpiry), /2026/)
  const billingFailed = AccessSummary({ wide: true, t: key => zh[key], useAccess: selector => selector({ loading: false, data: { ...data, subscription_expires_at: null, billing_status: 'unavailable' } }) })
  assert.ok(text(billingFailed).includes(zh.billingUnavailable))
  assert.ok(text(billingFailed).includes(`${zh.expiry}： ${zh.unknown}`))
  assert.ok(text(billingFailed).includes(zh.accessExpiry))
  assert.ok(text(billingFailed).includes('42.25%'))
})

test('narrow summary uses native top-layer popover without portals or DOM injection', async () => {
  const { AccessSummary } = await load('summary')
  const { zh } = await load('locales')
  const node = AccessSummary({ wide: false, t: key => zh[key], useAccess: selector => selector({ loading: true }) })
  const button = walk(node).find(n => n.type === 'button')
  const popover = walk(node).find(n => n.props.popover === 'auto')
  assert.equal(button.props.popoverTarget, popover.props.id)
  assert.ok(button.props['aria-label'].includes(zh.loading))
  assert.equal(popover.props.style.position, 'fixed')
})

test('slot routing prefers Usage Monitor stack and restores standalone fallback across HMR', async () => {
  const { apply, inject } = await load('index')
  assert.deepEqual([...inject], ['slots', 'locale'])
  const cleanups = [], callbacks = new Map(), active = new Map(), stores = []
  let sequence = 0
  apply({ effect: fn => cleanups.push(fn()), locale: { register: (name, dictionaries) => { assert.equal(name, 'whyai'); assert.equal(dictionaries.zh.brand, 'YAI'); return () => {} } }, slots: {
    inject: (name, fn) => callbacks.set(name, fn),
    register: (spec, component) => {
      const token = ++sequence
      active.set(spec.name, { token, spec, component })
      stores.push(spec.inject().hooks.access)
      return () => { if (active.get(spec.name)?.token === token) active.delete(spec.name) }
    },
  } })
  assert.equal(active.size, 0)
  const removeFooter = callbacks.get('sidebar.footer.action')()
  assert.equal(active.get('sidebar.footer.action').spec.order, 110)
  const firstStore = active.get('sidebar.footer.action').spec.inject().hooks.access

  const removeNested = callbacks.get('sidebar.footer.usage-monitor.after')()
  assert.equal(active.has('sidebar.footer.action'), false)
  assert.equal(active.get('sidebar.footer.usage-monitor.after').spec.order, 0)
  assert.equal(active.get('sidebar.footer.usage-monitor.after').spec.inject().hooks.access, firstStore)

  removeNested()
  await flush()
  assert.equal(active.get('sidebar.footer.action').spec.inject().hooks.access, firstStore)
  const removeNestedAgain = callbacks.get('sidebar.footer.usage-monitor.after')()
  await flush()
  assert.equal(active.has('sidebar.footer.action'), false)
  assert.equal(new Set(stores).size, 1)

  removeFooter()
  removeNestedAgain()
  for (const cleanup of cleanups.reverse()) cleanup()
  await flush()
  assert.equal(active.size, 0)
})

test('existing Usage Monitor seat wins without mounting a direct footer entry', async () => {
  const { apply } = await load('index')
  const callbacks = new Map(), active = new Map(), cleanups = []
  apply({ effect: fn => cleanups.push(fn()), locale: { register: () => () => {} }, slots: {
    inject: (name, fn) => callbacks.set(name, fn),
    register: spec => { active.set(spec.name, spec); return () => active.delete(spec.name) },
  } })
  const removeNested = callbacks.get('sidebar.footer.usage-monitor.after')()
  const removeFooter = callbacks.get('sidebar.footer.action')()
  assert.equal(active.has('sidebar.footer.action'), false)
  assert.equal(active.get('sidebar.footer.usage-monitor.after').id, 'whyai')
  for (const cleanup of cleanups.reverse()) cleanup()
  removeFooter(); removeNested(); await flush()
  assert.equal(active.size, 0)
})

test('polling is shared, hidden-paused, resumed immediately and cancelled on last unsubscribe', async () => {
  let calls = 0, signal
  const env = environment(async (_url, init) => { calls++; signal = init.signal; assert.equal(_url, '/api/whyai/access'); assert.equal(init.method, 'GET'); return response() })
  const { AccessStore } = await load('store', env.overrides)
  const store = new AccessStore(), listener = () => {}
  const off1 = store.subscribe(listener), off2 = store.subscribe(listener)
  await flush(); assert.equal(calls, 1); assert.equal(store.getSnapshot().data.available_percent, 42.25)
  assert.equal(env.timers.size, 1)
  env.fire(60_000); await flush(); assert.equal(calls, 2)
  env.hide(true); assert.equal(env.timers.size, 0); assert.equal(store.getSnapshot().data, undefined)
  env.fire(60_000); assert.equal(calls, 2)
  env.hide(false); await flush(); assert.equal(calls, 3)
  off1(); assert.equal(env.events.size, 1)
  off2(); await flush(); assert.equal(env.events.size, 0); assert.equal(env.timers.size, 0)
  const off3 = store.subscribe(listener); await flush(); assert.equal(calls, 4); off3()
  assert.equal(signal.aborted, false) // Completed requests have no live cancellation owner.
})

test('late non-cooperative fetch cannot repopulate unmounted or hidden state', async () => {
  let resolve, signal
  const env = environment((_url, init) => { signal = init.signal; return new Promise(done => { resolve = done }) })
  const { AccessStore } = await load('store', env.overrides)
  const store = new AccessStore(), off = store.subscribe(() => {})
  env.hide(true); assert.equal(signal.aborted, true)
  resolve(response()); await flush(); assert.equal(store.getSnapshot().data, undefined)
  env.hide(false); off(); assert.equal(signal.aborted, true)
  resolve(response()); await flush(); assert.equal(store.getSnapshot().data, undefined)
  assert.equal(env.timers.size, 0); assert.equal(env.events.size, 0)
})

test('timeout covers stalled body and clears timers; disposal prevents remount', async () => {
  let signal, bodyCancelled = false
  const env = environment(async (_url, init) => { signal = init.signal; return new Response(new ReadableStream({ start() {}, cancel() { bodyCancelled = true } })) })
  const { AccessStore } = await load('store', env.overrides)
  const store = new AccessStore(); store.subscribe(() => {})
  await flush(); env.fire(15_000); await flush()
  assert.equal(signal.aborted, true); assert.equal(bodyCancelled, true); assert.equal(store.getSnapshot().error, 'timeout')
  store.dispose(); store.subscribe(() => {}); await flush()
  assert.equal(env.events.size, 0); assert.equal(env.timers.size, 0)
})

test('HTTP failure and oversized/malformed response clear success data and sanitize errors', async () => {
  for (const bad of [() => new Response('private secret', { status: 401 }), () => new Response('timeout', { status: 504 }), () => new Response('x'.repeat(16385)), () => response({ status: 'ok', data: { ...data, available_percent: '42' } }), () => { throw new Error('private credential') }]) {
    let calls = 0
    const env = environment(async () => ++calls === 1 ? response() : bad())
    const { AccessStore } = await load('store', env.overrides)
    const store = new AccessStore(), off = store.subscribe(() => {})
    await flush(); assert.ok(store.getSnapshot().data)
    env.fire(60_000); await flush()
    assert.equal(store.getSnapshot().data, undefined)
    assert.ok(['auth', 'invalid', 'unavailable', 'timeout'].includes(store.getSnapshot().error))
    off(); await flush(); assert.equal(env.timers.size, 0)
  }
})

test('action buttons are shown on read failure and hidden on read success', async () => {
  const { AccessSummary } = await load('summary')
  const { zh } = await load('locales')

  // When reading succeeds, details and logout button are shown; install/login buttons must NOT be present
  const successNode = AccessSummary({ wide: true, t: key => zh[key], useAccess: selector => selector({ loading: false, data }) })
  assert.ok(!text(successNode).includes(zh.installBtn))
  assert.ok(!text(successNode).includes(zh.loginBtn))
  assert.ok(text(successNode).includes(zh.remaining))
  assert.ok(text(successNode).includes(zh.expiry))
  assert.ok(text(successNode).includes(zh.reset))
  assert.ok(text(successNode).includes(zh.logoutBtn))

  // When reading fails, ONLY brand and the two action buttons appear; details, error texts, and logout button MUST NOT appear
  const errorNode = AccessSummary({ wide: true, t: key => zh[key], useAccess: selector => selector({ loading: false, error: 'unavailable' }) })
  assert.ok(text(errorNode).includes(zh.brand))
  assert.ok(text(errorNode).includes(zh.installBtn))
  assert.ok(text(errorNode).includes(zh.loginBtn))
  // Disallowed items on failure:
  assert.ok(!text(errorNode).includes(zh.unavailable))
  assert.ok(!text(errorNode).includes(zh.remaining))
  assert.ok(!text(errorNode).includes(zh.expiry))
  assert.ok(!text(errorNode).includes(zh.reset))
  assert.ok(!text(errorNode).includes(zh.logoutBtn))

  // When reading has no data, only brand and action buttons are present
  const noDataNode = AccessSummary({ wide: true, t: key => zh[key], useAccess: selector => selector({ loading: false }) })
  assert.ok(text(noDataNode).includes(zh.installBtn))
  assert.ok(text(noDataNode).includes(zh.loginBtn))
  assert.ok(!text(noDataNode).includes(zh.remaining))
  assert.ok(!text(noDataNode).includes(zh.expiry))
  assert.ok(!text(noDataNode).includes(zh.reset))
  assert.ok(!text(noDataNode).includes(zh.logoutBtn))

  assert.equal(zh.fetchingData, '获取数据')
  assert.equal(zh.logoutBtn, '退出')
})

test('when data exists, refreshing in background hides buttons and shows content', async () => {
  const { AccessSummary } = await load('summary')
  const { zh } = await load('locales')

  // When refreshing with data (state.loading: true, data present):
  const refreshingNode = AccessSummary({ wide: true, t: key => zh[key], useAccess: selector => selector({ loading: true, data }) })
  assert.ok(!text(refreshingNode).includes(zh.installBtn))
  assert.ok(!text(refreshingNode).includes(zh.loginBtn))
  assert.ok(text(refreshingNode).includes(zh.remaining))
  assert.ok(text(refreshingNode).includes(zh.expiry))
  assert.ok(text(refreshingNode).includes(zh.reset))

  // When initial loading without data yet (state.loading: true, data: undefined):
  const initialLoadingNode = AccessSummary({ wide: true, t: key => zh[key], useAccess: selector => selector({ loading: true }) })
  // Action buttons must NOT be shown while loading in background
  assert.ok(!text(initialLoadingNode).includes(zh.installBtn))
  assert.ok(!text(initialLoadingNode).includes(zh.loginBtn))
  assert.ok(text(initialLoadingNode).includes(zh.fetchingData))
})



