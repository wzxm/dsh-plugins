import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
export * from './quick-onboarding.ts'
export * from './feishu.ts'
export * from './feishu-api.ts'
export * from './signature.ts'
export * from './bot-store.ts'
export const name = 'dsh-im'
export const inject = ['webServer']
export interface Config {
  callbackPath: string
  oauthCallbackPath: string
  publicBaseUrl: string
  maxBodyBytes: number
}
export function apply (ctx: Context, config: Config): void {
  if (
    !config.callbackPath.startsWith('/') ||
    !config.oauthCallbackPath.startsWith('/')
  )
    throw new Error('dsh-im paths must be absolute')
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: config.callbackPath,
        handler: (_req, res) => {
          res.statusCode = 501
          res.end('Feishu adapter pending configuration')
        }
      }),
    `dsh-im: ${config.callbackPath}`
  )
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: config.oauthCallbackPath,
        handler: (_req, res) => {
          res.statusCode = 501
          res.end('OAuth callback pending configuration')
        }
      }),
    `dsh-im: ${config.oauthCallbackPath}`
  )
}
export default { name, inject, apply }
