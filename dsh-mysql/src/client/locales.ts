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
    'This page is a revocation control. Writes authorized by the startup environment can be turned off or restored here immediately; unauthorized writes show the exact variable required and cannot be granted here.',
  envUnauthorized: 'Not authorized by environment',
  overridden: 'override',
  loading: 'Loading…',
  unavailable: 'Settings are not available in this browser session.',
  readOnly: 'This deployment does not accept settings writes.',
  allow: 'Allow {statements}',
  collapse: 'Collapse MySQL settings',
  expand: 'Expand MySQL settings',
  staged: 'staged',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  saveFailed: 'The deployment did not accept these values.',
  unsaved: 'Unsaved',
} as const

/** Chinese copy. */
export const zh = {
  title: 'MySQL',
  description: '允许 agent 对这个数据库执行哪些 SQL 写操作。',
  envNotice:
    '此页面用于撤销权限：启动环境已授权的写操作可在这里即时关闭或恢复；未授权项只显示所需环境变量，不能在这里授予。',
  envUnauthorized: '环境变量未授权',
  overridden: '已覆盖',
  loading: '加载中…',
  unavailable: '当前浏览器会话无法使用设置。',
  readOnly: '该部署不接受写入设置。',
  allow: '允许 {statements}',
  collapse: '收起 MySQL 设置',
  expand: '展开 MySQL 设置',
  staged: '待保存',
  save: '保存',
  saving: '保存中…',
  discard: '放弃',
  saveFailed: '部署未接受这些值。',
  unsaved: '未保存',
} as const

/** The card's dictionary key set. */
export type MysqlCardKey = keyof typeof en
