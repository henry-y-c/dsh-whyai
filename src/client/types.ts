import type { AccessState } from './store.ts'
import type { LocaleKey } from './locales.ts'

/** Local projection of the DSH 0.1.5-rc.2 sidebar and locale contracts. */
export interface Observable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}
export interface SidebarProps {
  wide: boolean
  t(key: LocaleKey): string
  useAccess<T>(selector: (state: AccessState) => T): T
}
export type AccessSlotName = 'sidebar.footer.action' | 'sidebar.footer.usage-monitor.after'

export interface ClientContext {
  effect(callback: () => () => void, label?: string): unknown
  locale: { register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void }
  slots: {
    inject(name: AccessSlotName, callback: () => () => void): unknown
    register(options: {
      name: AccessSlotName; id: string; order: number; locale: string
      inject(): { hooks: { access: Observable<AccessState> } }
    }, component: (props: SidebarProps) => unknown): () => void
  }
}
