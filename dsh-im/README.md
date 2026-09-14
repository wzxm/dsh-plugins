# @wzxm/dsh-im

Feishu IM integration for DeepSeek Harness. It supports OAuth QR-code onboarding, manual app credentials, direct chats, and `@bot` messages in group chats.

## Install

```bash
dsh plugin --profile web add "@wzxm/dsh-im"
```

Configure GitHub Packages authentication in `~/.npmrc`, or install the Release tarball:

```bash
dsh plugin --profile web add "https://github.com/wzxm/dsh-plugins/releases/latest/download/dsh-im.tgz"
```

## Local development and debugging

```bash
cd dsh-im
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Install the local plugin directory through the Harness plugin manager:

```bash
cd /Users/wangzhe/Documents/deepseek-harness/deepseek-harness
pnpm dsh plugin --profile web add /Users/wangzhe/Documents/deepseek-harness/dsh-plugins/dsh-im
pnpm dsh --profile web
```

After rebuilding source, run the `add` command again. If the plugin manager refuses to replace the existing record, remove and add it again:

```bash
pnpm dsh plugin --profile web remove @wzxm/dsh-im
pnpm dsh plugin --profile web add /Users/wangzhe/Documents/deepseek-harness/dsh-plugins/dsh-im
```

Run a web profile with `webServer`, `webhookRuntime`, `credentials`, Agent, and workspace services. Configure a Feishu test app with OAuth and event callbacks on an HTTPS-accessible URL, using a tunnel when needed. Keep secrets in the Harness credentials service.

The QR flow creates a short-lived, one-time state. Refresh an expired QR code instead of reusing its callback. Direct chats trigger on text messages; group chats require an explicit `@bot` mention.

## Build and release

`pnpm build` compiles `src/index.ts` into `lib/`; commit `lib/` with the source:

```bash
pnpm typecheck && pnpm test && pnpm build && git diff --check
git add .
git commit -m "release: dsh-im v0.1.1"
git tag dsh-im-v0.1.1
git push origin main dsh-im-v0.1.1
```

The release workflow should test, build, create `dsh-im.tgz`, publish a GitHub Release, and publish `@wzxm/dsh-im` to GitHub Packages. The package version and tag must match; each version can be published once.
