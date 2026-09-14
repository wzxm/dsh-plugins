# dsh-plugins

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的独立插件集合。各插件在本仓库中单独维护，通过 GitHub Packages（npm）和 GitHub Releases 分发，无需将源码放入 DeepSeek Harness 的 `packages/` 工作区。

## 插件列表

| 插件 | 包名 | 功能 | 文档 |
| --- | --- | --- | --- |
| [dsh-mysql](./dsh-mysql/) | `@wzxm/dsh-mysql` | 通过 MySQL MCP server 提供数据库工具，并对 SQL 写语句进行开关控制和一次性审批 | [中文](./dsh-mysql/README.zh.md) · [English](./dsh-mysql/README.md) |

## 安装 dsh-mysql

`dsh plugin --profile <name> <args...>` 会把参数转发给该 profile 目录里的 pnpm，所以包名、版本和 tarball URL 的写法与 `pnpm add` 相同。包必须已经发布成功，下面的地址才可用。

### GitHub Packages（npm）

包名 `@wzxm/dsh-mysql`，页面：[Packages](https://github.com/wzxm/dsh-plugins/pkgs/npm/dsh-mysql)。GitHub Packages 的 npm 源**即使是公开包也要登录**，token 须为 classic PAT（`ghp_`），至少包含 `read:packages`。一次性写入用户级 `~/.npmrc`：

```ini
@wzxm:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

然后在启动 `dsh` 的环境里提供该 token（不要把 PAT 写进仓库）：

```bash
export GITHUB_TOKEN=ghp_xxxxxxxx
```

安装最新版：

```bash
dsh plugin --profile web add "@wzxm/dsh-mysql"
```

固定版本：

```bash
dsh plugin --profile web add "@wzxm/dsh-mysql@0.2.0"
```

若在 DeepSeek Harness 源码仓库里用包装命令，把 `dsh` 换成 `pnpm dsh` 即可。

### GitHub Release 附件

不需要 npm 登录。安装包必须已上传到非草稿、非预发布的 GitHub Release。可在 [Releases](https://github.com/wzxm/dsh-plugins/releases) 查看。

```bash
dsh plugin --profile web add "https://github.com/wzxm/dsh-plugins/releases/latest/download/dsh-mysql.tgz"
```

固定版本：

```text
https://github.com/wzxm/dsh-plugins/releases/download/dsh-mysql-v0.2.0/dsh-mysql.tgz
```

安装后配置环境变量，并重启对应的 Harness profile。

### 环境变量

插件的连接信息与写开关全部来自**启动 `dsh` 的那个环境**，不是 `.env` 文件。

| 环境变量 | 说明 |
| --- | --- |
| `DSH_MYSQL_HOST` | MySQL 主机地址 |
| `DSH_MYSQL_PORT` | MySQL 端口，例如 `3306` |
| `DSH_MYSQL_USER` | 数据库用户名 |
| `DSH_MYSQL_PASSWORD` | 数据库密码 |
| `DSH_MYSQL_DATABASE` | 数据库名称 |
| `DSH_MYSQL_ALLOW_INSERT` 等 | 六类写操作开关，默认关闭，仅字符串 `true` 开启 |

推荐写进 shell profile（`~/.zshrc` 或 `~/.bashrc`）；不跑 shell 的场景（systemd unit、launchd plist、容器）在各自的环境配置块里设置：

```bash
export DSH_MYSQL_HOST=127.0.0.1
export DSH_MYSQL_PORT=3306
export DSH_MYSQL_USER=readonly_user
export DSH_MYSQL_PASSWORD='…'
export DSH_MYSQL_DATABASE=app
```

`DSH_` 是 bootstrap 保留前缀，写进 `.env` 会让 Harness 启动直接报错，所以不要那样做。修改后重启 `dsh` 进程；不要将包含真实密码的配置提交到 Git。

完整的变量说明、凭据文件写法、写操作三道闸门、multi-DB 写入限制，以及 SQL 分类规则，见 [dsh-mysql 中文文档](./dsh-mysql/README.zh.md)。

## 发布安装包

仅推送源码不会生成 Release 附件，也不会发布到 GitHub Packages。仓库的 [发布工作流](./.github/workflows/release-dsh-mysql.yml) 在推送 `dsh-mysql-v*` 标签时运行，依次执行：

1. `pnpm install --frozen-lockfile`。
2. `pnpm run build`，然后 `git diff --exit-code -- lib`：**提交的 `lib/` 必须与 `src/` 一致**，否则发布失败。
3. `pnpm run typecheck` 与 `pnpm run test`。
4. 校验标签版本与 `dsh-mysql/package.json` 的 `version` 相等。
5. `npm pack --ignore-scripts`，把 `wzxm-dsh-mysql-<版本>.tgz` 重命名为 `dsh-mysql.tgz`。
6. 创建 GitHub Release 并上传该附件。
7. `npm publish --ignore-scripts`，发布到 GitHub Packages 的 npm 源（`https://npm.pkg.github.com`，包名 `@wzxm/dsh-mysql`）。工作流用 `GITHUB_TOKEN`，权限为 `packages: write`。

所以发布前需要做的只有两件事：更新 `dsh-mysql/package.json` 的版本号，以及在 `dsh-mysql` 目录执行 `pnpm build` 并提交 `lib/`。产物是否陈旧由工作流把关，不依赖人工记得。`package.json` 里的 `publishConfig.registry` 指向 GitHub Packages，不要发到 npmjs.org。

例如发布 `0.2.0` 时，先提交并推送版本及产物改动，再执行：

```bash
git tag dsh-mysql-v0.2.0
git push origin dsh-mysql-v0.2.0
```

在 [GitHub Actions](https://github.com/wzxm/dsh-plugins/actions) 确认工作流成功，然后检查两处：

- [Releases](https://github.com/wzxm/dsh-plugins/releases) 上有 `dsh-mysql.tgz` 附件。
- [Packages](https://github.com/wzxm/dsh-plugins/pkgs/npm/dsh-mysql) 上出现对应版本。若包显示为 private，在包设置里改成 public（链接了本仓库后一般会继承仓库的公开可见性）。

同一个版本号只能 `npm publish` 一次。已经打过的 `dsh-mysql-v*` 标签不会补发到 Packages；要上架 npm 源，请升版本后打新标签。
