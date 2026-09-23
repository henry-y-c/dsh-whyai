import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
async function load(entry, overrides = {}) {
  const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL(`../src/client/${entry}.ts`, import.meta.url))], bundle: true, platform: 'browser', format: 'cjs', external: ['react'], write: false })
  const module = { exports: {} }
  vm.runInNewContext(outputFiles[0].text, { module, exports: module.exports, console, AbortController, TextDecoder, Uint8Array, setTimeout, clearTimeout, queueMicrotask, fetch,
    require: () => ({ useId: () => 'popover-test', createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) }), ...overrides })
  return module.exports
}
const data = { available_percent: 42.25, eligible: true, valid_until: '2026-10-01T00:00:00Z', subscription_expires_at: '2026-11-01T00:00:00Z', next_reset_at: null, billing_status: 'ok' }
const response = value => new Response(JSON.stringify(value))
const access = () => response({ status: 'ok', data })
const op = (phase = 'running', kind = 'login') => ({ id: 'test-op', kind, phase })
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve() }
function walk(node) { return !node || typeof node !== 'object' ? [] : [node, ...node.children.flat(Infinity).flatMap(walk)] }
function text(node) { return typeof node === 'string' ? node : node && typeof node === 'object' ? node.children.flat(Infinity).map(text).join(' ') : '' }
function environment(fetcher) {
  let sequence = 0
  const timers = new Map(), events = new Set(), calls = []
  const document = { hidden: false, addEventListener: (_name, fn) => events.add(fn), removeEventListener: (_name, fn) => events.delete(fn) }
  return { timers, events, calls, overrides: { fetch: (url, init) => { calls.push({ url, init }); return fetcher(url, init) }, document, setTimeout: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, ms }); return id }, clearTimeout: id => timers.delete(id) },
    fire(ms) { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn() } }, hide(hidden) { document.hidden = hidden; for (const fn of events) fn() } }
}
const withOperation = fetcher => (url, init) => url.endsWith('/operation') ? response({ operation: null }) : fetcher(url, init)

test('wire parsers validate zero, dates, billing and bounded operation fields', async () => {
  const { parseAccess, parseOperation } = await load('store')
  for (const percent of [null, 0, 100, 12.5]) assert.equal(parseAccess({ status: 'ok', data: { ...data, available_percent: percent } }).available_percent, percent)
  for (const invalid of [-1, 101, '40', NaN, undefined]) assert.throws(() => parseAccess({ status: 'ok', data: { ...data, available_percent: invalid } }))
  for (const key of ['subscription_expires_at', 'next_reset_at', 'billing_status']) { const d = { ...data }; delete d[key]; assert.throws(() => parseAccess({ status: 'ok', data: d })) }
  assert.equal(parseOperation({ operation: op() }).phase, 'running')
  for (const patch of [{ id: '../secret' }, { phase: 'done' }, { kind: 'shell' }, { version: '<secret>' }]) assert.throws(() => parseOperation({ operation: { ...op(), ...patch } }))
})

test('shared ordinary polling retains last-good stale data; auth classes clear it', async () => {
  for (const [failure, expected, retained] of [
    [() => { throw Error('private secret') }, 'unavailable', true],
    [() => new Response('secret', { status: 401 }), 'dshAuth', false],
    [() => new Response('secret', { status: 403 }), 'forbidden', false],
    [() => response({ status: 'error', code: 'WHYAI_NOT_LOGGED_IN' }), 'auth', false],
    [() => response({ status: 'error', code: 'WHYAI_EXECUTABLE_NOT_FOUND' }), 'missing', false],
  ]) {
    let reads = 0
    const env = environment(withOperation(() => ++reads === 1 ? access() : failure()))
    const { AccessStore } = await load('store', env.overrides)
    const store = new AccessStore(), off1 = store.subscribe(() => {}), off2 = store.subscribe(() => {})
    await flush(); assert.equal(reads, 1)
    env.fire(60_000); await flush()
    assert.equal(store.getSnapshot().error, expected)
    assert.equal(!!store.getSnapshot().data, retained)
    assert.equal(!!store.getSnapshot().stale, retained)
    assert.ok(env.calls.every(c => !c.url.includes('fresh')))
    off1(); assert.equal(env.events.size, 1); off2(); await flush()
    assert.equal(env.events.size, 0); assert.equal(env.timers.size, 0)
  }
})

test('actual buttons confirm host intent, prevent duplicate POST, cancel only on terminal and recover remount', async () => {
  let operation = null, posts = 0, loggedIn = false
  const env = environment((url, init) => {
    if (url.endsWith('/operation')) return response({ operation })
    if (url.includes('/login?')) { posts++; assert.equal(init.method, 'POST'); assert.ok(url.endsWith('confirm=host')); operation = op(); return response({ operation }) }
    if (url.includes('/cancel?')) return response({ operation })
    return loggedIn ? access() : response({ status: 'error', code: 'WHYAI_NOT_LOGGED_IN' })
  })
  const { AccessStore } = await load('store', env.overrides), { AccessSummary } = await load('summary'), { en } = await load('locales')
  const store = new AccessStore(); let off = store.subscribe(() => {}); await flush()
  const actions = { prepare: store.prepare, dismiss: store.dismiss, confirm: store.confirm, cancel: store.cancel, retry: store.retry }
  const render = () => AccessSummary({ wide: true, t: k => en[k], useAccess: s => s(store.getSnapshot()), actions })
  const click = label => { const button = walk(render()).find(n => n.type === 'button' && text(n) === label); assert.ok(button, label); return button.props.onClick() }
  click(en.loginBtn); assert.equal(posts, 0); assert.ok(text(render()).includes(en.loginConfirm))
  click(en.dismissBtn); assert.equal(store.getSnapshot().confirmation, undefined)
  click(en.loginBtn); const confirm = walk(render()).find(n => n.type === 'button' && text(n) === en.confirmBtn)
  confirm.props.onClick(); confirm.props.onClick(); await flush(); assert.equal(posts, 1)
  click(en.cancelBtn); await flush(); assert.equal(store.getSnapshot().operation.phase, 'running'); assert.equal(store.getSnapshot().cancelRequested, true)
  assert.ok(text(render()).includes(en.cancelRequested)); assert.ok(!text(render()).includes(en.operationCancelled))
  off(); assert.equal(env.timers.size, 0)
  off = store.subscribe(() => {}); await flush(); assert.equal(store.getSnapshot().operation.phase, 'running')
  operation = op('succeeded'); loggedIn = true; env.fire(2_000); await flush()
  assert.ok(store.getSnapshot().data); assert.ok(text(render()).includes(en.loginSuccess)); assert.ok(text(render()).includes('42.25%'))
  off()
})

test('failed logout remains failed even when access data recovers; identity invalidates at start', async () => {
  let operation = null
  const env = environment(url => url.includes('logout?') ? (operation = op('failed', 'logout'), response({ operation })) : url.endsWith('/operation') ? response({ operation }) : access())
  const { AccessStore } = await load('store', env.overrides), { AccessSummary } = await load('summary'), { en } = await load('locales')
  const store = new AccessStore(), off = store.subscribe(() => {}); await flush()
  store.prepare('logout'); const done = store.confirm(); assert.equal(store.getSnapshot().data, undefined); await done; await flush()
  const node = AccessSummary({ wide: true, t: k => en[k], useAccess: s => s(store.getSnapshot()), actions: store })
  assert.ok(text(node).includes(en.logoutFailed)); assert.ok(!text(node).includes(en.logoutSuccess)); assert.ok(store.getSnapshot().data)
  off()
})

test('lifecycle abort ignores late POST and recovers host outcome without cancelling it', async () => {
  let resolve, signal, operation = null
  const env = environment((url, init) => {
    if (url.endsWith('/operation')) return response({ operation })
    if (url.includes('login?')) { signal = init.signal; return new Promise(done => { resolve = done }) }
    return response({ status: 'error', code: 'WHYAI_NOT_LOGGED_IN' })
  })
  const { AccessStore } = await load('store', env.overrides), store = new AccessStore()
  let off = store.subscribe(() => {}); await flush(); store.prepare('login'); void store.confirm(); off()
  assert.equal(signal.aborted, true); operation = op(); resolve(response({ operation })); await flush()
  assert.equal(store.getSnapshot().operation, undefined); assert.equal(env.timers.size, 0)
  off = store.subscribe(() => {}); await flush(); assert.equal(store.getSnapshot().operation.phase, 'running')
  assert.ok(!env.calls.some(c => c.url.includes('/cancel'))); off()
})

test('request deadline bounds stalled body and oversized body is sanitized', async () => {
  for (const oversized of [false, true]) {
    let bodyCancelled = false, signal
    const env = environment(withOperation((_url, init) => { signal = init.signal; return oversized ? new Response('x'.repeat(16385)) : new Response(new ReadableStream({ cancel() { bodyCancelled = true } })) }))
    const { AccessStore } = await load('store', env.overrides), store = new AccessStore(), off = store.subscribe(() => {})
    await flush(); if (!oversized) { env.fire(35_000); await flush(); assert.equal(signal.aborted, true); assert.equal(bodyCancelled, true) }
    assert.equal(store.getSnapshot().error, oversized ? 'invalid' : 'timeout'); off(); assert.equal(env.timers.size, 0)
  }
})

test('UI distinguishes recovery actions, stale/error feedback, eligibility and native narrow popover', async () => {
  const { AccessSummary } = await load('summary'), { en, zh } = await load('locales')
  const actions = { prepare() {}, dismiss() {}, confirm() {}, cancel() {}, retry() {} }
  for (const dictionary of [en, zh]) {
    const render = state => AccessSummary({ wide: true, t: k => dictionary[k], useAccess: s => s(state), actions })
    for (const error of ['missing', 'auth', 'dshAuth', 'forbidden', 'unavailable']) {
      const node = render({ loading: false, error })
      const labels = walk(node).filter(n => n.type === 'button').map(text)
      assert.equal(labels.includes(dictionary.installBtn), error === 'missing')
      assert.equal(labels.includes(dictionary.loginBtn), error === 'auth')
      assert.ok(text(node).includes(dictionary[error]))
    }
    const node = render({ loading: false, data: { ...data, eligible: false }, stale: true, error: 'unavailable', operation: op('succeeded') })
    assert.ok(text(node).includes(dictionary.stale)); assert.ok(text(node).includes(dictionary.loginSuccess))
    assert.equal(walk(node).find(n => n.props.role === 'progressbar').props['aria-valuenow'], 42.25)
    assert.deepEqual(walk(node).filter(n => n.type === 'time').map(n => n.props.dateTime), [data.subscription_expires_at, data.valid_until])
    const dedup = render({ loading: false, data: { ...data, subscription_expires_at: data.valid_until, available_percent: null } })
    assert.equal(walk(dedup).filter(n => n.type === 'time').length, 1)
    assert.equal(walk(dedup).find(n => n.props.role === 'progressbar').props['aria-valuenow'], undefined)
    assert.ok(!text(dedup).includes(dictionary.accessExpiry)); assert.ok(!text(dedup).includes('0%'))
    const billing = render({ loading: false, data: { ...data, subscription_expires_at: null, billing_status: 'unavailable' } })
    assert.ok(text(billing).includes(dictionary.billingUnavailable)); assert.ok(text(billing).includes('42.25%'))
  }
  const node = AccessSummary({ wide: false, t: k => en[k], useAccess: s => s({ loading: true }), actions })
  assert.equal(walk(node).find(n => n.type === 'button').props.popoverTarget, walk(node).find(n => n.props.popover === 'auto').props.id)
})

test('install and logout buttons require confirmation and keep terminal feedback', async () => {
  for (const kind of ['install', 'logout']) {
    let operation = null, posts = 0
    const env = environment((url, init) => {
      if (url.endsWith('/operation')) return response({ operation })
      if (init.method === 'POST') { posts++; assert.equal(url, `/api/whyai/${kind}?confirm=host`); operation = op('succeeded', kind); return response({ operation }) }
      return kind === 'install' && !operation ? response({ status: 'error', code: 'WHYAI_EXECUTABLE_NOT_FOUND' }) : access()
    })
    const { AccessStore } = await load('store', env.overrides), { AccessSummary } = await load('summary'), { en } = await load('locales')
    const store = new AccessStore(), off = store.subscribe(() => {}); await flush()
    const render = () => AccessSummary({ wide: true, t: k => en[k], useAccess: s => s(store.getSnapshot()), actions: store })
    const click = label => walk(render()).find(n => n.type === 'button' && text(n) === label).props.onClick()
    click(en[`${kind}Btn`]); assert.equal(posts, 0); assert.ok(text(render()).includes(en[`${kind}Confirm`]))
    click(en.confirmBtn); await flush(); assert.equal(posts, 1); assert.ok(text(render()).includes(en[`${kind}Success`]))
    off()
  }
})

test('hidden pending POST with failed recovery leaves an enabled resume action', async () => {
  let failRecovery = false, resolve
  const env = environment(url => {
    if (url.includes('login?')) return new Promise(done => { resolve = done })
    if (url.endsWith('/operation')) { if (failRecovery) throw Error('offline'); return response({ operation: null }) }
    return response({ status: 'error', code: 'WHYAI_NOT_LOGGED_IN' })
  })
  const { AccessStore } = await load('store', env.overrides), { AccessSummary } = await load('summary'), { en } = await load('locales')
  const store = new AccessStore(), off = store.subscribe(() => {}); await flush()
  const render = () => AccessSummary({ wide: true, t: k => en[k], useAccess: s => s(store.getSnapshot()), actions: store })
  walk(render()).find(n => n.type === 'button' && text(n) === en.loginBtn).props.onClick()
  walk(render()).find(n => n.type === 'button' && text(n) === en.confirmBtn).props.onClick(); assert.equal(store.getSnapshot().pending, true)
  env.hide(true); failRecovery = true; env.hide(false); await flush()
  assert.equal(store.getSnapshot().pending, false); assert.equal(store.getSnapshot().watchPaused, true)
  const node = AccessSummary({ wide: true, t: k => en[k], useAccess: s => s(store.getSnapshot()), actions: store })
  const resume = walk(node).find(n => n.type === 'button' && text(n) === en.resumeBtn)
  assert.equal(resume.props.disabled, false)
  const before = env.calls.length; failRecovery = false; resume.props.onClick(); await flush(); assert.ok(env.calls.length > before)
  resolve(response({ operation: op() })); await flush(); assert.equal(store.getSnapshot().operation, undefined)
  off()
})

test('hidden unacknowledged cancel permits same-id retry after recovery', async () => {
  let resolve, cancels = 0
  const env = environment(url => {
    if (url.includes('/cancel?')) { cancels++; return cancels === 1 ? new Promise(done => { resolve = done }) : response({ operation: op() }) }
    return response({ operation: op() })
  })
  const { AccessStore } = await load('store', env.overrides), { AccessSummary } = await load('summary'), { en } = await load('locales')
  const store = new AccessStore(), off = store.subscribe(() => {}); await flush()
  const cancelButton = () => walk(AccessSummary({ wide: true, t: k => en[k], useAccess: s => s(store.getSnapshot()), actions: store })).find(n => n.type === 'button' && text(n) === en.cancelBtn)
  cancelButton().props.onClick(); assert.equal(store.getSnapshot().cancelRequested, true)
  env.hide(true); env.hide(false); await flush()
  assert.equal(cancelButton().props.disabled, false); cancelButton().props.onClick(); await flush(); assert.equal(cancels, 2)
  resolve(response({ operation: op('cancelled') })); await flush(); assert.equal(store.getSnapshot().operation.phase, 'running')
  off()
})

test('hidden identity and confirmation clear before resumed requests settle', async () => {
  let block = false, resolve
  const env = environment(url => block ? new Promise(done => { resolve = done }) : url.endsWith('/operation') ? response({ operation: null }) : access())
  const { AccessStore } = await load('store', env.overrides), store = new AccessStore(), off = store.subscribe(() => {})
  await flush(); store.prepare('logout'); assert.equal(store.getSnapshot().confirmation, 'logout')
  env.hide(true); assert.equal(store.getSnapshot().data, undefined); assert.equal(store.getSnapshot().confirmation, undefined)
  block = true; env.hide(false); assert.equal(store.getSnapshot().loading, true); assert.equal(store.getSnapshot().data, undefined)
  await store.confirm(); assert.ok(env.calls.every(c => c.init.method === 'GET'))
  off(); resolve(response({ operation: null })); await flush(); assert.equal(store.getSnapshot().data, undefined)
})

test('rejected new start cannot borrow previous terminal success; only a newer operation clears it', async () => {
  let operation = { ...op('succeeded'), id: 'previous-operation' }
  const env = environment(url => {
    if (url.includes('login?')) return response({ status: 'error', code: 'WHYAI_BUSY' })
    if (url.endsWith('/operation')) return response({ operation })
    return response({ status: 'error', code: 'WHYAI_NOT_LOGGED_IN' })
  })
  const { AccessStore } = await load('store', env.overrides), { AccessSummary } = await load('summary'), { en } = await load('locales')
  const store = new AccessStore(), off = store.subscribe(() => {}); await flush()
  const render = () => AccessSummary({ wide: true, t: k => en[k], useAccess: s => s(store.getSnapshot()), actions: store })
  const click = label => walk(render()).find(n => n.type === 'button' && text(n) === label).props.onClick()
  click(en.loginBtn); click(en.confirmBtn); await flush()
  assert.equal(store.getSnapshot().actionError, 'busy'); assert.ok(text(render()).includes(en.busy)); assert.ok(!text(render()).includes(en.loginSuccess))
  click(en.retryBtn); await flush(); assert.equal(store.getSnapshot().actionError, 'busy'); assert.ok(!text(render()).includes(en.loginSuccess))
  operation = { ...op('succeeded'), id: 'new-operation' }; click(en.retryBtn); await flush()
  assert.equal(store.getSnapshot().actionError, undefined); assert.ok(text(render()).includes(en.loginSuccess))
  off()
})

test('recovered operation clears observation errors but null recovery retains rejected-start guidance', async () => {
  let failure = true
  const env = environment(url => {
    if (url.includes('login?')) return response({ status: 'error', code: 'WHYAI_INSTALL_CUSTOM_PATH_UNSUPPORTED' })
    if (url.endsWith('/operation')) return response({ operation: failure ? null : op('succeeded') })
    return response({ status: 'error', code: 'WHYAI_NOT_LOGGED_IN' })
  })
  const { AccessStore } = await load('store', env.overrides), store = new AccessStore(), off = store.subscribe(() => {})
  await flush(); store.prepare('login'); await store.confirm(); await flush(); assert.equal(store.getSnapshot().actionError, 'customPath')
  failure = false; store.retry(); await flush(); assert.equal(store.getSnapshot().actionError, undefined)
  off()
})

test('operation monitoring is bounded, hidden-paused, resumes and disposal owns all resources', async () => {
  const env = environment(() => response({ operation: op() }))
  const { AccessStore } = await load('store', env.overrides), store = new AccessStore(), off = store.subscribe(() => {})
  await flush()
  env.hide(true); assert.equal(env.timers.size, 0)
  const calls = env.calls.length; env.fire(2_000); await flush(); assert.equal(env.calls.length, calls)
  env.hide(false); await flush()
  for (let i = 0; i < 179; i++) { env.fire(2_000); await flush() }
  assert.equal(store.getSnapshot().watchPaused, true); assert.equal(env.timers.size, 0)
  assert.equal(store.getSnapshot().operation.phase, 'running')
  store.retry(); await flush(); assert.equal(store.getSnapshot().watchPaused, false); assert.equal(env.timers.size, 1)
  store.dispose(); off(); store.subscribe(() => {}); assert.equal(env.timers.size, 0); assert.equal(env.events.size, 0)
})

test('slot routing shares observable and injected action identities through optional slot remount', async () => {
  const { apply } = await load('index'), callbacks = new Map(), active = new Map(), cleanups = []
  apply({ effect: fn => cleanups.push(fn()), locale: { register: () => () => {} }, slots: { inject: (name, fn) => callbacks.set(name, fn), register: spec => { active.set(spec.name, spec); return () => active.delete(spec.name) } } })
  const offFooter = callbacks.get('sidebar.footer.action')(), first = active.get('sidebar.footer.action').inject()
  const offNested = callbacks.get('sidebar.footer.usage-monitor.after')()
  assert.equal(active.has('sidebar.footer.action'), false)
  const nested = active.get('sidebar.footer.usage-monitor.after').inject()
  assert.equal(nested.hooks.access, first.hooks.access); assert.equal(nested.actions.confirm, first.actions.confirm)
  offNested(); await flush(); assert.equal(active.get('sidebar.footer.action').inject().hooks.access, first.hooks.access)
  offFooter(); for (const cleanup of cleanups.reverse()) cleanup(); await flush(); assert.equal(active.size, 0)
})
