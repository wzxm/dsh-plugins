import { _ as NormalizedMessage, a as SendOptions, i as RejectedMessage, l as ReplyTarget, n as ImTransport, t as ConnectionState } from "./transport-D2yPiUtg.js";
//#region src/transport-memory.d.ts
/** One message the transport was asked to send. */
interface SentMessage {
  readonly target: ReplyTarget;
  readonly text: string;
  readonly options?: SendOptions;
}
/** Injectable behaviour for the memory transport. */
interface MemoryTransportOptions {
  /**
   * Make {@link ImTransport.connect} reject with this error.
   *
   * Used to prove the plugin degrades instead of throwing when the platform is
   * unreachable at startup.
   */
  readonly failConnect?: Error;
  /**
   * Make {@link ImTransport.sendText} reject with this error.
   *
   * A failed reply is the common real-world failure (revoked scope, removed
   * bot), and it must not take down the connection or the queue.
   */
  readonly failSend?: Error;
}
/** A memory transport plus the handles a test drives it with. */
interface MemoryTransport extends ImTransport {
  /** Every message accepted by {@link ImTransport.sendText}, in order. */
  readonly sent: SentMessage[];
  /** Deliver one message to the registered handlers, as a live message would. */
  emit(message: NormalizedMessage): Promise<void>;
  /** Report one policy-withheld message to the reject handlers. */
  emitReject(rejected: RejectedMessage): void;
  /** Force a connection-state change, as a socket drop or recovery would. */
  setConnectionState(state: ConnectionState): void;
  /** Current number of live message subscriptions. */
  readonly messageHandlerCount: number;
  /** Whether {@link ImTransport.dispose} has been called. */
  readonly disposed: boolean;
}
/**
 * Create an in-memory transport.
 * @param options - optional injected failures.
 * @returns the transport and its test handles.
 */
declare function createMemoryTransport(options?: MemoryTransportOptions): MemoryTransport;
//#endregion
export { MemoryTransport, MemoryTransportOptions, SentMessage, createMemoryTransport };
//# sourceMappingURL=transport-memory.d.ts.map