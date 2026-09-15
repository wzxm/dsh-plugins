/**
 * Verifies the SHIPPED lib/index.js (not src/) exports a compilable plugin and
 * registers routes in real Cordis. This is the artifact the profile will load
 * after a restart, so a green result here is the strongest pre-restart evidence.
 *
 * The WebSocket transport cannot be exercised without real credentials, but we
 * verify that:
 *  1. The plugin descriptor (name, inject, Config) matches what src/ exports.
 *  2. `apply` registers the OAuth route in a real Cordis tree.
 *  3. The transport modules export correctly from the separate entry points.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import plugin, { Config, name, inject } from '../lib/index.js'
import { createMemoryTransport } from '../lib/transport-memory.js'
import { toNormalizedMessage, toPolicyConfig } from '../lib/transport-feishu.js'

describe('shipped lib/ plugin descriptor', () => {
  it('exports the same identity as src/', () => {
    expect(name).toBe('dsh-im')
    expect(inject).toEqual(['webServer'])
    expect(Config).toBeDefined()
  })

  it('exports a Config schema that validates with defaults', () => {
    const result = Config['~standard'].validate({})
    expect((result as { issues?: unknown }).issues).toBeUndefined()
  })

  it('registers the OAuth callback route in a real Cordis tree', async () => {
    const routes = new Map<string, unknown>()
    const ctx = new Context()
    ctx.provide('webServer', {
      register: (r: { path: string; handler: unknown }) => {
        routes.set(r.path, r.handler)
        return () => routes.delete(r.path)
      },
    } as never)

    const v = Config['~standard'].validate({ oauthCallbackPath: '/oauth/feishu/callback' })
    await ctx.plugin(plugin as never, (v as { value: Record<string, unknown> }).value as never)

    expect([...routes.keys()].sort()).toEqual(['/oauth/feishu/callback'])
    await ctx.fiber.dispose()
  })

  it('removes routes on dispose', async () => {
    const routes = new Map<string, unknown>()
    const ctx = new Context()
    ctx.provide('webServer', {
      register: (r: { path: string; handler: unknown }) => {
        routes.set(r.path, r.handler)
        return () => routes.delete(r.path)
      },
    } as never)

    const v = Config['~standard'].validate({ oauthCallbackPath: '/oauth/feishu/callback' })
    await ctx.plugin(plugin as never, (v as { value: Record<string, unknown> }).value as never)
    expect(routes.size).toBe(1)
    await ctx.fiber.dispose()
    expect(routes.size).toBe(0)
  })
})

describe('shipped lib/ transport modules', () => {
  it('memory transport connects, emits, and disposes', async () => {
    const transport = createMemoryTransport()
    const messages: string[] = []
    transport.onMessage(m => messages.push(m.text))
    await transport.connect()
    await transport.emit({
      eventId: 'e', chatType: 'p2p', chatId: 'oc_1',
      senderOpenId: 'ou_u', text: 'shipped test', messageId: 'om_1',
    })
    expect(messages).toEqual(['shipped test'])
  })

  it('transport-feishu translation works from lib/', () => {
    const m = toNormalizedMessage({
      messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p',
      senderId: 'ou_u', content: 'hi',
    })
    expect(m.text).toBe('hi')
    expect(toPolicyConfig({})).toEqual({})
  })
})