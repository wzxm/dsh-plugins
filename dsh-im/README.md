# @wzxm/dsh-im

Feishu/Lark IM adapter for DeepSeek Harness.

It registers two exact routes on the harness web server:

| Route | Purpose |
| --- | --- |
| `callbackPath` (`/webhooks/feishu`) | Feishu event subscription callbacks |
| `oauthCallbackPath` (`/oauth/feishu/callback`) | OAuth redirect |

Both are the application's own endpoints. A Feishu callback is authenticated by
its **signature**, not by the browser session that guards `/api`, so neither sits
behind the connection trust fence — that is deliberate, and it is why signature
verification is on by default.

## How a message becomes a reply

`webhookRuntime` is **not** used. It is fire-and-forget: a rule returns a Session
request, the runtime creates the Session, and nothing ever reports what the agent
said — so it cannot drive a reply back to the chat. This adapter owns the round
trip itself:

```
callback -> verify signature -> decrypt -> normalize
         -> Agent (one per conversation, reused across messages)
         -> followup() -> whenIdle() -> read the assistant text from the log
         -> send to Feishu
```

Two details make the reply correct rather than merely plausible:

- **The log offset is captured *before* `followup`**, and the reply is read from
  exactly that turn. Accumulating a live stream would instead be vulnerable to
  attaching too late.
- **The last** `assistant/message` **in the turn wins.** A turn may contain
  several steps; the final one carries the user-facing answer.

Prompts are **serialized per conversation**: two messages racing into one Agent
would make the second arrive as steering and merge both replies into one turn.

## What works today

- **Signature verification** — `X-Lark-Signature` is `SHA256(timestamp + nonce +
  encryptKey + rawBody)` as lowercase hex. This is **plain SHA-256, not HMAC**;
  the Encrypt Key is a literal segment of the digest input, not a key.
- **Decryption** — an `{"encrypt":"…"}` body is decrypted with AES-256-CBC, where
  the key is `SHA256(encryptKey)` and the IV is the first 16 bytes of the decoded
  payload.
- **`url_verification`** — the one-time handshake echoes `challenge` back and
  creates no delivery.
- **Message normalization** — a real v2.0 envelope is parsed, including the
  double-encoded `message.content` JSON string.
- **Mention handling** — group messages are accepted only when the bot is
  mentioned. `mentions[].id` is an **object** carrying `open_id`; the bot's own
  placeholder token (`@_user_1`) is stripped from the text.
- **Session continuity** — a conversation key (bot + chat + thread) maps to one
  live Agent, so a follow-up continues the same Session instead of starting over.
- **Reply delivery** — the assistant's text is sent back to the originating chat,
  truncated at `maxReplyChars` rather than rejected by the API.

## Configuration

All secrets are **credential references**, never values, so `cordis.patch.yml`
stays credential-free and safe to commit:

| Config | Env | Meaning |
| --- | --- | --- |
| `callbackPath` | — | Exact callback path |
| `oauthCallbackPath` | — | Exact OAuth redirect path |
| `encryptKeyRef` | `DSH_IM_ENCRYPT_KEY_REF` | Enables **both** signature verification and decryption |
| `verificationTokenRef` | `DSH_IM_VERIFICATION_TOKEN_REF` | Checked on the challenge handshake |
| `appIdRef` / `appSecretRef` | `DSH_IM_APP_ID_REF` / `DSH_IM_APP_SECRET_REF` | App credentials for token exchanges |
| `botOpenId` | `DSH_IM_BOT_OPEN_ID` | The bot's own `open_id` — **required for group chats** |
| `maxBodyBytes` | — | Raw body ceiling (default 1 MiB) |
| `botId` | `DSH_IM_BOT_ID` | Scopes conversation keys (default `feishu`); two bots never share a Session |
| `workspacePath` | `DSH_IM_WORKSPACE` | Absolute working directory for created Sessions |
| `agentPreset` | `DSH_IM_AGENT_PRESET` | Agent composition mounted per Session (default `standard`) |
| `permissionPreset` | `DSH_IM_PERMISSION_PRESET` | Permission preset per Session (default `default`) |
| `maxReplyChars` | — | Reply ceiling before truncation (default 4000) |

Credential refs must be shell-style identifiers (`FEISHU_ENCRYPT_KEY`), not
hyphenated names; a name outside that grammar is reported as a warning and
treated as unconfigured.

### `botOpenId` cannot be discovered

Feishu identifies the **author** of a mention, never the reader, so a callback
does not reveal which bot received it. Without `botOpenId` every group message is
discarded (a group message that does not mention the bot is not for us). Direct
(p2p) chats work without it.

## Dependencies

Only `webServer` is a hard dependency. Everything else is optional, because the
callback route must answer even in a profile that lacks the rest:

- `credentials` is resolved with `ctx.get`.
- The **Agent stack** (`agents`, `agentPresets`, `agentDefaultModel`,
  `permissionPresets`, `sessionTitle`, `workspaceRegistry`) is requested with
  `ctx.inject`, which **parks its callback** until every service exists instead of
  blocking `apply`. So the routes always register, and the dispatcher is built
  lazily on the first message — by which point both the stack and the API client
  are ready. When the stack is absent, messages are acknowledged (so Feishu stops
  retrying) and a warning is logged once.

A hard `inject` on the Agent stack would be wrong twice over: the routes would
vanish from a profile without an agent loop, and no shipped bundle guarantees
that every one of those services is mounted.

## Install

```bash
dsh plugin --profile web add "@wzxm/dsh-im"
```

Configure GitHub Packages authentication in `~/.npmrc`, or install the release
tarball:

```bash
dsh plugin --profile web add "https://github.com/wzxm/dsh-plugins/releases/latest/download/dsh-im.tgz"
```

## Local development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Install the local directory through the plugin manager:

```bash
cd /Users/wangzhe/Documents/deepseek-harness/deepseek-harness
pnpm dsh plugin --profile web add /Users/wangzhe/Documents/deepseek-harness/dsh-plugins/dsh-im
pnpm dsh --profile web
```

The running process loads `lib/` at boot, so restart it after rebuilding.

To exercise the flow, point a Feishu app's event subscription at an
HTTPS-reachable URL (a tunnel during development), enable the Encrypt Key, and
subscribe to `im.message.receive_v1`.

## Build and release

`pnpm build` compiles `src/index.ts` into `lib/`. **Commit `lib/` with the
source** — CI rebuilds and diffs it to prove the packed artifact matches the
reviewed source.

```bash
pnpm typecheck && pnpm test && pnpm build && git diff --check
git add .
git commit -m "release: dsh-im v0.1.1"
git tag dsh-im-v0.1.1
git push origin main dsh-im-v0.1.1
```

The tag must match `package.json`'s version; each version publishes once.
