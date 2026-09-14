import { credentialRef, isCredentialRefName } from "@deepseek-ai/dsh-credentials";
import { WebhookDeliveryId, WebhookSourceId } from "@deepseek-ai/dsh-webhook";
import z from "@deepseek-ai/schemastery";
import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
//#region src/body.ts
/** HTTP refusal whose message is safe to return to the sender verbatim. */
var CallbackHttpError = class extends Error {
	status;
	name = "CallbackHttpError";
	constructor(status, message) {
		super(message);
		this.status = status;
	}
};
/** Parse a decimal Content-Length or reject an ambiguous header. */
function contentLength(request) {
	const value = request.headers["content-length"];
	if (value === void 0) return void 0;
	if (!/^(0|[1-9]\d*)$/.test(value)) throw new CallbackHttpError(400, "invalid Content-Length");
	const length = Number(value);
	if (!Number.isSafeInteger(length)) throw new CallbackHttpError(413, "request body is too large");
	return length;
}
/**
* Read one request body as exact, bounded UTF-8 text.
* @param request - incoming request before any parser consumes it.
* @param maxBodyBytes - positive byte ceiling.
* @returns the decoded body after EOF.
* @throws {CallbackHttpError} for invalid length, excess bytes, invalid UTF-8, or an aborted stream.
*/
async function readBoundedUtf8Body(request, maxBodyBytes) {
	const declared = contentLength(request);
	if (declared !== void 0 && declared > maxBodyBytes) {
		request.resume();
		throw new CallbackHttpError(413, "request body is too large");
	}
	const chunks = [];
	let size = 0;
	try {
		for await (const raw of request) {
			const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
			size += chunk.byteLength;
			if (size > maxBodyBytes) {
				request.resume();
				throw new CallbackHttpError(413, "request body is too large");
			}
			chunks.push(chunk);
		}
	} catch (error) {
		if (error instanceof CallbackHttpError) throw error;
		throw new CallbackHttpError(400, "request body was aborted");
	}
	if (!request.complete) throw new CallbackHttpError(400, "request body was aborted");
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
	} catch {
		throw new CallbackHttpError(400, "request body is not valid UTF-8");
	}
}
//#endregion
//#region src/decrypt.ts
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
/** Length of the AES block, and therefore of the in-band IV prefix. */
const IV_BYTES = 16;
/**
* Decrypt one Feishu `encrypt` payload.
* @param encrypted - the base64 `encrypt` field from the callback body.
* @param encryptKey - the app's Encrypt Key, used as digest input.
* @returns the decrypted UTF-8 JSON text.
* @throws {Error} when the payload is too short to hold an IV, or the ciphertext
*   is not authentic — a wrong key or a tampered body fails here, because
*   PKCS#7 unpadding rejects a plaintext whose padding is malformed.
*/
function decryptFeishuEvent(encrypted, encryptKey) {
	const key = createHash("sha256").update(encryptKey).digest();
	const payload = Buffer.from(encrypted, "base64");
	if (payload.length <= IV_BYTES) throw new Error("feishu encrypted payload is too short to contain an IV");
	const iv = payload.subarray(0, IV_BYTES);
	const ciphertext = payload.subarray(IV_BYTES);
	const decipher = createDecipheriv("aes-256-cbc", key, iv);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
//#endregion
//#region src/event.ts
/** Whether `value` is a non-array object. */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Whether `value` is a non-empty string. */
function isNonEmptyString(value) {
	return typeof value === "string" && value.trim() !== "";
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
function parseCallback(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("feishu callback body is not valid JSON");
	}
	if (!isRecord(parsed)) throw new Error("feishu callback body must be a JSON object");
	return parsed;
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
function messageText(content) {
	if (!isNonEmptyString(content)) return null;
	let parsed;
	try {
		parsed = JSON.parse(content);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	const text = parsed["text"];
	return typeof text === "string" ? text : null;
}
/** Whether one mention refers to the given bot. */
function mentionsBot(mention, botOpenId) {
	return mention.id?.open_id === botOpenId;
}
/**
* Whether a group message explicitly addresses the bot.
* @param message - the raw message object.
* @param botOpenId - the bot's own open_id.
* @returns true when any mention resolves to the bot.
*/
function isBotMentioned(message, botOpenId) {
	return (message.mentions ?? []).some((m) => mentionsBot(m, botOpenId));
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
function stripBotMentions(text, mentions, botOpenId) {
	let stripped = text;
	for (const mention of mentions) {
		if (!mentionsBot(mention, botOpenId)) continue;
		if (isNonEmptyString(mention.key)) stripped = stripped.split(mention.key).join("");
	}
	return stripped.trim();
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
function normalizeCallback(callback, botOpenId) {
	const header = callback.header;
	const message = callback.event?.message;
	if (message === void 0) return null;
	if (!isNonEmptyString(message.message_id)) return null;
	if (!isNonEmptyString(message.chat_id)) return null;
	const chatType = message.chat_type === "group" ? "group" : "p2p";
	const mentions = message.mentions ?? [];
	if (chatType === "group" && !isBotMentioned(message, botOpenId)) return null;
	const text = messageText(message.content);
	if (text === null) return null;
	const body = stripBotMentions(text, mentions, botOpenId);
	if (body === "") return null;
	return {
		eventId: isNonEmptyString(header?.event_id) ? header.event_id : message.message_id,
		chatType,
		chatId: message.chat_id,
		senderOpenId: callback.event?.sender?.sender_id?.open_id ?? "",
		text: body,
		...isNonEmptyString(message.parent_id) ? { parentId: message.parent_id } : {},
		...isNonEmptyString(message.thread_id) ? { threadId: message.thread_id } : {},
		messageId: message.message_id
	};
}
//#endregion
//#region src/signature.ts
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
function verifyFeishuSignature(raw, timestamp, nonce, signature, encryptKey) {
	const expected = createHash("sha256").update(timestamp + nonce + encryptKey + raw).digest();
	if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
	const provided = Buffer.from(signature, "hex");
	return provided.length === expected.length && timingSafeEqual(provided, expected);
}
//#endregion
//#region src/handler.ts
/** Send one empty or plain-text response exactly once. */
function respond(response, status, message) {
	if (message === void 0) {
		response.writeHead(status);
		response.end();
		return;
	}
	response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
	response.end(message);
}
/** Answer with a JSON body, for the challenge handshake. */
function respondJson(response, status, value) {
	const body = JSON.stringify(value);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body)
	});
	response.end(body);
}
/** Read one unambiguous non-empty request header. */
function requiredHeader(request, name) {
	const values = request.headersDistinct[name];
	const value = values?.[0];
	if (values?.length !== 1 || value === void 0 || value.trim() === "") throw new CallbackHttpError(400, `missing ${name} header`);
	return value;
}
/** Whether Content-Type names JSON, with at most one UTF-8 charset parameter. */
function isJsonContentType(value) {
	if (value === void 0) return false;
	const [mediaType, parameter, ...extra] = value.split(";").map((part) => part.trim());
	if (mediaType?.toLowerCase() !== "application/json") return false;
	if (parameter === void 0) return true;
	return extra.length === 0 && /^charset=(?:utf-8|"utf-8")$/i.test(parameter);
}
/**
* Unwrap a `{"encrypt":"…"}` envelope.
* @param raw - the verified raw body.
* @param encryptKey - the configured Encrypt Key.
* @returns the plaintext JSON, or the original body when it is not an envelope.
* @throws {CallbackHttpError} when the body claims to be encrypted but cannot be decrypted.
*/
function unwrap(raw, encryptKey) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return raw;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return raw;
	const encrypted = parsed["encrypt"];
	if (typeof encrypted !== "string" || encrypted === "") return raw;
	if (encryptKey === void 0 || encryptKey === "") throw new CallbackHttpError(503, "an encrypted callback arrived but no Encrypt Key is configured");
	try {
		return decryptFeishuEvent(encrypted, encryptKey);
	} catch {
		throw new CallbackHttpError(401, "encrypted callback could not be decrypted");
	}
}
/**
* Create the callback handler for one bot.
* @param _ctx - plugin context, reserved for logging.
* @param config - resolved ingress configuration.
* @returns an HTTP handler that answers after in-memory dispatch.
*/
function createFeishuHandler(_ctx, config) {
	return async (request, response) => {
		try {
			if (request.method !== "POST") {
				response.setHeader("allow", "POST");
				throw new CallbackHttpError(405, "method not allowed");
			}
			if (!isJsonContentType(request.headers["content-type"])) throw new CallbackHttpError(415, "content type must be application/json");
			const raw = await readBoundedUtf8Body(request, config.maxBodyBytes);
			if (config.encryptKey !== void 0 && config.encryptKey !== "") {
				if (!verifyFeishuSignature(raw, requiredHeader(request, "x-lark-request-timestamp"), requiredHeader(request, "x-lark-request-nonce"), requiredHeader(request, "x-lark-signature"), config.encryptKey)) throw new CallbackHttpError(401, "invalid signature");
			}
			const plaintext = unwrap(raw, config.encryptKey);
			let callback;
			try {
				callback = parseCallback(plaintext);
			} catch {
				throw new CallbackHttpError(400, "callback body is not a valid JSON object");
			}
			if (callback.type === "url_verification" || callback.challenge !== void 0) {
				if (config.verificationToken !== void 0 && config.verificationToken !== "" && callback.token !== config.verificationToken) throw new CallbackHttpError(401, "invalid verification token");
				respondJson(response, 200, { challenge: callback.challenge ?? "" });
				return;
			}
			const message = normalizeCallback(callback, config.botOpenId);
			if (message === null) {
				respond(response, 200);
				return;
			}
			await config.onMessage(message);
			respond(response, 200);
		} catch (error) {
			if (error instanceof CallbackHttpError) {
				respond(response, error.status, error.message);
				return;
			}
			_ctx.logger.warn("dsh-im: callback handling failed");
			respond(response, 500, "callback handling failed");
		}
	};
}
//#endregion
//#region src/feishu.ts
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
function receiveTarget(message) {
	if (message.chatType === "p2p") {
		if (message.senderOpenId === "") throw new Error("cannot reply to a p2p message without the sender open_id");
		return {
			receiveIdType: "open_id",
			receiveId: message.senderOpenId
		};
	}
	return {
		receiveIdType: "chat_id",
		receiveId: message.chatId
	};
}
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
function conversationKey(botId, message) {
	return [
		botId,
		message.chatType,
		message.chatId,
		message.threadId ?? message.parentId ?? "root"
	].join(":");
}
//#endregion
//#region src/feishu-api.ts
/** Refresh an app token this long before its stated expiry. */
const TOKEN_REFRESH_SKEW_MS = 6e4;
/** Read a non-empty string field, or throw naming the endpoint that omitted it. */
function requiredString(record, field, where) {
	const value = record[field];
	if (typeof value !== "string" || value === "") throw new Error(`feishu ${where} response is missing "${field}"`);
	return value;
}
/**
* Create a Feishu client.
* @param credentials - the app id/secret pair used for app tokens.
* @param fetcher - HTTP implementation; injectable for tests.
* @param baseUrl - API host, overridable to target Lark's international host.
* @param now - clock, injectable so token-expiry behaviour is testable.
* @returns the client.
*/
function createFeishuApi(credentials, fetcher = fetch, baseUrl = "https://open.feishu.cn", now = () => Date.now()) {
	let cachedAppToken;
	let cachedTenantToken;
	/** Epoch-ms instant a token with `expiresIn` seconds stops being usable. */
	const usableUntil = (expiresIn) => {
		const lifetimeSeconds = typeof expiresIn === "number" ? expiresIn : 7200;
		return now() + Math.max(0, lifetimeSeconds * 1e3 - TOKEN_REFRESH_SKEW_MS);
	};
	const request = async (path, init, where) => {
		const response = await fetcher(`${baseUrl}${path}`, init);
		let body;
		try {
			body = await response.json();
		} catch {
			throw new Error(`feishu ${where} returned a non-JSON response (HTTP ${response.status})`);
		}
		const record = typeof body === "object" && body !== null && !Array.isArray(body) ? body : {};
		if (!response.ok || record["code"] !== 0) throw new Error(`feishu ${where} failed: ${String(record["msg"] ?? response.status)}`);
		return record;
	};
	const mintAppToken = async () => {
		const body = await request("/open-apis/auth/v3/app_access_token/internal", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				app_id: credentials.appId,
				app_secret: credentials.appSecret
			})
		}, "app_access_token");
		const token = requiredString(body, "app_access_token", "app_access_token");
		cachedAppToken = {
			token,
			usableUntil: usableUntil(body["expire"])
		};
		return token;
	};
	const appToken = async () => {
		if (cachedAppToken !== void 0 && now() < cachedAppToken.usableUntil) return cachedAppToken.token;
		return mintAppToken();
	};
	const tenantToken = async () => {
		if (cachedTenantToken !== void 0 && now() < cachedTenantToken.usableUntil) return cachedTenantToken.token;
		const body = await request("/open-apis/auth/v3/tenant_access_token/internal", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				app_id: credentials.appId,
				app_secret: credentials.appSecret
			})
		}, "tenant_access_token");
		const token = requiredString(body, "tenant_access_token", "tenant_access_token");
		cachedTenantToken = {
			token,
			usableUntil: usableUntil(body["expire"])
		};
		return token;
	};
	return {
		tenantToken,
		async authorize(code) {
			const bearer = await appToken();
			const data = (await request("/open-apis/authen/v1/oidc/access_token", {
				method: "POST",
				headers: {
					authorization: `Bearer ${bearer}`,
					"content-type": "application/json"
				},
				body: JSON.stringify({
					grant_type: "authorization_code",
					code
				})
			}, "oidc/access_token"))["data"];
			if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("feishu oidc/access_token response is missing \"data\"");
			const record = data;
			const botOpenId = requiredString(record, "open_id", "oidc/access_token");
			return {
				tenantAccessToken: await tenantToken(),
				userAccessToken: requiredString(record, "access_token", "oidc/access_token"),
				botOpenId,
				botName: typeof record["name"] === "string" && record["name"] !== "" ? record["name"] : botOpenId,
				...typeof record["tenant_name"] === "string" ? { tenantName: record["tenant_name"] } : {}
			};
		},
		async sendText(token, target, text, replyTo) {
			const content = JSON.stringify({ text });
			await request(replyTo === void 0 ? `/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(target.receiveIdType)}` : `/open-apis/im/v1/messages/${encodeURIComponent(replyTo)}/reply`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json"
				},
				body: JSON.stringify(replyTo === void 0 ? {
					receive_id: target.receiveId,
					msg_type: "text",
					content
				} : {
					msg_type: "text",
					content
				})
			}, "im/v1/messages");
		}
	};
}
//#endregion
//#region src/bot-store.ts
var BotStore = class {
	bots = /* @__PURE__ */ new Map();
	list() {
		return [...this.bots.values()].map((x) => ({ ...x }));
	}
	add(record) {
		if (this.bots.has(record.id)) throw new Error(`bot already exists: ${record.id}`);
		this.bots.set(record.id, { ...record });
		return { ...record };
	}
	remove(id) {
		this.bots.delete(id);
	}
};
//#endregion
//#region src/quick-onboarding.ts
var QuickOnboarding = class {
	ttlMs;
	now;
	sessions = /* @__PURE__ */ new Map();
	constructor(ttlMs = 3e5, now = () => Date.now()) {
		this.ttlMs = ttlMs;
		this.now = now;
	}
	create() {
		const id = crypto.randomUUID();
		const s = {
			id,
			state: crypto.randomUUID(),
			expiresAt: this.now() + this.ttlMs,
			status: "waiting_for_scan"
		};
		this.sessions.set(id, s);
		return { ...s };
	}
	get(id) {
		const s = this.sessions.get(id);
		if (!s) return;
		if (s.status === "waiting_for_scan" && this.now() >= s.expiresAt) s.status = "expired";
		return { ...s };
	}
	transition(id, status, botId, error) {
		const s = this.sessions.get(id);
		if (!s) throw new Error("quick onboarding session not found");
		if (s.status === "expired" || s.status === "success") throw new Error("quick onboarding session is closed");
		s.status = status;
		s.botId = botId;
		s.error = error;
		return { ...s };
	}
	consume(id) {
		const s = this.sessions.get(id);
		if (!s) throw new Error("quick onboarding session not found");
		if (s.status !== "waiting_for_scan") throw new Error("quick onboarding session already used");
		s.status = "authorizing";
		return { ...s };
	}
	cancel(id) {
		this.sessions.delete(id);
	}
};
//#endregion
//#region src/index.ts
const name = "dsh-im";
/**
* Only the web server is a hard dependency: it is the socket this plugin
* registers on, and there is nothing to do without it.
*/
const inject = ["webServer"];
/** Validate route and ref facts a schema cannot express. */
function assertConfig(config) {
	for (const [field, value] of [["callbackPath", config.callbackPath], ["oauthCallbackPath", config.oauthCallbackPath]]) if (!value.startsWith("/") || value === "/" || value.endsWith("/") || value.includes("?") || value.includes("#")) throw new Error(`dsh-im ${field} must be an absolute non-root pathname without a trailing slash, query, or fragment`);
	if (config.callbackPath === config.oauthCallbackPath) throw new Error("dsh-im callbackPath and oauthCallbackPath must differ");
}
/**
* The declared configuration.
*
* Exported as a Schemastery schema so the loader validates the profile's config
* before `apply` runs. Without it Cordis passes the raw object through
* unvalidated (`vendor/cordis/src/fiber.ts` only applies a schema when the
* plugin exports one).
*/
const Config = z.object({
	callbackPath: z.string().default("/webhooks/feishu"),
	oauthCallbackPath: z.string().default("/oauth/feishu/callback"),
	encryptKeyRef: z.string().default(""),
	verificationTokenRef: z.string().default(""),
	appIdRef: z.string().default(""),
	appSecretRef: z.string().default(""),
	botOpenId: z.string().default(""),
	maxBodyBytes: z.natural().default(1048576)
});
/**
* Resolve one optional credential reference.
* @param ctx - plugin context supplying the credential provider, if any.
* @param ref - the reference name; empty means "not configured".
* @returns the secret value, or `undefined`.
*/
async function resolveSecret(ctx, ref) {
	if (ref === "") return void 0;
	if (!isCredentialRefName(ref)) {
		ctx.logger.warn(`dsh-im: credential ref "${ref}" is not a valid name; use a shell-style identifier such as FEISHU_ENCRYPT_KEY`);
		return;
	}
	const credentials = ctx.get("credentials");
	if (credentials === void 0) {
		ctx.logger.warn(`dsh-im: "${ref}" is configured but no credential provider is mounted`);
		return;
	}
	const value = (await credentials.resolve(credentialRef(ref)))?.value;
	if (value === void 0 || value === "") {
		ctx.logger.warn(`dsh-im: credential "${ref}" is not configured`);
		return;
	}
	return value;
}
function apply(ctx, config) {
	assertConfig(config);
	const resolved = config;
	/**
	* Secrets are read once at activation. Re-resolving per request would make
	* every callback depend on the credential provider staying responsive, and a
	* rotated key can be picked up by reloading the plugin.
	*/
	let encryptKey;
	let verificationToken;
	/** Fixed at activation; a changed open_id needs a plugin reload anyway. */
	const botOpenId = resolved.botOpenId;
	/** Set once the missing-runtime warning has been logged. */
	let warnedNoRuntime = false;
	const onMessage = async (message) => {
		const runtime = ctx.get("webhookRuntime");
		if (runtime === void 0) {
			if (!warnedNoRuntime) {
				warnedNoRuntime = true;
				ctx.logger.warn("dsh-im: no webhook runtime is mounted, so inbound Feishu messages are acknowledged but never turned into Sessions; compose @deepseek-ai/dsh-webhook");
			}
			return;
		}
		runtime.dispatch({
			kind: "im",
			source: WebhookSourceId(name),
			deliveryId: WebhookDeliveryId(message.eventId),
			event: {
				provider: "feishu",
				chatType: message.chatType,
				chatId: message.chatId,
				senderOpenId: message.senderOpenId,
				text: message.text,
				...message.threadId === void 0 ? {} : { threadId: message.threadId },
				...message.parentId === void 0 ? {} : { parentId: message.parentId }
			},
			receivedAt: Date.now()
		});
	};
	const handler = createFeishuHandler(ctx, {
		get encryptKey() {
			return encryptKey;
		},
		get verificationToken() {
			return verificationToken;
		},
		get botOpenId() {
			return botOpenId;
		},
		maxBodyBytes: resolved.maxBodyBytes,
		onMessage
	});
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: resolved.callbackPath,
		handler
	}), `dsh-im: ${resolved.callbackPath}`);
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: resolved.oauthCallbackPath,
		handler: (_req, res) => {
			res.statusCode = 501;
			res.setHeader("content-type", "text/plain; charset=utf-8");
			res.end("OAuth callback is not wired to a bot store yet");
		}
	}), `dsh-im: ${resolved.oauthCallbackPath}`);
	(async () => {
		try {
			encryptKey = await resolveSecret(ctx, resolved.encryptKeyRef);
			verificationToken = await resolveSecret(ctx, resolved.verificationTokenRef);
		} catch (error) {
			ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
		}
	})();
}
var src_default = {
	name,
	inject,
	Config,
	apply
};
//#endregion
export { BotStore, Config, QuickOnboarding, apply, conversationKey, createFeishuApi, decryptFeishuEvent, src_default as default, inject, isBotMentioned, messageText, name, normalizeCallback, parseCallback, receiveTarget, stripBotMentions, verifyFeishuSignature };

//# sourceMappingURL=index.js.map