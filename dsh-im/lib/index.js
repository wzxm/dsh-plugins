import { assertReplyTarget } from "./transport.js";
import { createMemoryTransport } from "./transport-memory.js";
import { createFeishuTransport, toNormalizedMessage, toPolicyConfig } from "./transport-feishu.js";
import { isAbsolute } from "node:path";
import { credentialRef, isCredentialRefName } from "@deepseek-ai/dsh-credentials";
import z from "@deepseek-ai/schemastery";
import { brandString } from "@deepseek-ai/dsh-brand";
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionSeq } from "@deepseek-ai/dsh-session";
import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
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
//#region src/session-bridge.ts
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
function readTurnOutput(session, fromSeq) {
	let text = "";
	let reason;
	let interrupted = false;
	let started = false;
	const length = session.seq;
	for (let seq = fromSeq; seq < length; seq += 1) {
		const event = session.eventAt(SessionSeq(seq));
		if (event === void 0) continue;
		if (event.type === "turn/start") {
			started = true;
			continue;
		}
		if (!started) continue;
		if (event.type === "assistant/message") {
			const joined = event.data.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
			if (joined !== "") text = joined;
			if (event.data.interrupted === true) interrupted = true;
		}
		if (event.type === "turn/end") reason = event.data.reason.kind;
	}
	return {
		text,
		reason,
		interrupted
	};
}
/**
* Serializes prompts per conversation.
*
* Two messages arriving close together must not interleave into one Agent: the
* second would be consumed as steering for the first turn, and its reply would
* be read as part of the same turn. A per-key promise chain makes each prompt
* wait for the previous one to settle.
*/
var ConversationQueue = class {
	tails = /* @__PURE__ */ new Map();
	/**
	* Run `task` after every previously queued task for `key` has settled.
	* @param key - the conversation key.
	* @param task - the work to serialize.
	* @returns the task's result.
	*/
	run(key, task) {
		const next = (this.tails.get(key) ?? Promise.resolve()).then(task, task);
		const tail = next.then(() => void 0, () => void 0);
		this.tails.set(key, tail);
		tail.then(() => {
			if (this.tails.get(key) === tail) this.tails.delete(key);
		});
		return next;
	}
	/** Number of tracked conversations; for tests and diagnostics. */
	get size() {
		return this.tails.size;
	}
};
//#endregion
//#region src/dispatch.ts
/**
* Truncate a reply so an overlong answer cannot be rejected by the Feishu API.
* @param text - the assistant text.
* @param max - character ceiling.
* @returns the text, ellipsized when it exceeded the ceiling.
*/
function truncate(text, max) {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1))}…`;
}
/**
* Build the dispatcher that turns messages into turns and replies.
* @param ctx - plugin-scoped context that owns created Agents.
* @param config - resolved dispatch configuration.
* @param api - Feishu client used to send the reply.
* @returns a function handling one normalized message.
*/
function createDispatcher(ctx, config, api) {
	const queue = new ConversationQueue();
	/** Live Agents by conversation key. The binding is the Session continuity. */
	const agents = /* @__PURE__ */ new Map();
	/**
	* Create one Agent for a conversation.
	*
	* A deterministic session id derived from the conversation key means a restart
	* with persistence enabled resumes the same Session instead of forking a new
	* one per process.
	* @param key - conversation key.
	* @param title - initial Session title.
	* @returns the live Agent.
	*/
	const openAgent = async (key, title) => {
		ctx.permissionPresets.resolve(config.permissionPreset);
		const preset = await ctx.agentPresets.resolve(config.agentPreset);
		await ctx.agentPresets.standingKeyFor(preset.id);
		const workspace = await ctx.workspaceRegistry.create(config.workspacePath);
		const selected = ctx.agentDefaultModel.currentSelection();
		const sessionId = brandString(`im-${config.botId}-${key}`.replace(/[^A-Za-z0-9._-]/g, "_"));
		const handle = await ctx.agents.create({
			sessionId,
			meta: {
				cwd: workspace.path,
				agentPreset: preset.id
			},
			agentOptions: {
				provider: selected.provider,
				model: selected.model
			},
			setup: async (agentCtx) => {
				await ctx.agentPresets.mount(agentCtx, preset.id);
			}
		});
		await workspace.attachSession(sessionId);
		ctx.permissionPresets.set(handle.agent.session, config.permissionPreset);
		ctx.sessionTitle.rename(handle.agent.session, title);
		agents.set(key, handle.agent);
		return handle.agent;
	};
	/**
	* Ask one Agent for a reply.
	*
	* The log offset is captured **before** `followup`, so the reply is read from
	* exactly this turn rather than the previous exchange. `whenIdle()` is the
	* settlement signal: it resolves once no driver or maintenance task remains,
	* which is the point at which the log is complete.
	* @param agent - the live Agent.
	* @param prompt - the user's text.
	* @returns this turn's output.
	*/
	const ask = async (agent, prompt) => {
		const fromSeq = agent.session.seq;
		agent.followup(createUserMessage({
			content: [{
				type: "text",
				text: prompt
			}],
			source: {
				kind: "plugin",
				plugin: "dsh-im",
				form: "notice",
				summary: boundContextSummary(`Feishu message via ${config.botId}`)
			}
		}));
		await agent.whenIdle();
		return readTurnOutput(agent.session, fromSeq);
	};
	return async (message) => {
		const key = conversationKey(config.botId, message);
		return queue.run(key, async () => {
			let agent = agents.get(key);
			if (agent === void 0) agent = await openAgent(key, `Feishu ${message.chatType} ${message.chatId}`);
			const output = await ask(agent, message.text);
			if (output.text.trim() === "") return {
				replied: false,
				reason: output.reason ?? "no assistant text"
			};
			const token = await api.tenantToken();
			await api.sendText(token, receiveTarget(message), truncate(output.text, config.maxReplyChars));
			return { replied: true };
		});
	};
}
//#endregion
//#region src/event.ts
/**
* Read the handshake challenge from either wire form.
* @param callback - the parsed envelope.
* @returns the challenge to echo, or `undefined` when this is not a handshake.
*/
function verificationChallenge(callback) {
	if (callback.type === "url_verification" || callback.header?.event_type === "url_verification") return callback.challenge ?? callback.event?.challenge ?? "";
	return callback.challenge ?? callback.event?.challenge;
}
/**
* Read the Verification Token from either wire form.
* @param callback - the parsed envelope.
* @returns the presented token, or `undefined` when absent.
*/
function verificationToken(callback) {
	return callback.token ?? callback.event?.token;
}
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
* Only the web server is a hard dependency: it is needed for the OAuth callback
* route, which is the only remaining HTTP endpoint.
*/
const inject = ["webServer"];
/** Validate config facts a schema cannot express. */
function assertConfig(config) {
	if (config.oauthCallbackPath !== void 0 && config.oauthCallbackPath !== "") {
		if (!config.oauthCallbackPath.startsWith("/") || config.oauthCallbackPath === "/" || config.oauthCallbackPath.endsWith("/") || config.oauthCallbackPath.includes("?") || config.oauthCallbackPath.includes("#")) throw new Error(`dsh-im oauthCallbackPath must be an absolute non-root pathname without a trailing slash, query, or fragment`);
	}
	if (config.workspacePath !== void 0 && config.workspacePath !== "" && !isAbsolute(config.workspacePath)) throw new Error(`dsh-im workspacePath must be an absolute path, got ${JSON.stringify(config.workspacePath)}`);
	if (config.maxReplyChars !== void 0 && config.maxReplyChars < 1) throw new Error("dsh-im maxReplyChars must be at least 1");
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
	oauthCallbackPath: z.string().default("/oauth/feishu/callback"),
	appIdRef: z.string().default(""),
	appSecretRef: z.string().default(""),
	domain: z.string().default("feishu"),
	botOpenId: z.string().default(""),
	botId: z.string().default("feishu"),
	workspacePath: z.string().default(""),
	agentPreset: z.string().default("standard"),
	permissionPreset: z.string().default("default"),
	maxReplyChars: z.natural().default(4e3)
});
/**
* Resolve one credential reference.
* @param ctx - plugin context supplying the credential provider, if any.
* @param ref - the reference name; empty means "not configured".
* @returns the secret value, or `undefined`.
*/
async function resolveSecret(ctx, ref) {
	if (ref === "") return void 0;
	if (!isCredentialRefName(ref)) {
		ctx.logger.warn(`dsh-im: credential ref "${ref}" is not a valid name; use a shell-style identifier such as FEISHU_APP_ID`);
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
	* The transport — set once async init completes, then reused for the lifetime
	* of the plugin. A restart of the plugin (update or reload) discards it.
	*/
	let transport;
	/** Set once the dispatcher is wired by the Agent-stack injection below. */
	let dispatch;
	/** The Agent stack context, supplied by `ctx.inject` when those services exist. */
	let agentStack;
	/** Logged once each, so a busy callback cannot flood the log. */
	let warnedNoStack = false;
	let warnedNoTransport = false;
	const onMessage = async (message) => {
		if (agentStack === void 0) {
			if (!warnedNoStack) {
				warnedNoStack = true;
				ctx.logger.warn("dsh-im: the Agent stack is not mounted, so inbound Feishu messages are acknowledged but never answered; compose an agent loop, agent presets, permission presets, session-title, and the workspace registry");
			}
			return;
		}
		if (transport === void 0) {
			if (!warnedNoTransport) {
				warnedNoTransport = true;
				ctx.logger.warn("dsh-im: no Feishu transport is connected, so replies cannot be sent; check appIdRef and appSecretRef");
			}
			return;
		}
		dispatch ??= createDispatcher(agentStack, {
			botId: resolved.botId,
			workspacePath: resolved.workspacePath,
			agentPreset: resolved.agentPreset,
			permissionPreset: resolved.permissionPreset,
			maxReplyChars: resolved.maxReplyChars
		}, {
			tenantToken: async () => "",
			authorize: async () => {
				throw new Error("not available over WebSocket");
			},
			sendText: async (_token, target, text, replyTo) => {
				await transport.sendText(target, text, replyTo === void 0 ? {} : { replyTo });
			}
		});
		const result = await dispatch(message);
		if (!result.replied) ctx.logger.info(`dsh-im: no reply for ${message.eventId} (${result.reason ?? "unknown"})`);
	};
	if (resolved.oauthCallbackPath !== "") ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: resolved.oauthCallbackPath,
		handler: (_req, res) => {
			res.statusCode = 501;
			res.setHeader("content-type", "text/plain; charset=utf-8");
			res.end("OAuth callback is not wired to a bot store yet");
		}
	}), `dsh-im: ${resolved.oauthCallbackPath}`);
	/**
	* Wire the dispatcher once the Agent stack exists.
	*
	* `ctx.inject` (rather than a hard `inject` on this plugin) keeps route
	* registration independent of the Agent stack: the OAuth callback must answer
	* in a profile that has no agent loop, and the ordering between this plugin
	* and the bundle rows providing these services is not guaranteed.
	*/
	ctx.inject([
		"agents",
		"agentPresets",
		"agentDefaultModel",
		"permissionPresets",
		"sessionTitle",
		"workspaceRegistry"
	], (agentCtx) => {
		agentStack = agentCtx;
	});
	(async () => {
		try {
			const appId = await resolveSecret(ctx, resolved.appIdRef);
			const appSecret = await resolveSecret(ctx, resolved.appSecretRef);
			if (appId !== void 0 && appSecret !== void 0) {
				if (transport !== void 0) await transport.dispose();
				const { createFeishuTransport } = await import("./transport-feishu.js");
				transport = await createFeishuTransport({
					appId,
					appSecret,
					domain: resolved.domain,
					logger: {
						debug: (m) => ctx.logger.debug("[dsh-im] " + m),
						info: (m) => ctx.logger.info("[dsh-im] " + m),
						warn: (m) => ctx.logger.warn("[dsh-im] " + m),
						error: (m) => ctx.logger.error("[dsh-im] " + m)
					}
				});
				transport.onMessage(onMessage);
				transport.onConnectionChange((state) => {
					ctx.logger.info(`dsh-im: Feishu connection state -> ${state}`);
				});
				transport.onReject((rejected) => {
					ctx.logger.info(`dsh-im: message ${rejected.messageId} rejected (${rejected.reason})`);
				});
				await transport.connect();
				ctx.logger.info("dsh-im: Feishu WebSocket transport connected");
			} else ctx.logger.info("dsh-im: Feishu credentials not configured; transport not started. Set appIdRef and appSecretRef, or trigger the onboarding flow.");
		} catch (error) {
			ctx.logger.warn("dsh-im: failed to start Feishu transport: " + (error instanceof Error ? error.message : String(error)));
		}
	})();
	ctx.effect(() => async () => {
		if (transport !== void 0) {
			await transport.dispose();
			transport = void 0;
		}
	}, "dsh-im: dispose transport");
}
var src_default = {
	name,
	inject,
	Config,
	apply
};
//#endregion
export { BotStore, Config, ConversationQueue, QuickOnboarding, apply, assertReplyTarget, conversationKey, createDispatcher, createFeishuApi, createFeishuTransport, createMemoryTransport, decryptFeishuEvent, src_default as default, inject, isBotMentioned, messageText, name, normalizeCallback, parseCallback, readTurnOutput, receiveTarget, stripBotMentions, toNormalizedMessage, toPolicyConfig, verificationChallenge, verificationToken, verifyFeishuSignature };

//# sourceMappingURL=index.js.map