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
- **Dispatch** — each accepted message becomes one `kind: 'im'` delivery on the
  webhook runtime.

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

Credential refs must be shell-style identifiers (`FEISHU_ENCRYPT_KEY`), not
hyphenated names; a name outside that grammar is reported as a warning and
treated as unconfigured.

### `botOpenId` cannot be discovered

Feishu identifies the **author** of a mention, never the reader, so a callback
does not reveal which bot received it. Without `botOpenId` every group message is
discarded (a group message that does not mention the bot is not for us). Direct
(p2p) chats work without it.

## Runtime dependencies

`webhookRuntime` and `credentials` are resolved with `ctx.get`, **not** declared
in `inject`. No shipped bundle composes the webhook runtime, so injecting it
would park this plugin in PENDING and `apply` would never run — the routes would
never register. When the runtime is absent, messages are acknowledged (so Feishu
stops retrying) and a warning is logged once.

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
