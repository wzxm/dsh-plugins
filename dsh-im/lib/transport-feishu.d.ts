import { l as NormalizedMessage } from "./feishu-D_fJmJcC.js";
import { ImTransport } from "./transport.js";
//#region src/transport-feishu.d.ts
/** Minimal logging surface, so this module does not depend on Cordis. */
interface TransportLogger {
  debug: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}
/** Policy gates applied before a message reaches the plugin. */
interface FeishuPolicyOptions {
  /**
   * Require an explicit mention before a group message is delivered.
   *
   * Defaults to `true`, matching the SDK: a bot in a busy group should not
   * answer every message.
   */
  readonly requireMention?: boolean;
  /**
   * Who may open a direct conversation: `open`, `allowlist`, or `disabled`.
   *
   * Defaults to `open`.
   */
  readonly dmMode?: 'open' | 'allowlist' | 'disabled';
  /** Senders permitted when `dmMode` is `allowlist`. */
  readonly dmAllowlist?: readonly string[];
  /** Chats the bot will serve, when set. An empty list means every chat. */
  readonly groupAllowlist?: readonly string[];
  /** Whether `@all` counts as addressing the bot. Defaults to `false`. */
  readonly respondToMentionAll?: boolean;
}
/** The subset of the SDK this adapter uses, so a test can supply a stand-in. */
interface FeishuSdk {
  /**
   * Build a channel.
   *
   * The parameter is {@link FeishuChannelConfig} rather than the SDK's own
   * `LarkChannelOptions`: the adapter assembles this exact object, so stating it
   * here is what makes the config reviewable, and the real SDK still satisfies
   * the interface because its options type accepts every field set below.
   */
  createLarkChannel: (options: FeishuChannelConfig) => FeishuChannel;
  LoggerLevel: {
    warn: number;
  };
}
/** The channel options this adapter sets, mirroring the SDK's config shape. */
interface FeishuChannelConfig {
  readonly appId: string;
  readonly appSecret: string;
  readonly transport: 'websocket';
  readonly domain: string;
  readonly policy?: {
    requireMention?: boolean;
    dmMode?: 'open' | 'allowlist' | 'disabled';
    dmAllowlist?: string[];
    groupAllowlist?: string[];
    respondToMentionAll?: boolean;
  };
  readonly loggerLevel: number;
  readonly source: string;
}
/** Payload carried by each channel event name. */
interface FeishuChannelEvents {
  message: SdkMessage;
  reject: SdkReject;
  error: SdkError;
  reconnecting: undefined;
  reconnected: undefined;
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
interface FeishuChannel {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  on: <K extends keyof FeishuChannelEvents>(name: K, handler: (payload: FeishuChannelEvents[K]) => void) => () => void;
  send: (to: string, input: {
    text: string;
  }, options: {
    replyTo?: string;
  }) => Promise<{
    messageId?: string;
  }>;
}
/** A message as the SDK normalizes it, before translation to the port's shape. */
interface SdkMessage {
  readonly messageId: string;
  readonly chatId: string;
  readonly chatType: 'p2p' | 'group';
  readonly senderId: string;
  readonly content: string;
  readonly threadId?: string;
  readonly replyToMessageId?: string;
  readonly rootId?: string;
}
/** A withheld message as the SDK reports it. */
interface SdkReject {
  readonly messageId: string;
  readonly chatId: string;
  readonly senderId: string;
  readonly reason: string;
}
/** An error as the channel's error event carries it. */
interface SdkError {
  readonly code: string;
  readonly message: string;
}
/** Loads the SDK; injectable so the adapter is testable without the real one. */
type FeishuSdkLoader = () => Promise<FeishuSdk>;
/** Construction options for the Feishu transport. */
interface FeishuTransportOptions {
  /** App id (`cli_…`) of a Feishu/Lark bot application. */
  readonly appId: string;
  /**
   * App secret.
   *
   * Read as a plain value because it has already been resolved from the
   * credential provider by the caller; this module must not know how secrets are
   * stored.
   */
  readonly appSecret: string;
  /** Which brand to authenticate against. Defaults to `feishu`. */
  readonly domain?: 'feishu' | 'lark';
  /** Policy gates; omitted fields take the SDK defaults. */
  readonly policy?: FeishuPolicyOptions;
  /** Sink for SDK-originated and adapter-originated diagnostics. */
  readonly logger?: TransportLogger;
  /** SDK loader override; defaults to importing the real SDK. */
  readonly loadSdk?: FeishuSdkLoader;
}
/**
 * Convert the port's policy options into the SDK's mutable config shape.
 *
 * The allowlists are copied because the SDK's config type is `string[]`; passing
 * a caller's readonly array straight through would either fail to typecheck or,
 * if cast, let the SDK mutate the caller's value.
 * @param policy - the caller's policy options.
 * @returns the SDK-shaped policy config.
 */
declare function toPolicyConfig(policy: FeishuPolicyOptions): {
  requireMention?: boolean;
  dmMode?: 'open' | 'allowlist' | 'disabled';
  dmAllowlist?: string[];
  groupAllowlist?: string[];
  respondToMentionAll?: boolean;
};
/**
 * Create a Feishu transport.
 *
 * The SDK is imported here rather than at module load, so constructing the
 * transport is what pays its cost.
 * @param options - app credentials, domain, policy, and logger.
 * @returns a connected-ready transport.
 */
declare function createFeishuTransport(options: FeishuTransportOptions): Promise<ImTransport>;
/**
 * Translate the SDK's normalized message into the plugin's.
 *
 * The two shapes differ in field names only; the SDK has already decoded the
 * double-encoded `content`, stripped the bot's own mention token from the text,
 * and computed whether the bot was addressed.
 * @param message - an SDK `NormalizedMessage`.
 * @returns the same message in the plugin's vocabulary.
 */
declare function toNormalizedMessage(message: {
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  senderId: string;
  content: string;
  threadId?: string;
  replyToMessageId?: string;
  rootId?: string;
}): NormalizedMessage;
//#endregion
export { FeishuChannel, FeishuChannelConfig, FeishuChannelEvents, FeishuPolicyOptions, FeishuSdk, FeishuSdkLoader, FeishuTransportOptions, SdkError, SdkMessage, SdkReject, TransportLogger, createFeishuTransport, toNormalizedMessage, toPolicyConfig };
//# sourceMappingURL=transport-feishu.d.ts.map