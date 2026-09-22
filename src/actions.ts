import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessRuntime } from './dsh-types.ts'
import type { WhyAiConfig } from './config.ts'
import { asRecord, getStandardCliFallback, WhyAiCliError, type WhyAiCliRunner } from './runner.ts'

export type ActionKind = 'install' | 'login' | 'logout'
export interface Operation {
  readonly id: string
  readonly kind: ActionKind
  readonly phase: 'running' | 'succeeded' | 'failed' | 'cancelled'
  readonly code?: string
  readonly version?: string
}
export type ActionResult = { readonly operation: Operation } | { readonly status: 'error'; readonly code: string }
const CODES = new Set(['WHYAI_BUSY', 'WHYAI_DISPOSED', 'WHYAI_CANCELLED', 'WHYAI_TIMEOUT',
  'WHYAI_COMMAND_FAILED', 'WHYAI_PROCESS_FAILED', 'WHYAI_EXECUTABLE_NOT_FOUND',
  'WHYAI_MALFORMED_OUTPUT', 'WHYAI_OUTPUT_OVERFLOW', 'WHYAI_INSTALL_CUSTOM_PATH_UNSUPPORTED',
  'WHYAI_INSTALL_DOWNLOAD_FAILED', 'WHYAI_INSTALL_TOO_LARGE', 'WHYAI_INSTALL_VERIFY_FAILED'])
function failure(code: string): never { throw new WhyAiCliError('WhyAI operation failed', code) }
export function actionErrorCode(error: unknown): string {
  return error instanceof WhyAiCliError && CODES.has(error.code) ? error.code : 'WHYAI_COMMAND_FAILED'
}

/** Bounds third-party network promises even when cancellation is ignored. */
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener('abort', abort); reject(new WhyAiCliError('Cancelled', 'WHYAI_CANCELLED')) }
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, () => {
      signal.removeEventListener('abort', abort)
      reject(new WhyAiCliError('Download failed', 'WHYAI_INSTALL_DOWNLOAD_FAILED'))
    })
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

/** HTTPS transport trust only: the official installer is executable unsigned code. */
export async function downloadInstaller(signal: AbortSignal): Promise<Uint8Array> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  const combined = AbortSignal.any([signal, controller.signal])
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const pending = fetch('https://ai.yitang.top/cli/install.mjs', {
      redirect: 'error', signal: combined, headers: { 'User-Agent': 'dsh-whyai-installer' },
    })
    // A noncooperating fetch may produce a body after its owner has gone away.
    void pending.then(response => { if (combined.aborted) void response.body?.cancel().catch(() => {}) }, () => {})
    const response = await bounded(pending, combined)
    if (response.body) reader = response.body.getReader()
    if (!response.ok || !reader) failure('WHYAI_INSTALL_DOWNLOAD_FAILED')
    const length = response.headers.get('content-length')
    if (length && (!/^\d+$/u.test(length) || Number(length) > 1024 * 1024)) failure('WHYAI_INSTALL_TOO_LARGE')
    const chunks: Uint8Array[] = []
    let bytes = 0
    while (true) {
      const item = await bounded(reader.read(), combined)
      if (item.done) break
      bytes += item.value.byteLength
      if (bytes > 1024 * 1024) failure('WHYAI_INSTALL_TOO_LARGE')
      chunks.push(item.value)
    }
    if (!bytes) failure('WHYAI_INSTALL_DOWNLOAD_FAILED')
    return Buffer.concat(chunks, bytes)
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted) failure('WHYAI_TIMEOUT')
    throw error
  } finally {
    clearTimeout(timer)
    controller.abort()
    // Do not await an uncooperative stream's cancellation.
    if (reader) {
      const owned = reader
      void owned.cancel().catch(() => {}).finally(() => { try { owned.releaseLock() } catch { /* A stalled read retains the reader until it settles. */ } })
    }
  }
}

/** One mount owns admission, operation identity, cancellation and terminal publication. */
export class WhyAiActions {
  private operation: Operation | null = null
  private controller?: AbortController
  private pending?: Promise<void>
  private disposed = false
  private readonly retainedTemps = new Set<string>()

  constructor(
    _subprocess: SubprocessRuntime,
    private readonly config: WhyAiConfig,
    private readonly runner: WhyAiCliRunner,
    private readonly onStateChanged?: () => void,
  ) {}

  get current(): Operation | null { return this.operation }
  get busy(): boolean { return this.operation?.phase === 'running' }

  start(kind: ActionKind): ActionResult {
    if (this.disposed) return { status: 'error', code: 'WHYAI_DISPOSED' }
    if (this.busy || this.runner.isBusy) return { status: 'error', code: 'WHYAI_BUSY' }
    if (kind === 'install' && this.config.cliPath !== 'whyai') {
      return { status: 'error', code: 'WHYAI_INSTALL_CUSTOM_PATH_UNSUPPORTED' }
    }
    const controller = new AbortController()
    this.controller = controller
    const operation: Operation = Object.freeze({ id: randomUUID(), kind, phase: 'running' })
    this.operation = operation
    // Reserve the runner synchronously before publishing cache invalidation.
    const task = this.runner.runTask(controller.signal, async lease => {
      if (lease.signal.aborted) failure('WHYAI_CANCELLED')
      if (kind === 'install') {
        const target = getStandardCliFallback()
        if (!target) failure('WHYAI_INSTALL_VERIFY_FAILED')
        const before = await stat(target).catch(() => undefined)
        const bytes = await downloadInstaller(lease.signal)
        if (lease.signal.aborted) failure('WHYAI_CANCELLED')
        const directory = await mkdtemp(join(tmpdir(), 'whyai-install-'))
        this.retainedTemps.add(directory)
        try {
          if (lease.signal.aborted) failure('WHYAI_CANCELLED')
          const script = join(directory, 'install.mjs')
          await writeFile(script, bytes, { flag: 'wx', mode: 0o600 })
          if (lease.signal.aborted) failure('WHYAI_CANCELLED')
          const result = await lease.execute([process.execPath, script], directory)
          if (result.exitCode !== 0) failure('WHYAI_COMMAND_FAILED')
          const after = await stat(target).catch(() => undefined)
          if (!after?.isFile() || (before && before.ino === after.ino && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs)) failure('WHYAI_INSTALL_VERIFY_FAILED')
          return await lease.version(target)
        } finally {
          // Never unlink code while an owned process range may still use it.
          if (this.runner.isQuiescent) {
            await rm(directory, { recursive: true, force: true })
            this.retainedTemps.delete(directory)
          }
        }
      }
      if (kind === 'login') {
        const result = await lease.invokeRaw(['login', '--gateway', 'https://ai.yitang.top'], undefined, 180_000)
        if (result.exitCode !== 0) failure('WHYAI_COMMAND_FAILED')
      } else {
        const result = await lease.invoke(['--json', 'logout'])
        if (result.exitCode !== 0 || asRecord(result.value, 'logout').logged_out !== true) failure('WHYAI_COMMAND_FAILED')
      }
      const result = await lease.invoke(['--json', 'status'])
      if (result.exitCode !== 0 || asRecord(result.value, 'status').logged_in !== (kind === 'login')) failure('WHYAI_COMMAND_FAILED')
      return undefined
    }, kind === 'logout' ? 30_000 : 180_000)
    this.onStateChanged?.()
    this.pending = task.then(version => {
      this.operation = Object.freeze({ ...operation, phase: 'succeeded', ...(version ? { version } : {}) })
    }, error => {
      const code = actionErrorCode(error)
      this.operation = Object.freeze({ ...operation, phase: code === 'WHYAI_CANCELLED' || code === 'WHYAI_DISPOSED' ? 'cancelled' : 'failed', code })
    }).finally(() => {
      this.controller = undefined
      this.onStateChanged?.()
    })
    return { operation }
  }

  cancel(id: string): ActionResult {
    if (!this.operation || this.operation.id !== id) return { status: 'error', code: 'WHYAI_OPERATION_NOT_FOUND' }
    if (this.busy) this.controller?.abort()
    return { operation: this.operation }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.controller?.abort()
    await this.pending
    if (this.operation?.code === 'WHYAI_PROCESS_FAILED' && !this.runner.isQuiescent) failure('WHYAI_PROCESS_FAILED')
    if (this.runner.isQuiescent) {
      const deadline = new AbortController()
      const timer = setTimeout(() => deadline.abort(), this.config.graceMs * 3)
      try {
        await bounded(Promise.all([...this.retainedTemps].map(async directory => {
          await rm(directory, { recursive: true, force: true })
          this.retainedTemps.delete(directory)
        })), deadline.signal)
      } finally { clearTimeout(timer) }
    }
  }
}
