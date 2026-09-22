import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessRuntime } from './dsh-types.ts'
import type { WhyAiConfig } from './config.ts'
import type { WhyAiCliRunner } from './runner.ts'

export interface ActionResult {
  readonly status: 'ok' | 'error'
  readonly message: string
  readonly output?: string
  readonly version?: string
}

export class WhyAiActions {
  private inFlight = false

  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly config: WhyAiConfig,
    private readonly runner: WhyAiCliRunner,
    private readonly onStateChanged?: () => void,
  ) {}

  async install(signal?: AbortSignal): Promise<ActionResult> {
    if (this.inFlight) {
      return { status: 'error', message: 'Another operation is already in progress' }
    }
    this.inFlight = true
    const opSignal = signal ?? new AbortController().signal
    try {
      return await this.runner.runTask(opSignal, async (operationSignal) => {
        let scriptText: string
        try {
          const res = await fetch('https://ai.yitang.top/cli/install.mjs', {
            signal: AbortSignal.any([operationSignal, AbortSignal.timeout(30_000)]),
            headers: { 'User-Agent': 'dsh-whyai-installer' },
          })
          if (!res.ok) {
            return { status: 'error', message: `Failed to download installer: HTTP ${res.status}` }
          }
          const text = await res.text()
          if (text.length > 1024 * 1024) {
            return { status: 'error', message: 'Installer payload exceeded 1MB limit' }
          }
          scriptText = text
        } catch (fetchError) {
          return { status: 'error', message: `Download failed: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}` }
        }

        const tempDir = await mkdtemp(join(tmpdir(), 'whyai-install-'))
        const scriptPath = join(tempDir, 'install.mjs')
        try {
          await writeFile(scriptPath, scriptText, 'utf8')

          let handle
          try {
            handle = this.subprocess.spawn({
              argv: [process.execPath, scriptPath],
              cwd: tempDir,
              stdio: {
                stdin: 'ignore',
                stdout: { maxBytes: this.config.stdoutMaxBytes },
                stderr: { maxBytes: this.config.stderrMaxBytes },
              },
              graceMs: this.config.graceMs,
              signal: operationSignal,
            })
          } catch (spawnError) {
            return { status: 'error', message: `Installer process could not start: ${spawnError instanceof Error ? spawnError.message : String(spawnError)}` }
          }

          const outcome = await handle.done
          if (outcome.exitCode !== 0) {
            const stderr = handle.collected.stderr?.readFrom(0).text.trim() || ''
            return { status: 'error', message: `Installer failed with code ${outcome.exitCode}: ${stderr}` }
          }
        } finally {
          await rm(tempDir, { recursive: true, force: true }).catch(() => {})
        }

        try {
          const version = await this.runner.version(operationSignal)
          this.onStateChanged?.()
          return { status: 'ok', message: 'WhyAI installed successfully', version }
        } catch {
          return { status: 'error', message: 'Installer completed but WhyAI CLI executable could not be resolved' }
        }
      })
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : String(error) }
    } finally {
      this.inFlight = false
    }
  }

  async login(signal?: AbortSignal): Promise<ActionResult> {
    if (this.inFlight) {
      return { status: 'error', message: 'Another operation is already in progress' }
    }
    this.inFlight = true
    const opSignal = signal ?? new AbortController().signal
    try {
      return await this.runner.runTask(opSignal, async (operationSignal) => {
        const raw = await this.runner.invokeRaw(
          ['login', '--gateway', 'https://ai.yitang.top'],
          undefined,
          operationSignal,
          180_000,
        )
        if (raw.exitCode !== 0) {
          const errText = raw.stderr.trim() || raw.stdout.trim()
          return {
            status: 'error',
            message: `WhyAI login failed with exit code ${raw.exitCode}${errText ? `: ${errText}` : ''}`,
          }
        }

        try {
          const statusResult = await this.runner.invoke(['--json', 'status'], undefined, operationSignal)
          const value = statusResult.value as Record<string, unknown> | undefined
          if (statusResult.exitCode === 0 && value?.logged_in === true) {
            this.onStateChanged?.()
            return { status: 'ok', message: 'WhyAI login completed successfully' }
          }
          return { status: 'error', message: 'WhyAI login command finished but account status is not logged in' }
        } catch {
          return { status: 'error', message: 'WhyAI login finished but status verification failed' }
        }
      })
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : String(error) }
    } finally {
      this.inFlight = false
    }
  }

  async logout(signal?: AbortSignal): Promise<ActionResult> {
    if (this.inFlight) {
      return { status: 'error', message: 'Another operation is already in progress' }
    }
    this.inFlight = true
    const opSignal = signal ?? new AbortController().signal
    try {
      return await this.runner.runTask(opSignal, async (operationSignal) => {
        const raw = await this.runner.invokeRaw(['logout'], undefined, operationSignal, 30_000)
        if (raw.exitCode !== 0) {
          const errText = raw.stderr.trim() || raw.stdout.trim()
          return {
            status: 'error',
            message: `WhyAI logout failed with exit code ${raw.exitCode}${errText ? `: ${errText}` : ''}`,
          }
        }
        this.onStateChanged?.()
        return { status: 'ok', message: 'WhyAI logout completed successfully' }
      })
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : String(error) }
    } finally {
      this.inFlight = false
    }
  }
}
