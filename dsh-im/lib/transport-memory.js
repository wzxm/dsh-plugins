import { assertReplyTarget } from "./transport.js";
//#region src/transport-memory.ts
/**
* Create an in-memory transport.
* @param options - optional injected failures.
* @returns the transport and its test handles.
*/
function createMemoryTransport(options = {}) {
	const messageHandlers = /* @__PURE__ */ new Set();
	const rejectHandlers = /* @__PURE__ */ new Set();
	const connectionHandlers = /* @__PURE__ */ new Set();
	const sent = [];
	let state = "closed";
	let disposed = false;
	const setState = (next) => {
		if (state === next) return;
		state = next;
		for (const handler of [...connectionHandlers]) handler(next);
	};
	return {
		sent,
		get messageHandlerCount() {
			return messageHandlers.size;
		},
		get disposed() {
			return disposed;
		},
		async connect() {
			setState("connecting");
			if (options.failConnect !== void 0) {
				setState("closed");
				throw options.failConnect;
			}
			setState("connected");
		},
		async dispose() {
			disposed = true;
			messageHandlers.clear();
			rejectHandlers.clear();
			connectionHandlers.clear();
			setState("closed");
		},
		onMessage(handler) {
			messageHandlers.add(handler);
			const unsubscribe = () => {
				messageHandlers.delete(handler);
			};
			return unsubscribe;
		},
		onReject(handler) {
			rejectHandlers.add(handler);
			return () => {
				rejectHandlers.delete(handler);
			};
		},
		onConnectionChange(handler) {
			connectionHandlers.add(handler);
			return () => {
				connectionHandlers.delete(handler);
			};
		},
		async sendText(target, text, sendOptions) {
			assertReplyTarget(target);
			if (options.failSend !== void 0) throw options.failSend;
			sent.push({
				target,
				text,
				...sendOptions === void 0 ? {} : { options: sendOptions }
			});
			return { messageId: `om_sent_${sent.length}` };
		},
		async emit(message) {
			for (const handler of [...messageHandlers]) await handler(message);
		},
		emitReject(rejected) {
			for (const handler of [...rejectHandlers]) handler(rejected);
		},
		setConnectionState(next) {
			setState(next);
		}
	};
}
//#endregion
export { createMemoryTransport };

//# sourceMappingURL=transport-memory.js.map