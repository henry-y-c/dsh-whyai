import type { IncomingMessage, ServerResponse } from 'node:http'

export interface WebContext {
  readonly webServer: {
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
    }): () => void
  }
  readonly connection: {
    requestRejection(request: IncomingMessage): 401 | 403 | undefined
  }
  effect(callback: () => () => void | Promise<void>, label?: string): void
}

export interface ToolRunContext {
  readonly signal: AbortSignal
}

export interface ToolDefinition<TArgs, TValue> {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: TArgs, value: TValue): Array<{ type: 'text'; text: string }>
  }
  readonly timeoutMs?: number
  execute(args: TArgs, exec: ToolRunContext): Promise<TValue>
}

export interface ToolRegistry {
  register<TArgs, TValue>(definition: ToolDefinition<TArgs, TValue>): () => void
}

export interface SubprocessOutputRead {
  readonly text: string
  readonly nextOffset: number
  readonly lossy: boolean
  readonly spillPath?: string
}

export interface SubprocessOutputReader {
  readFrom(fromByte: number): SubprocessOutputRead
}

export interface SubprocessOutcome {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
}

export interface SubprocessHandle {
  readonly collected: {
    readonly stdout?: SubprocessOutputReader
    readonly stderr?: SubprocessOutputReader
  }
  readonly done: Promise<SubprocessOutcome>
  terminate(): void
  waitForExit(signal?: AbortSignal): Promise<boolean>
}

export interface SubprocessSpawnSpec {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly stdio: {
    readonly stdin: 'ignore' | 'pipe' | { readonly data: string }
    readonly stdout: 'pipe' | 'inherit' | { readonly maxBytes: number }
    readonly stderr: 'pipe' | 'inherit' | { readonly maxBytes: number }
  }
  readonly graceMs: number
  readonly signal?: AbortSignal
  readonly env?: NodeJS.ProcessEnv
}

export interface SubprocessRuntime {
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
}

export interface Logger {
  warn(message: string): void
  error(message: string): void
}

export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }

export interface PluginContext {
  inject(services: ['webServer', 'connection'], callback: (ctx: WebContext) => void): unknown
  readonly tools: ToolRegistry
  readonly subprocess: SubprocessRuntime
  readonly logger: Logger
  on(
    event: 'tools/pre-execute',
    listener: (
      exec: { readonly name: string; readonly signal: AbortSignal },
      next: () => Promise<PreToolDecision>,
    ) => Promise<PreToolDecision>,
  ): () => void
  effect(callback: () => () => void | Promise<void>, label?: string): void
}
