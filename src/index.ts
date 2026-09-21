import type { PluginContext } from './dsh-types.ts'
import { Config, validateConfig, type WhyAiConfig } from './config.ts'
import { WhyAiCliRunner } from './runner.ts'
import { installAccessRoute } from './routes.ts'
import { createToolDefinitions, TOOL_NAMES } from './tools.ts'

export { Config } from './config.ts'
export type { WhyAiConfig } from './config.ts'
export { WhyAiCliError, WhyAiCliRunner } from './runner.ts'
export { createToolDefinitions, TOOL_NAMES } from './tools.ts'
export type { ConversationResult, MessageResult, PartnerSummary, PartnersResult, StatusResult } from './tools.ts'

export const name = 'whyai'
export const inject = ['tools', 'subprocess']

const MUTATING_TOOLS = new Set<string>([TOOL_NAMES.create, TOOL_NAMES.send])

export function apply(ctx: PluginContext, config: WhyAiConfig): void {
  validateConfig(config)
  const runner = new WhyAiCliRunner(ctx.subprocess, config)
  for (const tool of createToolDefinitions(runner, config, ctx.logger)) ctx.tools.register(tool)
  ctx.inject(['webServer', 'connection'], (webCtx) => installAccessRoute(webCtx, runner))

  if (config.requireApproval) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      const prior = await next()
      if (prior.kind !== 'allow' || !MUTATING_TOOLS.has(exec.name)) return prior
      return {
        kind: 'ask',
        reason: exec.name === TOOL_NAMES.send
          ? 'This sends explicit text to the external WhyAI service and may consume paid quota.'
          : 'This creates a conversation on the external WhyAI service.',
      }
    })
  }

  ctx.effect(() => async () => {
    await runner.dispose()
  }, 'whyai: stop CLI calls')
}
