/**
 * In-memory {@link ImTransport} for tests.
 *
 * This is not a mock library stub: it is a real implementation of the port with
 * a delivery list instead of a socket. Tests therefore exercise the actual
 * `dispatch.ts` queue, Agent creation, turn reading, and reply truncation — the
 * logic that has bugs — while the platform stays out of the way.
 *
 * It also makes the *hard* transport cases testable, which is the real reason it
 * exists: a `connect` that rejects, a connection that drops mid-flight, a send
 * that fails, and a message withheld by policy all have to be handled by the
 * plugin, and none of them are reachable through a live SDK connection on
 * demand.
 *
 * @module dsh-im/transport-memory
 */

import type { NormalizedMessage } from './event.ts'
import type { ReplyTarget } from './feishu.ts'
import {
  assertReplyTarget,
  type ConnectionState,
  type ImTransport,
  type MessageHandler,
  type RejectedMessage,
  type SendOptions,
  type SendReceipt,
  type Unsubscribe,
} from './transport.ts'

/** One message the transport was asked to send. */
export interface SentMessage {
  readonly target: ReplyTarget
  readonly text: string
  readonly options?: SendOptions
}

/** Injectable behaviour for the memory transport. */
export interface MemoryTransportOptions {
  /**
   * Make {@link ImTransport.connect} reject with this error.
   *
   * Used to prove the plugin degrades instead of throwing when the platform is
   * unreachable at startup.
   */
  readonly failConnect?: Error
  /**
   * Make {@link ImTransport.sendText} reject with this error.
   *
   * A failed reply is the common real-world failure (revoked scope, removed
   * bot), and it must not take down the connection or the queue.
   */
  readonly failSend?: Error
}

/** A memory transport plus the handles a test drives it with. */
export interface MemoryTransport extends ImTransport {
  /** Every message accepted by {@link ImTransport.sendText}, in order. */
  readonly sent: SentMessage[]
  /** Deliver one message to the registered handlers, as a live message would. */
  emit (message: NormalizedMessage): Promise<void>
  /** Report one policy-withheld message to the reject handlers. */
  emitReject (rejected: RejectedMessage): void
  /** Force a connection-state change, as a socket drop or recovery would. */
  setConnectionState (state: ConnectionState): void
  /** Current number of live message subscriptions. */
  readonly messageHandlerCount: number
  /** Whether {@link ImTransport.dispose} has been called. */
  readonly disposed: boolean
}

/**
 * Create an in-memory transport.
 * @param options - optional injected failures.
 * @returns the transport and its test handles.
 */
export function createMemoryTransport (
  options: MemoryTransportOptions = {}
): MemoryTransport {
  const messageHandlers = new Set<MessageHandler>()
  const rejectHandlers = new Set<(rejected: RejectedMessage) => void>()
  const connectionHandlers = new Set<(state: ConnectionState) => void>()
  const sent: SentMessage[] = []

  let state: ConnectionState = 'closed'
  let disposed = false

  const setState = (next: ConnectionState): void => {
    if (state === next) return
    state = next
    // Copied before iteration: a handler may unsubscribe itself, and mutating a
    // Set while iterating it would skip the entry that follows.
    for (const handler of [...connectionHandlers]) handler(next)
  }

  return {
    sent,

    get messageHandlerCount () { return messageHandlers.size },
    get disposed () { return disposed },

    async connect () {
      setState('connecting')
      if (options.failConnect !== undefined) {
        setState('closed')
        throw options.failConnect
      }
      setState('connected')
    },

    async dispose () {
      disposed = true
      messageHandlers.clear()
      rejectHandlers.clear()
      connectionHandlers.clear()
      setState('closed')
    },

    onMessage (handler) {
      messageHandlers.add(handler)
      const unsubscribe: Unsubscribe = () => { messageHandlers.delete(handler) }
      return unsubscribe
    },

    onReject (handler) {
      rejectHandlers.add(handler)
      return () => { rejectHandlers.delete(handler) }
    },

    onConnectionChange (handler) {
      connectionHandlers.add(handler)
      return () => { connectionHandlers.delete(handler) }
    },

    async sendText (target, text, sendOptions) {
      assertReplyTarget(target)
      if (options.failSend !== undefined) throw options.failSend
      sent.push({ target, text, ...(sendOptions === undefined ? {} : { options: sendOptions }) })
      const receipt: SendReceipt = { messageId: `om_sent_${sent.length}` }
      return receipt
    },

    async emit (message) {
      // Awaited sequentially so two messages arrive in a defined order; the
      // plugin's own per-conversation queue is what makes concurrency safe, and
      // this must not pre-empt it.
      for (const handler of [...messageHandlers]) await handler(message)
    },

    emitReject (rejected) {
      for (const handler of [...rejectHandlers]) handler(rejected)
    },

    setConnectionState (next) {
      setState(next)
    },
  }
}
