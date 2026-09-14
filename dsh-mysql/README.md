# @wzxm/dsh-mysql

Authorized MySQL MCP tools for DeepSeek Harness. Reads work by default. Writes are off until you turn them on, and still need a one-shot approval.

## Install

```bash
dsh plugin --profile web add "@wzxm/dsh-mysql"
```

GitHub Packages requires auth even for public packages. Once, in `~/.npmrc` (classic PAT with `read:packages`):

```ini
@wzxm:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Or skip the token and install the [Release tarball](https://github.com/wzxm/dsh-plugins/releases/latest/download/dsh-mysql.tgz):

```bash
dsh plugin --profile web add "https://github.com/wzxm/dsh-plugins/releases/latest/download/dsh-mysql.tgz"
```

Then set the environment variables and restart the profile.

## Config

`export` these in the environment that **launches `dsh`**. The plugin does not load `.env` files automatically; if you use a separate env file, `source` it in that same shell before launching `dsh`.

```bash
# ~/.zshrc, or a file you source from it
export DSH_MYSQL_HOST=127.0.0.1
export DSH_MYSQL_PORT=3306
export DSH_MYSQL_USER=readonly_user
export DSH_MYSQL_PASSWORD='…'
export DSH_MYSQL_DATABASE=app
```

Restart `dsh` after changing them. The upstream server reads `MYSQL_PASS` / `MYSQL_DB`; the plugin forwards from the names above.

`DSH_MYSQL_ALLOW_*` is not one variable and `*` is not literal: each suffix controls one operation listed below. Do not set `DSH_MYSQL_ALLOW=true`. For example, `export DSH_MYSQL_ALLOW_UPDATE=true` enables only the update class; the other write classes remain off.

`~/.dsh/mysql.env` is not loaded automatically. If you keep the exports there, run `source ~/.dsh/mysql.env` in the same shell that launches `dsh` (or source it from `~/.zshrc`), then restart the profile.

## Writes

Off by default. A write runs only when all three are true:

1. The matching switch is `true` (env, or the MySQL settings card)
2. One-shot approval succeeds
3. The database account has the matching grants

```bash
export DSH_MYSQL_ALLOW_INSERT=true    # INSERT / REPLACE / LOAD
export DSH_MYSQL_ALLOW_UPDATE=true    # UPDATE, and SELECT … FOR UPDATE
export DSH_MYSQL_ALLOW_DELETE=true
export DSH_MYSQL_ALLOW_ALTER=true     # ALTER / CREATE / RENAME
export DSH_MYSQL_ALLOW_TRUNCATE=true
export DSH_MYSQL_ALLOW_DROP=true
```

Leave `DROP` / `TRUNCATE` off. Without an approval service, reads pass and every write is denied.

With `DSH_MYSQL_DATABASE` empty, writes are refused (otherwise any reachable schema would be in play). Opt in only when you need that:

```bash
export DSH_MYSQL_ALLOW_MULTI_DB_WRITES=true
export DSH_MYSQL_SCHEMA_INSERT_PERMISSIONS='app:true'
export DSH_MYSQL_SCHEMA_UPDATE_PERMISSIONS='app:true'
export DSH_MYSQL_SCHEMA_DELETE_PERMISSIONS='app:true'
export DSH_MYSQL_SCHEMA_DDL_PERMISSIONS='app:false'
```

## How SQL is classified

The upstream server exposes one tool, `mysql_query`. The plugin judges the **main verb** of the main statement:

| Kind | Statements |
| --- | --- |
| Read (no approval) | `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN`, `USE`, `WITH` (when the main statement is a read) |
| Write (matching switch) | `INSERT`/`REPLACE`/`LOAD`, `UPDATE`, `DELETE`, `ALTER`/`CREATE`/`RENAME`, `TRUNCATE`, `DROP` |
| Always denied | `SELECT … INTO OUTFILE`, `GRANT`, `SET`, `CALL`, and anything unrecognized |

One statement per call. `SELECT 1; DROP TABLE t` is refused. `WITH … DROP` is a `DROP`; `SELECT 'delete'` is still a read. A statement the plugin cannot prove is a read does not run.

## After a code change

```bash
cd dsh-mysql
pnpm test
pnpm build          # commit lib/ as well
```

Bump `package.json` `version` (e.g. `0.2.0` → `0.2.1`), push, then tag the same number:

```bash
git tag dsh-mysql-v0.2.1
git push origin dsh-mysql-v0.2.1
```

CI tests, then publishes the [Release](https://github.com/wzxm/dsh-plugins/releases) and [GitHub Packages](https://github.com/wzxm/dsh-plugins/pkgs/npm/dsh-mysql). A version can be published only once.
