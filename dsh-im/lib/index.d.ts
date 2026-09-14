import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/event.d.ts
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
interface FeishuMention {
  /** Placeholder token appearing in the text, e.g. `@_user_1`. */
  readonly key: string;
  /** Display name of the mentioned entity. */
  readonly name?: string;
  /** Identifiers of the mentioned entity; `open_id` is the one to match on. */
  readonly id?: {
    readonly open_id?: string;
    readonly union_id?: string;
    readonly user_id?: string;
  };
}
/** The `event.message` object of an `im.message.receive_v1` callback. */
interface FeishuMessage {
  readonly message_id?: string;
  readonly chat_id?: string;
  readonly chat_type?: string;
  readonly message_type?: string;
  /** JSON-encoded payload; for text messages this is `{"text":"..."}`. */
  readonly content?: string;
  readonly mentions?: readonly FeishuMention[];
  readonly thread_id?: string;
  readonly root_id?: string;
  readonly parent_id?: string;
}
/** The `event` object carrying one received message. */
interface FeishuMessageEvent {
  readonly sender?: {
    readonly sender_id?: {
      readonly open_id?: string;
    };
    readonly sender_type?: string;
  };
  readonly message?: FeishuMessage;
}
/** The `header` object of a v2.0 envelope. */
interface FeishuEventHeader {
  readonly event_id?: string;
  readonly event_type?: string;
  readonly create_time?: string;
  readonly tenant_key?: string;
  readonly app_id?: string;
}
/** A parsed v2.0 event callback. */
interface FeishuCallback {
  readonly schema?: string;
  readonly header?: FeishuEventHeader;
  readonly event?: FeishuMessageEvent;
  /** Present on the one-time URL-verification handshake instead of `event`. */
  readonly challenge?: string;
  readonly token?: string;
  readonly type?: string;
}
/** A message normalized into the fields the adapter acts on. */
interface NormalizedMessage {
  /** Stable event identity, used as the delivery id. */
  readonly eventId: string;
  readonly chatType: 'p2p' | 'group';
  readonly chatId: string;
  readonly senderOpenId: string;
  /** Message text with the bot's mention placeholder removed. */
  readonly text: string;
  /** Message being replied to, when the message is itself a reply. */
  readonly parentId?: string;
  /** Thread the message belongs to, when it is a threaded message. */
  readonly threadId?: string;
  readonly messageId?: string;
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
declare function parseCallback(raw: string): FeishuCallback;
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
declare function messageText(content: unknown): string | null;
/**
 * Whether a group message explicitly addresses the bot.
 * @param message - the raw message object.
 * @param botOpenId - the bot's own open_id.
 * @returns true when any mention resolves to the bot.
 */
declare function isBotMentioned(message: FeishuMessage, botOpenId: string): boolean;
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
declare function stripBotMentions(text: string, mentions: readonly FeishuMention[], botOpenId: string): string;
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
declare function normalizeCallback(callback: FeishuCallback, botOpenId: string): NormalizedMessage | null;
//#endregion
//#region src/feishu.d.ts
/**
 * Where a reply must be sent, in the form Feishu's send API expects.
 *
 * `receive_id_type` and `receive_id` travel together: sending a `chat_id` while
 * declaring `open_id` fails, so the pair is carried as one value.
 */
interface ReplyTarget {
  /** Value for the `receive_id_type` query parameter. */
  readonly receiveIdType: 'chat_id' | 'open_id';
  /** Value for the body's `receive_id` field. */
  readonly receiveId: string;
}
/**
 * Derive the reply destination for one message.
 *
 * A p2p chat is answered to the sender's `open_id`; a group chat is answered to
 * the `chat_id`. The `chat_id` is used even when a group message arrives in a
 * thread, because Feishu threads are addressed through `reply_message` rather
 * than a different receive id.
 * @param message - the normalized inbound message.
 * @returns the receive-id type and value to send with.
 * @throws {Error} when the fields needed for that chat type are missing.
 */
declare function receiveTarget(message: NormalizedMessage): ReplyTarget;
/**
 * Build the stable identity for one conversation.
 *
 * Scoping by bot keeps two apps that share a chat from writing into the same
 * Session. The thread segment separates a threaded discussion from the chat's
 * main timeline, so a `@bot` in a thread does not append to the parent Session.
 * @param botId - the configured bot instance id.
 * @param message - the normalized inbound message.
 * @returns the conversation key.
 */
declare function conversationKey(botId: string, message: Pick<NormalizedMessage, 'chatType' | 'chatId' | 'threadId' | 'parentId'>): string;
//#endregion
//#region src/feishu-api.d.ts
/** App credentials used to mint token-bearing requests. */
interface FeishuCredentials {
  readonly appId: string;
  readonly appSecret: string;
}
/** The identity resolved for one authorized bot. */
interface FeishuIdentity {
  /** Token for calling app-scoped APIs such as sending a message. */
  readonly tenantAccessToken: string;
  /** OAuth user token returned by the code exchange, when one was requested. */
  readonly userAccessToken?: string;
  readonly botOpenId: string;
  readonly botName: string;
  readonly tenantName?: string;
}
/** Feishu REST surface the adapter depends on. */
interface FeishuApi {
  /** Exchange an OAuth authorization code for the authorizing user's identity. */
  authorize(code: string): Promise<FeishuIdentity>;
  /** Mint (or reuse) an app-scoped tenant token. */
  tenantToken(): Promise<string>;
  /** Send one plain-text message to a chat or user. */
  sendText(token: string, target: ReplyTarget, text: string, replyTo?: string): Promise<void>;
}
/**
 * Create a Feishu client.
 * @param credentials - the app id/secret pair used for app tokens.
 * @param fetcher - HTTP implementation; injectable for tests.
 * @param baseUrl - API host, overridable to target Lark's international host.
 * @param now - clock, injectable so token-expiry behaviour is testable.
 * @returns the client.
 */
declare function createFeishuApi(credentials: FeishuCredentials, fetcher?: typeof fetch, baseUrl?: string, now?: () => number): FeishuApi;
//#endregion
//#region src/signature.d.ts
/**
 * Verify a Feishu/Lark event-subscription callback signature.
 *
 * Feishu computes `SHA256(timestamp + nonce + encryptKey)` over the *concatenated
 * UTF-8 text* and then appends the raw request body to that digest input — the
 * concatenation order below is the whole algorithm:
 *
 *     digest = SHA256(timestamp + nonce + encryptKey + rawBody)
 *
 * Two easy mistakes this implementation deliberately avoids:
 *
 * - **It is not HMAC.** `encryptKey` is a literal segment of the message, not a
 *   key. Using `createHmac('sha256', encryptKey)` produces a different digest for
 *   every input, so every genuine callback would be rejected.
 * - **The digest is hex, lowercase.** Comparison is case-folded so an uppercase
 *   `X-Lark-Signature` header still verifies; the bytes are compared with
 *   `timingSafeEqual` rather than `===`, so a wrong signature cannot be found
 *   byte-by-byte through response timing.
 *
 * @param raw - the exact request body bytes, decoded as UTF-8. It must be the
 *   unmodified body: any reserialization of the JSON invalidates the digest.
 * @param timestamp - the `X-Lark-Request-Timestamp` header.
 * @param nonce - the `X-Lark-Request-Nonce` header.
 * @param signature - the `X-Lark-Signature` header to check.
 * @param encryptKey - the event subscription's Encrypt Key.
 * @returns `true` only when the signature matches.
 */
declare function verifyFeishuSignature(raw: string, timestamp: string, nonce: string, signature: string, encryptKey: string): boolean;
//#endregion
//#region src/decrypt.d.ts
/**
 * Decryption of an encrypted Feishu event callback.
 *
 * When an Encrypt Key is configured, Feishu replaces the whole callback body
 * with `{"encrypt":"<base64>"}`. The plaintext is recovered as:
 *
 *     key        = SHA256(encryptKey)          // raw 32 bytes, not hex
 *     payload    = base64decode(encrypt)
 *     iv         = payload[0..16]
 *     ciphertext = payload[16..]
 *     plaintext  = AES-256-CBC(key, iv, ciphertext), PKCS#7 unpadded
 *
 * Two details are easy to get wrong and are deliberate here:
 *
 * - **The key is the digest bytes, not the hex string.** Passing
 *   `digest('hex')` would give a 64-byte key and `createDecipheriv` would reject
 *   it outright.
 * - **The IV is transmitted in-band**, prefixed to the ciphertext inside the
 *   same base64 blob. It is not a separate header.
 *
 * @module dsh-im/decrypt
 */
/**
 * Decrypt one Feishu `encrypt` payload.
 * @param encrypted - the base64 `encrypt` field from the callback body.
 * @param encryptKey - the app's Encrypt Key, used as digest input.
 * @returns the decrypted UTF-8 JSON text.
 * @throws {Error} when the payload is too short to hold an IV, or the ciphertext
 *   is not authentic — a wrong key or a tampered body fails here, because
 *   PKCS#7 unpadding rejects a plaintext whose padding is malformed.
 */
declare function decryptFeishuEvent(encrypted: string, encryptKey: string): string;
//#endregion
//#region src/bot-store.d.ts
interface BotRecord {
  id: string;
  name: string;
  tenantName?: string;
  botOpenId: string;
  tokenRef: string;
  workspacePath: string;
  agentPreset: string;
  enabled: boolean;
}
declare class BotStore {
  private readonly bots;
  list(): BotRecord[];
  add(record: BotRecord): BotRecord;
  remove(id: string): void;
}
//#endregion
//#region src/quick-onboarding.d.ts
type QuickState = 'idle' | 'creating' | 'waiting_for_scan' | 'authorizing' | 'provisioning' | 'checking' | 'success' | 'failed' | 'expired';
interface QuickSession {
  readonly id: string;
  readonly state: string;
  readonly expiresAt: number;
  status: QuickState;
  botId?: string;
  error?: string;
}
declare class QuickOnboarding {
  private readonly ttlMs;
  private readonly now;
  private sessions;
  constructor(ttlMs?: number, now?: () => number);
  create(): QuickSession;
  get(id: string): QuickSession | undefined;
  transition(id: string, status: QuickState, botId?: string, error?: string): QuickSession;
  consume(id: string): QuickSession;
  cancel(id: string): void;
}
//#endregion
//#region src/webhook-types.d.ts
/**
 * Feishu event values projected after signature verification.
 *
 * Declaring the `im` kind through module augmentation is what lets a
 * `WebhookRule<'im'>` receive a typed event instead of generic JSON, mirroring
 * how the GitHub adapter registers its own kind.
 *
 * @module dsh-im/webhook-types
 */
declare module '@deepseek-ai/dsh-webhook' {
  interface WebhookEventMap {
    im: FeishuWebhookEvent;
  }
}
/** Provider event supplied to `WebhookRule<'im'>`. */
interface FeishuWebhookEvent {
  /** Always `feishu`; distinguishes providers if another IM adapter shares the kind. */
  readonly provider: 'feishu';
  readonly chatType: 'p2p' | 'group';
  readonly chatId: string;
  readonly senderOpenId: string;
  /** Message text with the bot's own mention placeholders removed. */
  readonly text: string;
  readonly threadId?: string;
  readonly parentId?: string;
}
//#endregion
//#region src/index.d.ts
declare const name = "dsh-im";
/**
 * Only the web server is a hard dependency: it is the socket this plugin
 * registers on, and there is nothing to do without it.
 */
declare const inject: string[];
interface Config {
  /** Exact absolute path for Feishu event callbacks. */
  callbackPath: string;
  /** Exact absolute path for the OAuth redirect. */
  oauthCallbackPath: string;
  /**
   * Credential reference holding the Feishu Encrypt Key. When present, inbound
   * callbacks are signature-verified and decrypted. Empty disables both, which
   * is only appropriate for a trusted local tunnel during setup.
   */
  encryptKeyRef?: string;
  /** Credential reference holding the Verification Token. */
  verificationTokenRef?: string;
  /** Credential reference holding the app_id, used for token exchanges. */
  appIdRef?: string;
  /** Credential reference holding the app_secret. */
  appSecretRef?: string;
  /**
   * The bot's own `open_id`, matched against group-message mentions.
   *
   * This cannot be discovered from an inbound callback: Feishu identifies the
   * *author* of a mention, never the reader. Without it every group message is
   * discarded (a group message that does not mention the bot is not for us), so
   * it is required for group use even though p2p works without it.
   */
  botOpenId?: string;
  /** Raw callback body ceiling in bytes. */
  maxBodyBytes?: number;
}
/**
 * The declared configuration.
 *
 * Exported as a Schemastery schema so the loader validates the profile's config
 * before `apply` runs. Without it Cordis passes the raw object through
 * unvalidated (`vendor/cordis/src/fiber.ts` only applies a schema when the
 * plugin exports one).
 */
declare const Config: z<Required<Config>>;
declare function apply(ctx: Context, config: Config): void;
declare const _default: {
  name: string;
  inject: string[];
  Config: z<Required<Config>>;
  apply: typeof apply;
};
//#endregion
export { BotRecord, BotStore, Config, FeishuApi, FeishuCallback, FeishuCredentials, FeishuEventHeader, FeishuIdentity, FeishuMention, FeishuMessage, FeishuMessageEvent, type FeishuWebhookEvent, NormalizedMessage, QuickOnboarding, QuickSession, QuickState, ReplyTarget, apply, conversationKey, createFeishuApi, decryptFeishuEvent, _default as default, inject, isBotMentioned, messageText, name, normalizeCallback, parseCallback, receiveTarget, stripBotMentions, verifyFeishuSignature };
//# sourceMappingURL=index.d.ts.map