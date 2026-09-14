# @wzxm/dsh-mysql

面向 DeepSeek Harness 的授权 MySQL MCP 插件。查询工具由配置的 MCP server 提供；写操作默认关闭，开启后仍必须通过 dsh 审批 seam 的一次性授权。

`dsh plugin --profile <name> add` 把参数转发给 profile 目录里的 pnpm。

GitHub Packages（npm）。[包页面](https://github.com/wzxm/dsh-plugins/pkgs/npm/dsh-mysql)。该源即使公开包也要登录：在 `~/.npmrc` 写入 `@wzxm:registry=https://npm.pkg.github.com` 和 `//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}`，token 用带 `read:packages` 的 classic PAT。

```bash
dsh plugin --profile web add "@wzxm/dsh-mysql"
dsh plugin --profile web add "@wzxm/dsh-mysql@0.2.0"
```

GitHub Release 附件，无需 npm 登录：

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

开启后仍需一次性审批：插件通过审批 seam 提问，只有返回 `allowed-once` 才继续。数据库账号也必须拥有匹配的 MySQL 权限。

写操作要真正执行，需要三道独立的闸门同时打开：插件的 `DSH_MYSQL_ALLOW_*` 开关、审批应答、以及 patch 从同一开关派生的 server 端 `ALLOW_*_OPERATION` 开关。即使 seam 放行，对应的 server 开关没开仍会被 server 拒绝。

`DROP` 和 `TRUNCATE` 建议始终关闭，除非部署了专门的高风险审批应答者和数据库账号。

### 未组合审批服务时

插件**不**把审批服务列为硬依赖，而是使用时用 `ctx.get('approval')` 取。这一点很关键：若声明成硬依赖，在一个没有审批服务的 profile 里 Cordis 会让本插件停在 PENDING，`apply` 从不执行——**写闸门根本不存在**，是否可写就只取决于 server 端的 `ALLOW_*_OPERATION`。现在的行为是：取不到审批服务时，读照常放行，所有写一律拒绝，并记录一次警告。

同理，`enabled: false` 是**拒绝**该 namespace 下的全部调用，而不是卸载监听器；卸载会让 MCP 工具在完全无策略的状态下继续可用。

### 未固定数据库时的写操作（multi-DB）

上游 server 在 `MYSQL_DB` 为空时进入 multi-DB 模式，此时目标 schema 由语句自身（`USE` 或 `db.table`）决定。这意味着一把全局写开关会**授权账号可触及的任意 schema**，唯一的收窄手段是 server 端的 `SCHEMA_*_PERMISSIONS`。

因此本插件在 `DSH_MYSQL_DATABASE` 为空时**拒绝一切写操作**，除非显式设置：

```bash
export DSH_MYSQL_ALLOW_MULTI_DB_WRITES=true
```

只有在确实需要跨库写入时才这样设置，并配合按库授权：

```bash
# 上游 server 的格式：schema:true,schema2:false
export DSH_MYSQL_SCHEMA_INSERT_PERMISSIONS='app:true'
export DSH_MYSQL_SCHEMA_UPDATE_PERMISSIONS='app:true'
export DSH_MYSQL_SCHEMA_DELETE_PERMISSIONS='app:true'
export DSH_MYSQL_SCHEMA_DDL_PERMISSIONS='app:false'
```

不设置时，这四个开关是「全有/全无」——对账号能触及的每个 schema 都生效。

## 写操作如何被识别

上游 MySQL server 只暴露一个工具 `mysql_query`，接收原始 SQL 字符串。它没有按操作拆分的工具可供匹配，因此插件自己解析提交的 SQL。

脚本中的语句按**主关键字**判定：

- **读操作**无需审批：`SELECT`、`SHOW`、`DESCRIBE`、`DESC`、`EXPLAIN`、`USE`、`VALUES`、`HELP`，以及主语句为读的 `WITH`。
- **写操作**映射到对应开关：`INSERT`/`REPLACE`/`LOAD` → `allowInsert`，`UPDATE` → `allowUpdate`，`DELETE` → `allowDelete`，`ALTER`/`CREATE`/`RENAME` → `allowAlter`，`TRUNCATE` → `allowTruncate`，`DROP` → `allowDrop`。
- **`SELECT … FOR UPDATE` / `LOCK IN SHARE MODE`** 加写锁并需要写权限，按 `allowUpdate` 处理。
- **`SELECT … INTO OUTFILE` / `INTO DUMPFILE`** 会在数据库主机上写文件，**一律拒绝**，没有开关可开。
- **其余一律拒绝**，包括 `GRANT`、`SET`、`CALL`、`LOCK`、`SHUTDOWN` 以及分类器无法识别的任何关键字。这些没有对应的开关可以打开。

判定基于**主语句的主关键字**，而不是语句里出现的任意词：`WITH c AS (SELECT 1) DROP TABLE t` 会被判为 `DROP` 而不是 `SELECT`，而 `WITH c AS (SELECT 'insert') SELECT 1` 是纯读。字符串字面量和带引号的标识符内容不参与关键字匹配，所以 `SELECT 'delete'` 不会被视为写操作。

几条需要知道的边界：

- **一次只允许一条语句。** 含多条 `;` 分隔语句的脚本会被拒绝并提示逐条提交：每条语句都要有自己的授权决定，用一次审批覆盖整个脚本等于让一个开关替其余语句背书。（驱动本身也不支持多语句，会直接报语法错。）
- **可执行注释按 SQL 处理。** MySQL 会执行 `/*! … */`（含 `/*!50000 … */` 版本形式）里的内容，因此这些内容会被展开后参与分类，而不是当注释丢掉——否则 `SELECT 1 /*!50000 INTO OUTFILE … */` 会伪装成一条普通读语句。普通 `/* … */` 注释和 `/*+ … */` 优化器提示不执行，仍然忽略。
- **`EXPLAIN` 按它包裹的语句判定。** `EXPLAIN ANALYZE INSERT …`（MySQL 8.0.18+）会真正执行；`EXPLAIN FOR CONNECTION n` 只查看连接，按读处理。
- **`--` 按 MySQL 规则处理。** 只有后面跟空白字符时才是注释；`SELECT 1--2` 是算术表达式。

分类器刻意保守，因此个别罕见但只读的语句可能被拒绝。这是预期方向：插件无法证明是读操作的语句不会执行。

## 启动行为

MCP client 以 `failOnStartupError: false` 运行，因此 npm registry 不可达或数据库连不上时，profile 的其余部分照常工作——client 在后台重试，而不是终止整个 harness。只有当该部署必须无 MySQL 不启动时，才在 `cordis.patch.yml` 中改为 `true`。

上游 server 通过 `npx` 启动，首次使用时解析包。若主机无法访问 registry，请预先安装并把 `command`/`args` 指向本地二进制。

## 开发

```bash
cd dsh-mysql
pnpm install
pnpm test        # 分类器与闸门的行为测试
pnpm typecheck
pnpm build       # 生成 lib/；发布产物就是它，必须一并提交
```

改动 `src/` 后必须重新 `pnpm build` 并提交 `lib/`，否则发布出去的仍是旧逻辑。CI 的发布工作流会重新构建并比对 `lib/`，任何不一致都会让发布失败。
