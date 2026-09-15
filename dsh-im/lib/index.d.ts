import { a as FeishuEventHeader, c as FeishuMessageEvent, d as messageText, f as normalizeCallback, g as verificationToken, h as verificationChallenge, i as FeishuCallback, l as NormalizedMessage, m as stripBotMentions, n as conversationKey, o as FeishuMention, p as parseCallback, r as receiveTarget, s as FeishuMessage, t as ReplyTarget, u as isBotMentioned } from "./feishu-D_fJmJcC.js";
import z from "@deepseek-ai/schemastery";
import { Session } from "@deepseek-ai/dsh-session";
import { Context } from "@deepseek-ai/cordis";
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
//#region src/session-bridge.d.ts
/** The assistant text and outcome of one turn. */
interface TurnOutput {
  /** Concatenated text of the last assistant message in the turn, or `''`. */
  readonly text: string;
  /** The `kind` of the turn's end reason, when a `turn/end` was observed. */
  readonly reason: string | undefined;
  /** Whether the turn was interrupted before producing visible content. */
  readonly interrupted: boolean;
}
/**
 * Extract the assistant's reply for the turn that started at `fromSeq`.
 *
 * Only events at or after `fromSeq` are considered, so a continuing
 * conversation returns this turn's answer rather than the previous one. The
 * **last** `assistant/message` wins: a turn may contain several steps, and the
 * final one carries the user-facing reply.
 *
 * @param session - the live session whose log is read.
 * @param fromSeq - log offset captured before the prompt was submitted.
 * @returns the turn's text, end reason, and interruption flag.
 */
declare function readTurnOutput(session: Session, fromSeq: number): TurnOutput;
/** One live binding between a conversation key and its Agent. */
interface ConversationBinding {
  /** Session identity, for diagnostics and titles. */
  readonly sessionId: string;
  /** Submit one prompt and resolve with the turn's reply. */
  ask(prompt: string): Promise<TurnOutput>;
}
/**
 * Serializes prompts per conversation.
 *
 * Two messages arriving close together must not interleave into one Agent: the
 * second would be consumed as steering for the first turn, and its reply would
 * be read as part of the same turn. A per-key promise chain makes each prompt
 * wait for the previous one to settle.
 */
declare class ConversationQueue {
  private readonly tails;
  /**
   * Run `task` after every previously queued task for `key` has settled.
   * @param key - the conversation key.
   * @param task - the work to serialize.
   * @returns the task's result.
   */
  run<T>(key: string, task: () => Promise<T>): Promise<T>;
  /** Number of tracked conversations; for tests and diagnostics. */
  get size(): number;
}
//#endregion
//#region src/dispatch.d.ts
/** Resolved configuration for one dispatch executor. */
interface DispatcherConfig {
  /** Bot instance id; scopes conversation keys so two bots never share a Session. */
  readonly botId: string;
  /** Working directory for Sessions created by this bot. */
  readonly workspacePath: string;
  /** Agent composition mounted for each new Session. */
  readonly agentPreset: string;
  /** Permission preset applied to each Session. */
  readonly permissionPreset: string;
  /** Ceiling on one reply, in characters, before truncation. */
  readonly maxReplyChars: number;
}
/** The outcome of handling one message. */
interface DispatchResult {
  readonly replied: boolean;
  /** Why no reply was sent, when `replied` is false. */
  readonly reason?: string;
}
/**
 * Build the dispatcher that turns messages into turns and replies.
 * @param ctx - plugin-scoped context that owns created Agents.
 * @param config - resolved dispatch configuration.
 * @param api - Feishu client used to send the reply.
 * @returns a function handling one normalized message.
 */
declare function createDispatcher(ctx: Context, config: DispatcherConfig, api: FeishuApi): (message: NormalizedMessage) => Promise<DispatchResult>;
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
  /** Bot instance id; scopes conversation keys so two bots never share a Session. */
  botId?: string;
  /** Working directory for Sessions created by this bot. */
  workspacePath?: string;
  /** Agent composition mounted for each new Session. */
  readonly agentPreset?: string;
  /** Permission preset applied to each Session. */
  permissionPreset?: string;
  /** Ceiling on one reply, in characters, before truncation. */
  maxReplyChars?: number;
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
export { BotRecord, BotStore, Config, ConversationBinding, ConversationQueue, DispatchResult, DispatcherConfig, FeishuApi, FeishuCallback, FeishuCredentials, FeishuEventHeader, FeishuIdentity, FeishuMention, FeishuMessage, FeishuMessageEvent, NormalizedMessage, QuickOnboarding, QuickSession, QuickState, ReplyTarget, TurnOutput, apply, conversationKey, createDispatcher, createFeishuApi, decryptFeishuEvent, _default as default, inject, isBotMentioned, messageText, name, normalizeCallback, parseCallback, readTurnOutput, receiveTarget, stripBotMentions, verificationChallenge, verificationToken, verifyFeishuSignature };
//# sourceMappingURL=index.d.ts.map