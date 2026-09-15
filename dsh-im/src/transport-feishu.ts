/**
 * Feishu transport backed by the official `@larksuiteoapi/node-sdk`.
 *
 * This is the **only** module in the project that imports the SDK. Everything
 * else depends on {@link ImTransport}, so the platform dependency is one file
 * wide and a protocol change or a second platform is an added adapter rather
 * than an edit across the plugin.
 *
 * ## What the SDK owns, and why that is the right split
 *
 * The SDK is not merely a socket. `LarkChannel` performs the WebSocket
 * handshake and reconnect loop, decodes inbound events, **and** applies policy
 * gates before handing a message over. It also infers the receive-id type from
 * an id's prefix on the way out. Those are exactly the parts that are easy to
 * get subtly wrong and tedious to test, so they are delegated, and this adapter
 * translates the SDK's vocabulary into the port's.
 *
 * Two consequences worth stating, because they remove configuration:
 *
 * - **The bot's own `open_id` is discovered, not configured.** The channel calls
 *   `GET /open-apis/bot/v3/info` during `connect()` and uses the result for
 *   mention matching, so no `botOpenId` setting is needed here.
 * - **No `encryptKey` or `verificationToken` is required.** Those authenticate an
 *   inbound *HTTP* callback. Under a WebSocket connection the socket is
 *   authenticated by the app secret during handshake, so the webhook signing
 *   path does not apply.
 *
 * ## Why the import is dynamic
 *
 * The SDK is roughly 30 MB unpacked and pulls in `axios` and `protobufjs`.
 * Awaiting it inside the factory means a profile that never uses this transport
 * — a webhook deployment, or a harness with the plugin loaded but inert — never
 * pays that cost. The module therefore exposes an async factory rather than a
 * top-level SDK import, and only the port's types are imported statically.
 *
 * @module dsh-im/transport-feishu
 */

import type { NormalizedMessage } from './event.ts'
import type {
  ConnectionState,
  ImTransport,
  RejectedMessage,
  SendReceipt,
  Unsubscribe,
} from './transport.ts'
import { assertReplyTarget } from './transport.ts'

/** Minimal logging surface, so this module does not depend on Cordis. */
export interface TransportLogger {
  debug: (message: string) => void
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

/** Policy gates applied before a message reaches the plugin. */
export interface FeishuPolicyOptions {
  /**
   * Require an explicit mention before a group message is delivered.
   *
   * Defaults to `true`, matching the SDK: a bot in a busy group should not
   * answer every message.
   */
  readonly requireMention?: boolean
  /**
   * Who may open a direct conversation: `open`, `allowlist`, or `disabled`.
   *
   * Defaults to `open`.
   */
  readonly dmMode?: 'open' | 'allowlist' | 'disabled'
  /** Senders permitted when `dmMode` is `allowlist`. */
  readonly dmAllowlist?: readonly string[]
  /** Chats the bot will serve, when set. An empty list means every chat. */
  readonly groupAllowlist?: readonly string[]
  /** Whether `@all` counts as addressing the bot. Defaults to `false`. */
  readonly respondToMentionAll?: boolean
}

/** The subset of the SDK this adapter uses, so a test can supply a stand-in. */
export interface FeishuSdk {
  /**
   * Build a channel.
   *
   * The parameter is {@link FeishuChannelConfig} rather than the SDK's own
   * `LarkChannelOptions`: the adapter assembles this exact object, so stating it
   * here is what makes the config reviewable, and the real SDK still satisfies
   * the interface because its options type accepts every field set below.
   */
  createLarkChannel: (options: FeishuChannelConfig) => FeishuChannel
  LoggerLevel: { warn: number }
}

/** The channel options this adapter sets, mirroring the SDK's config shape. */
export interface FeishuChannelConfig {
  readonly appId: string
  readonly appSecret: string
  readonly transport: 'websocket'
  readonly domain: string
  readonly policy?: {
    requireMention?: boolean
    dmMode?: 'open' | 'allowlist' | 'disabled'
    dmAllowlist?: string[]
    groupAllowlist?: string[]
    respondToMentionAll?: boolean
  }
  readonly loggerLevel: number
  readonly source: string
}

/** Payload carried by each channel event name. */
export interface FeishuChannelEvents {
  message: SdkMessage
  reject: SdkReject
  error: SdkError
  reconnecting: undefined
  reconnected: undefined
}

/**
 * The channel surface this adapter uses.
 *
 * Declared structurally rather than imported so the adapter can be tested
 * against a small stand-in, and so the SDK's full type surface does not leak
 * into the plugin's public types.
 *
 * `on` is a single generic call signature keyed by {@link FeishuChannelEvents}
 * rather than an overload set: an interface of overloads is expressible only as
 * a call signature, and a map keeps each event's payload type exact so a handler
 * cannot be registered for the wrong event name.
 */
export interface FeishuChannel {
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  on: <K extends keyof FeishuChannelEvents>(
    name: K,
    handler: (payload: FeishuChannelEvents[K]) => void
  ) => () => void
  send: (
    to: string,
    input: { text: string },
    options: { replyTo?: string }
  ) => Promise<{ messageId?: string }>
}

/** A message as the SDK normalizes it, before translation to the port's shape. */
export interface SdkMessage {
  readonly messageId: string
  readonly chatId: string
  readonly chatType: 'p2p' | 'group'
  readonly senderId: string
  readonly content: string
  readonly threadId?: string
  readonly replyToMessageId?: string
  readonly rootId?: string
}

/** A withheld message as the SDK reports it. */
export interface SdkReject {
  readonly messageId: string
  readonly chatId: string
  readonly senderId: string
  readonly reason: string
}

/** An error as the channel's error event carries it. */
export interface SdkError {
  readonly code: string
  readonly message: string
}

/** Loads the SDK; injectable so the adapter is testable without the real one. */
export type FeishuSdkLoader = () => Promise<FeishuSdk>

/** The default loader: a dynamic import, so the cost is paid only on use. */
const loadRealSdk: FeishuSdkLoader = async () =>
  await import('@larksuiteoapi/node-sdk') as unknown as FeishuSdk

/** Construction options for the Feishu transport. */
export interface FeishuTransportOptions {
  /** App id (`cli_…`) of a Feishu/Lark bot application. */
  readonly appId: string
  /**
   * App secret.
   *
   * Read as a plain value because it has already been resolved from the
   * credential provider by the caller; this module must not know how secrets are
   * stored.
   */
  readonly appSecret: string
  /** Which brand to authenticate against. Defaults to `feishu`. */
  readonly domain?: 'feishu' | 'lark'
  /** Policy gates; omitted fields take the SDK defaults. */
  readonly policy?: FeishuPolicyOptions
  /** Sink for SDK-originated and adapter-originated diagnostics. */
  readonly logger?: TransportLogger
  /** SDK loader override; defaults to importing the real SDK. */
  readonly loadSdk?: FeishuSdkLoader
}

/**
 * SDK error code that means the connection itself is unusable.
 *
 * `not_connected` is emitted for a failed WebSocket handshake, and the SDK also
 * collapses authentication failures into it (`lib/index.js`, where every
 * unclassified endpoint error becomes `not_connected`). It is the one code that
 * reliably means "the socket is not usable".
 *
 * Notably **absent** from this check is every per-message code — `rate_limited`,
 * `send_timeout`, `format_error`, `upload_failed`, `target_revoked`,
 * `ssrf_blocked`, and `unknown`. `unknown` in particular is what the channel's
 * error event carries for a *message-processing* failure, so treating it as a
 * dropped connection would report a spurious outage on one malformed event.
 */
const CONNECTION_LOST_CODE = 'not_connected'

/**
 * Convert the port's policy options into the SDK's mutable config shape.
 *
 * The allowlists are copied because the SDK's config type is `string[]`; passing
 * a caller's readonly array straight through would either fail to typecheck or,
 * if cast, let the SDK mutate the caller's value.
 * @param policy - the caller's policy options.
 * @returns the SDK-shaped policy config.
 */
export function toPolicyConfig (policy: FeishuPolicyOptions): {
  requireMention?: boolean
  dmMode?: 'open' | 'allowlist' | 'disabled'
  dmAllowlist?: string[]
  groupAllowlist?: string[]
  respondToMentionAll?: boolean
} {
  return {
    ...(policy.requireMention === undefined ? {} : { requireMention: policy.requireMention }),
    ...(policy.dmMode === undefined ? {} : { dmMode: policy.dmMode }),
    ...(policy.dmAllowlist === undefined ? {} : { dmAllowlist: [...policy.dmAllowlist] }),
    ...(policy.groupAllowlist === undefined ? {} : { groupAllowlist: [...policy.groupAllowlist] }),
    ...(policy.respondToMentionAll === undefined
      ? {}
      : { respondToMentionAll: policy.respondToMentionAll }),
  }
}

/**
 * Create a Feishu transport.
 *
 * The SDK is imported here rather than at module load, so constructing the
 * transport is what pays its cost.
 * @param options - app credentials, domain, policy, and logger.
 * @returns a connected-ready transport.
 */
export async function createFeishuTransport (
  options: FeishuTransportOptions
): Promise<ImTransport> {
  const sdk = await (options.loadSdk ?? loadRealSdk)()
  const log = options.logger

  const channel = sdk.createLarkChannel({
    appId: options.appId,
    appSecret: options.appSecret,
    transport: 'websocket',
    domain: options.domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn',
    // Copied into mutable arrays: the SDK's config is `string[]`, and handing it
    // the caller's readonly arrays would let it mutate the caller's values.
    ...(options.policy === undefined ? {} : { policy: toPolicyConfig(options.policy) }),
    loggerLevel: sdk.LoggerLevel.warn,
    // Tags this process distinctly in Feishu's side of the connection, which is
    // what identifies it when the platform reports a duplicate subscriber.
    source: 'dsh-im',
  })

  /**
   * Fan-out sets, one per channel event name.
   *
   * `LarkChannel` keeps exactly **one** handler per event name: its
   * `attachSingle` assigns `this.handlers[name] = handler` and only warns about
   * the overwrite. Registering a channel handler per subscriber would therefore
   * make the second subscriber replace the first, and the first subscriber's
   * disposer — which deletes only if the stored handler is still its own — would
   * then leave nothing registered. So the adapter registers each channel event
   * once and broadcasts from here.
   */
  const messageSubscribers = new Set<(message: NormalizedMessage) => void>()
  const rejectSubscribers = new Set<(rejected: RejectedMessage) => void>()
  const connectionSubscribers = new Set<(state: ConnectionState) => void>()
  /** Channel deregistrations, released together on dispose. */
  const listeners: Array<() => void> = []
  let disposed = false

  listeners.push(
    channel.on('message', (message) => {
      const normalized = toNormalizedMessage(message)
      // Snapshot before dispatch: a handler is allowed to unsubscribe itself,
      // and mutating a Set mid-iteration would skip the entry after it.
      for (const handler of [...messageSubscribers]) handler(normalized)
    }),
    channel.on('reject', (event) => {
      const rejected: RejectedMessage = {
        messageId: event.messageId,
        chatId: event.chatId,
        senderId: event.senderId,
        reason: event.reason,
      }
      for (const handler of [...rejectSubscribers]) handler(rejected)
    }),
    channel.on('reconnecting', () => {
      for (const handler of [...connectionSubscribers]) handler('reconnecting')
    }),
    channel.on('reconnected', () => {
      for (const handler of [...connectionSubscribers]) handler('connected')
    }),
    channel.on('error', (error) => {
      // The channel's error event fires from *message processing* (a `normalize`
      // failure arrives here as `unknown`), not from socket loss — a failed
      // connect rejects `connect()` instead. So only a genuine `not_connected`
      // is reported as closed; everything else is a per-message failure on a
      // live connection, and announcing an outage for one bad event would be
      // wrong.
      if (String(error.code) === CONNECTION_LOST_CODE) {
        log?.error(`dsh-im: Feishu connection lost: ${error.message}`)
        for (const handler of [...connectionSubscribers]) handler('closed')
      } else {
        log?.warn(`dsh-im: Feishu transport error (${String(error.code)}): ${error.message}`)
      }
    }),
  )

  /** Build a subscriber disposer over one fan-out set. */
  const subscribe = <T>(set: Set<T>, handler: T): Unsubscribe => {
    set.add(handler)
    return () => { set.delete(handler) }
  }

  return {
    async connect () {
      await channel.connect()
      log?.info('dsh-im: connected to Feishu over websocket')
    },

    async dispose () {
      if (disposed) return
      disposed = true
      for (const off of listeners.splice(0)) off()
      messageSubscribers.clear()
      rejectSubscribers.clear()
      connectionSubscribers.clear()
      try {
        await channel.disconnect()
      } catch (error: unknown) {
        // Teardown runs on a plugin stop, an update, and an unload. A failing
        // socket close must not abort the rest of the unload, so it is reported
        // and swallowed rather than propagated into Cordis.
        log?.warn(
          `dsh-im: error closing the Feishu connection: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    },

    onMessage (handler) {
      return subscribe(messageSubscribers, handler)
    },

    onReject (handler) {
      return subscribe(rejectSubscribers, handler)
    },

    onConnectionChange (handler) {
      return subscribe(connectionSubscribers, handler)
    },

    async sendText (target, text, sendOptions): Promise<SendReceipt> {
      // The SDK infers the receive-id type from the id's prefix, so a target
      // whose declared type disagrees with its value would be delivered
      // according to the prefix and the declaration silently ignored.
      assertReplyTarget(target)
      const result = await channel.send(
        target.receiveId,
        { text },
        sendOptions?.replyTo === undefined ? {} : { replyTo: sendOptions.replyTo },
      )
      return result.messageId === undefined ? {} : { messageId: result.messageId }
    },
  }
}


/**
 * Translate the SDK's normalized message into the plugin's.
 *
 * The two shapes differ in field names only; the SDK has already decoded the
 * double-encoded `content`, stripped the bot's own mention token from the text,
 * and computed whether the bot was addressed.
 * @param message - an SDK `NormalizedMessage`.
 * @returns the same message in the plugin's vocabulary.
 */
export function toNormalizedMessage (message: {
  messageId: string
  chatId: string
  chatType: 'p2p' | 'group'
  senderId: string
  content: string
  threadId?: string
  replyToMessageId?: string
  rootId?: string
}): NormalizedMessage {
  // The SDK exposes no event id, and `messageId` is stable and unique per
  // message, so it serves as the delivery identity. It is also the id replies
  // are addressed to, which keeps the two consistent.
  return {
    eventId: message.messageId,
    chatType: message.chatType,
    chatId: message.chatId,
    senderOpenId: message.senderId,
    text: message.content,
    messageId: message.messageId,
    ...(message.replyToMessageId === undefined || message.replyToMessageId === ''
      ? {}
      : { parentId: message.replyToMessageId }),
    ...(message.threadId === undefined || message.threadId === ''
      ? {}
      : { threadId: message.threadId }),
  }
}
