import { asRecord, cliFailure, WhyAiCliError, type WhyAiCliRunner } from './runner.ts'

export interface AccessData {
  readonly eligible: boolean
  readonly available_percent: number | null
  /** CLI validity timestamp; never inferred as a quota reset time. */
  readonly valid_until: string | null
  readonly subscription_expires_at: string | null
  readonly next_reset_at: string | null
  readonly billing_status: 'ok' | 'unavailable'
}

export type AccessResult =
  | { readonly status: 'ok'; readonly data: AccessData }
  | { readonly status: 'error'; readonly code: string }

const PUBLIC_CODES = new Set([
  'WHYAI_NOT_LOGGED_IN', 'WHYAI_QUOTA_EXHAUSTED', 'WHYAI_ACCOUNT_DISABLED',
  'WHYAI_PAID_PLAN_REQUIRED', 'WHYAI_COMMAND_FAILED', 'WHYAI_PROCESS_FAILED',
  'WHYAI_EXECUTABLE_NOT_FOUND', 'WHYAI_MALFORMED_OUTPUT', 'WHYAI_OUTPUT_OVERFLOW',
  'WHYAI_TIMEOUT', 'WHYAI_CANCELLED', 'WHYAI_DISPOSED', 'WHYAI_BUSY',
])

function timestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || value.length > 128
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new WhyAiCliError('Invalid billing timestamp', 'WHYAI_MALFORMED_OUTPUT')
  }
  return value
}

function project(value: unknown): Pick<AccessData, 'eligible' | 'available_percent' | 'valid_until'> {
  const data = asRecord(value, 'billing access')
  const percent = data.available_percent ?? null
  if (typeof data.eligible !== 'boolean'
    || (percent !== null && (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100))) {
    throw new WhyAiCliError('Invalid billing access fields', 'WHYAI_MALFORMED_OUTPUT')
  }
  return { eligible: data.eligible, available_percent: percent, valid_until: timestamp(data.valid_until) }
}

function projectSummary(value: unknown): Pick<AccessData, 'subscription_expires_at' | 'next_reset_at' | 'billing_status'> {
  const data = asRecord(value, 'billing summary')
  if (data.plan_source !== undefined && data.plan_source !== null
    && (typeof data.plan_source !== 'string' || data.plan_source.length > 128)) {
    throw new WhyAiCliError('Invalid billing plan source', 'WHYAI_MALFORMED_OUTPUT')
  }
  return {
    subscription_expires_at: data.plan_source === 'subscription' ? timestamp(data.plan_expires_at) : null,
    next_reset_at: timestamp(data.next_reset_at),
    billing_status: 'ok',
  }
}

/** One route mount owns its cache, deadline and coalesced CLI invocation. */
export class WhyAiAccess {
  private disposed = false
  private generation = 0
  private cache?: { result: AccessResult; expires: number }
  private flight?: { promise: Promise<AccessResult>; cancel: () => void }

  constructor(
    private readonly runner: Pick<WhyAiCliRunner, 'invoke'>,
    private readonly managementBusy: () => boolean = () => false,
    private readonly timeoutMs = 30_000,
  ) {}

  invalidate(): void {
    this.cache = undefined
    this.generation++
    this.flight?.cancel()
  }

  get(forceFresh = false): Promise<AccessResult> {
    if (this.disposed) return Promise.resolve({ status: 'error', code: 'WHYAI_DISPOSED' })
    if (this.managementBusy()) return Promise.resolve({ status: 'error', code: 'WHYAI_BUSY' })
    if (forceFresh) this.cache = undefined
    if (this.cache && Date.now() < this.cache.expires) return Promise.resolve(this.cache.result)
    if (this.flight) return this.flight.promise
    const currentGeneration = this.generation
    const controller = new AbortController()
    let settle!: (result: AccessResult) => void
    const promise = new Promise<AccessResult>((resolve) => { settle = resolve })
    let finished = false
    let cancellation: 'WHYAI_TIMEOUT' | 'WHYAI_DISPOSED' | undefined
    const finish = (result: AccessResult): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (cancellation) result = { status: 'error', code: cancellation }
      if (this.generation !== currentGeneration) result = { status: 'error', code: 'WHYAI_CANCELLED' }
      if (this.generation === currentGeneration && !this.disposed && !this.managementBusy()) {
        this.cache = { result: Object.freeze(result), expires: Date.now() + 30_000 }
      }
      if (this.flight?.promise === promise) this.flight = undefined
      settle(result)
    }
    const timer = setTimeout(() => {
      cancellation = 'WHYAI_TIMEOUT'
      controller.abort()
    }, this.timeoutMs)
    this.flight = { promise, cancel: () => {
      cancellation = 'WHYAI_DISPOSED'
      clearTimeout(timer)
      controller.abort()
    } }
    // The deadline starts before invoke, so time in the shared runner queue counts.
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return undefined
      return this.runner.invoke(['--json', 'billing', 'access'], undefined, controller.signal)
    }).then(async (invocation) => {
      if (cancellation || !invocation) {
        finish({ status: 'error', code: cancellation ?? 'WHYAI_CANCELLED' })
        return
      }
      if (invocation.exitCode !== 0) throw cliFailure(invocation)
      const access = project(invocation.value)
      let billing: Pick<AccessData, 'subscription_expires_at' | 'next_reset_at' | 'billing_status'>
      try {
        const summary = await this.runner.invoke(['--json', 'billing', 'summary'], undefined, controller.signal)
        if (summary.exitCode !== 0) throw cliFailure(summary)
        billing = projectSummary(summary.value)
      } catch (error: unknown) {
        // Only this access operation's deadline or disposal invalidates the
        // already-validated access result. A summary-local timeout or
        // cancellation is an unavailable billing detail, like any other
        // summary failure.
        if (cancellation) throw error
        billing = { subscription_expires_at: null, next_reset_at: null, billing_status: 'unavailable' }
      }
      finish({ status: 'ok', data: Object.freeze({ ...access, ...billing }) })
    }).catch((error: unknown) => {
      const code = error instanceof WhyAiCliError && PUBLIC_CODES.has(error.code)
        ? error.code : 'WHYAI_COMMAND_FAILED'
      finish({ status: 'error', code })
    })
    return promise
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.cache = undefined
    const flight = this.flight
    flight?.cancel()
    await flight?.promise
  }
}
