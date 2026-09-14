/**
 * Feishu Open API client.
 *
 * Callers inject `fetch` so every path is deterministic under test.
 *
 * The three structural mistakes the previous version made, and what replaces
 * them:
 *
 * 1. **No `app_access_token`.** `/open-apis/authen/v1/oidc/access_token` requires
 *    `Authorization: Bearer <app_access_token>`, and that token is minted from
 *    app_id + app_secret at `/open-apis/auth/v3/app_access_token/internal`. The
 *    old code called the OIDC endpoint with no authorization header at all, so
 *    the exchange could never succeed. {@link FeishuCredentials} now carries the
 *    app pair, and the app token is cached until shortly before it expires.
 * 2. **The wrong response fields.** The internal endpoints return
 *    `tenant_access_token` / `app_access_token` at the *top level* of the body,
 *    while the OIDC endpoint returns the user token under `data`. The old code
 *    read `body.data.tenant_access_token`, a path no endpoint populates.
 * 3. **A hard-coded `receive_id_type`.** The old sender always declared
 *    `chat_id` while callers could hand it a composite conversation key. The
 *    receive-id type and value now travel together as a {@link ReplyTarget}.
 *
 * @module dsh-im/api
 */

import type { ReplyTarget } from './feishu.ts'

/** App credentials used to mint token-bearing requests. */
export interface FeishuCredentials {
  readonly appId: string
  readonly appSecret: string
}

/** The identity resolved for one authorized bot. */
export interface FeishuIdentity {
  /** Token for calling app-scoped APIs such as sending a message. */
  readonly tenantAccessToken: string
  /** OAuth user token returned by the code exchange, when one was requested. */
  readonly userAccessToken?: string
  readonly botOpenId: string
  readonly botName: string
  readonly tenantName?: string
}

/** Feishu REST surface the adapter depends on. */
export interface FeishuApi {
  /** Exchange an OAuth authorization code for the authorizing user's identity. */
  authorize (code: string): Promise<FeishuIdentity>
  /** Mint (or reuse) an app-scoped tenant token. */
  tenantToken (): Promise<string>
  /** Send one plain-text message to a chat or user. */
  sendText (
    token: string,
    target: ReplyTarget,
    text: string,
    replyTo?: string
  ): Promise<void>
}

/** Refresh an app token this long before its stated expiry. */
const TOKEN_REFRESH_SKEW_MS = 60_000

/** Read a non-empty string field, or throw naming the endpoint that omitted it. */
function requiredString (
  record: Record<string, unknown>,
  field: string,
  where: string
): string {
  const value = record[field]
  if (typeof value !== 'string' || value === '') {
    throw new Error(`feishu ${where} response is missing "${field}"`)
  }
  return value
}

/**
 * Create a Feishu client.
 * @param credentials - the app id/secret pair used for app tokens.
 * @param fetcher - HTTP implementation; injectable for tests.
 * @param baseUrl - API host, overridable to target Lark's international host.
 * @param now - clock, injectable so token-expiry behaviour is testable.
 * @returns the client.
 */
export function createFeishuApi (
  credentials: FeishuCredentials,
  fetcher: typeof fetch = fetch,
  baseUrl = 'https://open.feishu.cn',
  now: () => number = () => Date.now()
): FeishuApi {
  /** One cached bearer with the epoch-ms instant it stops being usable. */
  interface CachedToken {
    token: string
    usableUntil: number
  }

  // App and tenant tokens are distinct credentials with different scopes: the
  // app token authenticates the OIDC exchange, the tenant token authenticates
  // message sends. Sharing one cache slot would let `appToken()` hand a tenant
  // token to the OIDC call, so each keeps its own.
  let cachedAppToken: CachedToken | undefined
  let cachedTenantToken: CachedToken | undefined

  /** Epoch-ms instant a token with `expiresIn` seconds stops being usable. */
  const usableUntil = (expiresIn: unknown): number => {
    const lifetimeSeconds = typeof expiresIn === 'number' ? expiresIn : 7200
    return now() + Math.max(0, lifetimeSeconds * 1000 - TOKEN_REFRESH_SKEW_MS)
  }

  const request = async (
    path: string,
    init: RequestInit,
    where: string
  ): Promise<Record<string, unknown>> => {
    const response = await fetcher(`${baseUrl}${path}`, init)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new Error(
        `feishu ${where} returned a non-JSON response (HTTP ${response.status})`
      )
    }
    const record =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {}
    if (!response.ok || record['code'] !== 0) {
      throw new Error(
        `feishu ${where} failed: ${String(record['msg'] ?? response.status)}`
      )
    }
    return record
  }

  const mintAppToken = async (): Promise<string> => {
    const body = await request(
      '/open-apis/auth/v3/app_access_token/internal',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          app_id: credentials.appId,
          app_secret: credentials.appSecret
        })
      },
      'app_access_token'
    )
    // Both token fields sit at the top level of this response, not under `data`.
    const token = requiredString(body, 'app_access_token', 'app_access_token')
    cachedAppToken = { token, usableUntil: usableUntil(body['expire']) }
    return token
  }

  const appToken = async (): Promise<string> => {
    if (cachedAppToken !== undefined && now() < cachedAppToken.usableUntil) {
      return cachedAppToken.token
    }
    return mintAppToken()
  }

  const tenantToken = async (): Promise<string> => {
    if (cachedTenantToken !== undefined && now() < cachedTenantToken.usableUntil) {
      return cachedTenantToken.token
    }
    const body = await request(
      '/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          app_id: credentials.appId,
          app_secret: credentials.appSecret
        })
      },
      'tenant_access_token'
    )
    // Also top-level, and a different credential from the app token above.
    const token = requiredString(
      body,
      'tenant_access_token',
      'tenant_access_token'
    )
    cachedTenantToken = { token, usableUntil: usableUntil(body['expire']) }
    return token
  }

  return {
    tenantToken,

    async authorize (code) {
      // The OIDC exchange is authenticated by the app token, so it must be
      // obtained first; this was the missing step in the previous version.
      const bearer = await appToken()
      const body = await request(
        '/open-apis/authen/v1/oidc/access_token',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${bearer}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ grant_type: 'authorization_code', code })
        },
        'oidc/access_token'
      )
      // Unlike the token endpoints, this one nests its payload under `data`.
      const data = body['data']
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw new Error('feishu oidc/access_token response is missing "data"')
      }
      const record = data as Record<string, unknown>
      const botOpenId = requiredString(record, 'open_id', 'oidc/access_token')
      return {
        // Sending a message needs a tenant token; the user token identifies the
        // authorizing user but is not what the message API takes.
        tenantAccessToken: await tenantToken(),
        userAccessToken: requiredString(
          record,
          'access_token',
          'oidc/access_token'
        ),
        botOpenId,
        botName:
          typeof record['name'] === 'string' && record['name'] !== ''
            ? record['name']
            : botOpenId,
        ...(typeof record['tenant_name'] === 'string'
          ? { tenantName: record['tenant_name'] }
          : {})
      }
    },

    async sendText (token, target, text, replyTo) {
      const content = JSON.stringify({ text })
      // A reply is addressed by the message being answered; an unsolicited send
      // by the receive id, whose *type* must match the id.
      await request(
        replyTo === undefined
          ? `/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(target.receiveIdType)}`
          : `/open-apis/im/v1/messages/${encodeURIComponent(replyTo)}/reply`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify(
            replyTo === undefined
              ? {
                  receive_id: target.receiveId,
                  msg_type: 'text',
                  content
                }
              : { msg_type: 'text', content }
          )
        },
        'im/v1/messages'
      )
    }
  }
}
