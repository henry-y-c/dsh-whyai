export const name = 'whyai-probe'
export const inject = ['tools']

function project(result) {
  return {
    isError: result.isError,
    value: result.value,
    text: result.content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join(''),
  }
}

export function apply(ctx) {
  void (async () => {
    let schemas = []
    for (let attempt = 0; attempt < 100; attempt += 1) {
      schemas = ctx.tools.schemas().map((schema) => schema.name).filter((toolName) => toolName.startsWith('yai_')).sort()
      if (schemas.length === 4) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const execute = async (callId, name, args) => project(await ctx.tools.execute({
      callId: `whyai-probe-${callId}`,
      name,
      arguments: args,
      signal: new AbortController().signal,
    }))
    const status = await execute('status', 'yai_status', {})
    const create = await execute('create', 'yai_conversation_create', {
      partner_id: '11111111-1111-4111-8111-111111111111',
      title: 'composition fixture',
    })
    // The fallback lets the approval-enabled composition prove send is denied too.
    const conversation_id = create.value?.conversation_id ?? '33333333-3333-4333-8333-333333333333'
    const send = await execute('send', 'yai_message_send', {
      conversation_id,
      message: 'fixture first message 中文\nsecond line',
    })
    const repeatSend = await execute('repeat-send', 'yai_message_send', {
      conversation_id,
      message: 'fixture follow-up message',
      knowledge_base: true,
    })
    process.stdout.write(`WHYAI_PROBE ${JSON.stringify({ schemas, status, create, send, repeatSend })}\n`)
  })().catch((error) => {
    process.stdout.write(`WHYAI_PROBE_ERROR ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n`)
  })
}
