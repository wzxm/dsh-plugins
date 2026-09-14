import { Context } from "@deepseek-ai/cordis";
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
//#region src/feishu.d.ts
interface FeishuTextEvent {
  event_id: string;
  chat_type: 'p2p' | 'group';
  chat_id: string;
  sender_id: string;
  text: string;
  mentions?: Array<{
    key: string;
    name: string;
    id: string;
  }>;
  thread_id?: string;
  root_id?: string;
}
declare function normalizeMessage(event: FeishuTextEvent, botOpenId: string): string | null;
declare function conversationKey(botId: string, event: Pick<FeishuTextEvent, 'chat_type' | 'chat_id' | 'thread_id' | 'root_id'>): string;
//#endregion
//#region src/feishu-api.d.ts
/** Small Feishu REST client; callers provide fetch so it is deterministic in tests. */
interface FeishuApi {
  authorize(code: string): Promise<{
    tenantAccessToken: string;
    botOpenId: string;
    botName: string;
    tenantName?: string;
  }>;
  sendText(token: string, receiveId: string, text: string, replyTo?: string): Promise<void>;
}
declare function createFeishuApi(fetcher?: typeof fetch, baseUrl?: string): FeishuApi;
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
//#region src/index.d.ts
declare const name = "dsh-im";
declare const inject: string[];
interface Config {
  callbackPath: string;
  oauthCallbackPath: string;
  publicBaseUrl: string;
  maxBodyBytes: number;
}
declare function apply(ctx: Context, config: Config): void;
declare const _default: {
  name: string;
  inject: string[];
  apply: typeof apply;
};
//#endregion
export { BotRecord, BotStore, Config, FeishuApi, FeishuTextEvent, QuickOnboarding, QuickSession, QuickState, apply, conversationKey, createFeishuApi, _default as default, inject, name, normalizeMessage, verifyFeishuSignature };