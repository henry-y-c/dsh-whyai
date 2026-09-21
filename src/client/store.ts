import type { Observable } from './types.ts'
import type { LocaleKey } from './locales.ts'

export interface AccessData {
  available_percent: number | null
  eligible: boolean
  valid_until: string | null
  subscription_expires_at: string | null
  next_reset_at: string | null
  billing_status: 'ok' | 'unavailable'
}
export interface AccessState { loading: boolean; data?: AccessData; error?: LocaleKey }
const POLL_MS = 60_000
const TIMEOUT_MS = 15_000
const MAX_BYTES = 16_384

/** Reject malformed wire values rather than converting missing allowance into zero. */
export function parseAccess(value: unknown): AccessData {
  if (!value || typeof value !== 'object') throw new Error('invalid')
  const response = value as Record<string, unknown>
  if (response.status === 'error' && typeof response.code === 'string') {
    const code = response.code.toUpperCase()
    throw new Error(/AUTH|LOGIN|LOGGED_IN|UNAUTHORIZED|FORBIDDEN/.test(code) ? 'auth'
      : /RATE|LIMIT/.test(code) ? 'limited' : /TIMEOUT/.test(code) ? 'timeout'
        : /DISABLED/.test(code) ? 'disabled' : 'unavailable')
  }
  if (response.status !== 'ok' || !response.data || typeof response.data !== 'object') throw new Error('invalid')
  const data = response.data as Record<string, unknown>
  const percent = data.available_percent
  const expiry = data.valid_until
  if (!(percent === null || typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100)
    || typeof data.eligible !== 'boolean'
    || !(expiry === null || typeof expiry === 'string' && expiry.length <= 128 && Number.isFinite(Date.parse(expiry)))) throw new Error('invalid')
  if (!Object.hasOwn(data, 'subscription_expires_at')
    || !Object.hasOwn(data, 'next_reset_at')
    || !Object.hasOwn(data, 'billing_status')) throw new Error('invalid')
  const subscription = data.subscription_expires_at
  const reset = data.next_reset_at
  for (const date of [subscription, reset]) {
    if (!(date === null || typeof date === 'string' && date.length <= 128 && Number.isFinite(Date.parse(date)))) throw new Error('invalid')
  }
  const billing = data.billing_status
  if (billing !== 'ok' && billing !== 'unavailable') throw new Error('invalid')
  return { available_percent: percent, eligible: data.eligible, valid_until: expiry, subscription_expires_at: subscription as string | null, next_reset_at: reset as string | null, billing_status: billing }
}

const CACHE_KEY = 'dsh_whyai_access_cache'

export function loadSavedAccess(): AccessData | undefined {
  if (typeof localStorage === 'undefined') return undefined
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return undefined
    return parseAccess(JSON.parse(raw))
  } catch {
    return undefined
  }
}

export function saveAccess(data: AccessData | undefined): void {
  if (typeof localStorage === 'undefined') return
  try {
    if (data) {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ status: 'ok', data }))
    } else {
      localStorage.removeItem(CACHE_KEY)
    }
  } catch {
    // Ignore storage quota or security errors
  }
}

/** Bound the complete body before parsing; a single oversized chunk is rejected. */
async function readAccess(response: Response, signal: AbortSignal): Promise<AccessData> {
  if (signal.aborted) {
    void response.body?.cancel().catch(() => {})
    throw new Error('unavailable')
  }
  if (!response.ok && response.status !== 503) {
    void response.body?.cancel().catch(() => {})
    throw new Error(response.status === 401 || response.status === 403 ? 'auth' : response.status === 429 ? 'limited' : response.status === 504 || response.status === 408 ? 'timeout' : 'unavailable')
  }
  if (!response.body) throw new Error('invalid')
  const reader = response.body.getReader()
  const cancelReader = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancelReader, { once: true })
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
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch { throw new Error('invalid') }
    if (!response.ok && (!value || typeof value !== 'object' || (value as Record<string, unknown>).status !== 'error')) throw new Error('unavailable')
    return parseAccess(value)
  } finally {
    signal.removeEventListener('abort', cancelReader)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function executeInstall(): Promise<{ ok: boolean; message: string; version?: string }> {
  try {
    const res = await fetch('/api/whyai/install', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    if (!res.ok || body.status !== 'ok') {
      return { ok: false, message: typeof body.message === 'string' ? body.message : `HTTP ${res.status}` }
    }
    return {
      ok: true,
      message: typeof body.message === 'string' ? body.message : 'OK',
      version: typeof body.version === 'string' ? body.version : undefined,
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Network error' }
  }
}

export async function executeLogin(): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch('/api/whyai/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    if (!res.ok || body.status !== 'ok') {
      return { ok: false, message: typeof body.message === 'string' ? body.message : `HTTP ${res.status}` }
    }
    return {
      ok: true,
      message: typeof body.message === 'string' ? body.message : 'OK',
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Network error' }
  }
}

export async function executeLogout(): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch('/api/whyai/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    if (!res.ok || body.status !== 'ok') {
      return { ok: false, message: typeof body.message === 'string' ? body.message : `HTTP ${res.status}` }
    }
    return {
      ok: true,
      message: typeof body.message === 'string' ? body.message : 'OK',
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Network error' }
  }
}

/** One subscription-owned poller; hidden pages and the last unsubscribe cancel all work. */
export class AccessStore implements Observable<AccessState> {
  static current?: AccessStore

  #state: AccessState = { loading: true, data: loadSavedAccess() }
  #listeners = new Set<() => void>()
  #timer?: ReturnType<typeof setTimeout>
  #cancel?: () => void
  #generation = 0
  #disposed = false

  constructor() {
    AccessStore.current = this
  }

  static reload(fresh = true): Promise<AccessState> {
    if (AccessStore.current) {
      return AccessStore.current.reload(fresh)
    }
    return Promise.resolve({ loading: false })
  }

  static clear(): void {
    if (AccessStore.current) {
      AccessStore.current.clear()
    }
  }

  getSnapshot = (): AccessState => this.#state
  #visible = (): boolean => typeof document === 'undefined' || !document.hidden
  #publish(state: AccessState): void {
    this.#state = state
    for (const listener of this.#listeners) listener()
  }
  #stop(): void {
    ++this.#generation
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#cancel?.()
    this.#cancel = undefined
  }
  #visibility = (): void => {
    this.#stop()
    // Clear old account data while hidden, including during a login change.
    const isVis = this.#visible()
    this.#publish({ loading: isVis, ...(isVis ? { data: this.#state.data ?? loadSavedAccess() } : { error: 'paused' as const }) })
    if (isVis) void this.#load()
  }
  subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed) return () => {}
    const notify = () => listener()
    this.#listeners.add(notify)
    if (this.#listeners.size === 1) {
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.#visibility)
      if (this.#visible()) void this.#load()
    }
    return () => {
      if (!this.#listeners.delete(notify) || this.#listeners.size) return
      this.#stop()
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.#visibility)
      this.#state = { loading: true }
    }
  }
  dispose = (): void => {
    if (AccessStore.current === this) AccessStore.current = undefined
    this.#disposed = true
    this.#stop()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.#visibility)
    this.#listeners.clear()
    this.#state = { loading: true }
  }
  clear = (): void => {
    saveAccess(undefined)
    this.#stop()
    this.#publish({ loading: false, data: undefined, error: 'auth' })
  }
  reload = async (fresh = true): Promise<AccessState> => {
    if (this.#disposed) return this.#state
    this.#stop()
    this.#publish({ loading: true, data: this.#state.data ?? loadSavedAccess() })
    await this.#load(fresh)
    return this.#state
  }
  async #load(fresh = false): Promise<void> {
    if (this.#cancel || this.#disposed || !this.#listeners.size || !this.#visible()) return
    const generation = ++this.#generation
    const controller = new AbortController()
    let reject!: (error: Error) => void
    const cancelled = new Promise<never>((_resolve, fail) => { reject = fail })
    const cancel = (reason: string) => { reject(new Error(reason)); controller.abort() }
    this.#cancel = () => cancel('unavailable')
    const timeout = setTimeout(() => cancel('timeout'), TIMEOUT_MS)
    const url = fresh ? '/api/whyai/access?fresh=1' : '/api/whyai/access'
    const work = (async () => readAccess(await fetch(url, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json', 'cache-control': 'no-cache' }, signal: controller.signal,
    }), controller.signal))()
    try {
      const data = await Promise.race([work, cancelled])
      if (generation === this.#generation) {
        saveAccess(data)
        this.#publish({ loading: false, data, error: undefined })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const safe = ['auth', 'limited', 'timeout', 'invalid', 'disabled'].includes(message) ? message as LocaleKey : 'unavailable'
      if (safe === 'auth') saveAccess(undefined)
      if (generation === this.#generation) this.#publish({ loading: false, error: safe })
    } finally {
      clearTimeout(timeout)
      if (generation === this.#generation) {
        this.#cancel = undefined
        if (this.#listeners.size && this.#visible() && !this.#disposed) this.#timer = setTimeout(() => { void this.#load() }, POLL_MS)
      }
    }
  }
}
