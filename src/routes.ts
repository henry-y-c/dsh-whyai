import type { ServerResponse } from 'node:http'
import { WhyAiAccess, type AccessResult } from './access.ts'
import type { WhyAiActions } from './actions.ts'
import type { WebContext } from './dsh-types.ts'
import type { WhyAiCliRunner } from './runner.ts'

function respond(res: ServerResponse, status: number, result: AccessResult): void {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    ...(status === 405 ? { Allow: 'GET' } : {}) })
  res.end(JSON.stringify(result))
}

function respondJson(res: ServerResponse, status: number, body: unknown, allow?: string): void {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(allow ? { Allow: allow } : {}),
  })
  res.end(JSON.stringify(body))
}

/** Installs an authenticated exact route with mount-local cache and cleanup. */
export function installAccessRoute(
  ctx: WebContext,
  runner: Pick<WhyAiCliRunner, 'invoke'>,
  accessRef?: { current?: WhyAiAccess },
): void {
  ctx.effect(() => {
    const access = new WhyAiAccess(runner)
    if (accessRef) accessRef.current = access
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
        const url = req.url || ''
        const forceFresh = Boolean(url.includes('fresh=1') || req.headers?.['cache-control']?.includes('no-cache'))
        const result = await access.get(forceFresh)
        respond(res, result.status === 'ok' ? 200 : result.code === 'WHYAI_TIMEOUT' ? 504 : 503, result)
      },
    })
    return async () => {
      if (accessRef && accessRef.current === access) accessRef.current = undefined
      remove()
      await access.dispose()
    }
  }, 'whyai: authenticated access route')
}

/** Installs action routes for installing and logging in to WhyAI. */
export function installActionRoutes(
  ctx: WebContext,
  actions: WhyAiActions,
  onActionSuccess?: () => void,
): void {
  ctx.effect(() => {
    const removeInstall = ctx.webServer.register({
      kind: 'exact',
      path: '/api/whyai/install',
      handler: async (req, res) => {
        let rejection
        try {
          rejection = ctx.connection.requestRejection(req)
        } catch {
          respondJson(res, 403, { status: 'error', message: 'Forbidden' })
          return
        }
        if (rejection !== undefined) {
          respondJson(res, rejection, { status: 'error', message: rejection === 401 ? 'Unauthorized' : 'Forbidden' })
          return
        }
        if (req.method !== 'POST') {
          respondJson(res, 405, { status: 'error', message: 'Method Not Allowed' }, 'POST')
          return
        }
        const result = await actions.install()
        if (result.status === 'ok') onActionSuccess?.()
        respondJson(res, result.status === 'ok' ? 200 : 500, result)
      },
    })

    const removeLogin = ctx.webServer.register({
      kind: 'exact',
      path: '/api/whyai/login',
      handler: async (req, res) => {
        let rejection
        try {
          rejection = ctx.connection.requestRejection(req)
        } catch {
          respondJson(res, 403, { status: 'error', message: 'Forbidden' })
          return
        }
        if (rejection !== undefined) {
          respondJson(res, rejection, { status: 'error', message: rejection === 401 ? 'Unauthorized' : 'Forbidden' })
          return
        }
        if (req.method !== 'POST') {
          respondJson(res, 405, { status: 'error', message: 'Method Not Allowed' }, 'POST')
          return
        }
        const result = await actions.login()
        if (result.status === 'ok') onActionSuccess?.()
        respondJson(res, result.status === 'ok' ? 200 : 500, result)
      },
    })

    const removeLogout = ctx.webServer.register({
      kind: 'exact',
      path: '/api/whyai/logout',
      handler: async (req, res) => {
        let rejection
        try {
          rejection = ctx.connection.requestRejection(req)
        } catch {
          respondJson(res, 403, { status: 'error', message: 'Forbidden' })
          return
        }
        if (rejection !== undefined) {
          respondJson(res, rejection, { status: 'error', message: rejection === 401 ? 'Unauthorized' : 'Forbidden' })
          return
        }
        if (req.method !== 'POST') {
          respondJson(res, 405, { status: 'error', message: 'Method Not Allowed' }, 'POST')
          return
        }
        const result = await actions.logout()
        if (result.status === 'ok') onActionSuccess?.()
        respondJson(res, result.status === 'ok' ? 200 : 500, result)
      },
    })

    return () => {
      removeInstall()
      removeLogin()
      removeLogout()
    }
  }, 'whyai: action routes')
}
