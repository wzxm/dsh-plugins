# @wzxm/dsh-mysql

面向 DeepSeek Harness 的授权 MySQL MCP 插件。查询工具由配置的 MCP server 提供；写操作默认关闭，开启后仍必须通过 dsh 审批 seam 的一次性授权。

安装：

```bash
dsh plugin --profile web add "https://github.com/wzxm/dsh-plugins/releases/latest/download/dsh-mysql.tgz"
```

## 环境变量应该在哪里设置

**在启动 `dsh` 的那个环境里 export，不要写进任何 `.env` 文件。**

`dsh plugin add` 只负责安装包并登记它的 bundle 层，**不会**读取、搬运或应用任何环境变量；DSH 的其他部分也不会替你读取某个文件。这些变量必须在 `dsh` 进程启动时就存在于它自己的环境里，所以这是一次性的手工步骤，和安装是两件事。

`DSH_` 前缀属于 bootstrap 保留名：无论项目 `.env` 还是 `$DSH_HOME/.env`（默认 `~/.dsh/.env`），DSH 都会拒绝其中的 `DSH_*` 变量。写入 `DSH_MYSQL_HOST` 会导致**启动直接失败**，而不是被静默忽略：

```text
dsh: <path>/.env sets "DSH_MYSQL_HOST", which only the launching environment may set
```

推荐写进 shell profile，这样每次调用 `dsh` 都能继承：

```bash
# 加到 ~/.zshrc（或 ~/.bashrc），然后开一个新终端
export DSH_MYSQL_HOST=127.0.0.1
export DSH_MYSQL_PORT=3306
export DSH_MYSQL_USER=readonly_user
export DSH_MYSQL_PASSWORD='…'
export DSH_MYSQL_DATABASE=app
```

对于不跑 shell 的场景（systemd unit、launchd plist、容器），在它自己的环境配置块里设置同样的名字。

### 把密码放在单独的文件里

如果不想把凭据写进 shell profile，可以放进一个文件，再从 profile 里 `source` 它，这样凭据文件本身不进 dotfiles：

```bash
# ~/.dsh/mysql.env —— 凭据
export DSH_MYSQL_HOST=127.0.0.1
export DSH_MYSQL_PORT=3306
export DSH_MYSQL_USER=readonly_user
export DSH_MYSQL_PASSWORD='…'
export DSH_MYSQL_DATABASE=app
```

```bash
# 加到 ~/.zshrc —— 一行，每个新 shell 都会加载
[ -f ~/.dsh/mysql.env ] && source ~/.dsh/mysql.env
```

有两点必须说清楚：

- **DSH 从不读取 `~/.dsh/mysql.env`。** 这个文件名没有任何特殊含义；DSH 唯一会加载的文件是 `~/.dsh/.env`，而它又不允许放 `DSH_*` 变量。该文件能生效，完全是因为你的 shell `source` 了它——所以真正起作用的是 shell profile 里那行 `source`；没有它，文件就只是躺在那儿，插件拿到的是空凭据。
- **`source` 是进程级的，不会持久化。** 手动执行 `source ~/.dsh/mysql.env` 只在那一个 shell 里生效；新开的终端、IDE 任务、从桌面启动的 `dsh` 都看不到。请把这一行写进 shell profile，而不是每次手动敲。

示例里每行都写了 `export`，因此 `set -a` 是多余的。如果去掉 `export` 关键字，就要在 `source` 前加 `set -a`、之后加 `set +a`。

修改后重启 `dsh`；这些变量在 profile 启动时读取。

### 为什么必须显式转发

DSH 以**净化过的**环境启动 MCP server 子进程：名字里含 `KEY`、`PASSWORD`、`SECRET`、`TOKEN` 的变量一律丢弃，所有 `DSH_*` 变量也一并丢弃。因此插件在 `cordis.patch.yml` 里显式把它们映射进子进程的 `env`——这是凭据能到达 server 的唯一原因，单独 export `DSH_MYSQL_PASSWORD` 子进程是看不到的。

变量与上游 server 自身的名字对应关系：

| 导出给 `dsh` | 转发给 server |
| --- | --- |
| `DSH_MYSQL_HOST` | `MYSQL_HOST` |
| `DSH_MYSQL_PORT` | `MYSQL_PORT` |
| `DSH_MYSQL_USER` | `MYSQL_USER` |
| `DSH_MYSQL_PASSWORD` | `MYSQL_PASS` |
| `DSH_MYSQL_DATABASE` | `MYSQL_DB` |

上游 server 读取的是 `MYSQL_PASS` 和 `MYSQL_DB`。`MYSQL_PASSWORD` 和 `MYSQL_DATABASE` 这两个名字**它并不识别**，设置了也不生效。

## 开启写操作

所有写操作默认关闭，只有值为字符串 `true` 时才开启：

```bash
export DSH_MYSQL_ALLOW_INSERT=false
export DSH_MYSQL_ALLOW_UPDATE=false
export DSH_MYSQL_ALLOW_DELETE=false
export DSH_MYSQL_ALLOW_ALTER=false
export DSH_MYSQL_ALLOW_TRUNCATE=false
export DSH_MYSQL_ALLOW_DROP=false
```

开启后仍需一次性审批：插件通过 `ctx.approval` 提问，只有返回 `allowed-once` 才继续。未组合任何交互式应答者时，审批按 fail-closed 处理。数据库账号也必须拥有匹配的 MySQL 权限。

写操作要真正执行，需要三道独立的闸门同时打开：插件的 `DSH_MYSQL_ALLOW_*` 开关、审批应答、以及 patch 从同一开关派生的 server 端 `ALLOW_*_OPERATION` 开关。即使 seam 放行，对应的 server 开关没开仍会被 server 拒绝。

`DROP` 和 `TRUNCATE` 建议始终关闭，除非部署了专门的高风险审批应答者和数据库账号。

## 写操作如何被识别

上游 MySQL server 只暴露一个工具 `mysql_query`，接收原始 SQL 字符串。它没有按操作拆分的工具可供匹配，因此插件自己解析提交的 SQL。

脚本中每条语句按首个关键字判定：

- **读操作**无需审批：`SELECT`、`SHOW`、`DESCRIBE`、`DESC`、`EXPLAIN`、`USE`、`VALUES`、`HELP`，以及体内不含写关键字、以 `WITH` 开头的语句。
- **写操作**映射到对应开关：`INSERT`/`REPLACE`/`LOAD` → `allowInsert`，`UPDATE` → `allowUpdate`，`DELETE` → `allowDelete`，`ALTER`/`CREATE`/`RENAME` → `allowAlter`，`TRUNCATE` → `allowTruncate`，`DROP` → `allowDrop`。
- **其余一律拒绝**，包括 `GRANT`、`SET`、`CALL`、`LOCK`、`SHUTDOWN` 以及分类器无法识别的任何关键字。这些没有对应的开关可以打开。

含多条 `;` 分隔语句的脚本按最严格的那条判定：只要有一条写语句，整个脚本就需要审批；只要有一条不支持的关键字，整个脚本被拒绝。字符串字面量、带引号的标识符和注释里的分号不会被当作语句分隔符。

分类器刻意保守，因此个别罕见但只读的语句可能被拒绝。这是预期方向：插件无法证明是读操作的语句不会执行。

## 启动行为

MCP client 以 `failOnStartupError: false` 运行，因此 npm registry 不可达或数据库连不上时，profile 的其余部分照常工作——client 在后台重试，而不是终止整个 harness。只有当该部署必须无 MySQL 不启动时，才在 `cordis.patch.yml` 中改为 `true`。

上游 server 通过 `npx` 启动，首次使用时解析包。若主机无法访问 registry，请预先安装并把 `command`/`args` 指向本地二进制。
