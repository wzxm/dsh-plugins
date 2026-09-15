/**
 * dsh-im — Feishu/Lark IM adapter for DeepSeek Harness.
 *
 * The transport is owned by this plugin and lives at its scope. A WS connection
 * is one-per-process, so a second plugin instance would compete for the same
 * socket. That is by design: two instances are two presets, and a preset
 * contributes capabilities but never owns platform infrastructure.
 *
 * ## Webhook mode is removed
 *
 * The earlier design used HTTP callbacks with signature verification, AES
 * decryption, and a self-owned reply loop. That path is gone: under the
 * WebSocket transport the SDK authenticates the socket by app secret, and
 * Feishu pushes events through the WS channel with no inbound HTTP at all.
 *
 * The HTTP routes remain for the handshake endpoint, but only for the OAuth
 * callback — the code-exchange redirect that completes the onboarding flow.
 *
 * ## Dependencies
 *
 * Only `webServer` is a hard dependency: it is needed for the OAuth callback
 * route, and there is nothing to do without it.
 *
 * The Agent stack (`agents`, `agentPresets`, `agentDefaultModel`,
 * `permissionPresets`, `sessionTitle`, `workspaceRegistry`) is requested with
 * `ctx.inject`, which parks its callback until every service exists instead of
 * blocking `apply`. So the routes always register, and the dispatcher is built
 * lazily on the first message — by which point the stack is ready. When the
 * stack is absent, messages are acknowledged and a warning is logged once.
 *
 * @module @wzxm/dsh-im
 */

import type { Context } from '@deepseek-ai/cordis'
import { isAbsolute } from 'node:path'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import { createDispatcher, type DispatchResult } from './dispatch.ts'
import type { NormalizedMessage } from './event.ts'
import type { ImTransport } from './transport.ts'

export * from './event.ts'
export * from './feishu.ts'
export * from './feishu-api.ts'
export * from './signature.ts'
export * from './decrypt.ts'
export * from './session-bridge.ts'
export * from './dispatch.ts'
export * from './bot-store.ts'
export * from './quick-onboarding.ts'
export * from './transport.ts'
export * from './transport-memory.ts'
export * from './transport-feishu.ts'

export const name = 'dsh-im'

/**
 * Only the web server is a hard dependency: it is needed for the OAuth callback
 * route, which is the only remaining HTTP endpoint.
 */
export const inject = ['webServer']

export interface Config {
  /** Exact absolute path for the Feishu OAuth callback. */
  oauthCallbackPath: string
  /**
   * Credential reference holding the app_id of the Feishu/Lark bot.
   *
   * Required for the WebSocket transport; without it the plugin cannot connect
   * and logs a warning instead. May be left empty when onboarding has not
   * completed yet.
   */
  appIdRef?: string
  /** Credential reference holding the app_secret. */
  appSecretRef?: string
  /** Which brand to use: `feishu` or `lark`. Defaults to `feishu`. */
  domain?: string
  /**
   * The bot's own `open_id`.
   *
   * Under WebSocket transport the SDK discovers this automatically via
   * `GET /open-apis/bot/v3/info` during `connect()`, so configuring it here
   * is optional. A value supplied here overrides the auto-detected one.
   */
  botOpenId?: string
  /** Bot instance id; scopes conversation keys so two bots never share a Session. */
  botId?: string
  /** Working directory for Sessions created by this bot. */
  workspacePath?: string
  /** Agent composition mounted for each new Session. */
  readonly agentPreset?: string
  /** Permission preset applied to each Session. */
  permissionPreset?: string
  /** Ceiling on one reply, in characters, before truncation. */
  maxReplyChars?: number
}

/** Validate config facts a schema cannot express. */
function assertConfig (config: Config): void {
  if (config.oauthCallbackPath !== undefined && config.oauthCallbackPath !== '') {
    if (!config.oauthCallbackPath.startsWith('/') || config.oauthCallbackPath === '/'
      || config.oauthCallbackPath.endsWith('/')
      || config.oauthCallbackPath.includes('?') || config.oauthCallbackPath.includes('#')) {
      throw new Error(
        `dsh-im oauthCallbackPath must be an absolute non-root pathname without a trailing slash, query, or fragment`,
      )
    }
  }
  if (config.workspacePath !== undefined && config.workspacePath !== ''
    && !isAbsolute(config.workspacePath)) {
    throw new Error(
      `dsh-im workspacePath must be an absolute path, got ${JSON.stringify(config.workspacePath)}`,
    )
  }
  if (config.maxReplyChars !== undefined && config.maxReplyChars < 1) {
    throw new Error('dsh-im maxReplyChars must be at least 1')
  }
}

/**
 * The declared configuration.
 *
 * Exported as a Schemastery schema so the loader validates the profile's config
 * before `apply` runs. Without it Cordis passes the raw object through
 * unvalidated (`vendor/cordis/src/fiber.ts` only applies a schema when the
 * plugin exports one).
 */
export const Config: z<Required<Config>> = z.object({
  oauthCallbackPath: z.string().default('/oauth/feishu/callback'),
  appIdRef: z.string().default(''),
  appSecretRef: z.string().default(''),
  domain: z.string().default('feishu'),
  botOpenId: z.string().default(''),
  botId: z.string().default('feishu'),
  workspacePath: z.string().default(''),
  agentPreset: z.string().default('standard'),
  permissionPreset: z.string().default('default'),
  maxReplyChars: z.natural().default(4000),
})

/**
 * Resolve one credential reference.
 * @param ctx - plugin context supplying the credential provider, if any.
 * @param ref - the reference name; empty means "not configured".
 * @returns the secret value, or `undefined`.
 */
async function resolveSecret (
  ctx: Context,
  ref: string
): Promise<string | undefined> {
  if (ref === '') return undefined
  if (!isCredentialRefName(ref)) {
    ctx.logger.warn(
      `dsh-im: credential ref "${ref}" is not a valid name; use a shell-style `
      + 'identifier such as FEISHU_APP_ID',
    )
    return undefined
  }
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    ctx.logger.warn(
      `dsh-im: "${ref}" is configured but no credential provider is mounted`,
    )
    return undefined
  }
  const record = await credentials.resolve(credentialRef(ref))
  const value = record?.value
  if (value === undefined || value === '') {
    ctx.logger.warn(`dsh-im: credential "${ref}" is not configured`)
    return undefined
  }
  return value
}

export function apply (ctx: Context, config: Config): void {
  assertConfig(config)
  const resolved = config as Required<Config>

  /**
   * The transport — set once async init completes, then reused for the lifetime
   * of the plugin. A restart of the plugin (update or reload) discards it.
   */
  let transport: ImTransport | undefined

  /** Set once the dispatcher is wired by the Agent-stack injection below. */
  let dispatch: ((message: NormalizedMessage) => Promise<DispatchResult>) | undefined
  /** The Agent stack context, supplied by `ctx.inject` when those services exist. */
  let agentStack: Context | undefined
  /** Logged once each, so a busy callback cannot flood the log. */
  let warnedNoStack = false
  let warnedNoTransport = false

  const onMessage = async (message: NormalizedMessage): Promise<void> => {
    if (agentStack === undefined) {
      if (!warnedNoStack) {
        warnedNoStack = true
        ctx.logger.warn(
          'dsh-im: the Agent stack is not mounted, so inbound Feishu messages are '
          + 'acknowledged but never answered; compose an agent loop, agent presets, '
          + 'permission presets, session-title, and the workspace registry',
        )
      }
      return
    }
    if (transport === undefined) {
      if (!warnedNoTransport) {
        warnedNoTransport = true
        ctx.logger.warn(
          'dsh-im: no Feishu transport is connected, so replies cannot be sent; '
          + 'check appIdRef and appSecretRef',
        )
      }
      return
    }
    // Built lazily on first use: the Agent stack and the transport init resolve
    // independently and in either order, so a single "both are ready" hook would
    // be wrong. This also keeps the queue and Agent map alive across messages,
    // which is what gives a conversation Session continuity.
    dispatch ??= createDispatcher(agentStack, {
      botId: resolved.botId,
      workspacePath: resolved.workspacePath,
      agentPreset: resolved.agentPreset,
      permissionPreset: resolved.permissionPreset,
      maxReplyChars: resolved.maxReplyChars,
    }, {
      // A transport-backed adapter satisfying the FeishuApi contract needed by
      // dispatch.ts. The transport owns authentication, so no token mints here.
      tenantToken: async () => '',
      authorize: async () => { throw new Error('not available over WebSocket') },
      sendText: async (_token, target, text, replyTo) => {
        // Guard: by the time a message reaches dispatch, the transport must be
        // connected. If it isn't, the warning branch above caught it before
        // creating the dispatcher; this assertion exists because TypeScript
        // cannot track that temporal safety through the closure.
        await (transport as ImTransport).sendText(
          target, text, replyTo === undefined ? {} : { replyTo },
        )
      },
    })

    const result = await dispatch(message)
    if (!result.replied) {
      ctx.logger.info(
        `dsh-im: no reply for ${message.eventId} (${result.reason ?? 'unknown'})`,
      )
    }
  }

  // OAuth callback route — the only remaining HTTP endpoint. All traffic goes
  // through the WebSocket connection instead.
  if (resolved.oauthCallbackPath !== '') {
    ctx.effect(
      () => ctx.webServer.register({
        kind: 'exact',
        path: resolved.oauthCallbackPath,
        handler: (_req, res) => {
          res.statusCode = 501
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          res.end('OAuth callback is not wired to a bot store yet')
        },
      }),
      `dsh-im: ${resolved.oauthCallbackPath}`,
    )
  }

  /**
   * Wire the dispatcher once the Agent stack exists.
   *
   * `ctx.inject` (rather than a hard `inject` on this plugin) keeps route
   * registration independent of the Agent stack: the OAuth callback must answer
   * in a profile that has no agent loop, and the ordering between this plugin
   * and the bundle rows providing these services is not guaranteed.
   */
  ctx.inject(
    ['agents', 'agentPresets', 'agentDefaultModel', 'permissionPresets', 'sessionTitle', 'workspaceRegistry'],
    (agentCtx) => {
      agentStack = agentCtx
    },
  )

  // Build the transport once credentials resolve, then connect it.
  void (async () => {
    try {
      const appId = await resolveSecret(ctx, resolved.appIdRef)
      const appSecret = await resolveSecret(ctx, resolved.appSecretRef)
      if (appId !== undefined && appSecret !== undefined) {
        if (transport !== undefined) {
          // If init runs twice (should not happen, but guards against it), the
          // second transport replaces the first.
          await transport.dispose()
        }
        const { createFeishuTransport } = await import('./transport-feishu.ts')
        transport = await createFeishuTransport({
          appId,
          appSecret,
          domain: resolved.domain as 'feishu' | 'lark',
          logger: {
            debug: (m: string) => ctx.logger.debug('[dsh-im] ' + m),
            info: (m: string) => ctx.logger.info('[dsh-im] ' + m),
            warn: (m: string) => ctx.logger.warn('[dsh-im] ' + m),
            error: (m: string) => ctx.logger.error('[dsh-im] ' + m),
          },
        })

        transport.onMessage(onMessage)

        // Report connection state changes at the plugin level.
        transport.onConnectionChange((state) => {
          ctx.logger.info(`dsh-im: Feishu connection state -> ${state}`)
        })

        // Report rejected (policy-withheld) messages.
        transport.onReject((rejected) => {
          ctx.logger.info(
            `dsh-im: message ${rejected.messageId} rejected (${rejected.reason})`,
          )
        })

        await transport.connect()
        ctx.logger.info('dsh-im: Feishu WebSocket transport connected')
      } else {
        ctx.logger.info(
          'dsh-im: Feishu credentials not configured; transport not started. '
          + 'Set appIdRef and appSecretRef, or trigger the onboarding flow.',
        )
      }
    } catch (error: unknown) {
      ctx.logger.warn(
        'dsh-im: failed to start Feishu transport: '
        + (error instanceof Error ? error.message : String(error)),
      )
    }
  })()

  // Teardown: release the transport when the plugin stops or reloads.
  ctx.effect(
    () => async () => {
      if (transport !== undefined) {
        await transport.dispose()
        transport = undefined
      }
    },
    'dsh-im: dispose transport',
  )
}

export default { name, inject, Config, apply }