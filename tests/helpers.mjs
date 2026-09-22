import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

class Collector {
  constructor(maxBytes) {
    this.maxBytes = maxBytes
    this.buffer = Buffer.alloc(0)
    this.total = 0
    this.lossy = false
  }

  push(chunk) {
    const next = Buffer.concat([this.buffer, chunk])
    this.total += chunk.length
    if (next.length > this.maxBytes) {
      this.lossy = true
      this.buffer = next.subarray(next.length - this.maxBytes)
    } else {
      this.buffer = next
    }
  }

  readFrom() {
    return { text: this.buffer.toString('utf8'), nextOffset: this.total, lossy: this.lossy }
  }
}

export class NodeSubprocess {
  constructor(env = {}) {
    this.env = env
    this.specs = []
    this.children = new Set()
  }

  async resolveExecutable(command, _env, signal) {
    if (signal?.aborted) throw signal.reason
    if (!isAbsolute(command)) throw new Error('test adapter requires an absolute executable')
    return command
  }

  spawn(spec) {
    this.specs.push(spec)
    const stdout = new Collector(spec.stdio.stdout.maxBytes)
    const stderr = new Collector(spec.stdio.stderr.maxBytes)
    const isWindows = process.platform === 'win32'
    const isMjs = typeof spec.argv[0] === 'string' && spec.argv[0].endsWith('.mjs')
    const command = isWindows && isMjs ? process.execPath : spec.argv[0]
    const args = isWindows && isMjs ? [spec.argv[0], ...spec.argv.slice(1)] : spec.argv.slice(1)
    const child = spawn(command, args, {
      cwd: spec.cwd,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.children.add(child)
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    if (typeof spec.stdio.stdin === 'object') child.stdin.end(spec.stdio.stdin.data)
    else child.stdin.end()

    let closed = false
    let killTimer
    const terminate = () => {
      if (closed) return
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), spec.graceMs)
    }
    spec.signal?.addEventListener('abort', terminate, { once: true })
    const done = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (exitCode, signal) => {
        closed = true
        if (killTimer) clearTimeout(killTimer)
        spec.signal?.removeEventListener('abort', terminate)
        this.children.delete(child)
        resolve({ exitCode, signal })
      })
    })

    return {
      collected: { stdout, stderr },
      done,
      terminate,
      async waitForExit(signal) {
        if (closed) return true
        return new Promise((resolve) => {
          const finish = () => { cleanup(); resolve(true) }
          const abort = () => { cleanup(); resolve(false) }
          const cleanup = () => {
            child.removeListener('close', finish)
            signal?.removeEventListener('abort', abort)
          }
          child.once('close', finish)
          signal?.addEventListener('abort', abort, { once: true })
        })
      },
    }
  }
}

export const CONFIG = {
  cliPath: fileURLToPath(new URL('./fixtures/mock-whyai.mjs', import.meta.url)),
  timeoutMs: 2_000,
  graceMs: 100,
  stdoutMaxBytes: 8_192,
  stderrMaxBytes: 4_096,
  promptMaxBytes: 4_096,
  partnerLimit: 10,
  requireApproval: true,
}

export function fakeContext(subprocess) {
  const tools = new Map()
  const listeners = []
  const cleanups = []
  const warnings = []
  return {
    ctx: {
      subprocess,
      inject() {}, // Headless test composition has no Web services.
      tools: {
        register(definition) {
          tools.set(definition.name, definition)
          const cleanup = () => tools.delete(definition.name)
          cleanups.push(cleanup)
          return cleanup
        },
      },
      logger: { warn: (message) => warnings.push(message), error: () => {} },
      on(event, listener) {
        if (event !== 'tools/pre-execute') throw new Error(`unexpected event ${event}`)
        listeners.push(listener)
        const cleanup = () => {
          const index = listeners.indexOf(listener)
          if (index >= 0) listeners.splice(index, 1)
        }
        cleanups.push(cleanup)
        return cleanup
      },
      effect(callback) {
        cleanups.push(callback())
      },
    },
    tools,
    listeners,
    warnings,
    async dispose() {
      await Promise.all(cleanups.map((cleanup) => cleanup()))
    },
  }
}
