import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ActionResult {
  readonly status: 'ok' | 'error'
  readonly message: string
  readonly output?: string
  readonly version?: string
}

function getCredentialsPath(): string {
  if (process.env.WHYAI_CONFIG_DIR) {
    return join(process.env.WHYAI_CONFIG_DIR, 'credentials.json')
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || process.env.LOCALAPPDATA || homedir(), 'WhyAI', 'credentials.json')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'WhyAI', 'credentials.json')
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'whyai', 'credentials.json')
}

function updateProcessPath(): void {
  const whyAiBin = process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'WhyAI', 'bin')
    : join(homedir(), '.local', 'bin')

  const delimiter = process.platform === 'win32' ? ';' : ':'
  const currentPath = process.env.PATH || ''
  const parts = currentPath.split(delimiter).filter(Boolean)
  if (!parts.includes(whyAiBin)) {
    process.env.PATH = `${whyAiBin}${delimiter}${currentPath}`
  }
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(command, args, {
      shell: false,
      env: { ...process.env },
    })

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2000)
      reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)

    child.stdout?.on('data', (data) => {
      stdout += data.toString('utf8')
    })
    child.stderr?.on('data', (data) => {
      stderr += data.toString('utf8')
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

export class WhyAiActions {
  private inFlight = false

  async install(): Promise<ActionResult> {
    if (this.inFlight) {
      return { status: 'error', message: 'Another operation is already in progress' }
    }
    this.inFlight = true
    try {
      let result: { code: number; stdout: string; stderr: string }
      if (process.platform === 'win32') {
        const psScript = [
          '$cliTemp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())',
          'New-Item -ItemType Directory -Path $cliTemp | Out-Null',
          "Invoke-WebRequest https://ai.yitang.top/cli/install.mjs -OutFile (Join-Path $cliTemp 'install.mjs') -ErrorAction Stop",
          "node (Join-Path $cliTemp 'install.mjs')",
          "$env:Path = (Join-Path $env:LOCALAPPDATA 'WhyAI\\bin') + ';' + $env:Path",
          'whyai --version',
        ].join('\n')

        result = await runCommand(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
          180_000,
        )
      } else {
        const shScript = [
          'cli_tmp="$(mktemp -d)"',
          'curl -fsS https://ai.yitang.top/cli/install.mjs -o "$cli_tmp/install.mjs" &&',
          'node "$cli_tmp/install.mjs"',
          'export PATH="$HOME/.local/bin:$PATH"',
          'whyai --version',
        ].join('\n')

        result = await runCommand('/bin/sh', ['-c', shScript], 180_000)
      }

      if (result.code !== 0) {
        return {
          status: 'error',
          message: `Install failed with code ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`,
          output: result.stdout + (result.stderr ? `\n${result.stderr}` : ''),
        }
      }

      updateProcessPath()
      const match = result.stdout.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)
      const version = match ? match[1] : undefined

      return {
        status: 'ok',
        message: 'WhyAI installed successfully',
        output: result.stdout.trim(),
        version,
      }
    } catch (err: any) {
      return { status: 'error', message: err.message || String(err) }
    } finally {
      this.inFlight = false
    }
  }

  async login(): Promise<ActionResult> {
    if (this.inFlight) {
      return { status: 'error', message: 'Another operation is already in progress' }
    }
    this.inFlight = true
    try {
      updateProcessPath()
      let result: { code: number; stdout: string; stderr: string }
      if (process.platform === 'win32') {
        const psScript = [
          "$env:Path = (Join-Path $env:LOCALAPPDATA 'WhyAI\\bin') + ';' + $env:Path",
          'whyai login --gateway https://ai.yitang.top',
          'whyai billing access',
          'whyai --help',
        ].join('\n')

        result = await runCommand(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
          300_000,
        )
      } else {
        const shScript = [
          'export PATH="$HOME/.local/bin:$PATH"',
          'whyai login --gateway https://ai.yitang.top',
          'whyai billing access',
          'whyai --help',
        ].join('\n')

        result = await runCommand('/bin/sh', ['-c', shScript], 300_000)
      }

      if (result.code !== 0) {
        return {
          status: 'error',
          message: `Login failed with code ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`,
          output: result.stdout + (result.stderr ? `\n${result.stderr}` : ''),
        }
      }

      return {
        status: 'ok',
        message: 'WhyAI login completed successfully',
        output: result.stdout.trim(),
      }
    } catch (err: any) {
      return { status: 'error', message: err.message || String(err) }
    } finally {
      this.inFlight = false
    }
  }

  async logout(): Promise<ActionResult> {
    if (this.inFlight) {
      return { status: 'error', message: 'Another operation is already in progress' }
    }
    this.inFlight = true
    try {
      updateProcessPath()
      let result: { code: number; stdout: string; stderr: string }
      if (process.platform === 'win32') {
        const psScript = [
          "$env:Path = (Join-Path $env:LOCALAPPDATA 'WhyAI\\bin') + ';' + $env:Path",
          'whyai logout',
        ].join('\n')
        result = await runCommand(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
          30_000,
        )
      } else {
        const shScript = [
          'export PATH="$HOME/.local/bin:$PATH"',
          'whyai logout',
        ].join('\n')
        result = await runCommand('/bin/sh', ['-c', shScript], 30_000)
      }

      // Also ensure local credentials file is removed as guarantee
      try {
        const credPath = getCredentialsPath()
        await rm(credPath, { force: true }).catch(() => {})
      } catch {
        // ignore
      }

      return {
        status: 'ok',
        message: 'WhyAI logout completed successfully',
        output: result.stdout.trim(),
      }
    } catch {
      // Even if whyai command failed or wasn't found, ensure credentials file is erased
      try {
        const credPath = getCredentialsPath()
        await rm(credPath, { force: true }).catch(() => {})
      } catch {
        // ignore
      }
      return {
        status: 'ok',
        message: 'WhyAI authorization cleared',
      }
    } finally {
      this.inFlight = false
    }
  }
}
