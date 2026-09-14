/**
 * Card copy, in both languages the harness ships.
 *
 * Values are plain strings: the locale registry stores `Record<string, string>`
 * and interpolates by name, so anything dynamic is passed as a substitution
 * variable at the call site rather than as a function here.
 *
 * @module @wzxm/dsh-mysql/client/locales
 */

/** English copy. */
export const en = {
  title: 'MySQL',
  description: 'Which SQL write kinds the agent may run against this database.',
  envNotice:
    'The profile environment is the ceiling: the MCP server decides what it will admit when it starts, '
    + 'so a switch below can revoke a write kind immediately but cannot grant one the profile left off.',
  gated: 'needs DSH_MYSQL_ALLOW_*',
  overridden: 'override',
  loading: 'Loading…',
  unavailable: 'Settings are not available in this browser session.',
  readOnly: 'This deployment does not accept settings writes.',
  allow: 'Allow {statements}',
} as const

/** Chinese copy. */
export const zh = {
  title: 'MySQL',
  description: '允许 agent 对这个数据库执行哪些 SQL 写操作。',
  envNotice:
    'profile 环境变量是上限：MCP server 在启动时就决定了它接受哪些写操作，'
    + '因此下面的开关可以立即收回某类写操作，但无法授予 profile 未开启的那一类。',
  gated: '需 DSH_MYSQL_ALLOW_*',
  overridden: '已覆盖',
  loading: '加载中…',
  unavailable: '当前浏览器会话无法使用设置。',
  readOnly: '该部署不接受写入设置。',
  allow: '允许 {statements}',
} as const

/** The card's dictionary key set. */
export type MysqlCardKey = keyof typeof en
