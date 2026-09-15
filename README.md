# dsh-plugins

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的独立插件。每个插件一个目录，改完打 tag 即发布到 [GitHub Packages](https://github.com/wzxm/dsh-plugins/pkgs/npm/dsh-mysql) 和 [Releases](https://github.com/wzxm/dsh-plugins/releases)。

| 插件 | 包名 | 文档 |
| --- | --- | --- |
| [dsh-mysql](./dsh-mysql/) | `@wzxm/dsh-mysql` | [中文](./dsh-mysql/README.zh.md) · [English](./dsh-mysql/README.md) |
| [dsh-im](./dsh-im/) | `@wzxm/dsh-im` | [中文](./dsh-im/README.zh.md) · [English](./dsh-im/README.md) |

## 安装

```bash
dsh plugin --profile web add "@wzxm/dsh-mysql"
```

GitHub Packages 即使公开也要登录。一次性写入 `~/.npmrc`（classic PAT，权限 `read:packages`）：

```ini
@wzxm:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

不想配 token 就装 Release 附件：

```bash
dsh plugin --profile web add "https://github.com/wzxm/dsh-plugins/releases/latest/download/dsh-mysql.tgz"
```

环境变量等用法见 [dsh-mysql 文档](./dsh-mysql/README.zh.md)。

## 改完代码怎么发

只推源码不会发版。改 `dsh-mysql` 之后：

```bash
cd dsh-mysql
pnpm test
pnpm build          # 必须把 lib/ 一并提交，CI 会核对
```

把 `dsh-mysql/package.json` 的 `version` 升一档（例如 `0.2.0` → `0.2.1`），提交并推送，再打**与 version 相同**的 tag：

```bash
git tag dsh-mysql-v0.2.1
git push origin dsh-mysql-v0.2.1
```

[工作流](./.github/workflows/release-dsh-mysql.yml) 会测、打包、发 Release（`dsh-mysql.tgz`）并 `npm publish` 到 GitHub Packages。看 [Actions](https://github.com/wzxm/dsh-plugins/actions) 是否成功即可。

同一 version 只能发一次，已打过的 tag 不会补发。
