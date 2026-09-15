/**
 * Tests for the IM transport port and its in-memory implementation.
 *
 * These cover the seam rather than the platform: the memory transport is what
 * every other test drives, so a bug in it would silently weaken the whole suite.
 * The cases that matter are the ones a live connection cannot produce on demand
 * — a failed connect, a failed send, a withheld message, and a mid-flight drop.
 */

import { describe, expect, it, vi } from 'vitest'
import { assertReplyTarget, type ConnectionState } from '../src/transport.ts'
import { createMemoryTransport } from '../src/transport-memory.ts'
import type { NormalizedMessage } from '../src/event.ts'

/** One inbound message with sensible defaults. */
function message (overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    eventId: 'evt_1',
    chatType: 'p2p',
    chatId: 'oc_chat',
    senderOpenId: 'ou_user',
    text: 'hello',
    messageId: 'om_1',
    ...overrides,
  }
}

describe('assertReplyTarget', () => {
  it('accepts a target whose value matches its declared type', () => {
    expect(() => assertReplyTarget({ receiveIdType: 'open_id', receiveId: 'ou_x' })).not.toThrow()
    expect(() => assertReplyTarget({ receiveIdType: 'chat_id', receiveId: 'oc_x' })).not.toThrow()
  })

  it('rejects a chat_id declared as open_id', () => {
    // Feishu routes by the id's prefix, so the declaration would be ignored and
    // the message delivered to the wrong place. Better to fail here.
    expect(() => assertReplyTarget({ receiveIdType: 'open_id', receiveId: 'oc_x' }))
      .toThrow(/declares open_id but its value .* is a chat_id/)
  })

  it('rejects an open_id declared as chat_id', () => {
    expect(() => assertReplyTarget({ receiveIdType: 'chat_id', receiveId: 'ou_x' }))
      .toThrow(/declares chat_id but its value .* is a open_id/)
  })

  it('accepts an unrecognised id form', () => {
    // The id space belongs to the platform; refusing an id this merely fails to
    // recognise would break sends for any form added later.
    expect(() => assertReplyTarget({ receiveIdType: 'chat_id', receiveId: 'unknown_x' }))
      .not.toThrow()
  })
})

describe('memory transport', () => {
  it('reports readiness only after connect resolves', async () => {
    const transport = createMemoryTransport()
    const seen: ConnectionState[] = []
    transport.onConnectionChange(s => seen.push(s))

    await transport.connect()

    expect(seen).toEqual(['connecting', 'connected'])
  })

  it('rejects connect and returns to closed when configured to fail', async () => {
    const transport = createMemoryTransport({ failConnect: new Error('no route') })
    // Subscribed *before* connecting: a failed connect must not first report a
    // state it never reached, and a listener added afterwards cannot observe
    // that transition.
    const seen: ConnectionState[] = []
    transport.onConnectionChange(s => seen.push(s))

    await expect(transport.connect()).rejects.toThrow('no route')

    expect(seen).toEqual(['connecting', 'closed'])
  })

  it('delivers emitted messages to every handler', async () => {
    const transport = createMemoryTransport()
    const a = vi.fn()
    const b = vi.fn()
    transport.onMessage(a)
    transport.onMessage(b)

    await transport.emit(message())

    expect(a).toHaveBeenCalledOnce()
    expect(b).toHaveBeenCalledOnce()
    expect(a.mock.calls[0][0]).toMatchObject({ text: 'hello', chatType: 'p2p' })
  })

  it('stops delivering after unsubscribe', async () => {
    const transport = createMemoryTransport()
    const handler = vi.fn()
    const off = transport.onMessage(handler)

    off()
    await transport.emit(message())

    expect(handler).not.toHaveBeenCalled()
    expect(transport.messageHandlerCount).toBe(0)
  })

  it('keeps delivering to a handler that unsubscribes another mid-dispatch', async () => {
    // Handler iteration copies the set first, so a handler removing a sibling
    // cannot cause the sibling after it to be skipped.
    const transport = createMemoryTransport()
    const second = vi.fn()
    const offSecond = transport.onMessage(second)
    transport.onMessage(() => { offSecond() })

    await transport.emit(message())

    expect(second).toHaveBeenCalledOnce()
  })

  it('records sends and returns a receipt', async () => {
    const transport = createMemoryTransport()

    const receipt = await transport.sendText(
      { receiveIdType: 'open_id', receiveId: 'ou_user' },
      'a reply',
    )

    expect(transport.sent).toEqual([
      { target: { receiveIdType: 'open_id', receiveId: 'ou_user' }, text: 'a reply' },
    ])
    expect(receipt.messageId).toBe('om_sent_1')
  })

  it('records reply threading options', async () => {
    const transport = createMemoryTransport()

    await transport.sendText(
      { receiveIdType: 'chat_id', receiveId: 'oc_chat' },
      'threaded',
      { replyTo: 'om_1' },
    )

    expect(transport.sent[0].options).toEqual({ replyTo: 'om_1' })
  })

  it('rejects a send to a mismatched target without recording it', async () => {
    const transport = createMemoryTransport()

    await expect(transport.sendText(
      { receiveIdType: 'open_id', receiveId: 'oc_chat' },
      'misrouted',
    )).rejects.toThrow(/declares open_id/)

    expect(transport.sent).toEqual([])
  })

  it('propagates a configured send failure', async () => {
    const transport = createMemoryTransport({ failSend: new Error('scope revoked') })

    await expect(transport.sendText(
      { receiveIdType: 'open_id', receiveId: 'ou_user' },
      'x',
    )).rejects.toThrow('scope revoked')
  })

  it('reports withheld messages to reject handlers only', async () => {
    const transport = createMemoryTransport()
    const onMessage = vi.fn()
    const onReject = vi.fn()
    transport.onMessage(onMessage)
    transport.onReject(onReject)

    transport.emitReject({
      messageId: 'om_2', chatId: 'oc_g', senderId: 'ou_x', reason: 'no_mention',
    })

    expect(onReject).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'no_mention' }),
    )
    // A withheld message is a policy outcome, not traffic: it must never reach
    // the dispatch path.
    expect(onMessage).not.toHaveBeenCalled()
  })

  it('reports forced connection changes', async () => {
    const transport = createMemoryTransport()
    await transport.connect()
    const seen: ConnectionState[] = []
    transport.onConnectionChange(s => seen.push(s))

    transport.setConnectionState('reconnecting')
    transport.setConnectionState('connected')

    expect(seen).toEqual(['reconnecting', 'connected'])
  })

  it('clears every subscription on dispose and is idempotent', async () => {
    const transport = createMemoryTransport()
    const handler = vi.fn()
    transport.onMessage(handler)
    await transport.connect()

    await transport.dispose()
    await transport.dispose()

    expect(transport.disposed).toBe(true)
    expect(transport.messageHandlerCount).toBe(0)
    await transport.emit(message())
    expect(handler).not.toHaveBeenCalled()
  })
})
