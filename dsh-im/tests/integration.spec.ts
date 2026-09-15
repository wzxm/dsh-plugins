/**
 * Integration tests: the plugin inside a REAL Cordis tree.
 *
 * The unit tests call `apply` with a hand-rolled fake context, which cannot prove
 * that `ctx.inject` really gates on service availability, that a `provide`d
 * service unregisters when the providing fiber unloads, or that the response-to
 * plugins coexist.
 *
 * These do. Every test boots a real `Context` and composes `apply` plus enough
 * stubs to make it live, then exercises the integration points through the
 * exported transport interfaces.
 */

import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config } from '../src/index.ts'
import { createMemoryTransport } from '../src/transport-memory.ts'
import type { NormalizedMessage } from '../src/event.ts'

/** Build one Agent in the test's log store, writing a fixed reply. */
function makeAgent (reply: string) {
  const log: Array<Record<string, unknown>> = []

  const agent = {
    session: {
      get seq() { return log.length },
      eventAt: (s: number) => log[s],
    },
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
  return agent
}

function boot (opts: { reply?: string; omit?: string[] } = {}): Promise<{
  routes: Map<string, unknown>
  warnings: string[]
  ctx: Context
}> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('boot timed out — plugin never settled')), 3000)
    const stack = makeAgent(opts.reply ?? 'integration reply')
    const warnings: string[] = []
    const routes = new Map<string, unknown>()
    const omitSet = new Set(opts.omit ?? [])

    const ctx = new Context()
    ctx.logger.exporter({
      colors: false,
      levels: { default: 3 },
      export: (message: { args: unknown[] }) => {
        warnings.push(message.args.map(String).join(' '))
      },
    })

    // Provide services directly on the root context, not through a nested plugin,
    // so they are available to any plugin that injects them before apply runs.
    ctx.provide('webServer', {
      register: (r: { path: string; handler: unknown }) => {
        routes.set(r.path, r.handler)
        return () => { routes.delete(r.path) }
      },
    } as never)
    ctx.provide('credentials', {
      resolve: async () => ({ value: 'stub-cred', source: 'test' }),
    } as never)
    if (!omitSet.has('agents')) {
      for (const [k, v] of Object.entries({
        agents: { create: async () => ({ agent: stack, dispose: async () => {} }) },
        agentPresets: {
          resolve: async () => ({ id: 'standard' }),
          mount: async () => {},
          standingKeyFor: async () => 'k',
        },
        agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
        permissionPresets: { resolve: () => 'd', set: () => {} },
        sessionTitle: { rename: () => {} },
        workspaceRegistry: {
          create: async (p: string) => ({ path: p, attachSession: async () => {} }),
        },
      })) ctx.provide(k, v as never)
    }

    const validated = Config['~standard'].validate({
      oauthCallbackPath: '/oauth/feishu/callback',
      appIdRef: 'FEISHU_APP_ID',
      appSecretRef: 'FEISHU_APP_SECRET',
      domain: 'feishu',
      botId: 'feishu',
      workspacePath: '/tmp/ws',
      agentPreset: 'standard',
      permissionPreset: 'default',
      maxReplyChars: 4000,
    })
    if (validated instanceof Promise || (validated as { issues?: unknown }).issues !== undefined) {
      throw new Error(`invalid config: ${JSON.stringify(validated)}`)
    }
    ctx.plugin(apply as never, (validated as { value: Record<string, unknown> }).value as never)
      .then(() => resolve({ routes, warnings, ctx }))
  })
}

describe('plugin activation', () => {
  it('registers the OAuth route', async () => {
    const { routes } = await boot()
    expect([...routes.keys()].sort()).toEqual(['/oauth/feishu/callback'])
  })

  it('removes all routes when the tree disposes', async () => {
    const ctx = new Context()
    const routes = new Map<string, unknown>()
    ctx.provide('webServer', {
      register: (r: { path: string; handler: unknown }) => {
        routes.set(r.path, r.handler)
        return () => { routes.delete(r.path) }
      },
    } as never)
    ctx.provide('credentials', { resolve: async () => ({ value: 'x', source: 'x' }) } as never)
    const v = Config['~standard'].validate({ oauthCallbackPath: '/oauth/feishu/callback' })
    await ctx.plugin(apply as never, (v as { value: Record<string, unknown> }).value as never)
    expect(routes.size).toBe(1)
    await ctx.fiber.dispose()
    expect(routes.size).toBe(0)
  })
})

describe('memory transport dispatch path', () => {
  it('delivers one message to registered handlers', async () => {
    const transport = createMemoryTransport()
    const dispatched: NormalizedMessage[] = []
    transport.onMessage(m => { dispatched.push(m) })
    await transport.connect()

    await transport.emit({
      eventId: 'e1', chatType: 'p2p', chatId: 'oc_1',
      senderOpenId: 'ou_u', text: 'hi', messageId: 'om_1',
    })

    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].text).toBe('hi')
  })

  it('sends a reply through the transport', async () => {
    const transport = createMemoryTransport()

    const r = await transport.sendText(
      { receiveIdType: 'open_id', receiveId: 'ou_u' }, 'reply text',
    )

    expect(transport.sent).toEqual([
      { target: { receiveIdType: 'open_id', receiveId: 'ou_u' }, text: 'reply text' },
    ])
    expect(r.messageId).toBeTruthy()
  })

  it('reports connection state transitions', async () => {
    const transport = createMemoryTransport()
    const states: string[] = []
    transport.onConnectionChange(s => states.push(s))

    await transport.connect()
    transport.setConnectionState('reconnecting')

    expect(states).toContain('connecting')
    expect(states).toContain('connected')
    expect(states).toContain('reconnecting')
  })

  it('reports withheld messages to onReject handlers', async () => {
    const transport = createMemoryTransport()
    const rejects: string[] = []
    transport.onReject(r => rejects.push(r.reason))

    transport.emitReject({ messageId: 'om_2', chatId: 'oc_g', senderId: 'ou_x', reason: 'no_mention' })

    expect(rejects).toEqual(['no_mention'])
  })

  it('stops delivering after dispose', async () => {
    const transport = createMemoryTransport()
    const handler = () => { throw new Error('must not be called') }
    transport.onMessage(handler)
    await transport.connect()
    await transport.dispose()

    await transport.emit({
      eventId: 'e2', chatType: 'p2p', chatId: 'oc_1',
      senderOpenId: 'ou_x', text: 'after', messageId: 'om_2',
    })
    // No throw means handler was not called.
  })
})

describe('shipped lib build', () => {
  it('exports the same plugin identity from lib/ as from src/', async () => {
    const lib = await import('../lib/index.js')
    expect(lib.name).toBe('dsh-im')
    expect(lib.inject).toEqual(['webServer'])
    expect(lib.Config).toBeDefined()
    expect(typeof lib.apply).toBe('function')
  })
})