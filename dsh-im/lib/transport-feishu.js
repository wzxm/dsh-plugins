import { assertReplyTarget } from "./transport.js";
//#region src/transport-feishu.ts
/** The default loader: a dynamic import, so the cost is paid only on use. */
const loadRealSdk = async () => await import("@larksuiteoapi/node-sdk");
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
const CONNECTION_LOST_CODE = "not_connected";
/**
* Convert the port's policy options into the SDK's mutable config shape.
*
* The allowlists are copied because the SDK's config type is `string[]`; passing
* a caller's readonly array straight through would either fail to typecheck or,
* if cast, let the SDK mutate the caller's value.
* @param policy - the caller's policy options.
* @returns the SDK-shaped policy config.
*/
function toPolicyConfig(policy) {
	return {
		...policy.requireMention === void 0 ? {} : { requireMention: policy.requireMention },
		...policy.dmMode === void 0 ? {} : { dmMode: policy.dmMode },
		...policy.dmAllowlist === void 0 ? {} : { dmAllowlist: [...policy.dmAllowlist] },
		...policy.groupAllowlist === void 0 ? {} : { groupAllowlist: [...policy.groupAllowlist] },
		...policy.respondToMentionAll === void 0 ? {} : { respondToMentionAll: policy.respondToMentionAll }
	};
}
/**
* Create a Feishu transport.
*
* The SDK is imported here rather than at module load, so constructing the
* transport is what pays its cost.
* @param options - app credentials, domain, policy, and logger.
* @returns a connected-ready transport.
*/
async function createFeishuTransport(options) {
	const sdk = await (options.loadSdk ?? loadRealSdk)();
	const log = options.logger;
	const channel = sdk.createLarkChannel({
		appId: options.appId,
		appSecret: options.appSecret,
		transport: "websocket",
		domain: options.domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn",
		...options.policy === void 0 ? {} : { policy: toPolicyConfig(options.policy) },
		loggerLevel: sdk.LoggerLevel.warn,
		source: "dsh-im"
	});
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
	const messageSubscribers = /* @__PURE__ */ new Set();
	const rejectSubscribers = /* @__PURE__ */ new Set();
	const connectionSubscribers = /* @__PURE__ */ new Set();
	/** Channel deregistrations, released together on dispose. */
	const listeners = [];
	let disposed = false;
	listeners.push(channel.on("message", (message) => {
		const normalized = toNormalizedMessage(message);
		for (const handler of [...messageSubscribers]) handler(normalized);
	}), channel.on("reject", (event) => {
		const rejected = {
			messageId: event.messageId,
			chatId: event.chatId,
			senderId: event.senderId,
			reason: event.reason
		};
		for (const handler of [...rejectSubscribers]) handler(rejected);
	}), channel.on("reconnecting", () => {
		for (const handler of [...connectionSubscribers]) handler("reconnecting");
	}), channel.on("reconnected", () => {
		for (const handler of [...connectionSubscribers]) handler("connected");
	}), channel.on("error", (error) => {
		if (String(error.code) === CONNECTION_LOST_CODE) {
			log?.error(`dsh-im: Feishu connection lost: ${error.message}`);
			for (const handler of [...connectionSubscribers]) handler("closed");
		} else log?.warn(`dsh-im: Feishu transport error (${String(error.code)}): ${error.message}`);
	}));
	/** Build a subscriber disposer over one fan-out set. */
	const subscribe = (set, handler) => {
		set.add(handler);
		return () => {
			set.delete(handler);
		};
	};
	return {
		async connect() {
			await channel.connect();
			log?.info("dsh-im: connected to Feishu over websocket");
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			for (const off of listeners.splice(0)) off();
			messageSubscribers.clear();
			rejectSubscribers.clear();
			connectionSubscribers.clear();
			try {
				await channel.disconnect();
			} catch (error) {
				log?.warn(`dsh-im: error closing the Feishu connection: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
		onMessage(handler) {
			return subscribe(messageSubscribers, handler);
		},
		onReject(handler) {
			return subscribe(rejectSubscribers, handler);
		},
		onConnectionChange(handler) {
			return subscribe(connectionSubscribers, handler);
		},
		async sendText(target, text, sendOptions) {
			assertReplyTarget(target);
			const result = await channel.send(target.receiveId, { text }, sendOptions?.replyTo === void 0 ? {} : { replyTo: sendOptions.replyTo });
			return result.messageId === void 0 ? {} : { messageId: result.messageId };
		}
	};
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
function toNormalizedMessage(message) {
	return {
		eventId: message.messageId,
		chatType: message.chatType,
		chatId: message.chatId,
		senderOpenId: message.senderId,
		text: message.content,
		messageId: message.messageId,
		...message.replyToMessageId === void 0 || message.replyToMessageId === "" ? {} : { parentId: message.replyToMessageId },
		...message.threadId === void 0 || message.threadId === "" ? {} : { threadId: message.threadId }
	};
}
//#endregion
export { createFeishuTransport, toNormalizedMessage, toPolicyConfig };

//# sourceMappingURL=transport-feishu.js.map