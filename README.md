# dsh-plugins

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的独立插件集合。各插件在本仓库中单独维护，通过 GitHub Releases 分发安装包，无需将源码放入 DeepSeek Harness 的 `packages/` 工作区。

## 插件列表

| 插件 | 包名 | 功能 | 文档 |
| --- | --- | --- | --- |
| [dsh-mysql](./dsh-mysql/) | `@wzxm/dsh-mysql` | 通过 MySQL MCP server 提供数据库工具，并对匹配的写操作进行开关控制和一次性审批 | [中文](./dsh-mysql/README.zh.md) · [English](./dsh-mysql/README.md) |

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

### 数据库配置

插件从 Harness 服务进程的环境变量中读取连接信息：

| 环境变量 | 说明 |
| --- | --- |
| `DSH_MYSQL_HOST` | MySQL 主机地址 |
| `DSH_MYSQL_PORT` | MySQL 端口，例如 `3306` |
| `DSH_MYSQL_USER` | 数据库用户名 |
| `DSH_MYSQL_PASSWORD` | 数据库密码 |
| `DSH_MYSQL_DATABASE` | 数据库名称 |

在启动 Harness 前，通过启动环境或 `.env` 文件设置这些值；修改后重启服务。不要将包含真实密码的配置提交到 Git。

以下写操作开关默认关闭，只有对应变量设置为字符串 `true` 时才会开启：

```dotenv
DSH_MYSQL_ALLOW_INSERT=false
DSH_MYSQL_ALLOW_UPDATE=false
DSH_MYSQL_ALLOW_DELETE=false
DSH_MYSQL_ALLOW_ALTER=false
DSH_MYSQL_ALLOW_TRUNCATE=false
DSH_MYSQL_ALLOW_DROP=false
```

开启后，插件识别到的对应写工具调用仍需通过 Harness 的一次性审批；数据库账号也需要具备相应权限。具体配置说明见 [dsh-mysql 中文文档](./dsh-mysql/README.zh.md)。

## 发布安装包

仅推送源码不会生成 Release 附件。仓库的 [发布工作流](./.github/workflows/release-dsh-mysql.yml) 在推送 `dsh-mysql-v*` 标签时运行：

1. 在 `dsh-mysql` 目录执行 `npm pack --ignore-scripts`。
2. 将生成的 `wzxm-dsh-mysql-<版本>.tgz` 重命名为 `dsh-mysql.tgz`。
3. 创建 GitHub Release，并上传该文件作为附件。

发布前更新 `dsh-mysql/package.json` 中的版本号，并确保已提交的 `lib/` 产物与源码一致。当前工作流只打包已有产物，不执行编译。

例如，发布下一个版本 `0.1.1` 时，先提交并推送版本及产物改动，再执行：

```bash
git tag dsh-mysql-v0.1.1
git push origin dsh-mysql-v0.1.1
```

在 [GitHub Actions](https://github.com/wzxm/dsh-plugins/actions) 确认工作流成功，并在 Release 页面确认存在 `dsh-mysql.tgz` 附件。若需固定版本，可使用：

```text
https://github.com/wzxm/dsh-plugins/releases/download/dsh-mysql-v0.1.1/dsh-mysql.tgz
```

固定版本地址同样需要对应版本发布成功后才能使用。
