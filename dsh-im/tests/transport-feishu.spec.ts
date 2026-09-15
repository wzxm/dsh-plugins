/**
 * Tests for the Feishu SDK adapter.
 *
 * The adapter is exercised against a stand-in channel, which is what makes its
 * translation logic testable: the interesting behaviour is *mapping* — event
 * payloads to the port's vocabulary, error codes to connection states, ids to
 * reply targets — and none of it requires a socket.
 *
 * A separate type-level assertion at the bottom pins the real SDK's shape, so a
 * change in the SDK breaks the build here rather than surfacing at runtime as a
 * missing property.
 */

import { describe, expect, it, vi } from 'vitest'
import type { ConnectionState, RejectedMessage } from '../src/transport.ts'
import type { NormalizedMessage } from '../src/event.ts'
import {
  createFeishuTransport,
  toNormalizedMessage,
  toPolicyConfig,
  type FeishuChannel,
  type FeishuChannelEvents,
  type FeishuSdk,
} from '../src/transport-feishu.ts'

/** A stand-in channel recording what the adapter does to it. */
function fakeChannel () {
  const handlers = new Map<string, (payload: unknown) => void>()
  /** How many times each event name was registered, to expose overwrites. */
  const registrations = new Map<string, number>()
  const sent: Array<{ to: string; text: string; options: { replyTo?: string } }> = []
  const state = { connected: 0, disconnected: 0 }

  const channel: FeishuChannel = {
    async connect () { state.connected += 1 },
    async disconnect () { state.disconnected += 1 },
    on (name, handler) {
      registrations.set(name, (registrations.get(name) ?? 0) + 1)
      handlers.set(name, handler as (payload: unknown) => void)
      return () => { handlers.delete(name) }
    },
    async send (to, input, options) {
      sent.push({ to, text: input.text, options })
      return { messageId: 'om_sent' }
    },
  }

  return {
    channel,
    sent,
    state,
    registrations,
    /** Fire one channel event, as the SDK would. */
    emit<K extends keyof FeishuChannelEvents> (name: K, payload: FeishuChannelEvents[K]): void {
      handlers.get(name)?.(payload)
    },
    handlers,
  }
}

/** Build a transport over a stand-in channel. */
async function transportWith (fake: ReturnType<typeof fakeChannel>, options: {
  logger?: Record<string, ReturnType<typeof vi.fn>>
} = {}) {
  const sdk: FeishuSdk = {
    createLarkChannel: () => fake.channel,
    LoggerLevel: { warn: 2 },
  }
  return await createFeishuTransport({
    appId: 'cli_x',
    appSecret: 'secret',
    loadSdk: async () => sdk,
    ...(options.logger === undefined ? {} : { logger: options.logger as never }),
  })
}

describe('toNormalizedMessage', () => {
  const base = {
    messageId: 'om_1',
    chatId: 'oc_1',
    chatType: 'p2p' as const,
    senderId: 'ou_u',
    content: 'hello',
  }

  it('maps the SDK message onto the port vocabulary', () => {
    expect(toNormalizedMessage(base)).toEqual({
      eventId: 'om_1',
      chatType: 'p2p',
      chatId: 'oc_1',
      senderOpenId: 'ou_u',
      text: 'hello',
      messageId: 'om_1',
    })
  })

  it('carries thread and reply ids when present', () => {
    const message = toNormalizedMessage({
      ...base, threadId: 'omt_1', replyToMessageId: 'om_parent',
    })
    expect(message.threadId).toBe('omt_1')
    expect(message.parentId).toBe('om_parent')
  })

  it('omits empty thread and reply ids instead of emitting empty strings', () => {
    // An empty string would become a `parentId` that keys a distinct
    // conversation, splitting one chat into two Sessions.
    const message = toNormalizedMessage({ ...base, threadId: '', replyToMessageId: '' })
    expect('threadId' in message).toBe(false)
    expect('parentId' in message).toBe(false)
  })

  it('uses the message id as the delivery identity', () => {
    // The SDK exposes no event id; messageId is stable and unique per message.
    expect(toNormalizedMessage(base).eventId).toBe('om_1')
  })
})

describe('toPolicyConfig', () => {
  it('omits unset fields so SDK defaults still apply', () => {
    // Passing explicit `undefined`s would be indistinguishable from unset for
    // the SDK's `??` fallbacks, but omitting keeps the intent obvious.
    expect(toPolicyConfig({})).toEqual({})
  })

  it('copies allowlists into mutable arrays', () => {
    const groupAllowlist = ['oc_1'] as readonly string[]
    const config = toPolicyConfig({ groupAllowlist, dmAllowlist: ['ou_1'] })
    expect(config.groupAllowlist).toEqual(['oc_1'])
    expect(config.groupAllowlist).not.toBe(groupAllowlist)
  })

  it('passes through booleans and dmMode unchanged', () => {
    expect(toPolicyConfig({ requireMention: false, respondToMentionAll: true, dmMode: 'disabled' }))
      .toEqual({ requireMention: false, respondToMentionAll: true, dmMode: 'disabled' })
  })
})

describe('feishu transport adapter', () => {
  it('resolves connect only after the channel connects', async () => {
    const fake = fakeChannel()
    const transport = await transportWith(fake)

    await transport.connect()

    expect(fake.state.connected).toBe(1)
  })

  it('delivers translated messages to subscribers', async () => {
    const fake = fakeChannel()
    const transport = await transportWith(fake)
    const received: NormalizedMessage[] = []
    transport.onMessage(m => { received.push(m) })

    fake.emit('message', {
      messageId: 'om_9', chatId: 'oc_9', chatType: 'group',
      senderId: 'ou_u', content: 'hi', threadId: 'omt_9',
    })

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      eventId: 'om_9', chatId: 'oc_9', chatType: 'group', text: 'hi', threadId: 'omt_9',
    })
  })

  it('stops delivering after the subscription is released', async () => {
    const fake = fakeChannel()
    const transport = await transportWith(fake)
    const released = vi.fn()
    const kept = vi.fn()

    const off = transport.onMessage(released)
    transport.onMessage(kept)
    off()

    fake.emit('message', {
      messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', senderId: 'ou_u', content: 'x',
    })

    expect(released).not.toHaveBeenCalled()
    expect(kept).toHaveBeenCalledOnce()
  })

  it('registers each channel event exactly once regardless of subscribers', async () => {
    // `LarkChannel` keeps one handler per event name and *overwrites* on a
    // second registration, so a per-subscriber registration would silently drop
    // every subscriber but the last.
    const fake = fakeChannel()
    const transport = await transportWith(fake)
    transport.onMessage(vi.fn())
    transport.onMessage(vi.fn())
    transport.onMessage(vi.fn())

    expect(fake.registrations.get('message')).toBe(1)
  })

  it('keeps delivering to remaining subscribers after one leaves', async () => {
    const fake = fakeChannel()
    const transport = await transportWith(fake)
    const a = vi.fn()
    const b = vi.fn()
    const offA = transport.onMessage(a)
    transport.onMessage(b)

    offA()
    fake.emit('message', {
      messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', senderId: 'ou_u', content: 'x',
    })

    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledOnce()
  })

  it('delivers to every message subscriber', async () => {
    const fake = fakeChannel()
    const transport = await transportWith(fake)
    const a = vi.fn()
    const b = vi.fn()
    transport.onMessage(a)
    transport.onMessage(b)

    fake.emit('message', {
      messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', senderId: 'ou_u', content: 'x',
    })

    expect(a).toHaveBeenCalledOnce()
    expect(b).toHaveBeenCalledOnce()
  })

  it('reports withheld messages with their reason', async () => {
    const fake = fakeChannel()
    const transport = await transportWith(fake)
    const rejects: RejectedMessage[] = []
    transport.onReject(r => { rejects.push(r) })

    fake.emit('reject', {
      messageId: 'om_2', chatId: 'oc_g', senderId: 'ou_x', reason: 'no_mention',
    })

    expect(rejects).toEqual([
      { messageId: 'om_2', chatId: 'oc_g', senderId: 'ou_x', reason: 'no_mention' },
    ])
  })

  it('maps reconnecting and reconnected to connection states', async () => {
    const fake = fakeChannel()
    const transport = await transportWith(fake)
    const seen: ConnectionState[] = []
    transport.onConnectionChange(s => { seen.push(s) })

    fake.emit('reconnecting', undefined)
    fake.emit('reconnected', undefined)

    expect(seen).toEqual(['reconnecting', 'connected'])
  })

  it('treats a not_connected error as a lost connection', async () => {
    const fake = fakeChannel()
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const transport = await transportWith(fake, { logger })
    const seen: ConnectionState[] = []
    transport.onConnectionChange(s => { seen.push(s) })

    fake.emit('error', { code: 'not_connected', message: 'handshake failed' })

    expect(seen).toEqual(['closed'])
    expect(logger.error).toHaveBeenCalled()
  })

  it('does not report a closed connection for a per-message error', async () => {
    // The channel's error event fires from message *processing*, so an
    // `unknown` code there is one malformed event — not an outage. Reporting
    // `closed` would be a false alarm, and the plugin would stop trusting a
    // connection that is still up.
    const fake = fakeChannel()
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const transport = await transportWith(fake, { logger })
    const seen: ConnectionState[] = []
    transport.onConnectionChange(s => { seen.push(s) })

    fake.emit('error', { code: 'unknown', message: 'normalize failed' })

    expect(seen).toEqual([])
    expect(logger.warn).toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('sends text to the resolved id and returns the receipt', async () => {
    const fake = fakeChannel()
    const transport = await transportWith(fake)

    const receipt = await transport.sendText(
      { receiveIdType: 'open_id', receiveId: 'ou_u' }, 'a reply',
    )

    expect(fake.sent).toEqual([{ to: 'ou_u', text: 'a reply', options: {} }])
    expect(receipt.messageId).toBe('om_sent')
  })

  it('forwards reply threading to the channel', async () => {
    const fake = fakeChannel()
    const transport = await transportWith(fake)

    await transport.sendText(
      { receiveIdType: 'chat_id', receiveId: 'oc_1' }, 'threaded', { replyTo: 'om_1' },
    )

    expect(fake.sent[0].options).toEqual({ replyTo: 'om_1' })
  })

  it('refuses a send whose target contradicts itself', async () => {
    const fake = fakeChannel()
    const transport = await transportWith(fake)

    await expect(transport.sendText(
      { receiveIdType: 'open_id', receiveId: 'oc_1' }, 'misrouted',
    )).rejects.toThrow(/declares open_id/)

    expect(fake.sent).toEqual([])
  })

  it('disconnects and releases handlers on dispose', async () => {
    const fake = fakeChannel()
    const transport = await transportWith(fake)
    transport.onMessage(vi.fn())
    await transport.connect()

    await transport.dispose()

    expect(fake.state.disconnected).toBe(1)
    // Every channel registration is released, so nothing can deliver after
    // teardown.
    expect(fake.handlers.size).toBe(0)
  })

  it('is disposable more than once', async () => {
    // A stop, an update, and an unload can each run the disposer.
    const fake = fakeChannel()
    const transport = await transportWith(fake)
    await transport.connect()

    await transport.dispose()
    await transport.dispose()

    expect(fake.state.disconnected).toBe(1)
  })

  it('survives a disconnect failure during teardown', async () => {
    // A failing socket close must not abort the rest of a plugin unload.
    const fake = fakeChannel()
    fake.channel.disconnect = async () => { throw new Error('socket already gone') }
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const transport = await transportWith(fake, { logger })

    await expect(transport.dispose()).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('reports a failed connect instead of swallowing it', async () => {
    const fake = fakeChannel()
    fake.channel.connect = async () => { throw new Error('no route') }
    const transport = await transportWith(fake)

    await expect(transport.connect()).rejects.toThrow('no route')
  })
})

/**
 * Compile-time proof that the real SDK still satisfies this adapter's view of it.
 *
 * The adapter talks to the SDK through the structural {@link FeishuSdk} and
 * {@link FeishuChannel} types, and the default loader casts the import to that
 * shape. A cast would happily accept a renamed method or a changed payload, so
 * the assignment below makes the compiler check the real types instead: drift in
 * the SDK fails `pnpm run typecheck` here rather than at runtime as a silently
 * missing handler.
 */
describe('real SDK conformance', () => {
  it('satisfies the structural SDK interface', async () => {
    const sdk = await import('@larksuiteoapi/node-sdk')
    const channel = sdk.createLarkChannel({
      appId: 'cli_typecheck_only',
      appSecret: 'unused',
      transport: 'websocket',
    })

    // Each assignment is checked against the real SDK's declaration. If the SDK
    // renames `connect` / `disconnect` / `on` / `send`, this line stops compiling.
    const asChannel: FeishuChannel = {
      connect: channel.connect.bind(channel),
      disconnect: channel.disconnect.bind(channel),
      on: channel.on.bind(channel) as FeishuChannel['on'],
      // The real `send` accepts more input types, but this adapter only sends
      // `{ text }`, which every SDK version supports.
      send: (to, input, opts) => channel.send(to as never, input, opts),
    }

    // `setBotIdentity` / `updatePolicy` are consumed during construction — not
    // part of the adapter's channel surface — so they are not checked here.

    expect(typeof asChannel.connect).toBe('function')
    expect(typeof asChannel.disconnect).toBe('function')
    await asChannel.disconnect()
  })
})
