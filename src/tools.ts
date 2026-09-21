import type { Logger, ToolDefinition } from './dsh-types.ts'
import type { WhyAiConfig } from './config.ts'
import { asRecord, cliFailure, WhyAiCliError, type CliInvocation, type WhyAiCliRunner } from './runner.ts'

export const TOOL_NAMES = {
  status: 'yai_status',
  partners: 'yai_partners',
  create: 'yai_conversation_create',
  send: 'yai_message_send',
} as const

interface StatusArgs {}
interface PartnersArgs { query: string; type?: 'T' | 'C' | 'P' | 'R'; limit?: number }
interface CreateArgs { partner_id: string; title?: string }
interface SendArgs { conversation_id: string; message: string; knowledge_base?: boolean; use_memory?: boolean }

export interface StatusResult {
  cli_version: string
  logged_in: boolean
  gateway?: string
  environment?: string
  access?: {
    eligible: boolean
    available_percent?: number
    plan_code?: string
    valid_until?: string
    reason?: string
  }
  warnings: string[]
}

export interface PartnerSummary {
  id: string
  name: string
  description?: string
  tcpr_type?: string
  tcpr_label?: string
}

export interface PartnersResult {
  partners: PartnerSummary[]
  truncated: boolean
  warnings: string[]
}

export interface ConversationResult {
  conversation_id: string
  partner_id: string
  model_id?: string
  status?: string
  warnings: string[]
}

export interface MessageResult {
  status: 'completed' | 'partial'
  conversation_id: string
  content: string
  message_id?: string
  model_id?: string
  finish_reason?: string
  knowledge_base_requested: boolean
  warnings: string[]
}

type Tool = ToolDefinition<unknown, unknown>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactArgs(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new WhyAiCliError('tool arguments must be an object', 'INVALID_ARGS')
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new WhyAiCliError(`unexpected argument ${key}`, 'INVALID_ARGS')
  }
  for (const key of required) {
    if (!(key in value)) throw new WhyAiCliError(`missing required argument ${key}`, 'INVALID_ARGS')
  }
  return value
}

function text(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WhyAiCliError(`${name} must be a non-empty string`, 'INVALID_ARGS')
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new WhyAiCliError(`${name} exceeds ${maxBytes} UTF-8 bytes`, 'INVALID_ARGS')
  }
  return value
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new WhyAiCliError(`${name} must be a UUID`, 'INVALID_ARGS')
  return value
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new WhyAiCliError(`${name} must be boolean`, 'INVALID_ARGS')
  return value
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  if (typeof record[key] !== 'string' || record[key].length === 0) {
    throw new WhyAiCliError(`WhyAI CLI returned an invalid ${label}`, 'WHYAI_MALFORMED_OUTPUT')
  }
  return record[key]
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new WhyAiCliError(`WhyAI CLI returned an invalid ${key}`, 'WHYAI_MALFORMED_OUTPUT')
  }
  return value
}

function requiredBoolean(record: Record<string, unknown>, key: string): boolean {
  if (typeof record[key] !== 'boolean') {
    throw new WhyAiCliError(`WhyAI CLI returned an invalid ${key}`, 'WHYAI_MALFORMED_OUTPUT')
  }
  return record[key]
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new WhyAiCliError(`WhyAI CLI returned an invalid ${key}`, 'WHYAI_MALFORMED_OUTPUT')
  }
  return value
}

function warning(invocation: CliInvocation): string[] {
  return invocation.hadWarning ? ['WhyAI CLI reported a non-fatal warning; details were withheld.'] : []
}

function assertSuccess(invocation: CliInvocation): Record<string, unknown> {
  if (invocation.exitCode !== 0) throw cliFailure(invocation)
  return asRecord(invocation.value, 'result')
}

function renderJson(value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function renderMessage(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const result = value as MessageResult
  const suffix = `\n\n[YAI ${result.status}; conversation_id=${result.conversation_id}]`
  return [{ type: 'text', text: `${result.content}${suffix}` }]
}

const STATUS_OUTPUT = {
  type: 'object', additionalProperties: false,
  required: ['cli_version', 'logged_in', 'warnings'],
  properties: {
    cli_version: { type: 'string' }, logged_in: { type: 'boolean' }, gateway: { type: 'string' }, environment: { type: 'string' },
    access: { type: 'object', additionalProperties: false, required: ['eligible'], properties: {
      eligible: { type: 'boolean' }, available_percent: { type: 'number' }, plan_code: { type: 'string' }, valid_until: { type: 'string' }, reason: { type: 'string' },
    } },
    warnings: { type: 'array', items: { type: 'string' } },
  },
}

const PARTNERS_OUTPUT = {
  type: 'object', additionalProperties: false, required: ['partners', 'truncated', 'warnings'],
  properties: {
    partners: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'name'], properties: {
      id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, tcpr_type: { type: 'string' }, tcpr_label: { type: 'string' },
    } } },
    truncated: { type: 'boolean' }, warnings: { type: 'array', items: { type: 'string' } },
  },
}

const CONVERSATION_OUTPUT = {
  type: 'object', additionalProperties: false, required: ['conversation_id', 'partner_id', 'warnings'],
  properties: {
    conversation_id: { type: 'string' }, partner_id: { type: 'string' }, model_id: { type: 'string' }, status: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
}

const MESSAGE_OUTPUT = {
  type: 'object', additionalProperties: false,
  required: ['status', 'conversation_id', 'content', 'knowledge_base_requested', 'warnings'],
  properties: {
    status: { type: 'string', enum: ['completed', 'partial'] }, conversation_id: { type: 'string' }, content: { type: 'string' },
    message_id: { type: 'string' }, model_id: { type: 'string' }, finish_reason: { type: 'string' }, knowledge_base_requested: { type: 'boolean' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
}

export function createToolDefinitions(runner: WhyAiCliRunner, config: WhyAiConfig, logger: Logger): Tool[] {
  const status: ToolDefinition<StatusArgs, StatusResult> = {
    name: TOOL_NAMES.status,
    description: 'Check the local WhyAI CLI version, login state, and subscription access without exposing credentials.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: STATUS_OUTPUT, render: (_args, value) => renderJson(value) },
    timeoutMs: config.timeoutMs,
    async execute(rawArgs, exec) {
      exactArgs(rawArgs, [], [])
      const version = await runner.version(exec.signal)
      const statusCall = await runner.invoke(['--json', 'status'], undefined, exec.signal)
      const statusValue = assertSuccess(statusCall)
      const loggedIn = requiredBoolean(statusValue, 'logged_in')
      const warnings = warning(statusCall)
      if (!loggedIn) return { cli_version: version, logged_in: false, warnings }
      const accessCall = await runner.invoke(['--json', 'billing', 'access'], undefined, exec.signal)
      const accessValue = assertSuccess(accessCall)
      warnings.push(...warning(accessCall))
      const gateway = optionalString(statusValue, 'gateway')
      const environment = optionalString(statusValue, 'environment')
      const availablePercent = optionalNumber(accessValue, 'available_percent')
      if (availablePercent !== undefined && (availablePercent < 0 || availablePercent > 100)) {
        throw new WhyAiCliError('WhyAI CLI returned available_percent outside 0..100', 'WHYAI_MALFORMED_OUTPUT')
      }
      const planCode = optionalString(accessValue, 'plan_code')
      const validUntil = optionalString(accessValue, 'valid_until')
      const reason = optionalString(accessValue, 'reason')
      return {
        cli_version: version,
        logged_in: true,
        ...(gateway === undefined ? {} : { gateway }),
        ...(environment === undefined ? {} : { environment }),
        access: {
          eligible: requiredBoolean(accessValue, 'eligible'),
          ...(availablePercent === undefined ? {} : { available_percent: availablePercent }),
          ...(planCode === undefined ? {} : { plan_code: planCode }),
          ...(validUntil === undefined ? {} : { valid_until: validUntil }),
          ...(reason === undefined ? {} : { reason }),
        },
        warnings,
      }
    },
  }

  const partners: ToolDefinition<PartnersArgs, PartnersResult> = {
    name: TOOL_NAMES.partners,
    description: 'Find currently available official WhyAI Partners by topic. Returns stable Partner ids for later calls; do not put confidential data in the query.',
    parameters: { type: 'object', additionalProperties: false, required: ['query'], properties: {
      query: { type: 'string', description: 'Short non-confidential topic, such as 五步法 or ROI.' },
      type: { type: 'string', enum: ['T', 'C', 'P', 'R'] },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    } },
    output: { schema: PARTNERS_OUTPUT, render: (_args, value) => renderJson(value) },
    timeoutMs: config.timeoutMs,
    async execute(rawArgs, exec) {
      const args = exactArgs(rawArgs, ['query', 'type', 'limit'], ['query'])
      const query = text(args.query, 'query', 512)
      const type = args.type === undefined ? undefined : text(args.type, 'type', 1)
      if (type !== undefined && !['T', 'C', 'P', 'R'].includes(type)) throw new WhyAiCliError('type must be T, C, P, or R', 'INVALID_ARGS')
      const limit = args.limit === undefined ? config.partnerLimit : args.limit
      if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 50) throw new WhyAiCliError('limit must be an integer from 1 to 50', 'INVALID_ARGS')
      const command = ['--json', 'partners', 'search', query, '--scope', 'official']
      if (type !== undefined) command.push('--type', type)
      const invocation = await runner.invoke(command, undefined, exec.signal)
      if (invocation.hadWarning) logger.warn('[whyai] partner search completed with a CLI warning')
      if (invocation.exitCode !== 0) throw cliFailure(invocation)
      if (!Array.isArray(invocation.value)) throw new WhyAiCliError('WhyAI CLI returned an invalid Partner list', 'WHYAI_MALFORMED_OUTPUT')
      const parsed = invocation.value.map((item): PartnerSummary => {
        const record = asRecord(item, 'Partner')
        return {
          id: uuid(record.id, 'Partner id'),
          name: requiredString(record, 'name', 'Partner name'),
          ...(optionalString(record, 'description') ? { description: optionalString(record, 'description') } : {}),
          ...(optionalString(record, 'tcpr_type') ? { tcpr_type: optionalString(record, 'tcpr_type') } : {}),
          ...(optionalString(record, 'tcpr_label') ? { tcpr_label: optionalString(record, 'tcpr_label') } : {}),
        }
      })
      return { partners: parsed.slice(0, Number(limit)), truncated: parsed.length > Number(limit), warnings: warning(invocation) }
    },
  }

  const create: ToolDefinition<CreateArgs, ConversationResult> = {
    name: TOOL_NAMES.create,
    description: 'Create a WhyAI Partner conversation. This writes to an external service but sends no message; use the returned conversation_id with yai_message_send.',
    parameters: { type: 'object', additionalProperties: false, required: ['partner_id'], properties: {
      partner_id: { type: 'string', description: 'Partner UUID returned by yai_partners.' },
      title: { type: 'string', description: 'Optional non-sensitive conversation title.' },
    } },
    output: { schema: CONVERSATION_OUTPUT, render: (_args, value) => renderJson(value) },
    timeoutMs: config.timeoutMs,
    async execute(rawArgs, exec) {
      const args = exactArgs(rawArgs, ['partner_id', 'title'], ['partner_id'])
      const partnerId = uuid(args.partner_id, 'partner_id')
      const title = args.title === undefined ? undefined : text(args.title, 'title', 1_024)
      const payload = JSON.stringify({ partner_id: partnerId, ...(title === undefined ? {} : { title }) })
      const invocation = await runner.invoke(['--json', 'conversations', 'create', '--data', '-'], payload, exec.signal)
      const value = assertSuccess(invocation)
      const returnedPartnerId = uuid(value.partner_id, 'Partner id')
      if (returnedPartnerId !== partnerId) {
        throw new WhyAiCliError('WhyAI CLI returned a conversation for a different Partner', 'WHYAI_RESPONSE_MISMATCH')
      }
      const modelId = optionalString(value, 'model_id')
      const status = optionalString(value, 'status')
      return {
        conversation_id: uuid(value.id, 'conversation id'),
        partner_id: returnedPartnerId,
        ...(modelId === undefined ? {} : { model_id: modelId }),
        ...(status === undefined ? {} : { status }),
        warnings: warning(invocation),
      }
    },
  }

  const send: ToolDefinition<SendArgs, MessageResult> = {
    name: TOOL_NAMES.send,
    description: 'Send explicit text to an existing WhyAI conversation. This transmits data to an external, potentially billable service. Never send code, files, credentials, or private data unless the user explicitly authorizes that content.',
    parameters: { type: 'object', additionalProperties: false, required: ['conversation_id', 'message'], properties: {
      conversation_id: { type: 'string', description: 'Conversation UUID returned by yai_conversation_create.' },
      message: { type: 'string', description: 'Only the explicit, reviewed text to send to WhyAI.' },
      knowledge_base: { type: 'boolean', description: 'Ask WhyAI to enable its knowledge base for this message.' },
      use_memory: { type: 'boolean', description: 'Allow WhyAI account memory. Defaults to false.' },
    } },
    output: { schema: MESSAGE_OUTPUT, render: renderMessage },
    timeoutMs: config.timeoutMs,
    async execute(rawArgs, exec) {
      const args = exactArgs(rawArgs, ['conversation_id', 'message', 'knowledge_base', 'use_memory'], ['conversation_id', 'message'])
      const conversationId = uuid(args.conversation_id, 'conversation_id')
      const message = text(args.message, 'message', config.promptMaxBytes)
      const knowledgeBase = optionalBoolean(args.knowledge_base, 'knowledge_base') === true
      const useMemory = optionalBoolean(args.use_memory, 'use_memory') === true
      const command = ['--json', 'chat', '-', '--conversation', conversationId]
      if (knowledgeBase) command.push('--knowledge-base')
      if (!useMemory) command.push('--no-memory')
      const invocation = await runner.invoke(command, message, exec.signal)
      if (!isRecord(invocation.value)) {
        if (invocation.exitCode !== 0) throw cliFailure(invocation)
        throw new WhyAiCliError('WhyAI CLI returned an invalid chat result', 'WHYAI_MALFORMED_OUTPUT')
      }
      const value = invocation.value
      const partial = invocation.exitCode !== 0
        && typeof value.conversation_id === 'string'
        && typeof value.content === 'string'
      if (invocation.exitCode !== 0 && !partial) throw cliFailure(invocation)
      if (typeof value.content !== 'string') {
        throw new WhyAiCliError('WhyAI CLI returned chat content with an invalid type', 'WHYAI_MALFORMED_OUTPUT')
      }
      const returnedConversationId = uuid(value.conversation_id, 'conversation id')
      if (returnedConversationId !== conversationId) {
        throw new WhyAiCliError('WhyAI CLI returned a response for a different conversation', 'WHYAI_RESPONSE_MISMATCH')
      }
      const messageId = optionalString(value, 'message_id')
      const modelId = optionalString(value, 'model_id')
      const finishReason = optionalString(value, 'finish_reason')
      return {
        status: partial ? 'partial' : 'completed',
        conversation_id: returnedConversationId,
        content: value.content,
        ...(messageId === undefined ? {} : { message_id: messageId }),
        ...(modelId === undefined ? {} : { model_id: modelId }),
        ...(finishReason === undefined ? {} : { finish_reason: finishReason }),
        knowledge_base_requested: knowledgeBase,
        warnings: [...warning(invocation), ...(partial ? ['WhyAI returned a partial response; remote persistence may be incomplete.'] : [])],
      }
    },
  }

  return [status, partners, create, send] as Tool[]
}
