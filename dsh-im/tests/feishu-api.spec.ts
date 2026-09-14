import { describe, it, expect, vi } from 'vitest'
import { createFeishuApi } from '../src/feishu-api.ts'

/** One recorded request, captured so tests can assert on URL, headers, and body. */
interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

/**
 * Build a fake `fetch` from a path→response table.
 *
 * Responses are routed on the request URL's path so a test can assert the call
 * order (app token before OIDC) without stubbing by index.
 */
function fakeFetch (
  routes: Record<string, { status?: number; json: unknown }>
): { fetcher: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const path = new URL(url).pathname
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v
    }
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    const route = routes[path]
    if (route === undefined) throw new Error(`unexpected request: ${path}`)
    const status = route.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => route.json,
    } as Response
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

const CREDS = { appId: 'cli_app', appSecret: 'secret' }

/** The app-token endpoint's real response shape: token at the TOP level. */
const APP_TOKEN_OK = {
  '/open-apis/auth/v3/app_access_token/internal': {
    json: { code: 0, msg: 'ok', app_access_token: 'app-tok', expire: 7200 },
  },
}
/** The tenant-token endpoint's real response shape: also top level. */
const TENANT_TOKEN_OK = {
  '/open-apis/auth/v3/tenant_access_token/internal': {
    json: { code: 0, msg: 'ok', tenant_access_token: 'tenant-tok', expire: 7200 },
  },
}

describe('createFeishuApi.authorize', () => {
  it('obtains an app_access_token first, then sends it as the OIDC bearer', async () => {
    // The previous implementation called the OIDC endpoint with no authorization
    // header at all, so the exchange could never succeed.
    const { fetcher, calls } = fakeFetch({
      ...APP_TOKEN_OK,
      ...TENANT_TOKEN_OK,
      '/open-apis/authen/v1/oidc/access_token': {
        json: { code: 0, msg: 'ok', data: { access_token: 'user-tok', open_id: 'ou_bot', name: 'Bot' } },
      },
    })
    const api = createFeishuApi(CREDS, fetcher)

    const identity = await api.authorize('auth-code-1')

    const appCall = calls.find(c => c.url.includes('app_access_token'))
    expect(appCall?.body).toEqual({ app_id: 'cli_app', app_secret: 'secret' })

    const oidc = calls.find(c => c.url.includes('oidc/access_token'))
    // The bearer must be the app token, not the tenant token and not empty.
    expect(oidc?.headers['authorization']).toBe('Bearer app-tok')
    expect(oidc?.body).toEqual({ grant_type: 'authorization_code', code: 'auth-code-1' })

    expect(identity.botOpenId).toBe('ou_bot')
    expect(identity.botName).toBe('Bot')
    expect(identity.userAccessToken).toBe('user-tok')
  })

  it('reads the user identity from data, not from the top level', async () => {
    const { fetcher } = fakeFetch({
      ...APP_TOKEN_OK,
      ...TENANT_TOKEN_OK,
      // Top-level open_id present too: `data` must win, since that is where the
      // OIDC endpoint actually puts it.
      '/open-apis/authen/v1/oidc/access_token': {
        json: { code: 0, msg: 'ok', open_id: 'ou_WRONG', data: { access_token: 'u', open_id: 'ou_right', name: 'Right' } },
      },
    })
    const api = createFeishuApi(CREDS, fetcher)
    expect((await api.authorize('c')).botOpenId).toBe('ou_right')
  })

  it('reuses the cached app token across calls', async () => {
    let clock = 1_000_000
    const { fetcher, calls } = fakeFetch({
      ...APP_TOKEN_OK,
      ...TENANT_TOKEN_OK,
      '/open-apis/authen/v1/oidc/access_token': {
        json: { code: 0, msg: 'ok', data: { access_token: 'u', open_id: 'ou_bot', name: 'B' } },
      },
    })
    const api = createFeishuApi(CREDS, fetcher, 'https://open.feishu.cn', () => clock)

    await api.authorize('c1')
    await api.authorize('c2')
    const appCalls = calls.filter(c => c.url.includes('app_access_token'))
    expect(appCalls).toHaveLength(1)

    // Past the refresh skew (expire 7200s minus 60s), it must re-mint.
    clock += 7200_000
    await api.authorize('c3')
    expect(calls.filter(c => c.url.includes('app_access_token'))).toHaveLength(2)
  })

  it('fails loudly when a response omits the expected field', async () => {
    const { fetcher } = fakeFetch({
      '/open-apis/auth/v3/app_access_token/internal': { json: { code: 0, msg: 'ok' } },
    })
    const api = createFeishuApi(CREDS, fetcher)
    await expect(api.authorize('c')).rejects.toThrow(/app_access_token/)
  })

  it('surfaces a non-zero business code as an error', async () => {
    const { fetcher } = fakeFetch({
      '/open-apis/auth/v3/app_access_token/internal': { json: { code: 10003, msg: 'invalid app_secret' } },
    })
    const api = createFeishuApi(CREDS, fetcher)
    await expect(api.authorize('c')).rejects.toThrow(/invalid app_secret/)
  })
})

describe('createFeishuApi.tenantToken', () => {
  it('reads tenant_access_token from the top level', async () => {
    const { fetcher } = fakeFetch(TENANT_TOKEN_OK)
    const api = createFeishuApi(CREDS, fetcher)
    expect(await api.tenantToken()).toBe('tenant-tok')
  })

  it('does not confuse the app token with the tenant token', async () => {
    // Both caches must stay separate: sharing one slot let a tenant token be
    // handed to the OIDC call as its bearer.
    const { fetcher, calls } = fakeFetch({
      ...APP_TOKEN_OK,
      ...TENANT_TOKEN_OK,
      '/open-apis/authen/v1/oidc/access_token': {
        json: { code: 0, msg: 'ok', data: { access_token: 'u', open_id: 'ou_bot', name: 'B' } },
      },
    })
    const api = createFeishuApi(CREDS, fetcher)
    expect(await api.tenantToken()).toBe('tenant-tok')
    await api.authorize('c')
    const oidc = calls.find(c => c.url.includes('oidc/access_token'))
    expect(oidc?.headers['authorization']).toBe('Bearer app-tok')
  })
})

describe('createFeishuApi.sendText', () => {
  it('declares the receive_id_type matching the id it sends', async () => {
    const { fetcher, calls } = fakeFetch({
      '/open-apis/im/v1/messages': { json: { code: 0, msg: 'ok', data: {} } },
    })
    const api = createFeishuApi(CREDS, fetcher)

    await api.sendText('tok', { receiveIdType: 'open_id', receiveId: 'ou_user_1' }, 'hi')

    const call = calls[0]
    expect(call?.url).toContain('receive_id_type=open_id')
    expect(call?.body).toEqual({
      receive_id: 'ou_user_1',
      msg_type: 'text',
      content: JSON.stringify({ text: 'hi' }),
    })
    expect(call?.headers['authorization']).toBe('Bearer tok')
  })

  it('sends chat_id for a group target', async () => {
    const { fetcher, calls } = fakeFetch({
      '/open-apis/im/v1/messages': { json: { code: 0, msg: 'ok', data: {} } },
    })
    const api = createFeishuApi(CREDS, fetcher)
    await api.sendText('tok', { receiveIdType: 'chat_id', receiveId: 'oc_1' }, 'hi')
    expect(calls[0]?.url).toContain('receive_id_type=chat_id')
    expect((calls[0]?.body as Record<string, unknown>)['receive_id']).toBe('oc_1')
  })

  it('replies to a message id instead of using a receive_id', async () => {
    const { fetcher, calls } = fakeFetch({
      '/open-apis/im/v1/messages/om_1/reply': { json: { code: 0, msg: 'ok', data: {} } },
    })
    const api = createFeishuApi(CREDS, fetcher)
    await api.sendText('tok', { receiveIdType: 'chat_id', receiveId: 'oc_1' }, 'hi', 'om_1')

    const call = calls[0]
    // A reply is addressed by the message; it must carry no receive_id at all.
    expect(call?.url).not.toContain('receive_id_type')
    expect(call?.body).toEqual({ msg_type: 'text', content: JSON.stringify({ text: 'hi' }) })
  })

  it('encodes a message id so it cannot break out of the path', async () => {
    const { fetcher, calls } = fakeFetch({
      '/open-apis/im/v1/messages/om_a%2Fb/reply': { json: { code: 0, msg: 'ok', data: {} } },
    })
    const api = createFeishuApi(CREDS, fetcher)
    await api.sendText('tok', { receiveIdType: 'chat_id', receiveId: 'oc_1' }, 'hi', 'om_a/b')
    expect(calls[0]?.url).toContain('om_a%2Fb')
  })
})
