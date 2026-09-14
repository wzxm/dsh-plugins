# @wzxm/dsh-im

DeepSeek Harness 的飞书 IM 插件。支持 OAuth 扫码快速新增机器人、手动接入、飞书单聊，以及群聊中 `@机器人` 对话。

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
cd dsh-im
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

修改源码并重新构建后，再次执行 `add` 更新本地插件；如果插件管理器拒绝覆盖旧记录，先移除再添加：

```bash
pnpm dsh plugin --profile web remove @wzxm/dsh-im
pnpm dsh plugin --profile web add /Users/wangzhe/Documents/deepseek-harness/dsh-plugins/dsh-im
```

使用带 `webServer`、`webhookRuntime`、`credentials`、Agent 和工作区服务的 web profile 启动。飞书开放平台测试应用的 OAuth 与事件回调必须指向可访问的 HTTPS 地址，可使用 HTTPS 隧道。App Secret、Verification Token、Encrypt Key 和 token 只能通过 credentials service 注入，不能提交到仓库。

扫码流程生成短期一次性 state；二维码过期后刷新，不要复用旧回调。单聊直接发送文本，群聊必须 `@机器人`。

## 构建与发布

`pnpm build` 使用 tsdown 将 `src/index.ts` 构建到 `lib/`，发布时必须提交 `lib/`：

```bash
pnpm typecheck && pnpm test && pnpm build && git diff --check
git add .
git commit -m "release: dsh-im v0.1.1"
git tag dsh-im-v0.1.1
git push origin main dsh-im-v0.1.1
```

发布工作流应运行测试和构建，创建 `dsh-im.tgz` Release 附件，并发布 `@wzxm/dsh-im` 到 GitHub Packages。版本号与 tag 必须一致，同一版本只能发布一次。
