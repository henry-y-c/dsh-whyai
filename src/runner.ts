import { homedir } from 'node:os'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
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

export interface RawInvocation {
  exitCode: number
  stdout: string
  stderr: string
}

export interface RunnerLease {
  readonly signal: AbortSignal
  invoke(args: readonly string[], stdin?: string): Promise<CliInvocation>
  invokeRaw(args: readonly string[], stdin?: string, timeoutMs?: number): Promise<RawInvocation>
  version(executable?: string): Promise<string>
  execute(argv: readonly string[], cwd: string): Promise<RawInvocation>
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
const TIMED_OUT = Symbol('WhyAI deadline expired')
const busyError = (): WhyAiCliError => new WhyAiCliError('WhyAI CLI is busy', 'WHYAI_BUSY')

function deadlineMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_800_000) {
    throw new WhyAiCliError('Invalid WhyAI operation deadline', 'WHYAI_INVALID_ARGUMENT')
  }
  return value
}

async function launcherText(path: string): Promise<string> {
  const file = await open(path, 'r')
  try {
    if (!(await file.stat()).isFile()) throw new Error('not a file')
    const buffer = Buffer.alloc(8193)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 8192) throw new Error('oversized launcher')
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally { await file.close() }
}

/** Never ask a shell to interpret a Windows launcher or user arguments. */
async function launchArgv(argv: readonly string[], signal: AbortSignal): Promise<readonly string[]> {
  const executable = argv[0]
  if (!executable) throw new WhyAiCliError('Missing executable', 'WHYAI_EXECUTABLE_NOT_FOUND')
  if (!/\.(?:cmd|bat)$/iu.test(executable)) return argv
  try {
    if (!/whyai\.cmd$/iu.test(executable)) throw new Error('unsupported launcher')
    const sibling = executable.slice(0, -4)
    const [cmd, js] = await untilAbort(Promise.all([launcherText(executable), launcherText(sibling)]), signal)
    const escaped = sibling.replace(/%/gu, '%%')
    const lines = cmd.replace(/\r\n/gu, '\n').trimEnd().split('\n')
    if (lines.length !== 3 || lines[0] !== '@echo off' || lines[1] !== '@rem YAI CLI managed launcher'
      || !lines[2]?.startsWith('"') || !/^"[^"\r\n]+" /u.test(lines[2])
      || lines[2].replace(/^"[^"\r\n]+" /u, '') !== `"${escaped}" %*`
      || !js.startsWith('#!/usr/bin/env node\n// YAI CLI managed launcher\n')) throw new Error('unsupported launcher')
    return [process.execPath, sibling, ...argv.slice(1)]
  } catch {
    throw new WhyAiCliError('WhyAI Windows launcher is not supported', 'WHYAI_EXECUTABLE_NOT_FOUND')
  }
}

export function getStandardCliFallback(): string | undefined {
  const home = homedir()
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    return join(localAppData, 'WhyAI', 'bin', 'whyai.cmd')
  }
  return join(home, '.local', 'bin', 'whyai')
}

function abortError(signal: AbortSignal, timeout?: AbortSignal): WhyAiCliError {
  if (signal.aborted && signal.reason === DISPOSED) return new WhyAiCliError('WhyAI plugin was disposed', 'WHYAI_DISPOSED')
  if (signal.reason === TIMED_OUT || (timeout?.aborted && !signal.aborted)) return new WhyAiCliError('WhyAI CLI timed out', 'WHYAI_TIMEOUT')
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
  private readonly abandonedTasks = new Set<Promise<unknown>>()
  private busy = false
  private management = false

  get isBusy(): boolean { return this.busy || this.poisoned }
  get managementBusy(): boolean { return this.management }
  get isQuiescent(): boolean { return this.activeHandles.size === 0 && this.abandonedTasks.size === 0 }
  // A failed cleanup must never permit another process to overlap an orphan.
  private poisoned = false

  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly config: WhyAiConfig,
    private readonly cwd = process.cwd(),
  ) {}

  async invoke(args: readonly string[], stdin: string | undefined, signal: AbortSignal): Promise<CliInvocation> {
    return this.serialized(signal, (operationSignal) => this.invokeOwned(args, stdin, operationSignal))
  }

  private async invokeOwned(args: readonly string[], stdin: string | undefined, signal: AbortSignal): Promise<CliInvocation> {
      const raw = await this.run(args, stdin, signal)
      const stdoutValue = raw.stdout ? parseJson(raw.stdout, 'stdout') : undefined
      // Only status documents exit 1 as a successful logged-out observation.
      if (raw.exitCode === 1 && raw.stderr === '' && args.length === 2
        && args[0] === '--json' && args[1] === 'status'
        && isRecord(stdoutValue) && stdoutValue.logged_in === false && !('error' in stdoutValue)) {
        return { exitCode: 0, value: stdoutValue, hadWarning: false }
      }
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
  }

  async version(signal: AbortSignal): Promise<string> {
    return this.serialized(signal, (operationSignal) => this.versionOwned(operationSignal))
  }

  private async versionOwned(signal: AbortSignal, executable?: string): Promise<string> {
      const raw = await this.run(['--version'], undefined, signal, this.config.timeoutMs, executable === undefined ? undefined : [executable, '--version'])
      if (raw.exitCode !== 0) throw new WhyAiCliError('WhyAI CLI version check failed', 'WHYAI_COMMAND_FAILED')
      const version = raw.stdout.trim()
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
        throw new WhyAiCliError('WhyAI CLI returned an invalid version', 'WHYAI_MALFORMED_OUTPUT')
      }
      return version
  }

  async resolveExecutable(signal?: AbortSignal): Promise<string> {
    const deadline = new AbortController()
    const opSignal = AbortSignal.any([signal ?? this.lifetime.signal, this.lifetime.signal, deadline.signal])
    const timer = setTimeout(() => deadline.abort(TIMED_OUT), this.config.timeoutMs)
    try {
      if (opSignal.aborted) throw abortError(opSignal)
      try {
        return await untilAbort(this.subprocess.resolveExecutable(this.config.cliPath, undefined, opSignal), opSignal)
      } catch {
        if (opSignal.aborted) throw abortError(opSignal)
        if (this.config.cliPath === 'whyai') {
          const fallback = getStandardCliFallback()
          if (fallback) {
            try {
              return await untilAbort(this.subprocess.resolveExecutable(fallback, undefined, opSignal), opSignal)
            } catch {
              if (opSignal.aborted) throw abortError(opSignal)
              // Fallback lookup also failed; publish only the redacted error.
            }
          }
        }
        throw new WhyAiCliError('WhyAI CLI executable could not be resolved', 'WHYAI_EXECUTABLE_NOT_FOUND')
      }
    } finally { clearTimeout(timer) }
  }

  async invokeRaw(
    args: readonly string[],
    stdin: string | undefined,
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<RawInvocation> {
    return this.serialized(signal, (operationSignal) => this.run(args, stdin, operationSignal, timeoutMs))
  }

  async runTask<T>(signal: AbortSignal, task: (lease: RunnerLease) => Promise<T>, timeoutMs = 180_000): Promise<T> {
    const duration = deadlineMs(timeoutMs)
    const controller = new AbortController()
    const operationSignal = AbortSignal.any([signal, this.lifetime.signal, controller.signal])
    if (operationSignal.aborted) throw abortError(operationSignal)
    if (this.isBusy) throw busyError()
    // Admission is synchronous: management never queues behind a consultation.
    this.busy = true
    this.management = true
    const release = this.releaseFactory()
    const timer = setTimeout(() => controller.abort(TIMED_OUT), duration)
    let closed = false
    let pending: Promise<unknown> | undefined
    const owned = <R>(operation: () => Promise<R>): Promise<R> => {
      if (closed || operationSignal.aborted) return Promise.reject(abortError(operationSignal))
      if (this.poisoned) return Promise.reject(new WhyAiCliError('WhyAI CLI runner is unavailable after a process cleanup failure', 'WHYAI_PROCESS_FAILED'))
      if (pending) return Promise.reject(busyError())
      const result = operation()
      pending = result
      void result.then(() => { if (pending === result) pending = undefined }, () => { if (pending === result) pending = undefined })
      return result
    }
    const lease: RunnerLease = {
      signal: operationSignal,
      invoke: (args, stdin) => owned(() => this.invokeOwned(args, stdin, operationSignal)),
      invokeRaw: (args, stdin, timeout) => owned(() => this.run(args, stdin, operationSignal, timeout)),
      version: (executable) => owned(() => this.versionOwned(operationSignal, executable)),
      execute: (argv, cwd) => owned(() => this.run([], undefined, operationSignal, duration, argv, cwd)),
    }
    const callback = Promise.resolve().then(() => task(lease)).then(
      value => ({ value }), error => ({ error }),
    )
    const work = (async () => {
      try {
        // Preserve task errors; cancellation races only the callback, never cleanup.
        const result = await untilAbort(callback, operationSignal)
        if (operationSignal.aborted) throw abortError(operationSignal)
        if ('error' in result) throw result.error
        return result.value
      } catch (error) {
        if (operationSignal.aborted) throw abortError(operationSignal)
        throw error
      } finally {
        closed = true
        controller.abort()
        // Also own calls a callback started but neglected to await.
        if (pending) await pending.catch(() => undefined)
        try {
          await this.settleCallback(callback)
        } catch {
          this.poisoned = true
          this.abandonedTasks.add(callback)
          void callback.then(() => this.abandonedTasks.delete(callback))
        }
        clearTimeout(timer)
        this.management = false
        release()
        if (this.poisoned) throw new WhyAiCliError('WhyAI CLI process cleanup failed', 'WHYAI_PROCESS_FAILED')
      }
    })()
    const tracked = work.then(() => undefined, () => undefined)
    this.inFlight.add(tracked)
    try { return await work } finally { this.inFlight.delete(tracked) }
  }

  private async settleCallback(callback: Promise<unknown>): Promise<void> {
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), this.config.graceMs * 3)
    try { await untilAbort(callback, deadline.signal) } finally { clearTimeout(timer) }
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
    for (const callback of [...this.abandonedTasks]) {
      try { await this.settleCallback(callback) } catch {
        cleanupErrors.push(new WhyAiCliError('WhyAI task did not settle within its shutdown deadline', 'WHYAI_PROCESS_FAILED'))
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
    if (this.management) return Promise.reject(busyError())
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

  private async run(args: readonly string[], stdin: string | undefined, signal: AbortSignal, timeoutMs = this.config.timeoutMs, argv?: readonly string[], cwd = this.cwd): Promise<RawInvocation> {
    if (signal.aborted) throw abortError(signal)
    if (stdin !== undefined && Buffer.byteLength(stdin, 'utf8') > this.config.promptMaxBytes) {
      throw new WhyAiCliError('WhyAI stdin exceeds its byte limit', 'WHYAI_INPUT_OVERFLOW')
    }
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), deadlineMs(timeoutMs))
    try {
      return await this.runWithDeadline(args, stdin, signal, timeout.signal, argv, cwd)
    } finally {
      clearTimeout(timer)
    }
  }

  private async runWithDeadline(args: readonly string[], stdin: string | undefined, signal: AbortSignal, timeout: AbortSignal, fixedArgv?: readonly string[], cwd = this.cwd): Promise<RawInvocation> {
    const operationSignal = AbortSignal.any([signal, timeout])
    let argv: readonly string[]
    try {
      argv = await launchArgv(fixedArgv ?? [await this.resolveExecutable(operationSignal), ...args], operationSignal)
    } catch {
      if (operationSignal.aborted) throw abortError(signal, timeout)
      throw new WhyAiCliError('WhyAI CLI executable could not be resolved', 'WHYAI_EXECUTABLE_NOT_FOUND')
    }
    // A resolver may settle concurrently with cancellation. Never spawn late work.
    if (operationSignal.aborted) throw abortError(signal, timeout)
    let handle
    try {
      handle = this.subprocess.spawn({
        argv,
        cwd,
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
