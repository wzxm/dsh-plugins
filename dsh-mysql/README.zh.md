# @wzxm/dsh-mysql

面向 DeepSeek Harness 的授权 MySQL MCP 插件。查询工具由配置的 MCP server 提供；写操作默认关闭，开启后仍必须通过 dsh 审批 seam 的一次性授权。

安装：

```bash
pnpm dsh plugin --profile web add "https://github.com/wzxm/dsh-plugins/releases/latest/download/dsh-mysql.tgz"
```

配置 `DSH_MYSQL_HOST`、`DSH_MYSQL_PORT`、`DSH_MYSQL_USER`、`DSH_MYSQL_PASSWORD` 和 `DSH_MYSQL_DATABASE`。通过对应的 `DSH_MYSQL_ALLOW_*` 环境变量逐项开启写操作。数据库账号仍必须拥有匹配的 MySQL 权限。

每次开启的写操作都会通过 `ctx.approval` 请求一次性授权。`DROP` 和 `TRUNCATE` 建议始终关闭，除非部署了专门的高风险审批应答者和数据库账号。
