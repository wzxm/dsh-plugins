/**
 * dsh-im — Feishu/Lark IM adapter for DeepSeek Harness.
 *
 * The plugin owns two exact routes on the injected WebServer: the event callback
 * and the OAuth redirect. Both are the application's own endpoints — a webhook
 * is authenticated by its signature, not by the browser session that guards
 * `/api`, so neither sits behind the connection trust fence by design.
 *
 * ## Why `webhookRuntime` is optional
 *
 * The harness webhook runtime is the natural destination for an inbound message,
 * but **no shipped bundle composes it**. Declaring it in `inject` would park this
 * plugin in PENDING forever: `apply` would never run, so the routes below would
 * never register and the adapter would be silently absent. It is therefore read
 * with `ctx.get` at dispatch time, and a profile without it logs a warning
 * instead of going dark.
 *
 * The same reasoning applies to `credentials`: secrets are resolved per request
 * and a profile without a credential provider falls back to the composition
 * entry itself.
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
import { createFeishuApi, type FeishuApi } from './feishu-api.ts'
import { createDispatcher, type DispatchResult } from './dispatch.ts'
import { createFeishuHandler } from './handler.ts'
import type { NormalizedMessage } from './event.ts'

export * from './event.ts'
export * from './feishu.ts'
export * from './feishu-api.ts'
export * from './signature.ts'
export * from './decrypt.ts'
export * from './session-bridge.ts'
export * from './dispatch.ts'
export * from './bot-store.ts'
export * from './quick-onboarding.ts'

export const name = 'dsh-im'

/**
 * Only the web server is a hard dependency: it is the socket this plugin
 * registers on, and there is nothing to do without it.
 */
export const inject = ['webServer']

export interface Config {
  /** Exact absolute path for Feishu event callbacks. */
  callbackPath: string
  /** Exact absolute path for the OAuth redirect. */
  oauthCallbackPath: string
  /**
   * Credential reference holding the Feishu Encrypt Key. When present, inbound
   * callbacks are signature-verified and decrypted. Empty disables both, which
   * is only appropriate for a trusted local tunnel during setup.
   */
  encryptKeyRef?: string
  /** Credential reference holding the Verification Token. */
  verificationTokenRef?: string
  /** Credential reference holding the app_id, used for token exchanges. */
  appIdRef?: string
  /** Credential reference holding the app_secret. */
  appSecretRef?: string
  /**
   * The bot's own `open_id`, matched against group-message mentions.
   *
   * This cannot be discovered from an inbound callback: Feishu identifies the
   * *author* of a mention, never the reader. Without it every group message is
   * discarded (a group message that does not mention the bot is not for us), so
   * it is required for group use even though p2p works without it.
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
  /** Raw callback body ceiling in bytes. */
  maxBodyBytes?: number
}

/** Validate route and ref facts a schema cannot express. */
function assertConfig (config: Config): void {
  for (const [field, value] of [
    ['callbackPath', config.callbackPath],
    ['oauthCallbackPath', config.oauthCallbackPath],
  ] as const) {
    if (!value.startsWith('/') || value === '/' || value.endsWith('/')
      || value.includes('?') || value.includes('#')) {
      throw new Error(
        `dsh-im ${field} must be an absolute non-root pathname without a trailing slash, query, or fragment`,
      )
    }
  }
  if (config.callbackPath === config.oauthCallbackPath) {
    throw new Error('dsh-im callbackPath and oauthCallbackPath must differ')
  }
  // The workspace registry rejects a relative path, and a Session created with a
  // bad cwd fails only once a message arrives. Validating at activation turns a
  // silent per-message failure into a startup error. `assertConfig` runs on the
  // pre-default config, so an absent value is fine here.
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
  callbackPath: z.string().default('/webhooks/feishu'),
  oauthCallbackPath: z.string().default('/oauth/feishu/callback'),
  encryptKeyRef: z.string().default(''),
  verificationTokenRef: z.string().default(''),
  appIdRef: z.string().default(''),
  appSecretRef: z.string().default(''),
  botOpenId: z.string().default(''),
  botId: z.string().default('feishu'),
  workspacePath: z.string().default(''),
  agentPreset: z.string().default('standard'),
  permissionPreset: z.string().default('default'),
  maxReplyChars: z.natural().default(4000),
  maxBodyBytes: z.natural().default(1_048_576),
})

/**
 * Resolve one optional credential reference.
 * @param ctx - plugin context supplying the credential provider, if any.
 * @param ref - the reference name; empty means "not configured".
 * @returns the secret value, or `undefined`.
 */
async function resolveSecret (
  ctx: Context,
  ref: string
): Promise<string | undefined> {
  if (ref === '') return undefined
  // A name outside the credential grammar has no reference to miss, so it reads
  // as "not configured" instead of throwing from deep inside the provider. The
  // grammar is a POSIX shell identifier (e.g. `FEISHU_ENCRYPT_KEY`), which a
  // hyphenated name like `feishu-encrypt-key` would violate.
  if (!isCredentialRefName(ref)) {
    ctx.logger.warn(
      `dsh-im: credential ref "${ref}" is not a valid name; use a shell-style `
      + 'identifier such as FEISHU_ENCRYPT_KEY',
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
   * Secrets are read once at activation. Re-resolving per request would make
   * every callback depend on the credential provider staying responsive, and a
   * rotated key can be picked up by reloading the plugin.
   */
  let encryptKey: string | undefined
  let verificationToken: string | undefined
  /** Fixed at activation; a changed open_id needs a plugin reload anyway. */
  const botOpenId = resolved.botOpenId

  /** Set once the dispatcher is wired by the Agent-stack injection below. */
  let dispatch: ((message: NormalizedMessage) => Promise<DispatchResult>) | undefined
  /** Set once the app credentials resolve into a usable API client. */
  let api: FeishuApi | undefined
  /** The Agent stack context, supplied by `ctx.inject` when those services exist. */
  let agentStack: Context | undefined
  /** Logged once each, so a busy callback cannot flood the log. */
  let warnedNoStack = false
  let warnedNoApi = false

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
    if (api === undefined) {
      if (!warnedNoApi) {
        warnedNoApi = true
        ctx.logger.warn(
          'dsh-im: no Feishu app credentials are configured, so replies cannot be '
          + 'sent; set appIdRef and appSecretRef',
        )
      }
      return
    }
    // Built lazily on first use: the Agent stack and the credentials resolve
    // independently and in either order, so a single "both are ready" hook would
    // be wrong. This also keeps the queue and Agent map alive across messages,
    // which is what gives a conversation Session continuity.
    dispatch ??= createDispatcher(agentStack, {
      botId: resolved.botId,
      workspacePath: resolved.workspacePath,
      agentPreset: resolved.agentPreset,
      permissionPreset: resolved.permissionPreset,
      maxReplyChars: resolved.maxReplyChars,
    }, api)

    const result = await dispatch(message)
    if (!result.replied) {
      ctx.logger.info(
        `dsh-im: no reply for ${message.eventId} (${result.reason ?? 'unknown'})`,
      )
    }
  }

  const handler = createFeishuHandler(ctx, {
    get encryptKey () { return encryptKey },
    get verificationToken () { return verificationToken },
    get botOpenId () { return botOpenId },
    maxBodyBytes: resolved.maxBodyBytes,
    onMessage,
  })

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: resolved.callbackPath,
      handler,
    }),
    `dsh-im: ${resolved.callbackPath}`,
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: resolved.oauthCallbackPath,
      handler: (_req, res) => {
        // The OAuth redirect is answered 501 until the code exchange is wired to
        // a bot store; failing loudly beats accepting a code nothing consumes.
        res.statusCode = 501
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end('OAuth callback is not wired to a bot store yet')
      },
    }),
    `dsh-im: ${resolved.oauthCallbackPath}`,
  )

  /**
   * Wire the dispatcher once the Agent stack exists.
   *
   * `ctx.inject` (rather than a hard `inject` on this plugin) keeps route
   * registration independent of the Agent stack: the callback route must answer
   * in a profile that has no agent loop, and the ordering between this plugin
   * and the bundle rows providing these services is not guaranteed.
   */
  ctx.inject(
    ['agents', 'agentPresets', 'agentDefaultModel', 'permissionPresets', 'sessionTitle', 'workspaceRegistry'],
    (agentCtx) => {
      agentStack = agentCtx
    },
  )

  // Secrets resolve asynchronously after the routes exist, so a slow credential
  // provider cannot delay registration. Requests arriving first are answered
  // fail-closed by the handler.
  void (async () => {
    try {
      encryptKey = await resolveSecret(ctx, resolved.encryptKeyRef)
      verificationToken = await resolveSecret(ctx, resolved.verificationTokenRef)
      const appId = await resolveSecret(ctx, resolved.appIdRef)
      const appSecret = await resolveSecret(ctx, resolved.appSecretRef)
      if (appId !== undefined && appSecret !== undefined) {
        api = createFeishuApi({ appId, appSecret })
      }
    } catch (error: unknown) {
      ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
    }
  })()
}

export default { name, inject, Config, apply }
