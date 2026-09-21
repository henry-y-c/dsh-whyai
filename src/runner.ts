import type { SubprocessHandle, SubprocessRuntime } from './dsh-types.ts'
import type { WhyAiConfig } from './config.ts'

export interface CliErrorInfo {
  message: string
  status?: number
  code?: string | number
}

export interface CliInvocation {
  exitCode: number
  value?: unknown
  error?: CliErrorInfo
  hadWarning: boolean
}

interface RawInvocation {
  exitCode: number
  stdout: string
  stderr: string
}

interface Waiter {
  readonly signal: AbortSignal
  readonly resolve: (release: () => void) => void
  readonly reject: (error: WhyAiCliError) => void
  readonly abort: () => void
}

export class WhyAiCliError extends Error {
  readonly code: string
  readonly status?: number

  constructor(message: string, code: string, status?: number) {
    super(message)
    this.name = 'WhyAiCliError'
    this.code = code
    this.status = status
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new WhyAiCliError(`WhyAI CLI returned malformed ${label} JSON`, 'WHYAI_MALFORMED_OUTPUT')
  }
}

function classifyExternalError(raw: string, status: number | undefined, rawCode: unknown): { message: string; code: string } {
  const code = typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode).toUpperCase() : ''
  if (/not logged in/iu.test(raw)) return { message: 'WhyAI CLI is not logged in; run whyai login.', code: 'WHYAI_NOT_LOGGED_IN' }
  if (/quota.+exhausted/iu.test(raw) || code.includes('QUOTA')) return { message: 'WhyAI CLI quota is exhausted.', code: 'WHYAI_QUOTA_EXHAUSTED' }
  if (/account.+disabled/iu.test(raw)) return { message: 'The WhyAI account is disabled.', code: 'WHYAI_ACCOUNT_DISABLED' }
  if (/active paid plan/iu.test(raw)) return { message: 'WhyAI CLI requires an active paid plan.', code: 'WHYAI_PAID_PLAN_REQUIRED' }
  if (/partner not found/iu.test(raw)) return { message: 'The requested WhyAI Partner was not found.', code: 'WHYAI_PARTNER_NOT_FOUND' }
  if (status === 404 || code === 'NOT_FOUND') return { message: 'The requested WhyAI resource was not found.', code: 'WHYAI_NOT_FOUND' }
  if (code.includes('PERSIST')) return { message: 'WhyAI could not persist the response.', code: 'WHYAI_PERSIST_FAILED' }
  return { message: 'WhyAI CLI command failed.', code: 'WHYAI_COMMAND_FAILED' }
}

function parseError(value: unknown): CliErrorInfo | undefined {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.message !== 'string') return undefined
  const rawStatus = value.error.status
  const status = typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
    ? rawStatus
    : undefined
  const classified = classifyExternalError(value.error.message, status, value.error.code)
  return { ...classified, ...(status === undefined ? {} : { status }) }
}

function readComplete(
  reader: { readFrom(offset: number): { text: string; lossy: boolean } } | undefined,
  label: string,
): string {
  if (!reader) throw new WhyAiCliError(`WhyAI CLI produced no collected ${label}`, 'WHYAI_PROCESS_FAILED')
  let output
  try {
    output = reader.readFrom(0)
  } catch {
    throw new WhyAiCliError(`WhyAI CLI ${label} could not be read`, 'WHYAI_PROCESS_FAILED')
  }
  if (output.lossy) throw new WhyAiCliError(`WhyAI CLI ${label} exceeded its configured byte limit`, 'WHYAI_OUTPUT_OVERFLOW')
  return output.text
}

const DISPOSED = Symbol('WhyAI plugin disposed')

function abortError(signal: AbortSignal, timeout?: AbortSignal): WhyAiCliError {
  if (signal.aborted && signal.reason === DISPOSED) return new WhyAiCliError('WhyAI plugin was disposed', 'WHYAI_DISPOSED')
  if (timeout?.aborted && !signal.aborted) return new WhyAiCliError('WhyAI CLI timed out', 'WHYAI_TIMEOUT')
  return new WhyAiCliError('WhyAI CLI was cancelled', 'WHYAI_CANCELLED')
}

/** Bound even providers that ignore cancellation; consume their late settlement. */
function untilAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener('abort', abort); reject(new Error('operation aborted')) }
    pending.then((value) => {
      signal.removeEventListener('abort', abort)
      resolve(value)
    }, () => {
      signal.removeEventListener('abort', abort)
      reject(new Error('subprocess provider failed'))
    })
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

async function waitForQuiescence(handle: SubprocessHandle, timeoutMs: number): Promise<boolean> {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), timeoutMs)
  try {
    return await untilAbort(handle.waitForExit(deadline.signal), deadline.signal)
  } finally {
    clearTimeout(timer)
  }
}

export class WhyAiCliRunner {
  private readonly lifetime = new AbortController()
  private readonly waiters: Waiter[] = []
  private readonly inFlight = new Set<Promise<void>>()
  private readonly activeHandles = new Set<SubprocessHandle>()
  private busy = false
  // A failed cleanup must never permit another process to overlap an orphan.
  private poisoned = false

  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly config: WhyAiConfig,
    private readonly cwd = process.cwd(),
  ) {}

  async invoke(args: readonly string[], stdin: string | undefined, signal: AbortSignal): Promise<CliInvocation> {
    return this.serialized(signal, async (operationSignal) => {
      const raw = await this.run(args, stdin, operationSignal)
      const stdoutValue = raw.stdout ? parseJson(raw.stdout, 'stdout') : undefined
      const stderrValue = raw.exitCode !== 0 && raw.stderr
        ? parseJson(raw.stderr.split(/\n/u).at(-1) ?? '', 'stderr')
        : undefined
      const error = parseError(stderrValue)
      if (raw.exitCode === 0 && stdoutValue === undefined) {
        throw new WhyAiCliError('WhyAI CLI returned no JSON result', 'WHYAI_MALFORMED_OUTPUT')
      }
      if (raw.exitCode !== 0 && error === undefined) {
        throw new WhyAiCliError(`WhyAI CLI failed with exit code ${raw.exitCode}`, 'WHYAI_PROCESS_FAILED')
      }
      return {
        exitCode: raw.exitCode,
        ...(stdoutValue === undefined ? {} : { value: stdoutValue }),
        ...(error === undefined ? {} : { error }),
        hadWarning: raw.exitCode === 0 && raw.stderr.length > 0,
      }
    })
  }

  async version(signal: AbortSignal): Promise<string> {
    return this.serialized(signal, async (operationSignal) => {
      const raw = await this.run(['--version'], undefined, operationSignal)
      if (raw.exitCode !== 0) throw new WhyAiCliError('WhyAI CLI version check failed', 'WHYAI_COMMAND_FAILED')
      const version = raw.stdout.trim()
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
        throw new WhyAiCliError('WhyAI CLI returned an invalid version', 'WHYAI_MALFORMED_OUTPUT')
      }
      return version
    })
  }

  async dispose(): Promise<void> {
    if (!this.lifetime.signal.aborted) this.lifetime.abort(DISPOSED)
    await Promise.allSettled([...this.inFlight])
    const cleanupErrors: unknown[] = []
    for (const handle of [...this.activeHandles]) {
      try {
        await this.stop(handle)
      } catch (error: unknown) {
        cleanupErrors.push(error)
      }
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'WhyAI CLI process cleanup failed')
  }

  private async serialized<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const operationSignal = AbortSignal.any([signal, this.lifetime.signal])
    const task = (async (): Promise<T> => {
      const release = await this.acquire(operationSignal)
      try {
        return await operation(operationSignal)
      } finally {
        release()
      }
    })()
    const tracked = task.then(() => undefined, () => undefined)
    this.inFlight.add(tracked)
    try {
      return await task
    } finally {
      this.inFlight.delete(tracked)
    }
  }

  private async stop(handle: SubprocessHandle): Promise<void> {
    try {
      handle.terminate()
      // TERM grace, forceful termination, then one observation grace.
      if (!await waitForQuiescence(handle, this.config.graceMs * 3)) throw new Error('not quiet')
      this.activeHandles.delete(handle)
    } catch {
      this.poisoned = true
      // Keep ownership of the handle so dispose can retry; never resume spawning.
      throw new WhyAiCliError('WhyAI CLI process range could not be stopped within its shutdown deadline', 'WHYAI_PROCESS_FAILED')
    }
  }

  private acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(abortError(signal))
    if (this.poisoned) return Promise.reject(new WhyAiCliError('WhyAI CLI runner is unavailable after a process cleanup failure', 'WHYAI_PROCESS_FAILED'))
    if (!this.busy) {
      this.busy = true
      return Promise.resolve(this.releaseFactory())
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(abortError(signal))
        },
      }
      signal.addEventListener('abort', waiter.abort, { once: true })
      this.waiters.push(waiter)
    })
  }

  private releaseFactory(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      if (this.poisoned) {
        for (const waiter of this.waiters.splice(0)) {
          waiter.signal.removeEventListener('abort', waiter.abort)
          waiter.reject(new WhyAiCliError('WhyAI CLI runner is unavailable after a process cleanup failure', 'WHYAI_PROCESS_FAILED'))
        }
        this.busy = false
        return
      }
      const waiter = this.waiters.shift()
      if (!waiter) {
        this.busy = false
        return
      }
      waiter.signal.removeEventListener('abort', waiter.abort)
      waiter.resolve(this.releaseFactory())
    }
  }

  private async run(args: readonly string[], stdin: string | undefined, signal: AbortSignal): Promise<RawInvocation> {
    if (signal.aborted) throw abortError(signal)
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), this.config.timeoutMs)
    try {
      return await this.runWithDeadline(args, stdin, signal, timeout.signal)
    } finally {
      clearTimeout(timer)
    }
  }

  private async runWithDeadline(args: readonly string[], stdin: string | undefined, signal: AbortSignal, timeout: AbortSignal): Promise<RawInvocation> {
    const operationSignal = AbortSignal.any([signal, timeout])
    let executable: string
    try {
      executable = await untilAbort(this.subprocess.resolveExecutable(this.config.cliPath, undefined, operationSignal), operationSignal)
    } catch {
      if (operationSignal.aborted) throw abortError(signal, timeout)
      throw new WhyAiCliError('WhyAI CLI executable could not be resolved', 'WHYAI_EXECUTABLE_NOT_FOUND')
    }
    // A resolver may settle concurrently with cancellation. Never spawn late work.
    if (operationSignal.aborted) throw abortError(signal, timeout)
    let handle
    try {
      handle = this.subprocess.spawn({
        argv: [executable, ...args],
        cwd: this.cwd,
        stdio: {
          stdin: stdin === undefined ? 'ignore' : { data: stdin },
          stdout: { maxBytes: this.config.stdoutMaxBytes },
          stderr: { maxBytes: this.config.stderrMaxBytes },
        },
        graceMs: this.config.graceMs,
        signal: operationSignal,
      })
    } catch {
      if (operationSignal.aborted) throw abortError(signal, timeout)
      throw new WhyAiCliError('WhyAI CLI could not start', 'WHYAI_PROCESS_FAILED')
    }
    this.activeHandles.add(handle)

    let outcome
    try {
      outcome = await untilAbort(handle.done, operationSignal)
    } catch {
      await this.stop(handle)
      if (operationSignal.aborted) throw abortError(signal, timeout)
      throw new WhyAiCliError('WhyAI CLI process failed', 'WHYAI_PROCESS_FAILED')
    }

    let quiet = false
    try {
      quiet = await waitForQuiescence(handle, this.config.graceMs)
    } catch {
      await this.stop(handle)
      if (operationSignal.aborted) throw abortError(signal, timeout)
      throw new WhyAiCliError('WhyAI CLI process range could not be observed within its shutdown grace', 'WHYAI_PROCESS_FAILED')
    }
    if (!quiet) {
      await this.stop(handle)
      if (operationSignal.aborted) throw abortError(signal, timeout)
      throw new WhyAiCliError('WhyAI CLI process range exceeded its shutdown grace', 'WHYAI_PROCESS_FAILED')
    }
    this.activeHandles.delete(handle)
    if (operationSignal.aborted) throw abortError(signal, timeout)

    const stdout = readComplete(handle.collected.stdout, 'stdout').trim()
    const stderr = readComplete(handle.collected.stderr, 'stderr').trim()
    if (outcome.signal !== null || outcome.exitCode === null) {
      throw new WhyAiCliError(`WhyAI CLI was terminated by ${outcome.signal ?? 'an unknown signal'}`, 'WHYAI_PROCESS_FAILED')
    }
    return { exitCode: outcome.exitCode, stdout, stderr }
  }
}

export function cliFailure(invocation: CliInvocation): WhyAiCliError {
  const info = invocation.error
  return new WhyAiCliError(
    info?.message ?? `WhyAI CLI failed with exit code ${invocation.exitCode}`,
    info?.code === undefined ? 'WHYAI_COMMAND_FAILED' : String(info.code),
    info?.status,
  )
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new WhyAiCliError(`WhyAI CLI returned an invalid ${label}`, 'WHYAI_MALFORMED_OUTPUT')
  return value
}
