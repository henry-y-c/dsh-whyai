import { createElement as h, useId, useState } from 'react'
import { AccessStore, executeInstall, executeLogin, executeLogout } from './store.ts'
import type { SidebarProps } from './types.ts'

const muted = { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 }
const panel = {
  boxSizing: 'border-box', width: '100%', minWidth: 0, padding: '9px 10px', borderRadius: 10,
  border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-specific-sidebar-fill)',
  color: 'var(--dsw-alias-label-primary)', fontSize: 12, lineHeight: 1.5, overflowWrap: 'anywhere',
}

/** Render only the official owner width and renderer-bound observable/locale props. */
export function AccessSummary({ wide, t, useAccess }: SidebarProps) {
  const id = useId()
  const [actionStatus, setActionStatus] = useState<'idle' | 'installing' | 'loggingIn' | 'loggingOut' | 'fetching' | 'success' | 'error'>('idle')
  const [actionMessage, setActionMessage] = useState<string>('')

  const state = useAccess(value => value)
  const data = state.data
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

  const isBusy = actionStatus === 'installing' || actionStatus === 'loggingIn' || actionStatus === 'loggingOut' || actionStatus === 'fetching'
  const isSuccess = Boolean(data)
  const showLoading = !isSuccess && (state.loading || actionStatus === 'fetching')
  const canShowActions = !isSuccess && !state.loading && actionStatus !== 'fetching'
  const showButtons = canShowActions && (!state.error || state.error === 'unavailable' || state.error === 'auth')
  const showOtherError = canShowActions && !showButtons && Boolean(state.error)

  const handleInstall = async () => {
    if (isBusy) return
    setActionStatus('installing')
    setActionMessage(t('installing'))
    const result = await executeInstall()
    if (result.ok) {
      setActionStatus('fetching')
      setActionMessage(t('fetchingData'))
      const next = await AccessStore.reload()
      setActionStatus('idle')
      setActionMessage(next.data ? '' : (result.version ? `${t('installSuccess')} (v${result.version})` : t('installSuccess')))
    } else {
      setActionStatus('error')
      setActionMessage(`${t('installFailed')}: ${result.message}`)
    }
  }

  const handleLogin = async () => {
    if (isBusy) return
    setActionStatus('loggingIn')
    setActionMessage(t('loginPrompt'))
    const result = await executeLogin()
    if (result.ok) {
      setActionStatus('fetching')
      setActionMessage(t('fetchingData'))
      const next = await AccessStore.reload()
      if (next.data && !next.error) {
        setActionStatus('idle')
        setActionMessage('')
      } else {
        setActionStatus('error')
        setActionMessage(next.error ? t(next.error) : t('unavailable'))
      }
    } else {
      setActionStatus('error')
      setActionMessage(`${t('loginFailed')}: ${result.message}`)
    }
  }

  const handleLogout = async () => {
    if (isBusy) return
    setActionStatus('loggingOut')
    setActionMessage(t('loggingOut'))
    const result = await executeLogout()
    AccessStore.clear()
    if (result.ok) {
      setActionStatus('idle')
      setActionMessage('')
    } else {
      setActionStatus('error')
      setActionMessage(`${t('logoutFailed')}: ${result.message}`)
    }
  }

  const installButton = h('button', {
    type: 'button',
    disabled: isBusy,
    onClick: handleInstall,
    style: {
      flex: 1,
      padding: '5px 8px',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-fill-quaternary, rgba(255, 255, 255, 0.06))',
      color: isBusy && actionStatus === 'installing' ? 'var(--dsw-alias-state-brand-primary, #3b82f6)' : 'var(--dsw-alias-label-primary)',
      fontSize: 11,
      fontWeight: 600,
      cursor: isBusy ? 'not-allowed' : 'pointer',
      opacity: isBusy && actionStatus !== 'installing' ? 0.6 : 1,
      textAlign: 'center',
      transition: 'all 0.15s ease',
    },
  }, actionStatus === 'installing' ? t('installing') : t('installBtn'))

  const loginButton = h('button', {
    type: 'button',
    disabled: isBusy,
    onClick: handleLogin,
    style: {
      flex: 1,
      padding: '5px 8px',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-fill-quaternary, rgba(255, 255, 255, 0.06))',
      color: isBusy && actionStatus === 'loggingIn' ? 'var(--dsw-alias-state-brand-primary, #3b82f6)' : 'var(--dsw-alias-label-primary)',
      fontSize: 11,
      fontWeight: 600,
      cursor: isBusy ? 'not-allowed' : 'pointer',
      opacity: isBusy && actionStatus !== 'loggingIn' ? 0.6 : 1,
      textAlign: 'center',
      transition: 'all 0.15s ease',
    },
  }, actionStatus === 'loggingIn' ? t('loggingIn') : t('loginBtn'))

  const content = h('section', { 'aria-label': t('title'), style: panel },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 } },
      h('strong', { style: { letterSpacing: '.04em' } }, t('brand')),
      isSuccess ? h('span', { style: { ...muted, color: tone, border: '1px solid currentColor', borderRadius: 20, padding: '0 6px', fontSize: 10 } }, status) : null,
    ),
    isSuccess ? h('div', null,
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 3 } },
        h('span', { style: muted }, t('remaining')),
        h('strong', { style: { fontSize: 22, fontVariantNumeric: 'tabular-nums', lineHeight: 1.3 } }, value)),
      h('div', {
        role: 'progressbar', 'aria-label': t('remaining'), 'aria-valuemin': 0, 'aria-valuemax': 100,
        ...(percent === null ? { 'aria-valuetext': t('unknown') } : { 'aria-valuenow': percent }),
        style: { height: 8, borderRadius: 8, overflow: 'hidden', background: 'var(--dsw-alias-border-l2)', margin: '6px 0' },
      }, percent === null ? null : h('div', { style: { height: '100%', width: `${percent}%`, borderRadius: 8, background: tone } })),
      h('div', { style: muted }, `${t('expiry')}：`, time(data?.subscription_expires_at)),
      h('div', { style: muted }, `${t('reset')}：`, time(data?.next_reset_at)),
      separateAccess ? h('div', { style: muted, title: t('validityHint') }, `${t('accessExpiry')}：`, time(data?.valid_until)) : null,
      data?.billing_status === 'unavailable' ? h('div', { role: 'status', style: muted }, t('billingUnavailable')) : null,
      h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 8 } },
        h('button', {
          type: 'button',
          disabled: isBusy,
          onClick: handleLogout,
          style: {
            padding: '2px 8px',
            borderRadius: 4,
            border: '1px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-fill-quaternary, rgba(255, 255, 255, 0.04))',
            color: 'var(--dsw-alias-label-tertiary)',
            fontSize: 10,
            cursor: isBusy ? 'not-allowed' : 'pointer',
            lineHeight: 1.4,
            transition: 'all 0.15s ease',
          },
        }, actionStatus === 'loggingOut' ? t('loggingOut') : t('logoutBtn')),
      ),
    ) : null,
    showLoading ? h('div', {
      role: 'status',
      style: {
        marginTop: 10,
        padding: '6px 10px',
        borderRadius: 6,
        fontSize: 12,
        fontWeight: 600,
        textAlign: 'center',
        background: 'var(--dsw-alias-fill-quaternary, rgba(255, 255, 255, 0.08))',
        color: 'var(--dsw-alias-state-brand-primary, #3b82f6)',
      },
    }, t('fetchingData')) : null,
    showButtons ? h('div', { style: { display: 'flex', gap: 6, marginTop: 10 } }, installButton, loginButton) : null,
    showOtherError ? h('div', { role: 'status', style: { ...muted, marginTop: 8 } }, t(state.error!)) : null,
    canShowActions && actionMessage ? h('div', {
      role: 'status',
      style: {
        marginTop: 6,
        padding: '4px 6px',
        borderRadius: 4,
        fontSize: 10,
        lineHeight: 1.4,
        background: actionStatus === 'error'
          ? 'var(--dsw-alias-state-error-background, rgba(239, 68, 68, 0.15))'
          : actionStatus === 'success'
            ? 'var(--dsw-alias-state-success-background, rgba(34, 197, 94, 0.15))'
            : 'var(--dsw-alias-fill-quaternary, rgba(255, 255, 255, 0.08))',
        color: actionStatus === 'error'
          ? 'var(--dsw-alias-state-error-primary, #ef4444)'
          : actionStatus === 'success'
            ? 'var(--dsw-alias-state-success-primary, #22c55e)'
            : 'var(--dsw-alias-label-secondary)',
      },
    }, actionMessage) : null,
  )
  if (wide) return h('div', { style: { width: '100%', minWidth: 0 } }, content)
  return h('div', { style: { width: 36 } },
    h('button', { type: 'button', popoverTarget: id, 'aria-label': label, title: label,
      style: { width: 36, minHeight: 36, padding: '6px 0', cursor: 'pointer', border: 0, borderRadius: 8, background: 'transparent', color: 'var(--dsw-alias-label-primary)', fontSize: 10, fontWeight: 700 } }, h('span', { style: { display: 'block' } }, t('brand')), h('span', { style: { display: 'block', fontSize: 9, color: tone, fontVariantNumeric: 'tabular-nums' } }, value)),
    h('div', { id, popover: 'auto', 'aria-label': t('title'),
      style: { position: 'fixed', inset: 'auto auto 56px 56px', margin: 0, padding: 0, border: 0, background: 'transparent', width: 'min(280px, calc(100vw - 72px))', maxHeight: '70vh', overflowY: 'auto' } }, content),
  )
}
