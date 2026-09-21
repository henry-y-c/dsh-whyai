import type { ServerResponse } from 'node:http'
import { WhyAiAccess, type AccessResult } from './access.ts'
import type { WebContext } from './dsh-types.ts'
import type { WhyAiCliRunner } from './runner.ts'

function respond(res: ServerResponse, status: number, result: AccessResult): void {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    ...(status === 405 ? { Allow: 'GET' } : {}) })
  res.end(JSON.stringify(result))
}

/** Installs an authenticated exact route with mount-local cache and cleanup. */
export function installAccessRoute(ctx: WebContext, runner: Pick<WhyAiCliRunner, 'invoke'>): void {
  ctx.effect(() => {
    const access = new WhyAiAccess(runner)
    const remove = ctx.webServer.register({
      kind: 'exact', path: '/api/whyai/access',
      handler: async (req, res) => {
        let rejection
        try {
          rejection = ctx.connection.requestRejection(req)
        } catch {
          respond(res, 403, { status: 'error', code: 'WHYAI_FORBIDDEN' })
          return
        }
        if (rejection !== undefined) {
          respond(res, rejection, { status: 'error', code: rejection === 401 ? 'WHYAI_UNAUTHORIZED' : 'WHYAI_FORBIDDEN' })
          return
        }
        if (req.method !== 'GET') {
          respond(res, 405, { status: 'error', code: 'WHYAI_METHOD_NOT_ALLOWED' })
          return
        }
        const result = await access.get()
        respond(res, result.status === 'ok' ? 200 : result.code === 'WHYAI_TIMEOUT' ? 504 : 503, result)
      },
    })
    return async () => { remove(); await access.dispose() }
  }, 'whyai: authenticated access route')
}
