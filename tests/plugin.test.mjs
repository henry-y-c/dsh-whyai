import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, Config, createToolDefinitions, TOOL_NAMES, WhyAiCliError } from '../lib/index.js'
import { CONFIG, fakeContext, NodeSubprocess } from './helpers.mjs'

const exec = () => ({ signal: new AbortController().signal })

test('explicit approval mode registers four bounded tools and an approval gate', async () => {
  const harness = fakeContext(new NodeSubprocess())
  apply(harness.ctx, CONFIG)
  assert.deepEqual([...harness.tools.keys()].sort(), Object.values(TOOL_NAMES).sort())
  assert.equal(harness.listeners.length, 1)

  let nextCalls = 0
  const allow = async () => { nextCalls += 1; return { kind: 'allow' } }
  assert.deepEqual(await harness.listeners[0]({ name: TOOL_NAMES.status }, allow), { kind: 'allow' })
  const decision = await harness.listeners[0]({ name: TOOL_NAMES.send }, allow)
  assert.equal(decision.kind, 'ask')
  assert.equal(nextCalls, 2)
  const denied = await harness.listeners[0]({ name: TOOL_NAMES.send }, async () => ({ kind: 'deny', reason: 'policy' }))
  assert.deepEqual(denied, { kind: 'deny', reason: 'policy' })
  await harness.dispose()
  assert.equal(harness.tools.size, 0)
  assert.equal(harness.listeners.length, 0)
})

test('default configuration does not add a plugin approval prompt', async () => {
  const config = Config({})
  assert.equal(config.requireApproval, false)
  const harness = fakeContext(new NodeSubprocess())
  apply(harness.ctx, config)
  assert.deepEqual([...harness.tools.keys()].sort(), Object.values(TOOL_NAMES).sort())
  assert.equal(harness.listeners.length, 0)
  await harness.dispose()
})

test('invalid subprocess limits fail at plugin load', () => {
  const harness = fakeContext(new NodeSubprocess())
  assert.throws(() => apply(harness.ctx, { ...CONFIG, stdoutMaxBytes: Number.MAX_SAFE_INTEGER }), /stdoutMaxBytes/u)
  assert.throws(() => apply(harness.ctx, { ...CONFIG, cliPath: ` ${CONFIG.cliPath}` }), /whitespace/u)
  assert.equal(harness.tools.size, 0)
})

test('status rejects missing booleans and invalid percentage ranges', async () => {
  const logger = { warn() {}, error() {} }
  const missing = createToolDefinitions({
    async version() { return '0.5.7' },
    async invoke() { return { exitCode: 0, value: {}, hadWarning: false } },
  }, CONFIG, logger).find((tool) => tool.name === TOOL_NAMES.status)
  await assert.rejects(missing.execute({}, exec()), (error) => error.code === 'WHYAI_MALFORMED_OUTPUT')

  const invalidPercent = createToolDefinitions({
    async version() { return '0.5.7' },
    async invoke(args) {
      return args.includes('status')
        ? { exitCode: 0, value: { logged_in: true }, hadWarning: false }
        : { exitCode: 0, value: { eligible: true, available_percent: 101 }, hadWarning: false }
    },
  }, CONFIG, logger).find((tool) => tool.name === TOOL_NAMES.status)
  await assert.rejects(invalidPercent.execute({}, exec()), (error) => error.code === 'WHYAI_MALFORMED_OUTPUT')
})

test('status omits user identity and returns access facts', async () => {
  const harness = fakeContext(new NodeSubprocess())
  apply(harness.ctx, CONFIG)
  const value = await harness.tools.get(TOOL_NAMES.status).execute({}, exec())
  assert.equal(value.cli_version, '0.5.7')
  assert.equal(value.logged_in, true)
  assert.equal(value.access.available_percent, 75)
  assert.equal('user' in value, false)
  await harness.dispose()
})

test('partner search returns UUIDs and enforces the configured result limit', async () => {
  const harness = fakeContext(new NodeSubprocess())
  apply(harness.ctx, { ...CONFIG, partnerLimit: 1 })
  const value = await harness.tools.get(TOOL_NAMES.partners).execute({ query: '五步法' }, exec())
  assert.equal(value.partners.length, 1)
  assert.equal(value.partners[0].id, '11111111-1111-4111-8111-111111111111')
  assert.equal(value.truncated, true)
  assert.equal('reasoning_content' in value.partners[0], false)
  await harness.dispose()
})

test('conversation data and messages travel through stdin, not argv', async () => {
  const log = join(tmpdir(), `dsh-whyai-${process.pid}-${Date.now()}.jsonl`)
  const subprocess = new NodeSubprocess({ MOCK_WHYAI_LOG: log })
  const harness = fakeContext(subprocess)
  apply(harness.ctx, CONFIG)
  const partnerId = '11111111-1111-4111-8111-111111111111'
  const created = await harness.tools.get(TOOL_NAMES.create).execute({ partner_id: partnerId, title: 'Private title' }, exec())
  assert.equal(created.conversation_id, '33333333-3333-4333-8333-333333333333')

  const sent = await harness.tools.get(TOOL_NAMES.send).execute({
    conversation_id: created.conversation_id,
    message: 'Private consultation text',
    knowledge_base: true,
  }, exec())
  assert.equal(sent.content, 'answer:Private consultation text')
  assert.equal(sent.knowledge_base_requested, true)
  assert.equal('reasoning_content' in sent, false)
  assert.equal('tool_executions' in sent, false)

  const rows = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  const createRow = rows.find((row) => row.args.includes('create'))
  const chatRow = rows.find((row) => row.args.includes('chat'))
  assert.equal(createRow.args.join(' ').includes('Private title'), false)
  assert.equal(createRow.stdin.includes('Private title'), true)
  assert.equal(chatRow.args.join(' ').includes('Private consultation text'), false)
  assert.equal(chatRow.stdin, 'Private consultation text')
  assert.equal(chatRow.args.includes('--no-memory'), true)
  assert.equal(chatRow.args.includes('--knowledge-base'), true)
  await harness.dispose()
  await rm(log, { force: true })
})

test('partial response is preserved without private reasoning', async () => {
  const harness = fakeContext(new NodeSubprocess())
  apply(harness.ctx, CONFIG)
  const value = await harness.tools.get(TOOL_NAMES.send).execute({
    conversation_id: '33333333-3333-4333-8333-333333333333',
    message: '__partial__',
  }, exec())
  assert.equal(value.status, 'partial')
  assert.equal(value.content, 'partial answer')
  assert.equal('reasoning_content' in value, false)
  assert.match(value.warnings[0], /partial response/u)
  await harness.dispose()
})

test('malformed and mismatched CLI responses fail closed', async () => {
  const harness = fakeContext(new NodeSubprocess())
  apply(harness.ctx, CONFIG)
  const send = harness.tools.get(TOOL_NAMES.send)
  await assert.rejects(send.execute({
    conversation_id: '33333333-3333-4333-8333-333333333333',
    message: '__missing__',
  }, exec()), (error) => error instanceof WhyAiCliError && error.code === 'WHYAI_MALFORMED_OUTPUT')
  await assert.rejects(send.execute({
    conversation_id: '33333333-3333-4333-8333-333333333333',
    message: '__mismatch__',
  }, exec()), (error) => error instanceof WhyAiCliError && error.code === 'WHYAI_RESPONSE_MISMATCH')
  await assert.rejects(harness.tools.get(TOOL_NAMES.create).execute({
    partner_id: '11111111-1111-4111-8111-111111111111',
    title: '__mismatch__',
  }, exec()), (error) => error instanceof WhyAiCliError && error.code === 'WHYAI_RESPONSE_MISMATCH')
  await harness.dispose()
})

test('invalid UUIDs, extra fields and oversized prompts fail before spawn', async () => {
  const subprocess = new NodeSubprocess()
  const harness = fakeContext(subprocess)
  apply(harness.ctx, { ...CONFIG, promptMaxBytes: 4 })
  const send = harness.tools.get(TOOL_NAMES.send)
  await assert.rejects(send.execute({ conversation_id: 'not-a-uuid', message: 'ok' }, exec()), WhyAiCliError)
  await assert.rejects(send.execute({ conversation_id: '33333333-3333-4333-8333-333333333333', message: '12345' }, exec()), WhyAiCliError)
  await assert.rejects(send.execute({ conversation_id: '33333333-3333-4333-8333-333333333333', message: '你好' }, exec()), WhyAiCliError)
  await assert.rejects(send.execute({ conversation_id: '33333333-3333-4333-8333-333333333333', message: 'ok', file: '/tmp/a' }, exec()), WhyAiCliError)
  assert.equal(subprocess.specs.length, 0)
  const exact = await send.execute({ conversation_id: '33333333-3333-4333-8333-333333333333', message: 'éé' }, exec())
  assert.equal(exact.content, 'answer:éé')
  await harness.dispose()
})
