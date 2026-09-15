import { l as NormalizedMessage, t as ReplyTarget } from "./feishu-D_fJmJcC.js";
//#region src/transport.d.ts
/**
 * Remove one previously registered handler.
 *
 * Returned by every `on*` method so a caller can release a subscription without
 * depending on the transport's own teardown, which is what lets `apply` hand
 * each registration to `ctx.effect` and stay correctly disposable.
 */
type Unsubscribe = () => void;
/** A message the transport received but deliberately did not deliver. */
interface RejectedMessage {
  readonly messageId: string;
  readonly chatId: string;
  readonly senderId: string;
  /**
   * Why it was withheld, in the transport's own vocabulary (for example
   * `no_mention` or `sender_not_allowed`).
   *
   * This is reported rather than swallowed because a misconfigured gate is
   * otherwise indistinguishable from a quiet chat: the bot looks online and
   * simply never answers.
   */
  readonly reason: string;
}
/** Connection liveness, as the plugin needs to reason about it. */
type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed';
/** Receipt for one accepted send. */
interface SendReceipt {
  /** Feishu message id of the delivered message, when the platform reports one. */
  readonly messageId?: string;
}
/** Options for one outbound message. */
interface SendOptions {
  /**
   * Reply to this message id instead of posting a new one.
   *
   * A reply keeps the answer visually attached to the question, which is what
   * makes a threaded group conversation readable.
   */
  readonly replyTo?: string;
}
/** Handler for one inbound message. May be async; the transport ignores the result. */
type MessageHandler = (message: NormalizedMessage) => void | Promise<void>;
/**
 * One chat connection.
 *
 * Lifecycle is explicit and symmetric: {@link connect} resolves only once the
 * transport is actually able to receive, and {@link dispose} releases every
 * resource. A `connect` that resolves on a *scheduled* attempt would report
 * readiness the plugin does not have, so an adapter must await the real
 * handshake and reject when it cannot be established.
 */
interface ImTransport {
  /**
   * Establish the connection.
   * @returns a promise that resolves once messages can be received and rejects
   * when the connection cannot be established.
   */
  connect(): Promise<void>;
  /**
   * Release the connection and every subscription.
   *
   * Must be safe to call more than once and after a failed {@link connect},
   * because `ctx.effect` disposers run on a stop, an update, and an unload
   * alike, and startup failures are followed by teardown.
   * @returns a promise that resolves once teardown is complete.
   */
  dispose(): Promise<void>;
  /**
   * Subscribe to inbound messages that passed the transport's own gating.
   * @param handler - invoked for each actionable message.
   * @returns a disposer removing this handler.
   */
  onMessage(handler: MessageHandler): Unsubscribe;
  /**
   * Subscribe to messages the transport withheld.
   *
   * Separate from {@link onMessage} because these are policy outcomes, not
   * traffic: they exist for diagnostics, not for the dispatch path.
   * @param handler - invoked for each withheld message.
   * @returns a disposer removing this handler.
   */
  onReject(handler: (rejected: RejectedMessage) => void): Unsubscribe;
  /**
   * Subscribe to connection liveness changes.
   * @param handler - invoked on each change.
   * @returns a disposer removing this handler.
   */
  onConnectionChange(handler: (state: ConnectionState) => void): Unsubscribe;
  /**
   * Send one plain-text message.
   *
   * The transport owns authentication, so no token is passed in: a caller that
   * had to mint or carry a bearer would be reaching through the port.
   * @param target - where to send, as a receive-id type and value pair.
   * @param text - the message body.
   * @param options - optional reply threading.
   * @returns the receipt for the accepted message.
   */
  sendText(target: ReplyTarget, text: string, options?: SendOptions): Promise<SendReceipt>;
}
/**
 * Assert a reply target's declared type agrees with the id it carries.
 *
 * Feishu infers the receive-id type from the id's prefix, so a target whose
 * declared type disagrees with its value is routed as the *prefix* says and the
 * declared type is silently ignored. Checking here turns that into a named
 * error at the call site instead of a message delivered to the wrong place.
 * @param target - the target about to be used.
 * @throws {Error} when the value's prefix contradicts the declared type.
 */
declare function assertReplyTarget(target: ReplyTarget): void;
//#endregion
export { ConnectionState, ImTransport, MessageHandler, RejectedMessage, SendOptions, SendReceipt, Unsubscribe, assertReplyTarget };
//# sourceMappingURL=transport.d.ts.map