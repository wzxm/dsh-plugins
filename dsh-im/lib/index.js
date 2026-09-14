import { createHash, timingSafeEqual } from "node:crypto";
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
//#region src/feishu.ts
function normalizeMessage(event, botOpenId) {
	if (event.chat_type === "group" && !event.mentions?.some((m) => m.id === botOpenId || m.key === `@${botOpenId}`)) return null;
	let text = event.text;
	for (const m of event.mentions ?? []) if (m.id === botOpenId || m.key === `@${botOpenId}`) text = text.replace(m.key, "");
	return text.trim() || null;
}
function conversationKey(botId, event) {
	return [
		botId,
		event.chat_type,
		event.chat_id,
		event.thread_id ?? event.root_id ?? "root"
	].join(":");
}
//#endregion
//#region src/feishu-api.ts
function createFeishuApi(fetcher = fetch, baseUrl = "https://open.feishu.cn") {
	const request = async (path, init) => {
		const response = await fetcher(`${baseUrl}${path}`, init);
		const body = await response.json();
		if (!response.ok || body.code !== 0) throw new Error(`feishu API failed: ${String(body.msg ?? response.status)}`);
		return body;
	};
	return {
		async authorize(code) {
			const data = (await request("/open-apis/authen/v1/oidc/access_token", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					grant_type: "authorization_code",
					code
				})
			})).data;
			return {
				tenantAccessToken: String(data.tenant_access_token),
				botOpenId: String(data.open_id),
				botName: String(data.name ?? data.open_id),
				tenantName: data.tenant_name === void 0 ? void 0 : String(data.tenant_name)
			};
		},
		async sendText(token, receiveId, text, replyTo) {
			await request(replyTo ? `/open-apis/im/v1/messages/${encodeURIComponent(replyTo)}/reply` : "/open-apis/im/v1/messages?receive_id_type=chat_id", {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json"
				},
				body: JSON.stringify({
					receive_id: receiveId,
					msg_type: "text",
					content: JSON.stringify({ text })
				})
			});
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
//#region src/index.ts
const name = "dsh-im";
const inject = ["webServer"];
function apply(ctx, config) {
	if (!config.callbackPath.startsWith("/") || !config.oauthCallbackPath.startsWith("/")) throw new Error("dsh-im paths must be absolute");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: config.callbackPath,
		handler: (_req, res) => {
			res.statusCode = 501;
			res.end("Feishu adapter pending configuration");
		}
	}), `dsh-im: ${config.callbackPath}`);
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: config.oauthCallbackPath,
		handler: (_req, res) => {
			res.statusCode = 501;
			res.end("OAuth callback pending configuration");
		}
	}), `dsh-im: ${config.oauthCallbackPath}`);
}
var src_default = {
	name,
	inject,
	apply
};
//#endregion
export { BotStore, QuickOnboarding, apply, conversationKey, createFeishuApi, src_default as default, inject, name, normalizeMessage, verifyFeishuSignature };
