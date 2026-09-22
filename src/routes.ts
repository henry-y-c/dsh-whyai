import type { IncomingMessage, ServerResponse } from 'node:http'
import { WhyAiAccess } from './access.ts'
import type { WhyAiActions } from './actions.ts'
import type { WebContext } from './dsh-types.ts'
import type { WhyAiCliRunner } from './runner.ts'

function respond(res: ServerResponse, status: number, body: unknown, allow?: string): void {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...(allow ? { Allow: allow } : {}),
  })
  res.end(JSON.stringify(body))
}
function authorize(ctx: WebContext, req: IncomingMessage, res: ServerResponse, method: string): boolean {
  let rejection
  try { rejection = ctx.connection.requestRejection(req) } catch { rejection = 403 }
  if (rejection !== undefined) {
    respond(res, rejection, { status: 'error', code: rejection === 401 ? 'WHYAI_UNAUTHORIZED' : 'WHYAI_FORBIDDEN' })
    return false
  }
  if (req.method !== method) {
    respond(res, 405, { status: 'error', code: 'WHYAI_METHOD_NOT_ALLOWED' }, method)
    return false
  }
  return true
}
/** Routes have no body schema. Refuse framed bodies rather than buffering them. */
function query(req: IncomingMessage, res: ServerResponse, allowed: readonly string[]): URLSearchParams | undefined {
  const raw = req.url ?? ''
  if (raw.length > 2048 || req.headers?.['transfer-encoding'] !== undefined
    || (req.headers?.['content-length'] !== undefined && req.headers['content-length'] !== '0')) {
    respond(res, 400, { status: 'error', code: 'WHYAI_INVALID_REQUEST' })
    return undefined
  }
  try {
    const params = new URL(raw || '/', 'http://whyai.invalid').searchParams
    for (const key of params.keys()) {
      if (!allowed.includes(key) || params.getAll(key).length !== 1) throw new Error('query')
    }
    return params
  } catch {
    respond(res, 400, { status: 'error', code: 'WHYAI_INVALID_REQUEST' })
    return undefined
  }
}

export function installAccessRoute(
  ctx: WebContext,
  runner: Pick<WhyAiCliRunner, 'invoke'>,
  accessRef?: { current?: WhyAiAccess },
  managementBusy: () => boolean = () => false,
): void {
  ctx.effect(() => {
    const access = new WhyAiAccess(runner, managementBusy)
    if (accessRef) accessRef.current = access
    const remove = ctx.webServer.register({
      kind: 'exact', path: '/api/whyai/access',
      handler: async (req, res) => {
        if (!authorize(ctx, req, res, 'GET')) return
        const params = query(req, res, ['fresh'])
        if (!params) return
        if (params.has('fresh') && params.get('fresh') !== '1') {
          respond(res, 400, { status: 'error', code: 'WHYAI_INVALID_REQUEST' })
          return
        }
        const result = await access.get(params.get('fresh') === '1')
        respond(res, result.status === 'ok' ? 200 : result.code === 'WHYAI_TIMEOUT' ? 504 : result.code === 'WHYAI_BUSY' ? 409 : 503, result)
      },
    })
    return async () => {
      if (accessRef?.current === access) accessRef.current = undefined
      remove()
      await access.dispose()
    }
  }, 'whyai: authenticated access route')
}

/** Management requests acknowledge admission; only the owner publishes cleanup completion. */
export function installActionRoutes(ctx: WebContext, actions: WhyAiActions): void {
  ctx.effect(() => {
    const removes = (['install', 'login', 'logout', 'operation', 'operation/cancel'] as const).map(path => {
      const method = path === 'operation' ? 'GET' : 'POST'
      return ctx.webServer.register({ kind: 'exact', path: `/api/whyai/${path}`, handler: (req, res) => {
        if (!authorize(ctx, req, res, method)) return
        const params = query(req, res, path === 'operation' ? [] : path === 'operation/cancel' ? ['id'] : ['confirm'])
        if (!params) return
        if (path === 'operation') { respond(res, 200, { operation: actions.current }); return }
        if (path === 'operation/cancel') {
          const id = params.get('id')
          if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id)) {
            respond(res, 400, { status: 'error', code: 'WHYAI_INVALID_REQUEST' }); return
          }
          const result = actions.cancel(id)
          respond(res, 'operation' in result ? 200 : 404, result)
          return
        }
        if (params.get('confirm') !== 'host') {
          respond(res, 400, { status: 'error', code: 'WHYAI_CONFIRMATION_REQUIRED' }); return
        }
        const result = actions.start(path)
        respond(res, 'operation' in result ? 202 : result.code === 'WHYAI_BUSY' ? 409 : 503, result)
      } })
    })
    return async () => {
      for (const remove of removes) remove()
      await actions.dispose()
    }
  }, 'whyai: authenticated management routes')
}
