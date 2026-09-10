# @deepseek-ai/dsh-mysql

Authorized MySQL MCP tools for DeepSeek Harness. Read tools are available through the configured MCP server. Write tools are disabled by default and pass through the dsh approval seam when enabled.

Install the packed release with:

```bash
pnpm dsh plugin --profile web add "https://github.com/wzxm/dsh-plugins/releases/latest/download/dsh-mysql.tgz"
```

Set `DSH_MYSQL_HOST`, `DSH_MYSQL_PORT`, `DSH_MYSQL_USER`, `DSH_MYSQL_PASSWORD`, and `DSH_MYSQL_DATABASE`. Enable individual operations with `DSH_MYSQL_ALLOW_INSERT=true` and the corresponding `DSH_MYSQL_ALLOW_*` variable. A database account with matching MySQL grants is still required.

Every enabled write call asks through `ctx.approval` and receives only a one-shot approval. `DROP` and `TRUNCATE` should remain disabled unless the deployment has a dedicated high-risk approval answerer and database account.
