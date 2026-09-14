# @wzxm/dsh-mysql

Authorized MySQL MCP tools for DeepSeek Harness. Read tools are available through the configured MCP server. Write tools are disabled by default and pass through the dsh approval seam when enabled.

`dsh plugin --profile <name> add` forwards its arguments to pnpm in the profile directory.

GitHub Packages (npm). [Package page](https://github.com/wzxm/dsh-plugins/pkgs/npm/dsh-mysql). The npm registry requires auth even for public packages: put `@wzxm:registry=https://npm.pkg.github.com` and `//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}` in `~/.npmrc`, using a classic PAT with `read:packages`.

```bash
dsh plugin --profile web add "@wzxm/dsh-mysql"
dsh plugin --profile web add "@wzxm/dsh-mysql@0.2.0"
```

GitHub Release tarball, no npm login:

```bash
dsh plugin --profile web add "https://github.com/wzxm/dsh-plugins/releases/latest/download/dsh-mysql.tgz"
```

## Where to set the environment variables

**Export them in the environment that launches `dsh` — not in any `.env` file.**

`dsh plugin add` only installs the package and registers its bundle layer. It does **not** read, move, or apply any environment variable, and nothing else in DSH will read a file for you. The variables have to exist in the `dsh` process's own environment at startup, so setting them up is a separate step you perform once.

The `DSH_` prefix is reserved for bootstrap: DSH rejects a `DSH_*` name in a project `.env` *and* in `$DSH_HOME/.env` (`~/.dsh/.env`). Writing `DSH_MYSQL_HOST` there is a hard startup error, not a silently ignored line:

```text
dsh: <path>/.env sets "DSH_MYSQL_HOST", which only the launching environment may set
```

Put the exports in your shell profile so every `dsh` invocation inherits them:

```bash
# Add to ~/.zshrc (or ~/.bashrc), then open a new terminal.
export DSH_MYSQL_HOST=127.0.0.1
export DSH_MYSQL_PORT=3306
export DSH_MYSQL_USER=readonly_user
export DSH_MYSQL_PASSWORD='…'
export DSH_MYSQL_DATABASE=app
```

For anything that does not run a shell — a systemd unit, a launchd plist, a container — set the same names in its environment block.

### Keeping the secrets in a separate file

If you would rather not keep credentials in your shell profile, put them in a file and `source` it from the profile, so the file stays out of your dotfiles:

```bash
# ~/.dsh/mysql.env — the credentials
export DSH_MYSQL_HOST=127.0.0.1
export DSH_MYSQL_PORT=3306
export DSH_MYSQL_USER=readonly_user
export DSH_MYSQL_PASSWORD='…'
export DSH_MYSQL_DATABASE=app
```

```bash
# Add to ~/.zshrc — one line, sourced on every new shell
[ -f ~/.dsh/mysql.env ] && source ~/.dsh/mysql.env
```

Two things to be clear about:

- **DSH never reads `~/.dsh/mysql.env`.** That filename has no special meaning; `~/.dsh/.env` is the only file DSH loads, and it cannot hold `DSH_*` names. The file works only because your shell sources it, so the `source` line in your shell profile is what matters — without it the file sits unused and the plugin gets empty credentials.
- **Sourcing is per-process and does not persist.** Running `source ~/.dsh/mysql.env` by hand exports into that one shell; a new terminal, an IDE task, or a desktop-launched `dsh` will not see it. Put the line in your shell profile rather than retyping it.

Every line in the example already uses `export`, so `set -a` is unnecessary. If you drop the `export` keyword, add `set -a` before the `source` and `set +a` after it.

Restart `dsh` after changing any of these; they are read when the profile boots.

### Why the variables must be forwarded explicitly

DSH launches the MCP server as a child process with a **scrubbed** environment: every name containing `KEY`, `PASSWORD`, `SECRET`, or `TOKEN` is dropped, and so is every `DSH_*` name. The plugin's `cordis.patch.yml` therefore maps them into the child's `env` explicitly. That mapping is the only reason the credentials reach the server — an exported `DSH_MYSQL_PASSWORD` is *not* visible to the child on its own.

The variables map onto the upstream server's own names:

| Exported to `dsh` | Forwarded to the server as |
| --- | --- |
| `DSH_MYSQL_HOST` | `MYSQL_HOST` |
| `DSH_MYSQL_PORT` | `MYSQL_PORT` |
| `DSH_MYSQL_USER` | `MYSQL_USER` |
| `DSH_MYSQL_PASSWORD` | `MYSQL_PASS` |
| `DSH_MYSQL_DATABASE` | `MYSQL_DB` |

The upstream server reads `MYSQL_PASS` and `MYSQL_DB`. The names `MYSQL_PASSWORD` and `MYSQL_DATABASE` are **not** recognized by it, and setting them has no effect.

## Enabling writes

Every write kind is off by default. Only the string `true` enables one:

```bash
export DSH_MYSQL_ALLOW_INSERT=false
export DSH_MYSQL_ALLOW_UPDATE=false
export DSH_MYSQL_ALLOW_DELETE=false
export DSH_MYSQL_ALLOW_ALTER=false
export DSH_MYSQL_ALLOW_TRUNCATE=false
export DSH_MYSQL_ALLOW_DROP=false
```

An enabled write still needs a one-shot approval: the plugin asks through the approval seam and proceeds only on `allowed-once`. A database account with matching MySQL grants is required as well.

Three independent gates must all open for a write to run: the plugin's `DSH_MYSQL_ALLOW_*` toggle, the approval prompt, and the server-side `ALLOW_*_OPERATION` switch that the patch derives from the same toggle. A write permitted by the seam is still refused by the server if its switch is off.

`DROP` and `TRUNCATE` should stay disabled unless the deployment has a dedicated high-risk approval answerer and database account.

### With no approval service composed

The plugin does **not** declare the approval service as a hard dependency; it resolves it with `ctx.get('approval')` at the point of use. That matters: declared as a hard dependency, Cordis would park this plugin in PENDING in a profile that composes no approval service, `apply` would never run, and **the write gate would not exist at all** — writability would then rest solely on the server's `ALLOW_*_OPERATION` switches. The current behavior is: reads pass, every write is denied, and one warning is logged.

For the same reason, `enabled: false` **denies** every call in the namespace rather than unregistering the listener; unregistering would leave the MCP tools live with no policy whatsoever.

### Writes with no database pinned (multi-DB)

When `MYSQL_DB` is empty the upstream server runs in multi-DB mode, where the target schema comes from the statement itself (`USE`, or a `db.table` reference). One global write toggle would then authorize a write against **any schema the account can reach**, and the server's `SCHEMA_*_PERMISSIONS` list is the only narrowing.

So this plugin **refuses all writes** while `DSH_MYSQL_DATABASE` is empty, unless you opt in explicitly:

```bash
export DSH_MYSQL_ALLOW_MULTI_DB_WRITES=true
```

Set that only when cross-schema writes are genuinely wanted, and narrow them per schema:

```bash
# Upstream server format: schema:true,schema2:false
export DSH_MYSQL_SCHEMA_INSERT_PERMISSIONS='app:true'
export DSH_MYSQL_SCHEMA_UPDATE_PERMISSIONS='app:true'
export DSH_MYSQL_SCHEMA_DELETE_PERMISSIONS='app:true'
export DSH_MYSQL_SCHEMA_DDL_PERMISSIONS='app:false'
```

Left unset, those four switches are all-or-nothing across every schema the account can reach.

## How writes are detected

The upstream MySQL server exposes a single tool — `mysql_query` — that takes a raw SQL string. There is no per-operation tool to match on, so the plugin classifies the submitted SQL itself.

Each statement is judged by its **main verb**:

- **Reads** need no approval: `SELECT`, `SHOW`, `DESCRIBE`, `DESC`, `EXPLAIN`, `USE`, `VALUES`, `HELP`, and `WITH` whose main statement is a read.
- **Writes** map to their toggle: `INSERT`/`REPLACE`/`LOAD` → `allowInsert`, `UPDATE` → `allowUpdate`, `DELETE` → `allowDelete`, `ALTER`/`CREATE`/`RENAME` → `allowAlter`, `TRUNCATE` → `allowTruncate`, `DROP` → `allowDrop`.
- **`SELECT … FOR UPDATE` / `LOCK IN SHARE MODE`** takes write locks and needs write capability, so it is treated as `allowUpdate`.
- **`SELECT … INTO OUTFILE` / `INTO DUMPFILE`** writes a file on the database host and is **always denied**; no toggle enables it.
- **Everything else is denied** — including `GRANT`, `SET`, `CALL`, `LOCK`, `SHUTDOWN`, and any keyword the classifier does not recognize. There is no toggle that turns these on.

The verdict follows the main verb rather than any word appearing in the statement: `WITH c AS (SELECT 1) DROP TABLE t` is a `DROP`, not a `SELECT`, while `WITH c AS (SELECT 'insert') SELECT 1` is a plain read. String literals and quoted identifiers are excluded from keyword matching, so `SELECT 'delete'` is not a write.

Boundaries worth knowing:

- **One statement per call.** A script holding several `;`-separated statements is refused with a message to submit them one at a time: each statement needs its own decision, and one approval covering the whole script would let a single toggle vouch for the rest. (The driver rejects multi-statement payloads anyway.)
- **Executable comments are treated as SQL.** MySQL executes the body of `/*! … */` (including the `/*!50000 … */` version form), so those bodies are inlined before classification rather than dropped — otherwise `SELECT 1 /*!50000 INTO OUTFILE … */` would pass itself off as a plain read. Ordinary `/* … */` comments and `/*+ … */` optimizer hints are never executed and stay ignored.
- **`EXPLAIN` is judged by the statement it wraps.** `EXPLAIN ANALYZE INSERT …` really executes it (MySQL 8.0.18+); `EXPLAIN FOR CONNECTION n` only inspects a session and counts as a read.
- **`--` follows MySQL's rule.** It opens a comment only when followed by whitespace; `SELECT 1--2` is arithmetic.

Because the classifier is deliberately conservative, an unusual but read-only statement may be refused. That is the intended direction: a statement the plugin cannot prove is a read does not run.

## Startup behavior

The MCP client runs with `failOnStartupError: false`, so a missing npm registry or an unreachable database leaves the rest of the profile working — the client retries in the background instead of stopping the harness. Set it to `true` in `cordis.patch.yml` only if this deployment must refuse to start without MySQL.

The upstream server is launched with `npx`, which resolves the package on first use. On a host without registry access, install it beforehand and point `command`/`args` at the local binary.

## Development

```bash
cd dsh-mysql
pnpm install
pnpm test        # classifier and gate behavior
pnpm typecheck
pnpm build       # writes lib/; the release archive is built from it, so commit it
```

After changing `src/`, re-run `pnpm build` and commit `lib/`, or the release ships stale logic. The release workflow rebuilds and diffs `lib/`, so any drift fails the release.

