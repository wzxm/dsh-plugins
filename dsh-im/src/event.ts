/**
 * Feishu v2.0 event-envelope parsing and normalization.
 *
 * The earlier `FeishuTextEvent` interface described a shape Feishu never sends.
 * A real callback is an envelope, and the message text arrives double-encoded:
 *
 * ```json
 * {
 *   "schema": "2.0",
 *   "header": { "event_id": "...", "event_type": "im.message.receive_v1", ... },
 *   "event": {
 *     "sender": { "sender_id": { "open_id": "ou_...", "union_id": "...", ... } },
 *     "message": {
 *       "message_id": "om_...",
 *       "chat_id": "oc_...",
 *       "chat_type": "p2p",
 *       "message_type": "text",
 *       "content": "{\"text\":\"hi\"}",     // <- a JSON *string*, not an object
 *       "mentions": [
 *         { "key": "@_user_1", "name": "Bot", "id": { "open_id": "ou_..." } }
 *       ],
 *       "thread_id": "omt_...",
 *       "root_id": "om_...",
 *       "parent_id": "om_..."
 *     }
 *   }
 * }
 * ```
 *
 * The two bugs this module exists to fix:
 *
 * - **`mentions[].id` is an object, not a string.** The old code compared
 *   `m.id === botOpenId` against an object, so the test could never be true and
 *   *every* group message was discarded. The open_id lives at `id.open_id`.
 * - **Mention placeholders are tokens, not names.** Group text reads
 *   `"@_user_1 hi"`, so stripping the bot's placeholder means removing its
 *   `key` (`@_user_1`), not the literal `@{openId}` the old code looked for.
 *
 * @module dsh-im/event
 */

/** One mention entry exactly as Feishu serializes it. */
export interface FeishuMention {
  /** Placeholder token appearing in the text, e.g. `@_user_1`. */
  readonly key: string
  /** Display name of the mentioned entity. */
  readonly name?: string
  /** Identifiers of the mentioned entity; `open_id` is the one to match on. */
  readonly id?: {
    readonly open_id?: string
    readonly union_id?: string
    readonly user_id?: string
  }
}

/** The `event.message` object of an `im.message.receive_v1` callback. */
export interface FeishuMessage {
  readonly message_id?: string
  readonly chat_id?: string
  readonly chat_type?: string
  readonly message_type?: string
  /** JSON-encoded payload; for text messages this is `{"text":"..."}`. */
  readonly content?: string
  readonly mentions?: readonly FeishuMention[]
  readonly thread_id?: string
  readonly root_id?: string
  readonly parent_id?: string
}

/** The `event` object carrying one received message. */
export interface FeishuMessageEvent {
  readonly sender?: {
    readonly sender_id?: { readonly open_id?: string }
    readonly sender_type?: string
  }
  readonly message?: FeishuMessage
  /**
   * Present on the v2.0 URL-verification handshake, where the challenge sits
   * inside `event` rather than at the envelope's top level.
   */
  readonly challenge?: string
  readonly token?: string
}

/** The `header` object of a v2.0 envelope. */
export interface FeishuEventHeader {
  readonly event_id?: string
  readonly event_type?: string
  readonly create_time?: string
  readonly tenant_key?: string
  readonly app_id?: string
}

/**
 * A parsed event callback, covering both wire forms Feishu uses.
 *
 * Feishu sends the handshake in **two** shapes and both must be handled:
 *
 * - **v1 (flat)** — `{"type":"url_verification","challenge":"…","token":"…"}`,
 *   with the fields at the top level.
 * - **v2.0 (envelope)** — `{"schema":"2.0","header":{"event_type":
 *   "url_verification"},"event":{"challenge":"…"}}`, with the fields nested.
 *
 * Reading only the top-level form (as an earlier version of the handler did)
 * answers a real v2.0 handshake with an empty body, and the Feishu console then
 * reports the URL as unreachable — the app never finishes setup.
 */
export interface FeishuCallback {
  readonly schema?: string
  readonly header?: FeishuEventHeader
  readonly event?: FeishuMessageEvent
  /** v1 handshake: the value to echo back. */
  readonly challenge?: string
  /** v1 handshake: the app's Verification Token. */
  readonly token?: string
  /** v1 handshake: `url_verification`. */
  readonly type?: string
}

/**
 * Read the handshake challenge from either wire form.
 * @param callback - the parsed envelope.
 * @returns the challenge to echo, or `undefined` when this is not a handshake.
 */
export function verificationChallenge (callback: FeishuCallback): string | undefined {
  if (callback.type === 'url_verification' || callback.header?.event_type === 'url_verification') {
    return callback.challenge ?? callback.event?.challenge ?? ''
  }
  // A bare `challenge` with no declared type is still a handshake.
  return callback.challenge ?? callback.event?.challenge
}

/**
 * Read the Verification Token from either wire form.
 * @param callback - the parsed envelope.
 * @returns the presented token, or `undefined` when absent.
 */
export function verificationToken (callback: FeishuCallback): string | undefined {
  return callback.token ?? callback.event?.token
}

/** A message normalized into the fields the adapter acts on. */
export interface NormalizedMessage {
  /** Stable event identity, used as the delivery id. */
  readonly eventId: string
  readonly chatType: 'p2p' | 'group'
  readonly chatId: string
  readonly senderOpenId: string
  /** Message text with the bot's mention placeholder removed. */
  readonly text: string
  /** Message being replied to, when the message is itself a reply. */
  readonly parentId?: string
  /** Thread the message belongs to, when it is a threaded message. */
  readonly threadId?: string
  readonly messageId?: string
}

/** Whether `value` is a non-array object. */
function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether `value` is a non-empty string. */
function isNonEmptyString (value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Parse one callback body into an envelope.
 *
 * The body may already be decrypted JSON text. A root value that is not an
 * object, or is not valid JSON, is rejected rather than coerced.
 * @param raw - the (possibly decrypted) request body text.
 * @returns the parsed envelope.
 * @throws {Error} when the body is not a JSON object.
 */
export function parseCallback (raw: string): FeishuCallback {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // JSON.parse is the only statement in the try.
    throw new Error('feishu callback body is not valid JSON')
  }
  if (!isRecord(parsed))
    throw new Error('feishu callback body must be a JSON object')
  return parsed as FeishuCallback
}

/**
 * Extract the plain `text` field from a message's double-encoded content.
 *
 * `content` is a JSON string, not an object, so it needs a second parse. A
 * message whose content is absent or unparsable yields `null` rather than
 * throwing: content shape varies by `message_type`, and the caller decides
 * whether a non-text message is ignorable.
 * @param content - the raw `message.content` string.
 * @returns the text, or `null` when it cannot be read.
 */
export function messageText (content: unknown): string | null {
  if (!isNonEmptyString(content)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const text = parsed['text']
  return typeof text === 'string' ? text : null
}

/** Whether one mention refers to the given bot. */
function mentionsBot (mention: FeishuMention, botOpenId: string): boolean {
  // The open_id lives on the nested `id` object. Comparing `mention.id` itself
  // (as the previous implementation did) can never match a string.
  return mention.id?.open_id === botOpenId
}

/**
 * Whether a group message explicitly addresses the bot.
 * @param message - the raw message object.
 * @param botOpenId - the bot's own open_id.
 * @returns true when any mention resolves to the bot.
 */
export function isBotMentioned (
  message: FeishuMessage,
  botOpenId: string
): boolean {
  return (message.mentions ?? []).some(m => mentionsBot(m, botOpenId))
}

/**
 * Remove the bot's own mention placeholders from message text.
 *
 * Feishu substitutes each mention with its `key` token, so removing the bot's
 * `key` is what strips it. Replacement is literal (not a regex) because the key
 * contains no regex metacharacters but is not guaranteed to stay that way.
 * @param text - the message text.
 * @param mentions - that message's mentions.
 * @param botOpenId - the bot's own open_id.
 * @returns the text with the bot's mentions removed and trimmed.
 */
export function stripBotMentions (
  text: string,
  mentions: readonly FeishuMention[],
  botOpenId: string
): string {
  let stripped = text
  for (const mention of mentions) {
    if (!mentionsBot(mention, botOpenId)) continue
    if (isNonEmptyString(mention.key))
      stripped = stripped.split(mention.key).join('')
  }
  return stripped.trim()
}

/**
 * Normalize one callback into the fields the adapter acts on.
 *
 * Returns `null` — never throws — for anything not actionable: a non-message
 * event, a non-text message, an unnamed sender or chat, or a group message that
 * does not mention the bot. Ingress must answer 200 for those, so refusal is a
 * value rather than an exception.
 * @param callback - the parsed envelope.
 * @param botOpenId - the bot's own open_id, used for mention matching.
 * @returns the normalized message, or `null` when it should be ignored.
 */
export function normalizeCallback (
  callback: FeishuCallback,
  botOpenId: string
): NormalizedMessage | null {
  const header = callback.header
  const message = callback.event?.message
  if (message === undefined) return null
  if (!isNonEmptyString(message.message_id)) return null
  if (!isNonEmptyString(message.chat_id)) return null

  const chatType = message.chat_type === 'group' ? 'group' : 'p2p'
  const mentions = message.mentions ?? []
  // A group message that does not address the bot is not for us. A p2p message
  // is always addressed to the bot.
  if (chatType === 'group' && !isBotMentioned(message, botOpenId)) return null

  const text = messageText(message.content)
  if (text === null) return null
  const body = stripBotMentions(text, mentions, botOpenId)
  if (body === '') return null

  // `event_id` is the delivery identity; fall back to the message id so a
  // malformed header cannot collapse two deliveries into one.
  const eventId = isNonEmptyString(header?.event_id)
    ? header.event_id
    : message.message_id

  return {
    eventId,
    chatType,
    chatId: message.chat_id,
    senderOpenId: callback.event?.sender?.sender_id?.open_id ?? '',
    text: body,
    ...(isNonEmptyString(message.parent_id) ? { parentId: message.parent_id } : {}),
    ...(isNonEmptyString(message.thread_id) ? { threadId: message.thread_id } : {}),
    messageId: message.message_id
  }
}
