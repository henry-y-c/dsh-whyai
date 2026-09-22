import { createElement as h, useId } from 'react'
import { errorKey } from './store.ts'
import type { LocaleKey } from './locales.ts'
import type { SidebarProps } from './types.ts'

const muted = { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 }
const panel = {
  boxSizing: 'border-box', width: '100%', minWidth: 0, padding: '9px 10px', borderRadius: 10,
  border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-specific-sidebar-fill)',
  color: 'var(--dsw-alias-label-primary)', fontSize: 12, lineHeight: 1.5, overflowWrap: 'anywhere',
}
const operationKeys = {
  install: { running: 'installing', succeeded: 'installSuccess', failed: 'installFailed', confirmation: 'installConfirm' },
  login: { running: 'loggingIn', succeeded: 'loginSuccess', failed: 'loginFailed', confirmation: 'loginConfirm' },
  logout: { running: 'loggingOut', succeeded: 'logoutSuccess', failed: 'logoutFailed', confirmation: 'logoutConfirm' },
} as const

/** Render observable state; only user events invoke the injected actions. */
export function AccessSummary({ wide, t, useAccess, actions }: SidebarProps) {
  const id = useId()
  const state = useAccess(value => value)
  const data = state.data
  const operation = state.operation
  const running = operation?.phase === 'running'
  const busy = Boolean(state.pending || running)
  const percent = data?.available_percent ?? null
  const value = percent === null ? '—' : `${Number(percent.toFixed(2))}%`
  const status = state.loading ? t('loading') : state.error ? t(state.error) : data ? t(data.eligible ? 'eligible' : 'ineligible') : t('unknown')
  const label = `${t('title')} · ${t('remaining')} ${value} · ${status}`
  const tone = data ? `var(--dsw-alias-state-${data.eligible ? 'success' : 'error'}-primary)` : 'var(--dsw-alias-label-tertiary)'
  const formatDate = (date: string) => new Intl.DateTimeFormat(t('dateLocale'), {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(date))
  const time = (date: string | null | undefined) => date ? h('time', { dateTime: date, title: date }, formatDate(date)) : t('unknown')
  const separateAccess = data?.valid_until && (!data.subscription_expires_at || Date.parse(data.valid_until) !== Date.parse(data.subscription_expires_at))
  const button = (key: LocaleKey, action: () => void | Promise<unknown>, disabled = busy) => h('button', {
    type: 'button', disabled,
    onClick: () => { if (!disabled) return action() },
    style: {
      padding: '5px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-fill-quaternary, rgba(255, 255, 255, 0.06))',
      color: 'var(--dsw-alias-label-primary)', fontSize: 11, fontWeight: 600,
      cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
    },
  }, t(key))
  const notice = (text: string, error = false) => h('div', {
    role: error ? 'alert' : 'status',
    style: { ...muted, marginTop: 6, ...(error ? { color: 'var(--dsw-alias-state-error-primary)' } : {}) },
  }, text)
  let operationMessage: string | undefined
  if (operation) {
    const keys = operationKeys[operation.kind]
    if (operation.phase === 'running') operationMessage = t(keys.running)
    else if (operation.phase === 'succeeded') operationMessage = `${t(keys.succeeded)}${operation.version ? ` (${operation.version})` : ''}`
    else if (operation.phase === 'failed') operationMessage = `${t(keys.failed)}: ${t(operation.code ? errorKey(operation.code) : state.actionError ?? 'unavailable')}`
    else if (operation.phase === 'cancelled') operationMessage = t('operationCancelled')
  }

  const content = h('section', { 'aria-label': t('title'), style: panel },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 } },
      h('strong', { style: { letterSpacing: '.04em' } }, t('brand')),
      data ? h('span', { style: { ...muted, color: tone, border: '1px solid currentColor', borderRadius: 20, padding: '0 6px', fontSize: 10 } }, t(data.eligible ? 'eligible' : 'ineligible')) : null,
    ),
    data ? h('div', null,
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 3 } },
        h('span', { style: muted }, t('remaining')),
        h('strong', { style: { fontSize: 22, fontVariantNumeric: 'tabular-nums', lineHeight: 1.3 } }, value)),
      h('div', {
        role: 'progressbar', 'aria-label': t('remaining'), 'aria-valuemin': 0, 'aria-valuemax': 100,
        ...(percent === null ? { 'aria-valuetext': t('unknown') } : { 'aria-valuenow': percent }),
        style: { height: 8, borderRadius: 8, overflow: 'hidden', background: 'var(--dsw-alias-border-l2)', margin: '6px 0' },
      }, percent === null ? null : h('div', { style: { height: '100%', width: `${percent}%`, borderRadius: 8, background: tone } })),
      h('div', { style: muted }, `${t('expiry')}：`, time(data.subscription_expires_at)),
      h('div', { style: muted }, `${t('reset')}：`, time(data.next_reset_at)),
      separateAccess ? h('div', { style: muted, title: t('validityHint') }, `${t('accessExpiry')}：`, time(data.valid_until)) : null,
      data.billing_status === 'unavailable' ? notice(t('billingUnavailable')) : null,
    ) : null,
    state.loading ? notice(t('fetchingData')) : null,
    state.error ? notice(t(state.error), true) : null,
    state.stale ? notice(t('stale')) : null,
    state.pending ? notice(t('actionPending')) : null,
    operationMessage ? notice(operationMessage, operation?.phase === 'failed') : null,
    running && operation?.kind === 'login' ? notice(t('loginPrompt')) : null,
    state.cancelRequested && running ? notice(t('cancelRequested')) : null,
    state.watchPaused ? notice(t('monitorPaused')) : null,
    state.actionError ? notice(t(state.actionError), true) : null,
    state.confirmation ? h('div', { style: { marginTop: 8 } },
      notice(t(operationKeys[state.confirmation].confirmation)),
      state.confirmation === 'login' ? notice(t('loginPrompt')) : null,
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 } },
        button('confirmBtn', () => actions.confirm()), button('dismissBtn', () => actions.dismiss())),
    ) : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 } },
      state.error === 'missing' ? button('installBtn', () => actions.prepare('install')) : null,
      state.error === 'auth' ? button('loginBtn', () => actions.prepare('login')) : null,
      data ? button('logoutBtn', () => actions.prepare('logout')) : null,
      button(state.watchPaused ? 'resumeBtn' : 'retryBtn', () => actions.retry(), Boolean(state.pending || (running && !state.watchPaused))),
    ),
    running ? h('div', { style: { marginTop: 6 } }, button('cancelBtn', () => actions.cancel(), Boolean(state.pending || state.cancelRequested))) : null,
  )
  if (wide) return h('div', { style: { width: '100%', minWidth: 0 } }, content)
  return h('div', { style: { width: 36 } },
    h('button', { type: 'button', popoverTarget: id, 'aria-label': label, title: label,
      style: { width: 36, minHeight: 36, padding: '6px 0', cursor: 'pointer', border: 0, borderRadius: 8, background: 'transparent', color: 'var(--dsw-alias-label-primary)', fontSize: 10, fontWeight: 700 } }, h('span', { style: { display: 'block' } }, t('brand')), h('span', { style: { display: 'block', fontSize: 9, color: tone, fontVariantNumeric: 'tabular-nums' } }, value)),
    h('div', { id, popover: 'auto', 'aria-label': t('title'),
      style: { position: 'fixed', inset: 'auto auto 56px 56px', margin: 0, padding: 0, border: 0, background: 'transparent', width: 'min(280px, calc(100vw - 72px))', maxHeight: '70vh', overflowY: 'auto' } }, content),
  )
}
