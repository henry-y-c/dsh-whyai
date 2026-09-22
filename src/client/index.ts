import type { AccessSlotName, ClientContext } from './types.ts'
import { en, zh } from './locales.ts'
import { AccessStore } from './store.ts'
import { AccessSummary } from './summary.ts'

export const inject = ['slots', 'locale']
const FOOTER_SLOT: AccessSlotName = 'sidebar.footer.action'
const USAGE_AFTER_SLOT: AccessSlotName = 'sidebar.footer.usage-monitor.after'

/** Contribute below Usage Monitor when available, with a standalone footer fallback. */
export function apply(ctx: ClientContext): void {
  const access = new AccessStore()
  ctx.effect(() => access.dispose, 'whyai: access lifecycle')
  ctx.effect(() => ctx.locale.register('whyai', { zh, en }), 'whyai: dictionaries')

  let disposed = false
  let footerLive = false
  let nestedLive = false
  let removeDirect: (() => void) | undefined
  const register = (name: AccessSlotName, order: number) => ctx.slots.register({
    name, id: 'whyai', order, locale: 'whyai',
    inject: () => ({ hooks: { access }, actions: { prepare: access.prepare, dismiss: access.dismiss, confirm: access.confirm, cancel: access.cancel, retry: access.retry } }),
  }, AccessSummary)
  const mountDirect = (): void => {
    if (!disposed && footerLive && !nestedLive && removeDirect === undefined) {
      removeDirect = register(FOOTER_SLOT, 110)
    }
  }
  const unmountDirect = (): void => {
    removeDirect?.()
    removeDirect = undefined
  }

  // Register this waiter first so an existing Usage Monitor seat wins before
  // the standalone footer contribution is considered.
  ctx.slots.inject(USAGE_AFTER_SLOT, () => {
    nestedLive = true
    unmountDirect()
    const removeNested = register(USAGE_AFTER_SLOT, 0)
    return () => {
      removeNested()
      nestedLive = false
      queueMicrotask(mountDirect)
    }
  })
  ctx.slots.inject(FOOTER_SLOT, () => {
    footerLive = true
    mountDirect()
    return () => {
      footerLive = false
      unmountDirect()
    }
  })
  ctx.effect(() => () => {
    disposed = true
    unmountDirect()
  }, 'whyai: footer routing')
}
