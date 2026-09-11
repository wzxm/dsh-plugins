# dsh-plugins

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的独立插件集合。各插件在本仓库中单独维护，通过 GitHub Releases 分发安装包，无需将源码放入 DeepSeek Harness 的 `packages/` 工作区。

## 插件列表

| 插件 | 包名 | 功能 | 文档 |
| --- | --- | --- | --- |
| [dsh-mysql](./dsh-mysql/) | `@wzxm/dsh-mysql` | 通过 MySQL MCP server 提供数据库工具，并对 SQL 写语句进行开关控制和一次性审批 | [中文](./dsh-mysql/README.zh.md) · [English](./dsh-mysql/README.md) |

## 安装 dsh-mysql

在 DeepSeek Harness 源码项目根目录执行：

```bash
pnpm dsh plugin --profile web add "https://github.com/wzxm/dsh-plugins/releases/latest/download/dsh-mysql.tgz"
```

如果使用已安装的 `dsh` 命令：

```bash
dsh plugin --profile web add "https://github.com/wzxm/dsh-plugins/releases/latest/download/dsh-mysql.tgz"
```

安装包必须已上传到非草稿、非预发布的 GitHub Release，下载地址才可用。可以在 [Releases](https://github.com/wzxm/dsh-plugins/releases) 页面查看可用版本。安装后配置环境变量，并重启对应的 Harness profile。

### 环境变量设置位置

**在启动 `dsh` 的环境里 export，不要写进 `.env` 文件。**

`dsh plugin add` 只安装包并登记 bundle 层，不会读取或应用任何环境变量。这些变量必须在 `dsh` 进程启动时就存在于它的环境里，属于安装之外的一次性手工步骤。

`DSH_` 是 bootstrap 保留前缀：项目 `.env` 和 `$DSH_HOME/.env`（默认 `~/.dsh/.env`）都不允许设置 `DSH_*`，写了会导致 Harness 启动直接报错：

```text
dsh: <path>/.env sets "DSH_MYSQL_HOST", which only the launching environment may set
```

推荐写进 shell profile（`~/.zshrc` 或 `~/.bashrc`），这样每次调用 `dsh` 都能继承；不跑 shell 的场景（systemd unit、launchd plist、容器）在各自的环境配置块里设置：

```bash
export DSH_MYSQL_HOST=127.0.0.1
export DSH_MYSQL_PORT=3306
export DSH_MYSQL_USER=readonly_user
export DSH_MYSQL_PASSWORD='…'
export DSH_MYSQL_DATABASE=app
```

也可以把凭据放在单独文件里，再从 shell profile 中 `source`：

```bash
# ~/.dsh/mysql.env —— 凭据
export DSH_MYSQL_HOST=127.0.0.1
# …

# 加到 ~/.zshrc —— 这一行才是生效的关键
[ -f ~/.dsh/mysql.env ] && source ~/.dsh/mysql.env
```

注意：**DSH 不会读取 `~/.dsh/mysql.env`**，该文件名没有特殊含义（DSH 唯一加载的文件是 `~/.dsh/.env`，且不允许放 `DSH_*`）。它生效完全依赖 shell 里那行 `source`；手动 `source` 只对当前 shell 有效，新终端看不到。

插件从 Harness 服务进程的环境变量中读取连接信息：

| 环境变量 | 说明 |
| --- | --- |
| `DSH_MYSQL_HOST` | MySQL 主机地址 |
| `DSH_MYSQL_PORT` | MySQL 端口，例如 `3306` |
| `DSH_MYSQL_USER` | 数据库用户名 |
| `DSH_MYSQL_PASSWORD` | 数据库密码 |
| `DSH_MYSQL_DATABASE` | 数据库名称 |

修改后重启 `dsh` 进程。不要将包含真实密码的配置提交到 Git。

以下写操作开关默认关闭，只有对应变量设置为字符串 `true` 时才会开启：

```bash
export DSH_MYSQL_ALLOW_INSERT=false
export DSH_MYSQL_ALLOW_UPDATE=false
export DSH_MYSQL_ALLOW_DELETE=false
export DSH_MYSQL_ALLOW_ALTER=false
export DSH_MYSQL_ALLOW_TRUNCATE=false
export DSH_MYSQL_ALLOW_DROP=false
```

开启后，插件识别到的对应 SQL 写语句仍需通过 Harness 的一次性审批；数据库账号也需要具备相应权限。具体配置说明见 [dsh-mysql 中文文档](./dsh-mysql/README.zh.md)。

## 发布安装包

仅推送源码不会生成 Release 附件。仓库的 [发布工作流](./.github/workflows/release-dsh-mysql.yml) 在推送 `dsh-mysql-v*` 标签时运行：

1. 在 `dsh-mysql` 目录执行 `npm pack --ignore-scripts`。
2. 将生成的 `wzxm-dsh-mysql-<版本>.tgz` 重命名为 `dsh-mysql.tgz`。
3. 创建 GitHub Release，并上传该文件作为附件。

发布前更新 `dsh-mysql/package.json` 中的版本号，并确保已提交的 `lib/` 产物与 `src/` 一致。当前工作流只打包已有产物，不执行编译：

- 修改 `src/index.ts` 后，必须在 `dsh-mysql` 目录重新构建并提交 `lib/`，否则发布出去的仍是旧逻辑。
- 仅改 `cordis.patch.yml` 无需重新构建，但会直接改变启动行为，建议先用 `dsh --profile web --dump-config` 验证能被解析。

例如，发布下一个版本 `0.1.3` 时，先提交并推送版本及产物改动，再执行：

```bash
git tag dsh-mysql-v0.1.3
git push origin dsh-mysql-v0.1.3
```

在 [GitHub Actions](https://github.com/wzxm/dsh-plugins/actions) 确认工作流成功，并在 Release 页面确认存在 `dsh-mysql.tgz` 附件。若需固定版本，可使用：

```text
https://github.com/wzxm/dsh-plugins/releases/download/dsh-mysql-v0.1.3/dsh-mysql.tgz
```

固定版本地址同样需要对应版本发布成功后才能使用。
