/** React is supplied by the DSH shell, never bundled as a private instance. */
declare module 'react' {
  export interface ReactElement { readonly type: unknown; readonly props: unknown; readonly key: string | null }
  export function createElement(type: string, props: Record<string, unknown> | null, ...children: unknown[]): ReactElement
  export function useId(): string
  export function useState<T>(initialState: T | (() => T)): [T, (action: T | ((prevState: T) => T)) => void]
}
