import z from '@deepseek-ai/schemastery'
import { isAbsolute } from 'node:path'

export const DEFAULT_TIMEOUT_MS = 180_000
export const DEFAULT_GRACE_MS = 2_000
export const DEFAULT_STDOUT_MAX_BYTES = 4 * 1024 * 1024
export const DEFAULT_STDERR_MAX_BYTES = 256 * 1024
export const DEFAULT_PROMPT_MAX_BYTES = 128 * 1024
export const DEFAULT_PARTNER_LIMIT = 10

export interface WhyAiConfig {
  cliPath: string
  timeoutMs: number
  graceMs: number
  stdoutMaxBytes: number
  stderrMaxBytes: number
  promptMaxBytes: number
  partnerLimit: number
  requireApproval: boolean
}

export const Config: z<WhyAiConfig> = z.object({
  cliPath: z.string().default('whyai'),
  timeoutMs: z.number().step(1).min(1).max(1_800_000).default(DEFAULT_TIMEOUT_MS),
  graceMs: z.number().step(1).min(1).max(30_000).default(DEFAULT_GRACE_MS),
  stdoutMaxBytes: z.number().step(1).min(1024).max(16 * 1024 * 1024).default(DEFAULT_STDOUT_MAX_BYTES),
  stderrMaxBytes: z.number().step(1).min(1024).max(1024 * 1024).default(DEFAULT_STDERR_MAX_BYTES),
  promptMaxBytes: z.number().step(1).min(1).max(1024 * 1024).default(DEFAULT_PROMPT_MAX_BYTES),
  partnerLimit: z.number().step(1).min(1).max(50).default(DEFAULT_PARTNER_LIMIT),
  requireApproval: z.boolean().default(false),
})

function integerInRange(value: number, min: number, max: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`whyai ${name} must be an integer from ${min} to ${max}`)
  }
}

export function validateConfig(config: WhyAiConfig): void {
  const path = config.cliPath.trim()
  if (!path) throw new Error('whyai cliPath must not be empty')
  if (path !== config.cliPath) throw new Error('whyai cliPath must not have surrounding whitespace')
  if (!isAbsolute(path) && /[\\/]/u.test(path)) {
    throw new Error('whyai cliPath must be an absolute path or a bare executable name')
  }
  integerInRange(config.timeoutMs, 1, 1_800_000, 'timeoutMs')
  integerInRange(config.graceMs, 1, 30_000, 'graceMs')
  integerInRange(config.stdoutMaxBytes, 1024, 16 * 1024 * 1024, 'stdoutMaxBytes')
  integerInRange(config.stderrMaxBytes, 1024, 1024 * 1024, 'stderrMaxBytes')
  integerInRange(config.promptMaxBytes, 1, 1024 * 1024, 'promptMaxBytes')
  integerInRange(config.partnerLimit, 1, 50, 'partnerLimit')
  if (typeof config.requireApproval !== 'boolean') throw new Error('whyai requireApproval must be boolean')
}
