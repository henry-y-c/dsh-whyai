import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const home = join(root, `.tmp-composition-${process.pid}`)
const profile = join(home, 'profiles', 'web')
const mockCli = join(root, 'tests', 'fixtures', 'mock-whyai.mjs')
const probe = join(root, 'tests', 'fixtures', 'probe')
const mockLog = join(home, 'mock-whyai.jsonl')
const dsh = process.env.DSH_BIN ?? 'dsh'

function redact(text) {
  return text.replace(/([?&]token=)[^\s&"']+/gu, '$1<redacted>')
}

function appendTail(current, chunk) {
  return `${current}${chunk}`.slice(-1024 * 1024)
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('could not allocate a test port'))
      server.close((error) => error ? reject(error) : resolvePort(address.port))
    })
  })
}

let preserveHome = false

// POSIX-only fixture ownership: detached children lead a private process group.
// Windows needs a Job Object implementation; do not pretend child.kill is equivalent.
function managedCommand(args, { timeoutMs, onData, onStop = () => {}, onExit = () => {} }) {
  if (process.platform === 'win32') throw new Error('test:composition requires POSIX process groups (macOS/Linux); Windows is unsupported')
  const child = spawn(dsh, args, {
    detached: true,
    env: { ...process.env, DSH_HOME: home, MOCK_WHYAI_LOG: mockLog, MOCK_WHYAI_STATE: join(home, 'mock-auth-state') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let closed = false
  let code
  let failure
  let observationError
  let signalDenied = false
  let stopped = false
  let settled = false
  let pollTimer
  let killTimer
  let cleanupTimer
  let resolveDone
  let rejectDone
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
  const groupExists = () => {
    if (!child.pid) return false
    try { process.kill(-child.pid, 0); return true } catch (error) {
      if (error.code === 'ESRCH') return false
      throw error
    }
  }
  const signalGroup = (signal) => {
    if (!child.pid || signalDenied) return
    try { process.kill(-child.pid, signal) } catch (error) {
      if (error.code === 'EPERM') {
        signalDenied = true
        observationError = error
      } else if (error.code !== 'ESRCH') failure ??= error
    }
  }
  const finish = (cleanupFailed = false) => {
    if (settled) return
    settled = true
    for (const timer of [deadline, pollTimer, killTimer, cleanupTimer]) clearTimeout(timer)
    child.stdout.destroy()
    child.stderr.destroy()
    if (cleanupFailed) {
      preserveHome = true
      child.unref()
      rejectDone(new Error('DSH process-group cleanup could not be confirmed; temporary home retained', { cause: failure ?? observationError }))
    } else if (failure) rejectDone(failure)
    else resolveDone({ code })
  }
  const observe = () => {
    if (settled) return
    try {
      if (!groupExists() && closed) return finish()
    } catch (error) {
      // Darwin killpg1 also returns EPERM for a group with no live members.
      // It is unknown, not empty: only a later ESRCH plus close proves cleanup.
      if (error.code === 'EPERM') {
        observationError = error
        signalDenied = true
      } else failure ??= error
    }
    pollTimer = setTimeout(observe, 50)
  }
  const stop = (error) => {
    if (settled) return
    failure ??= error
    if (stopped) return
    stopped = true
    clearTimeout(deadline)
    onStop()
    signalGroup('SIGTERM')
    killTimer = setTimeout(() => signalGroup('SIGKILL'), 2_000)
    cleanupTimer = setTimeout(() => finish(true), 4_000)
    observe()
  }
  const deadline = setTimeout(() => stop(new Error(`dsh command timed out: ${args.join(' ')}`)), timeoutMs)
  for (const [stream, label] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
    stream.on('data', (chunk) => {
      if (settled) return
      try { onData(label, chunk.toString()) } catch (error) { stop(error) }
    })
    stream.on('error', stop)
  }
  child.once('error', stop)
  child.once('exit', (exitCode) => {
    code = exitCode
    try { onExit(exitCode) } catch (error) { failure ??= error }
    stop()
  })
  child.once('close', (exitCode) => { code = exitCode; closed = true; stop() })
  return { done, stop }
}

async function command(args, timeoutMs = 60_000) {
  let stdout = ''
  let stderr = ''
  const { done } = managedCommand(args, { timeoutMs, onData: (stream, chunk) => {
    if (stream === 'stdout') stdout = appendTail(stdout, chunk)
    else stderr = appendTail(stderr, chunk)
  } })
  const { code } = await done
  if (code !== 0) throw new Error(`dsh ${args.join(' ')} exited ${code}: ${redact(stderr || stdout).slice(-2_000)}`)
  return { stdout, stderr }
}

async function probeWeb(port, token, signal, toolsDone) {
  assert.notEqual(port, 3080)
  const origin = `http://127.0.0.1:${port}`
  const request = (path, options = {}) => fetch(origin + path, { ...options, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
  const auth = await request(`/?token=${token}`, { redirect: 'manual' })
  assert.equal(auth.status, 303)
  const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  assert.ok(cookie)
  const get = (path, options = {}) => request(path, { headers: { cookie }, ...options })
  assert.equal((await request('/api/whyai/access')).status, 401)
  assert.equal((await get('/api/whyai/access', { headers: { cookie, origin: 'https://attacker.invalid' } })).status, 403)
  assert.equal((await get('/api/whyai/access', { method: 'POST' })).status, 405)
  const responses = await Promise.all(Array.from({ length: 4 }, () => get('/api/whyai/access')))
  for (const response of responses) {
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), { status: 'ok', data: { eligible: true, available_percent: 75, valid_until: '2099-01-01T00:00:00Z', subscription_expires_at: '2099-01-01T00:00:00Z', next_reset_at: null, billing_status: 'ok' } })
  }
  const html = await (await get('/')).text()
  const marker = 'globalThis["__DSH_BOOT__"] = '
  const start = html.indexOf(marker)
  assert.ok(start >= 0)
  const graph = JSON.parse(html.slice(start + marker.length).split('</script>')[0].trim().replace(/;$/, ''))
  const entry = graph.entries.find(row => row.id === 'dsh-whyai')
  assert.ok(entry, '客户端必须出现在真实启动清单')
  const combo = await get(entry.url)
  assert.equal(combo.status, 200)
  assert.match(await combo.text(), /sidebar\.footer\.action/u)

  // These requests must fail before any management command is executed.
  for (const kind of ['install', 'login', 'logout']) {
    assert.equal((await request(`/api/whyai/${kind}?confirm=host`, { method: 'POST' })).status, 401)
    assert.equal((await get(`/api/whyai/${kind}?confirm=host`, { method: 'POST', headers: { cookie, origin: 'https://attacker.invalid' } })).status, 403)
    assert.equal((await get(`/api/whyai/${kind}`)).status, 405)
    assert.equal((await get(`/api/whyai/${kind}`, { method: 'POST' })).status, 400)
  }
  assert.equal((await request('/api/whyai/operation')).status, 401)
  assert.equal((await request('/api/whyai/operation/cancel?id=fixture', { method: 'POST' })).status, 401)
  assert.deepEqual(await (await get('/api/whyai/operation')).json(), { operation: null })

  // Let consultation probes finish first: management must not interrupt them.
  await toolsDone
  for (const kind of ['logout', 'login']) {
    const startOperation = await get(`/api/whyai/${kind}?confirm=host`, { method: 'POST' })
    assert.equal(startOperation.status, 202)
    let { operation } = await startOperation.json()
    const id = operation.id
    assert.equal(operation.kind, kind)
    for (let attempt = 0; operation.phase === 'running' && attempt < 100; attempt++) {
      await delay(25, undefined, { signal })
      const response = await get('/api/whyai/operation')
      assert.equal(response.status, 200)
      ;({ operation } = await response.json())
      assert.equal(operation.id, id)
    }
    assert.equal(operation.phase, 'succeeded', `fixture ${kind} must settle successfully`)
    assert.equal(JSON.stringify(operation).includes('must-not-leak'), false)
  }
}

async function bootAndProbe(port) {
  let buffer = ''
  let result
  let webStarted = false
  let webDone = false
  let resolveToolsDone
  const toolsDone = new Promise(resolve => { resolveToolsDone = resolve })
  const webController = new AbortController()
  const incomplete = (code) => new Error(`dsh boot exited ${code} before probes completed (toolDone=${result !== undefined}, webDone=${webDone}): ${redact(buffer).slice(-2_000)}`)
  const { done, stop } = managedCommand(['--profile', 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
    timeoutMs: 90_000,
    onStop: () => webController.abort(),
    onExit: (code) => {
      if (result === undefined || !webDone) throw incomplete(code)
    },
    onData: (_stream, chunk) => {
      if (webController.signal.aborted) return
      buffer = appendTail(buffer, chunk)
      const token = buffer.match(/https?:\/\/[^\s]+[?&]token=([^\s]+)/u)?.[1]
      if (token && !webStarted) {
        webStarted = true
        void probeWeb(port, token, webController.signal, toolsDone).then(() => {
          if (webController.signal.aborted) return
          webDone = true
          if (result !== undefined) stop()
        }).catch((error) => {
          if (!webController.signal.aborted) stop(error)
        })
      }
      const marker = buffer.match(/WHYAI_PROBE (\{[^\n]+\})/u)
      const probeFailure = buffer.match(/WHYAI_PROBE_ERROR (\{[^\n]+\})/u)
      if (probeFailure) {
        stop(new Error(`probe failed: ${probeFailure[1]}`))
      } else if (marker && result === undefined) {
        result = JSON.parse(marker[1])
        resolveToolsDone()
        if (webDone) stop()
      }
    },
  })
  const { code } = await done
  if (result === undefined || !webDone) throw incomplete(code)
  return result
}

try {
  await rm(home, { recursive: true, force: true })
  await command(['plugin', '--profile', 'web', 'add', `file:${root}`])
  await command(['plugin', '--profile', 'web', 'add', `file:${probe}`])
  await mkdir(profile, { recursive: true })
  const configLines = [
    '- id: whyai',
    '  name: dsh-whyai',
    '  config:',
    `    cliPath: ${JSON.stringify(mockCli)}`,
    '    timeoutMs: 5000',
    '    graceMs: 200',
    '    stdoutMaxBytes: 65536',
    '    stderrMaxBytes: 16384',
    '    promptMaxBytes: 4096',
    '    partnerLimit: 10',
  ]
  // Omit requireApproval to test the actual default, not an explicit false override.
  await writeFile(join(profile, 'cordis.patch.yml'), [...configLines, ''].join('\n'))

  const installed = await lstat(join(profile, 'node_modules', 'dsh-whyai'))
  assert.equal(installed.isSymbolicLink(), false, 'file: install must be a real directory')
  const dump = await command(['--profile', 'web', '--dump-config'])
  assert.match(dump.stdout, /# == dsh-whyai/u)
  assert.match(dump.stdout, /id: whyai/u)

  const readCalls = async () => (await readFile(mockLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  const readOnlyCommands = [
    '--version', '--json status', '--json billing access', '--json billing access', '--json billing summary',
  ]
  const managementCommands = ['--json logout', '--json status', 'login --gateway https://ai.yitang.top', '--json status']
  const checkCommon = (result) => {
    assert.deepEqual(result.schemas, ['yai_conversation_create', 'yai_message_send', 'yai_partners', 'yai_status'])
    assert.equal(result.status.isError, false, result.status.text)
    assert.equal(result.status.value.cli_version, '0.5.7')
    assert.equal(result.status.value.logged_in, true)
  }
  const result = await bootAndProbe(await freePort())
  checkCommon(result)
  assert.equal(result.create.isError, false, result.create.text)
  const conversationId = '33333333-3333-4333-8333-333333333333'
  assert.deepEqual(result.create.value, {
    conversation_id: conversationId,
    partner_id: '11111111-1111-4111-8111-111111111111',
    model_id: 'mock-model', status: 'active', warnings: [],
  })
  const messages = ['fixture first message 中文\nsecond line', 'fixture follow-up message']
  for (const [index, send] of [result.send, result.repeatSend].entries()) {
    assert.equal(send.isError, false, send.text)
    assert.deepEqual(send.value, {
      status: 'completed', conversation_id: conversationId, content: `answer:${messages[index]}`,
      message_id: '44444444-4444-4444-8444-444444444444', model_id: 'mock-model', finish_reason: 'stop',
      knowledge_base_requested: index === 1, warnings: [],
    })
    assert.equal(send.text, `answer:${messages[index]}\n\n[YAI completed; conversation_id=${conversationId}]`)
  }
  const calls = await readCalls()
  const createCommand = '--json conversations create --data -'
  const sendCommand = `--json chat - --conversation ${conversationId}`
  assert.deepEqual(calls.map((call) => call.args.join(' ')).sort(), [
    ...readOnlyCommands, ...managementCommands, createCommand, `${sendCommand} --no-memory`, `${sendCommand} --knowledge-base --no-memory`,
  ].sort())
  const writes = calls.filter((call) => call.args[1] === 'conversations' || call.args[1] === 'chat')
  assert.deepEqual(writes, [
    { args: createCommand.split(' '), stdin: JSON.stringify({ partner_id: '11111111-1111-4111-8111-111111111111', title: 'composition fixture' }) },
    { args: `${sendCommand} --no-memory`.split(' '), stdin: messages[0] },
    { args: `${sendCommand} --knowledge-base --no-memory`.split(' '), stdin: messages[1] },
  ])

  await writeFile(join(profile, 'cordis.patch.yml'), [...configLines, '    requireApproval: true', ''].join('\n'))
  await rm(mockLog)
  const approvalResult = await bootAndProbe(await freePort())
  checkCommon(approvalResult)
  for (const denied of [approvalResult.create, approvalResult.send, approvalResult.repeatSend]) {
    assert.equal(denied.isError, true)
    assert.match(denied.text, /requires approval|no agent|approval/u)
  }
  // A policy denial must happen before the fixture subprocess is invoked.
  assert.deepEqual((await readCalls()).map((call) => call.args.join(' ')).sort(), [...readOnlyCommands, ...managementCommands].sort())
  process.stdout.write('真实组合通过：Loader、默认 create/send/repeat send、显式批准拒绝、认证与管理路由、fixture 退出/登录、并发缓存、客户端清单与资源\n')
} finally {
  // A failed cleanup is not quiescence: keep files that surviving work may use.
  if (!preserveHome) await rm(home, { recursive: true, force: true })
}
