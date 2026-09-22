#!/usr/bin/env node
import { appendFile, readFile, writeFile } from 'node:fs/promises'

const args = process.argv.slice(2)
let stdin = ''
for await (const chunk of process.stdin) stdin += chunk

if (process.env.MOCK_WHYAI_LOG) {
  await appendFile(process.env.MOCK_WHYAI_LOG, `${JSON.stringify({ args, stdin })}\n`)
}

const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const fail = (message, code = undefined) => {
  process.stderr.write(`${JSON.stringify({ error: { message, ...(code ? { code } : {}) } })}\n`)
  process.exitCode = 1
}

if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('0.5.7\n')
} else if (args.join(' ') === 'login --gateway https://ai.yitang.top') {
  if (!process.env.MOCK_WHYAI_STATE) throw new Error('management fixture requires isolated state')
  await writeFile(process.env.MOCK_WHYAI_STATE, 'logged-in')
  print({ logged_in: true })
} else if (args.join(' ') === '--json logout') {
  if (!process.env.MOCK_WHYAI_STATE) throw new Error('management fixture requires isolated state')
  await writeFile(process.env.MOCK_WHYAI_STATE, 'logged-out')
  print({ logged_out: true })
} else if (args.join(' ') === '--json status') {
  const loggedOut = process.env.MOCK_WHYAI_STATE && await readFile(process.env.MOCK_WHYAI_STATE, 'utf8').catch(() => '') === 'logged-out'
  if (loggedOut) {
    print({ logged_in: false })
    process.exitCode = 1
  } else {
    print({ logged_in: true, gateway: 'https://mock.invalid', environment: 'test', user: { id: 'must-not-leak' } })
  }
} else if (args.join(' ') === '--json billing access') {
  print({ eligible: true, available_percent: 75, plan_code: 'test', valid_until: '2099-01-01T00:00:00Z' })
} else if (args.join(' ') === '--json billing summary') {
  print({ preview: false, state: 'active', plan_source: 'subscription', plan_status: 'active', plan_expires_at: '2099-01-01T00:00:00Z', next_reset_at: null, order_id: 'must-not-leak' })
} else if (args[0] === '--json' && args[1] === 'partners' && args[2] === 'search') {
  print([
    { id: '11111111-1111-4111-8111-111111111111', name: 'Five Step Coach', description: 'Mock A', tcpr_type: 'T', reasoning_content: 'omit' },
    { id: '22222222-2222-4222-8222-222222222222', name: 'ROI Coach', description: 'Mock B', tcpr_type: 'C' },
  ])
} else if (args.join(' ') === '--json conversations create --data -') {
  const payload = JSON.parse(stdin)
  const returnedPartner = payload.title === '__mismatch__' ? '22222222-2222-4222-8222-222222222222' : payload.partner_id
  print({ id: '33333333-3333-4333-8333-333333333333', partner_id: returnedPartner, model_id: 'mock-model', status: 'active' })
} else if (args[0] === '--json' && args[1] === 'chat' && args[2] === '-') {
  const conversationId = args[args.indexOf('--conversation') + 1]
  if (stdin === '__hang__') {
    setInterval(() => {}, 1_000)
  } else if (stdin === '__malformed__') {
    process.stdout.write('not-json\n')
  } else if (stdin === '__oversize__') {
    print({ conversation_id: conversationId, content: 'x'.repeat(20_000) })
  } else if (stdin === '__missing__') {
    print({ conversation_id: conversationId })
  } else if (stdin === '__mismatch__') {
    print({ conversation_id: '55555555-5555-4555-8555-555555555555', content: 'wrong conversation' })
  } else if (stdin === '__error__') {
    fail('quota exhausted Bearer secret-token?token=also-secret', 'QUOTA_EXHAUSTED')
  } else if (stdin === '__unknown_error__') {
    fail('Cookie=session-secret and private diagnostics', 'ATTACKER_CONTROLLED_SECRET_CODE')
  } else if (stdin === '__partial__') {
    print({ conversation_id: conversationId, content: 'partial answer', reasoning_content: 'private reasoning', tool_executions: [{ secret: true }] })
    fail('PERSIST_FAILED: response not persisted', 'PERSIST_FAILED')
  } else {
    if (stdin === '__warning__') process.stderr.write('CLI automatic update unavailable; continuing\n')
    print({
      conversation_id: conversationId,
      content: `answer:${stdin}`,
      message_id: '44444444-4444-4444-8444-444444444444',
      model_id: 'mock-model',
      finish_reason: 'stop',
      reasoning_content: 'private reasoning',
      tool_executions: [{ secret: true }],
    })
  }
} else {
  fail(`unexpected argv: ${args.join(' ')}`)
}
