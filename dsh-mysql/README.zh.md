# @wzxm/dsh-mysql

DeepSeek Harness 的 MySQL MCP 插件。查询默认可用；写操作默认关闭，开启后仍需一次性审批。

## 安装

```bash
dsh plugin --profile web add "@wzxm/dsh-mysql"
```

GitHub Packages 即使公开也要登录。一次性写入 `~/.npmrc`（classic PAT，权限 `read:packages`）：

```ini
@wzxm:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

或不配 token，装 [Release 附件](https://github.com/wzxm/dsh-plugins/releases/latest/download/dsh-mysql.tgz)：

```bash
dsh plugin --profile web add "https://github.com/wzxm/dsh-plugins/releases/latest/download/dsh-mysql.tgz"
```

装完配置环境变量，重启对应 profile。

## 配置

在**启动 `dsh` 的环境**里 `export`，不要写进任何 `.env`（`DSH_` 是保留前缀，写进去会启动失败）。

```bash
# ~/.zshrc 或单独文件再 source
export DSH_MYSQL_HOST=127.0.0.1
export DSH_MYSQL_PORT=3306
export DSH_MYSQL_USER=readonly_user
export DSH_MYSQL_PASSWORD='…'
export DSH_MYSQL_DATABASE=app
```

改完后重启 `dsh`。上游 server 读的是 `MYSQL_PASS` / `MYSQL_DB`，插件会从上面这组变量转发过去。

## 写操作

默认全关。打开某一类需要：

1. 开关为 `true`（环境变量，或设置页的 MySQL 卡片）
2. 一次性审批通过
3. 数据库账号本身有对应权限

```bash
export DSH_MYSQL_ALLOW_INSERT=true    # INSERT / REPLACE / LOAD
export DSH_MYSQL_ALLOW_UPDATE=true    # UPDATE，以及 SELECT … FOR UPDATE
export DSH_MYSQL_ALLOW_DELETE=true
export DSH_MYSQL_ALLOW_ALTER=true     # ALTER / CREATE / RENAME
export DSH_MYSQL_ALLOW_TRUNCATE=true
export DSH_MYSQL_ALLOW_DROP=true
```

`DROP` / `TRUNCATE` 建议保持关闭。没有审批服务时，读照常、写一律拒绝。

未设置 `DSH_MYSQL_DATABASE` 时默认禁写（否则会授权账号能碰到的任意库）。确需跨库写入才打开：

```bash
export DSH_MYSQL_ALLOW_MULTI_DB_WRITES=true
export DSH_MYSQL_SCHEMA_INSERT_PERMISSIONS='app:true'
export DSH_MYSQL_SCHEMA_UPDATE_PERMISSIONS='app:true'
export DSH_MYSQL_SCHEMA_DELETE_PERMISSIONS='app:true'
export DSH_MYSQL_SCHEMA_DDL_PERMISSIONS='app:false'
```

## SQL 怎么分类

上游只有一个工具 `mysql_query`，插件按**主语句的主关键字**判断：

| 类型 | 语句 |
| --- | --- |
| 读（无需审批） | `SELECT`、`SHOW`、`DESCRIBE`、`EXPLAIN`、`USE`、`WITH`（主句为读） |
| 写（对应开关） | `INSERT`/`REPLACE`/`LOAD`、`UPDATE`、`DELETE`、`ALTER`/`CREATE`/`RENAME`、`TRUNCATE`、`DROP` |
| 一律拒绝 | `SELECT … INTO OUTFILE`、`GRANT`、`SET`、`CALL`，以及无法识别的语句 |

一次只接受一条语句。`SELECT 1; DROP TABLE t` 会被拒绝。`WITH … DROP` 算 `DROP`，`SELECT 'delete'` 仍是读。无法证明是读的语句不会执行。

## 改完代码怎么发

```bash
cd dsh-mysql
pnpm test
pnpm build          # 必须提交 lib/
```

升 `package.json` 的 `version`（例如 `0.2.0` → `0.2.1`），提交推送后打同号 tag：

```bash
git tag dsh-mysql-v0.2.1
git push origin dsh-mysql-v0.2.1
```

CI 会测、发 [Release](https://github.com/wzxm/dsh-plugins/releases) 和 [GitHub Packages](https://github.com/wzxm/dsh-plugins/pkgs/npm/dsh-mysql)。同一 version 只能发一次。
