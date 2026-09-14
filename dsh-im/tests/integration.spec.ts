/**
 * Integration: the plugin inside a REAL Cordis tree.
 *
 * The unit tests call `apply` with a hand-rolled fake context, which cannot prove
 * that `ctx.inject` really gates on service availability, that a `provide`d
 * service resolves through the context, or that `ctx.effect` ownership unwinds.
 * This test boots the shipped plugin against real Cordis with stub services
 * standing in for the harness, then drives a real request through the route the
 * plugin registered.
 *
 * Only the *harness's own* services are stubbed. The plugin, its handler, its
 * dispatch, and its reply path are the real compiled build.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes, createCipheriv } from 'node:crypto'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import plugin, { Config, name as pluginName } from '../src/index.ts'

const ENCRYPT_KEY = 'integration-encrypt-key'
const BOT = 'ou_bot'

/** A route handler as the plugin registers it. */
type RouteHandler = (req: IncomingMessage, res: ServerResponse) => unknown

/** Official Feishu signature: plain SHA-256 over the concatenated prefix. */
function sign (raw: string, timestamp: string, nonce: string, key: string): string {
  return createHash('sha256').update(timestamp + nonce + key + raw).digest('hex')
}

/** Encrypt the way Feishu does: SHA256(key) raw bytes, in-band IV, base64. */
function encrypt (plaintext: string, encryptKey: string): string {
  const key = createHash('sha256').update(encryptKey).digest()
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([iv, cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64')
}

/**
 * The harness services this plugin consumes, as stubs.
 *
 * The Agent stub models the one behaviour that matters: `followup` appends a turn
 * to a session log and `whenIdle` resolves afterwards, so the plugin's
 * reply-reading path runs against a log that actually grows.
 */
function makeStack (reply: string) {
  const log: Array<Record<string, unknown>> = []
  const agent = {
    session: { get seq () { return log.length }, eventAt: (seq: number) => log[seq] },
    followup: () => {
      log.push({ type: 'turn/start', data: { turn: 1 } })
      log.push({
        type: 'assistant/message',
        data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: reply }] } },
      })
      log.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    },
    whenIdle: async () => {},
  }
  /** Text delivered through the stubbed Feishu HTTP endpoint. */
  const sentText: string[] = []
  const created = vi.fn(async () => ({ agent, dispose: async () => {} }))
  return {
    sentText,
    created,
    services: {
      agents: { create: created },
      agentPresets: {
        resolve: async (id?: string) => ({ id: id ?? 'standard' }),
        mount: async () => {},
        standingKeyFor: async () => 'key',
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      permissionPresets: { resolve: () => 'default', set: () => {} },
      sessionTitle: { rename: () => {} },
      workspaceRegistry: {
        create: async (path: string) => ({ path, attachSession: async () => {} }),
      },
      credentials: {
        resolve: async (name: string) => ({
          value: name === 'FEISHU_APP_SECRET' ? 'secret' : ENCRYPT_KEY,
          source: 'stub',
        }),
      },
    },
  }
}

/** Routes registered by the tree currently booting. */
let routes = new Map<string, RouteHandler>()

const live: Array<() => Promise<void>> = []

/** The real `fetch` captured once, so a stub can be undone between tests. */
const realFetch = globalThis.fetch

/**
 * Replace `fetch` with a stub that answers Feishu's token and message endpoints.
 *
 * The plugin builds its API client with the ambient `fetch`, so the client under
 * test is real — only the remote host is replaced. Without this the suite would
 * make real network calls to open.feishu.cn and fail on a sandboxed machine.
 * @param onSend - receives the text of each outbound message.
 */
function stubFetch (onSend: (text: string) => void): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/tenant_access_token/') || url.includes('/app_access_token/')) {
      return new Response(JSON.stringify({
        code: 0,
        tenant_access_token: 't-stub',
        app_access_token: 'a-stub',
        expire: 7200,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/im/v1/messages')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { content?: string }
      const content = JSON.parse(body.content ?? '{}') as { text?: string }
      onSend(content.text ?? '')
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`unexpected fetch in integration test: ${url}`)
  }) as typeof fetch
}

afterEach(async () => {
  globalThis.fetch = realFetch
  for (const dispose of live.splice(0)) await dispose()
})

/**
 * Boot the real plugin against real Cordis with stubbed harness services.
 * @param options - reply text, omitted services, and config overrides.
 * @returns the booted tree's observable surface.
 */
async function boot (
  options: { reply?: string; omit?: readonly string[]; config?: Record<string, unknown> } = {},
) {
  const stack = makeStack(options.reply ?? 'integration reply')
  routes = new Map()
  const warnings: string[] = []
  const omit = new Set(options.omit ?? [])
  // The plugin's API client uses the ambient fetch; stub the remote host only.
  stubFetch(text => { stack.sentText.push(text) })

  const ctx = new Context()
  const fiber = ctx.plugin({
    name: 'test-harness-stubs',
    apply (sc: Context) {
      // `ctx.logger` is a Cordis builtin, so it cannot be replaced with
      // `provide`. An exporter is the supported capture point; it unregisters
      // with this fiber.
      sc.logger.exporter({
        colors: false,
        // Cordis levels are ERROR=0, INFO=1, WARN=2, DEBUG=3, and an exporter's
        // threshold defaults to INFO — which would filter out the very `warn`
        // calls this capture exists to observe.
        levels: { default: 3 },
        // `args` carries the formatted arguments of the log call.
        export: (message: { args: unknown[] }) => {
          warnings.push(message.args.map(String).join(' '))
        },
      })
      sc.provide('webServer', {
        register (route: { path: string; handler: RouteHandler }) {
          routes.set(route.path, route.handler)
          return () => { routes.delete(route.path) }
        },
      })
      for (const [key, value] of Object.entries(stack.services)) {
        if (omit.has(key)) continue
        sc.provide(key, value)
      }
    },
  })
  await fiber

  const validated = Config['~standard'].validate({
    encryptKeyRef: 'FEISHU_ENCRYPT_KEY',
    appIdRef: 'FEISHU_APP_ID',
    appSecretRef: 'FEISHU_APP_SECRET',
    botOpenId: BOT,
    workspacePath: '/tmp/ws',
    ...options.config,
  })
  if (validated instanceof Promise || validated.issues !== undefined) {
    throw new Error(`invalid test config: ${JSON.stringify(validated)}`)
  }

  // Pass the real default export (name/inject/Config/apply), exactly the shape
  // the Loader hands to Cordis. Passing the bare `apply` would drop `inject`,
  // and Cordis refuses `ctx.webServer` for a plugin that never declared it.
  await ctx.plugin(plugin as never, validated.value as never)
  // Secret resolution is async and gates construction of the API client.
  await new Promise(resolve => setTimeout(resolve, 20))

  live.push(async () => { await ctx.fiber.dispose() })
  return { routes, warnings, stack, ctx }
}

/** POST one signed+encrypted v2.0 callback to a route. */
async function post (
  handler: RouteHandler,
  plaintext: string,
  tamper = false,
): Promise<{ status: number; body: string }> {
  const body = JSON.stringify({ encrypt: encrypt(plaintext, ENCRYPT_KEY) })
  const timestamp = '1700000000'
  const nonce = 'nonce-1'
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-lark-request-timestamp': timestamp,
    'x-lark-request-nonce': nonce,
    'x-lark-signature': tamper
      ? 'f'.repeat(64)
      : sign(body, timestamp, nonce, ENCRYPT_KEY),
  }
  const req = Readable.from([Buffer.from(body, 'utf8')]) as unknown as IncomingMessage
  req.method = 'POST'
  req.headers = headers
  req.headersDistinct = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, [v]]))
  Object.defineProperty(req, 'complete', { value: true })

  const state = {
    status: 0,
    body: '',
    setHeader: () => {},
    writeHead (status: number) { state.status = status; return state },
    end (chunk?: string) { state.body = chunk ?? '' },
  }
  await handler(req, state as unknown as ServerResponse)
  // Let the dispatch tail settle.
  await new Promise(resolve => setTimeout(resolve, 30))
  return { status: state.status, body: state.body }
}

/** A v2.0 text-message envelope. */
function envelope (text: string): string {
  return JSON.stringify({
    schema: '2.0',
    header: { event_id: 'evt_int', event_type: 'im.message.receive_v1' },
    event: {
      sender: { sender_id: { open_id: 'ou_user' } },
      message: {
        message_id: 'om_1',
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text }),
      },
    },
  })
}

describe('integration — the plugin against real Cordis', () => {
  it('registers both routes on the web server it depends on', async () => {
    const { routes: r } = await boot()
    expect([...r.keys()].sort()).toEqual([
      '/oauth/feishu/callback',
      '/webhooks/feishu',
    ])
  })

  it('takes a signed callback end to end and sends the reply back', async () => {
    const { routes: r, stack } = await boot({ reply: 'hello from the agent' })
    const res = await post(r.get('/webhooks/feishu')!, envelope('hi there'))

    expect(res.status).toBe(200)
    // The reply travelled the plugin's real client and reached the Feishu endpoint.
    expect(stack.sentText).toEqual(['hello from the agent'])
  })

  it('rejects a forged signature with 401 and never dispatches', async () => {
    const { routes: r, stack } = await boot()
    const res = await post(r.get('/webhooks/feishu')!, envelope('spoofed'), true)

    expect(res.status).toBe(401)
    expect(stack.sentText).toHaveLength(0)
  })

  it('reuses one Agent for two messages in the same conversation', async () => {
    const { routes: r, stack } = await boot({ reply: 'again' })
    const handler = r.get('/webhooks/feishu')!
    await post(handler, envelope('one'))
    await post(handler, envelope('two'))

    expect(stack.created).toHaveBeenCalledOnce()
    expect(stack.sentText).toHaveLength(2)
  })

  it('answers the challenge handshake without sending a reply', async () => {
    const { routes: r, stack } = await boot()
    const challenge = JSON.stringify({
      schema: '2.0',
      header: { event_id: 'e', event_type: 'url_verification' },
      event: { challenge: 'chal-123' },
    })
    const res = await post(r.get('/webhooks/feishu')!, challenge)

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body).challenge).toBe('chal-123')
    expect(stack.sentText).toHaveLength(0)
  })

  it('keeps answering the callback when the Agent stack is absent', async () => {
    // The route must survive a profile with no agent loop: `ctx.inject` parks its
    // callback instead of blocking `apply`, so the callback still acknowledges.
    const { routes: r, stack, warnings } = await boot({ omit: ['agents'] })
    expect(r.has('/webhooks/feishu')).toBe(true)

    const res = await post(r.get('/webhooks/feishu')!, envelope('hi'))

    expect(res.status).toBe(200)
    expect(stack.sentText).toHaveLength(0)
    expect(warnings.join(' ')).toContain('Agent stack is not mounted')
  })

  it('removes both routes when the tree disposes', async () => {
    // Proves ctx.effect ownership: a stop or update must not leave stale handlers.
    const { routes: r } = await boot()
    expect(r.size).toBe(2)
    for (const dispose of live.splice(0)) await dispose()
    expect(r.size).toBe(0)
  })
})

describe('integration — the shipped build matches source', () => {
  it('exposes the same plugin identity from lib/ as from src/', async () => {
    const mod = await import('../lib/index.js') as { default: { name: string } }
    expect(mod.default.name).toBe(pluginName)
  })
})
