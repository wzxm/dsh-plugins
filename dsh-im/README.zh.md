# @wzxm/dsh-im

DeepSeek Harness 的飞书 / Lark IM 插件。

它在 Harness Web 服务器上注册两条 exact 路由：

| 路由 | 用途 |
| --- | --- |
| `callbackPath`（`/webhooks/feishu`） | 飞书事件订阅回调 |
| `oauthCallbackPath`（`/oauth/feishu/callback`） | OAuth 重定向 |

这两条都是应用自身的端点。飞书回调由**签名**认证，而不是由保护 `/api` 的浏览器会话认证，因此二者都不在连接信任围栏之后——这是刻意的设计，也正是默认开启签名校验的原因。

## 消息如何变成回复

**没有**使用 `webhookRuntime`。它是"发射即忘"：规则返回一个 Session 请求，runtime 创建
Session，但**从不报告 Agent 说了什么**——因此无法把回复发回聊天。本插件自己拥有这条回环：

```
回调 -> 验签 -> 解密 -> 归一化
     -> Agent（每个会话一个，多条消息复用）
     -> followup() -> whenIdle() -> 从日志读取 assistant 文本
     -> 发回飞书
```

两个细节决定回复是"正确"而不只是"看起来合理"：

- **日志偏移在 `followup` 之前捕获**，回复严格取自该回合。改为累积实时流则会在
  监听挂得太晚时丢失内容。
- **取该回合最后一条** `assistant/message`**。** 一个回合可包含多个 step，最后一条才是
  面向用户的答案。

同一会话的提示词是**串行**的：两条消息同时进入一个 Agent 会让第二条变成 steering，
把两份回复合并进同一个回合。

## 当前已实现

- **签名校验** —— `X-Lark-Signature` 是 `SHA256(timestamp + nonce + encryptKey + rawBody)` 的小写 hex。这是**普通 SHA-256，不是 HMAC**；Encrypt Key 是摘要输入的字面片段，不是密钥。
- **解密** —— `{"encrypt":"…"}` 报文使用 AES-256-CBC 解密，密钥为 `SHA256(encryptKey)`，IV 为解码后前 16 字节。
- **`url_verification`** —— 一次性握手原样返回 `challenge`，不产生投递。
- **报文归一化** —— 解析真实的 v2.0 信封，包括需要二次解析的 `message.content` JSON 字符串。
- **@ 提及处理** —— 群聊仅在机器人被 @ 时接受。`mentions[].id` 是携带 `open_id` 的**对象**；文本中机器人自己的占位符（`@_user_1`）会被摘除。
- **会话连续性** —— 会话键（bot + chat + thread）映射到一个存活 Agent，后续消息延续
  同一个 Session 而非重开。
- **回复投递** —— assistant 文本发回原会话，超过 `maxReplyChars` 时截断，而不是被 API 拒绝。

## 配置

所有密钥都是**凭据引用**而非明文，因此 `cordis.patch.yml` 保持无凭据、可安全提交：

| 配置 | 环境变量 | 含义 |
| --- | --- | --- |
| `callbackPath` | — | 回调路径 |
| `oauthCallbackPath` | — | OAuth 重定向路径 |
| `encryptKeyRef` | `DSH_IM_ENCRYPT_KEY_REF` | **同时**开启签名校验与解密 |
| `verificationTokenRef` | `DSH_IM_VERIFICATION_TOKEN_REF` | 握手时校验 Verification Token |
| `appIdRef` / `appSecretRef` | `DSH_IM_APP_ID_REF` / `DSH_IM_APP_SECRET_REF` | 换取 token 用的应用凭据 |
| `botOpenId` | `DSH_IM_BOT_OPEN_ID` | 机器人自身 `open_id`——**群聊必需** |
| `maxBodyBytes` | — | 请求体上限（默认 1 MiB） |
| `botId` | `DSH_IM_BOT_ID` | 会话键作用域（默认 `feishu`）；两个机器人不共享 Session |
| `workspacePath` | `DSH_IM_WORKSPACE` | 创建 Session 使用的绝对工作目录 |
| `agentPreset` | `DSH_IM_AGENT_PRESET` | 每个 Session 挂载的 Agent 组合（默认 `standard`） |
| `permissionPreset` | `DSH_IM_PERMISSION_PRESET` | 每个 Session 的权限预设（默认 `default`） |
| `maxReplyChars` | — | 回复截断上限（默认 4000） |

凭据引用必须是 shell 风格标识符（`FEISHU_ENCRYPT_KEY`），不能是连字符名字；不符合该语法的名字会记录警告并按"未配置"处理。

### `botOpenId` 无法自动获取

飞书只标识被 @ 的**作者**，从不标识接收者，所以回调本身不会暴露是哪个机器人收到了消息。缺少 `botOpenId` 时所有群消息都会被丢弃（不 @ 机器人的群消息不属于本机器人）。单聊不受影响。

## 依赖

只有 `webServer` 是硬依赖。其余全部可选，因为回调路由必须在缺少这些服务的 profile 中
也能应答：

- `credentials` 通过 `ctx.get` 解析。
- **Agent 栈**（`agents`、`agentPresets`、`agentDefaultModel`、`permissionPresets`、
  `sessionTitle`、`workspaceRegistry`）通过 `ctx.inject` 请求，它在服务齐全前**挂起回调**
  而不是阻塞 `apply`。因此路由总会注册，dispatcher 在第一条消息时惰性构建——那时栈与
  API 客户端都已就绪。栈缺失时确认收到消息（避免飞书重投）并记录一次警告。

把 Agent 栈写成硬 `inject` 会错两次：没有 agent loop 的 profile 里路由会消失，而且没有
任何 bundle 保证这些服务全部被组装。

## 安装

```bash
dsh plugin --profile web add "@wzxm/dsh-im"
```

GitHub Packages 需要在 `~/.npmrc` 配置：

```ini
@wzxm:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

也可以安装 Release 附件：

```bash
dsh plugin --profile web add "https://github.com/wzxm/dsh-plugins/releases/latest/download/dsh-im.tgz"
```

## 本地开发与调试

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

在 Harness 仓库中直接安装本地插件目录：

```bash
cd /Users/wangzhe/Documents/deepseek-harness/deepseek-harness
pnpm dsh plugin --profile web add /Users/wangzhe/Documents/deepseek-harness/dsh-plugins/dsh-im
pnpm dsh --profile web
```

运行中的进程在启动时加载 `lib/`，重新构建后需要重启。

联调时把飞书应用的事件订阅指向可访问的 HTTPS 地址（开发期可用隧道），开启 Encrypt Key，并订阅 `im.message.receive_v1`。

## 构建与发布

`pnpm build` 使用 tsdown 将 `src/index.ts` 构建到 `lib/`。**必须连同源码一起提交 `lib/`**——CI 会重新构建并做 diff，以证明打包产物与受审源码一致。

```bash
pnpm typecheck && pnpm test && pnpm build && git diff --check
git add .
git commit -m "release: dsh-im v0.1.1"
git tag dsh-im-v0.1.1
git push origin main dsh-im-v0.1.1
```

tag 必须与 `package.json` 版本一致；同一版本只能发布一次。
