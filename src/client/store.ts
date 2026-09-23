import type { LocaleKey } from './locales.ts'
import type { Observable } from './types.ts'

export interface AccessData {
  readonly eligible: boolean
  readonly available_percent: number | null
  readonly valid_until: string | null
  readonly subscription_expires_at: string | null
  readonly next_reset_at: string | null
  readonly billing_status: 'ok' | 'unavailable'
}
export type OperationKind = 'install' | 'login' | 'logout'
export interface Operation { id: string; kind: OperationKind; phase: 'running' | 'succeeded' | 'failed' | 'cancelled'; code?: string; version?: string }
export interface AccessState {
  readonly loading: boolean
  readonly data?: AccessData
  readonly error?: LocaleKey
  readonly stale?: boolean
  readonly confirmation?: OperationKind
  readonly pending?: boolean
  readonly operation?: Operation
  readonly actionError?: LocaleKey
  readonly cancelRequested?: boolean
  readonly watchPaused?: boolean
}
export function errorKey(code: unknown): LocaleKey {
  if (code === 'WHYAI_AUTH_REQUIRED' || code === 'WHYAI_NOT_LOGGED_IN') return 'auth'
  if (code === 'WHYAI_EXECUTABLE_NOT_FOUND') return 'missing'
  if (code === 'WHYAI_INSTALL_CUSTOM_PATH_UNSUPPORTED') return 'customPath'
  if (code === 'WHYAI_BUSY') return 'busy'
  if (code === 'WHYAI_TIMEOUT') return 'timeout'
  return 'unavailable'
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
export function parseAccess(value: unknown): AccessData {
  if (!record(value)) throw new Error('invalid')
  if (value.status === 'error') throw new Error(errorKey(value.code))
  if (value.status !== 'ok' || !record(value.data)) throw new Error('invalid')
  const d = value.data
  if (!(d.available_percent === null || typeof d.available_percent === 'number' && Number.isFinite(d.available_percent) && d.available_percent >= 0 && d.available_percent <= 100) || typeof d.eligible !== 'boolean') throw new Error('invalid')
  for (const key of ['valid_until', 'subscription_expires_at', 'next_reset_at']) {
    const date = d[key]
    if (!(date === null || typeof date === 'string' && date.length <= 128 && Number.isFinite(Date.parse(date)))) throw new Error('invalid')
  }
  if (d.billing_status !== 'ok' && d.billing_status !== 'unavailable') throw new Error('invalid')
  return { available_percent: d.available_percent, eligible: d.eligible, valid_until: d.valid_until as string | null, subscription_expires_at: d.subscription_expires_at as string | null, next_reset_at: d.next_reset_at as string | null, billing_status: d.billing_status }
}
export function parseOperation(value: unknown): Operation | undefined {
  if (!record(value)) throw new Error('invalid')
  if (value.operation === null) return undefined
  const op = value.operation
  if (!record(op) || typeof op.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(op.id) || !['install', 'login', 'logout'].includes(op.kind as string) || !['running', 'succeeded', 'failed', 'cancelled'].includes(op.phase as string)) throw new Error('invalid')
  if (op.code !== undefined && (typeof op.code !== 'string' || !/^WHYAI_[A-Z_]{1,80}$/.test(op.code))) throw new Error('invalid')
  if (op.version !== undefined && (typeof op.version !== 'string' || !/^[0-9][a-zA-Z0-9.+-]{0,79}$/.test(op.version))) throw new Error('invalid')
  return { id: op.id, kind: op.kind as OperationKind, phase: op.phase as Operation['phase'], ...(op.code ? { code: op.code as string } : {}), ...(op.version ? { version: op.version as string } : {}) }
}
const MAX_BYTES = 16 * 1024
async function readBody(response: Response, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted || [401, 403, 429, 408, 504].includes(response.status)) {
    void response.body?.cancel().catch(() => {})
    throw new Error(signal.aborted ? 'unavailable' : response.status === 401 ? 'dshAuth' : response.status === 403 ? 'forbidden' : response.status === 429 ? 'limited' : 'timeout')
  }
  if (!response.body) throw new Error('invalid')
  const reader = response.body.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_BYTES) throw new Error('invalid')
      chunks.push(next.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new Error('invalid') }
    if (record(value) && value.status === 'error') throw new Error(errorKey(value.code))
    if (!response.ok) throw new Error('unavailable')
    return value
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
    reader.releaseLock()
  }
}
function safeError(error: unknown): LocaleKey {
  const message = error instanceof Error ? error.message : ''
  return ['auth', 'missing', 'dshAuth', 'forbidden', 'busy', 'customPath', 'limited', 'timeout', 'invalid'].includes(message) ? message as LocaleKey : 'unavailable'
}

/** Requests and timers belong to subscribers; stopping observation never cancels a host operation. */
export class AccessStore implements Observable<AccessState> {
  #state: AccessState = { loading: true }
  #listeners = new Set<() => void>()
  #timer?: ReturnType<typeof setTimeout>
  #requests = new Set<() => void>()
  #generation = 0
  #disposed = false
  #working = false
  #polls = 0
  #lastOperationId?: string
  #supersededOperationId?: string
  getSnapshot = (): AccessState => this.#state
  #visible = () => typeof document === 'undefined' || !document.hidden
  #live = () => !this.#disposed && this.#listeners.size > 0 && this.#visible()
  #publish(patch: Partial<AccessState>): void {
    this.#state = { ...this.#state, ...patch }
    for (const notify of this.#listeners) notify()
  }
  #stop(): void {
    ++this.#generation
    clearTimeout(this.#timer)
    this.#timer = undefined
    for (const cancel of this.#requests) cancel()
    this.#requests.clear()
    this.#working = false
  }
  async #request(path: string, method = 'GET'): Promise<unknown> {
    const controller = new AbortController()
    let reject!: (reason: Error) => void
    const cancelled = new Promise<never>((_, fail) => { reject = fail })
    const cancel = (reason = 'unavailable') => { reject(new Error(reason)); controller.abort() }
    const dispose = () => cancel()
    this.#requests.add(dispose)
    const timeout = setTimeout(() => cancel('timeout'), 35_000)
    const work = (async () => readBody(await fetch(`/api/whyai/${path}`, { method, credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' }, signal: controller.signal }), controller.signal))()
    try { return await Promise.race([work, cancelled]) }
    finally { clearTimeout(timeout); this.#requests.delete(dispose) }
  }
  #schedule(ms: number): void {
    clearTimeout(this.#timer)
    if (this.#live()) this.#timer = setTimeout(() => { this.#timer = undefined; void this.#refresh() }, ms)
  }
  #accept(op: Operation | undefined): void {
    if (op) this.#lastOperationId = op.id
    // A rejected/uncertain start must not borrow the previous operation's success.
    if (op && op.id === this.#supersededOperationId) {
      this.#publish({ operation: undefined, pending: false, watchPaused: false })
      return
    }
    if (op) this.#supersededOperationId = undefined
    const prev = this.#state.operation
    const changed = op && (op.id !== prev?.id || op.phase !== prev.phase)
    this.#publish({ operation: op, pending: false, watchPaused: false, ...(op ? { actionError: undefined } : {}), ...(changed ? { data: undefined, stale: false, error: undefined, confirmation: undefined } : {}), ...(op?.phase !== 'running' ? { cancelRequested: false } : {}) })
  }
  async #refresh(): Promise<void> {
    if (!this.#live() || this.#working) return
    this.#working = true
    const generation = this.#generation
    let operationRead = false
    try {
      const op = parseOperation(await this.#request('operation'))
      if (generation !== this.#generation) return
      operationRead = true
      this.#accept(op)
      if (op?.phase === 'running') {
        this.#publish({ loading: false })
        if (++this.#polls >= 180) this.#publish({ watchPaused: true, actionError: 'monitorPaused' })
        else this.#schedule(2_000)
        return
      }
      this.#polls = 0
      this.#publish({ loading: true })
      const data = parseAccess(await this.#request('access'))
      if (generation === this.#generation) this.#publish({ data, error: undefined, stale: false, loading: false })
    } catch (error) {
      if (generation !== this.#generation) return
      const key = safeError(error)
      const clear = ['auth', 'missing', 'dshAuth', 'forbidden'].includes(key)
      this.#publish({ loading: false, error: key, ...(clear ? { data: undefined, stale: false, confirmation: undefined } : { stale: !!this.#state.data }), ...(!operationRead && (this.#state.pending || this.#state.operation?.phase === 'running') ? { watchPaused: true, actionError: 'operationUnknown' } : {}) })
    } finally {
      if (generation === this.#generation) {
        this.#working = false
        if (!this.#timer && !this.#state.watchPaused) this.#schedule(60_000)
      }
    }
  }
  #visibility = (): void => {
    this.#stop()
    this.#publish({ data: undefined, stale: false, confirmation: undefined, pending: false, cancelRequested: false, ...(this.#state.pending ? { watchPaused: true, actionError: 'operationUnknown' } : {}), loading: this.#visible(), error: this.#visible() ? undefined : 'paused' })
    if (this.#visible()) { this.#polls = 0; void this.#refresh() }
  }
  subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed) return () => {}
    const notify = () => listener()
    this.#listeners.add(notify)
    if (this.#listeners.size === 1) {
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.#visibility)
      this.#polls = 0
      void this.#refresh()
    }
    return () => {
      if (!this.#listeners.delete(notify) || this.#listeners.size) return
      this.#stop()
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.#visibility)
      this.#state = { loading: true }
    }
  }
  dispose = (): void => {
    this.#disposed = true
    this.#stop()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.#visibility)
    this.#listeners.clear()
    this.#state = { loading: true }
  }
  prepare = (kind: OperationKind): void => {
    if (!this.#live() || this.#state.pending || this.#state.operation?.phase === 'running') return
    if (kind === 'install' ? this.#state.error !== 'missing' : kind === 'login' ? this.#state.error !== 'auth' : !this.#state.data) return
    this.#publish({ confirmation: kind, actionError: undefined })
  }
  dismiss = (): void => { this.#publish({ confirmation: undefined }) }
  confirm = async (): Promise<void> => {
    const kind = this.#state.confirmation
    if (!kind || !this.#live() || this.#state.pending || this.#state.operation?.phase === 'running') return
    if (kind === 'install' ? this.#state.error !== 'missing' : kind === 'login' ? this.#state.error !== 'auth' : !this.#state.data) { this.dismiss(); return }
    this.#stop()
    const generation = this.#generation
    this.#supersededOperationId = this.#lastOperationId
    this.#publish({ confirmation: undefined, pending: true, data: undefined, stale: false, error: undefined, actionError: undefined, operation: undefined, cancelRequested: false, loading: false })
    try {
      const op = parseOperation(await this.#request(`${kind}?confirm=host`, 'POST'))
      if (!op || op.kind !== kind) throw new Error('invalid')
      if (generation !== this.#generation) return
      this.#accept(op)
    } catch (error) {
      if (generation !== this.#generation) return
      // The POST may have reached the host: only GET can establish its outcome.
      this.#publish({ pending: false, actionError: safeError(error), watchPaused: true })
    }
    if (generation === this.#generation) { this.#polls = 0; void this.#refresh() }
  }
  cancel = async (): Promise<void> => {
    const op = this.#state.operation
    if (!this.#live() || op?.phase !== 'running' || this.#state.cancelRequested) return
    this.#stop()
    const generation = this.#generation
    this.#publish({ cancelRequested: true, actionError: undefined })
    try {
      const result = parseOperation(await this.#request(`operation/cancel?id=${encodeURIComponent(op.id)}`, 'POST'))
      if (!result || result.id !== op.id) throw new Error('invalid')
      if (generation === this.#generation) this.#accept(result)
    } catch (error) {
      if (generation === this.#generation) this.#publish({ cancelRequested: false, actionError: safeError(error), watchPaused: true })
    }
    if (generation === this.#generation) { this.#polls = 0; void this.#refresh() }
  }
  retry = (): void => {
    if (!this.#live() || this.#state.pending || this.#requests.size) return
    this.#stop()
    this.#polls = 0
    this.#publish({ watchPaused: false, ...(!this.#supersededOperationId ? { actionError: undefined } : {}) })
    void this.#refresh()
  }
}
