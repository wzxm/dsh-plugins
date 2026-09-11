/**
 * Authorization seam for the MySQL MCP bridge.
 *
 * The upstream MySQL MCP server exposes exactly ONE tool — `mysql_query` — that
 * accepts a raw SQL string. There is no `insert`/`update`/`delete` tool to
 * match on, so write detection has to read the SQL itself. This plugin
 * classifies every statement in the submitted `sql` argument, and a write is
 * allowed only when its `allow*` toggle is on AND the dsh approval seam returns
 * a one-shot approval.
 *
 * Everything unrecognized is denied: a statement this classifier cannot prove
 * is a read fails closed rather than slipping past the gate.
 *
 * @module @wzxm/dsh-mysql
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import '@deepseek-ai/dsh-user-approval'

export const name = 'dsh-mysql'
export const inject = ['tools', 'approval']

export interface Config {
  enabled?: boolean
  serverName?: string
  allowInsert?: boolean
  allowUpdate?: boolean
  allowDelete?: boolean
  allowAlter?: boolean
  allowTruncate?: boolean
  allowDrop?: boolean
  /** Reserved for a future result-size guard; accepted so existing config keeps loading. */
  maxAffectedRows?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  serverName: z.string().default('mysql'),
  allowInsert: z.boolean().default(false),
  allowUpdate: z.boolean().default(false),
  allowDelete: z.boolean().default(false),
  allowAlter: z.boolean().default(false),
  allowTruncate: z.boolean().default(false),
  allowDrop: z.boolean().default(false),
  maxAffectedRows: z.number().min(1).default(100),
})

/** The `allow*` switches, keyed by the write they permit. */
type WriteSetting =
  | 'allowInsert'
  | 'allowUpdate'
  | 'allowDelete'
  | 'allowAlter'
  | 'allowTruncate'
  | 'allowDrop'

/** Leading keywords that are unambiguously reads and never need approval. */
const READ_KEYWORDS = new Set(['select', 'show', 'describe', 'desc', 'explain', 'use', 'values', 'help'])

/** Leading keywords mapped to the switch that permits them. */
const WRITE_KEYWORDS: ReadonlyMap<string, WriteSetting> = new Map<string, WriteSetting>([
  ['insert', 'allowInsert'],
  ['replace', 'allowInsert'],
  ['load', 'allowInsert'],
  ['update', 'allowUpdate'],
  ['delete', 'allowDelete'],
  ['alter', 'allowAlter'],
  ['create', 'allowAlter'],
  ['rename', 'allowAlter'],
  ['truncate', 'allowTruncate'],
  ['drop', 'allowDrop'],
])

/**
 * Remaining statement-leading keywords that write or change state but have no
 * dedicated switch. They are denied outright, so an operator cannot turn them
 * on by enabling one of the six named toggles.
 */
const UNSUPPORTED_WRITE_KEYWORDS = new Set([
  'call', 'do', 'execute', 'grant', 'revoke', 'kill', 'lock', 'unlock',
  'flush', 'reset', 'purge', 'install', 'uninstall', 'shutdown', 'set',
  'prepare', 'deallocate', 'savepoint', 'xa', 'analyze', 'optimize',
  'repair', 'check', 'checksum', 'handler', 'import',
])

/**
 * Split a SQL script into statements on top-level semicolons.
 *
 * String literals, quoted identifiers, and comments are copied through
 * untouched so a `;` inside `'a;b'` or inside a comment never splits a
 * statement — mis-splitting would let a write hide behind a read's keyword.
 * @param sql - the script to split.
 * @returns each statement with surrounding whitespace and comments trimmed.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let index = 0
  while (index < sql.length) {
    const char = sql[index] as string
    const next = sql[index + 1]
    // Line comments (`-- …`, `# …`) and block comments (`/* … */`) contribute a
    // space so adjacent tokens never fuse across the removed comment.
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index)
      index = end === -1 ? sql.length : end + 1
      current += ' '
      continue
    }
    if (char === '#') {
      const end = sql.indexOf('\n', index)
      index = end === -1 ? sql.length : end + 1
      current += ' '
      continue
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2)
      index = end === -1 ? sql.length : end + 2
      current += ' '
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      current += char
      index += 1
      while (index < sql.length) {
        const inner = sql[index] as string
        current += inner
        index += 1
        if (inner === '\\' && quote !== '`') {
          // A backslash escape consumes the next character, so `\'` stays inside.
          if (index < sql.length) current += sql[index] as string
          index += 1
          continue
        }
        if (inner !== quote) continue
        if (sql[index] === quote) {
          // A doubled quote is an escaped quote, not the end of the literal.
          current += sql[index] as string
          index += 1
          continue
        }
        break
      }
      continue
    }
    if (char === ';') {
      statements.push(current)
      current = ''
      index += 1
      continue
    }
    current += char
    index += 1
  }
  statements.push(current)
  return statements.map(statement => statement.trim()).filter(statement => statement !== '')
}

/** The first bare keyword of a stripped statement, lowercased. */
function leadingKeyword(statement: string): string {
  const match = /^[A-Za-z_]+/.exec(statement)
  return match === null ? '' : match[0].toLowerCase()
}

/** Whether any top-level word of a statement is one of `keywords`. */
function containsKeyword(statement: string, keywords: ReadonlySet<string> | ReadonlyMap<string, unknown>): boolean {
  const words = statement.match(/[A-Za-z_]+/g)
  if (words === null) return false
  return words.some(word => keywords.has(word.toLowerCase()))
}

/** What one SQL payload requires before it may run. */
export type SqlVerdict =
  | { kind: 'read' }
  | { kind: 'write'; setting: WriteSetting }
  | { kind: 'unsupported'; keyword: string }
  | { kind: 'empty' }

/**
 * Classify one submitted SQL script.
 *
 * A script may hold several `;`-separated statements, so the verdict is the
 * strictest one any statement produces: one write makes the whole script a
 * write, and one unsupported keyword denies the whole script.
 * @param sql - the script from the tool call's `sql` argument.
 * @returns the approval requirement the script carries.
 */
export function classifySql(sql: string): SqlVerdict {
  const statements = splitStatements(sql)
  if (statements.length === 0) return { kind: 'empty' }
  let write: WriteSetting | undefined
  for (const statement of statements) {
    const keyword = leadingKeyword(statement)
    if (keyword === 'with') {
      // A CTE can wrap a write (`WITH x AS (…) INSERT …`), so a leading `with`
      // is only a read when no write keyword appears anywhere in the statement.
      const nested = [...WRITE_KEYWORDS.keys()].find(candidate =>
        new RegExp(`\\b${candidate}\\b`, 'i').test(statement))
      if (nested !== undefined) {
        write ??= WRITE_KEYWORDS.get(nested)
        continue
      }
      if (containsKeyword(statement, READ_KEYWORDS)) continue
      return { kind: 'unsupported', keyword }
    }
    if (READ_KEYWORDS.has(keyword)) continue
    const setting = WRITE_KEYWORDS.get(keyword)
    if (setting !== undefined) {
      write ??= setting
      continue
    }
    if (UNSUPPORTED_WRITE_KEYWORDS.has(keyword)) return { kind: 'unsupported', keyword }
    // An unknown leading keyword is not proven to be a read.
    return { kind: 'unsupported', keyword: keyword === '' ? '(unparsable)' : keyword }
  }
  return write === undefined ? { kind: 'read' } : { kind: 'write', setting: write }
}

/** The `sql` argument of a call, when the call carries one. */
function sqlArgument(exec: ToolExecution): string | undefined {
  const args = exec.arguments
  if (typeof args !== 'object' || args === null) return undefined
  const sql = (args as Record<string, unknown>).sql
  return typeof sql === 'string' ? sql : undefined
}

/** A short, credential-free description of the pending call for the approval prompt. */
function safeSummary(exec: ToolExecution): string {
  let rendered: string
  try {
    rendered = JSON.stringify(exec.arguments) ?? String(exec.arguments)
  } catch {
    rendered = '(unserializable arguments)'
  }
  return `MySQL statement via ${exec.name}: ${rendered.slice(0, 4000)}`
}

export function apply(ctx: Context, config: Config = {}): void {
  if (config.enabled === false) return
  const prefix = `mcp__${config.serverName ?? 'mysql'}__`
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (!exec.name.startsWith(prefix)) return next()
    const sql = sqlArgument(exec)
    if (sql === undefined) {
      // A namespaced call whose SQL never arrived cannot be classified, so it
      // cannot be cleared.
      return { kind: 'deny', reason: `MYSQL_SQL_UNREADABLE: ${exec.name} carried no string "sql" argument to classify.` }
    }
    const verdict = classifySql(sql)
    if (verdict.kind === 'read') return next()
    if (verdict.kind === 'empty') {
      return { kind: 'deny', reason: 'MYSQL_SQL_UNREADABLE: the "sql" argument held no statement.' }
    }
    if (verdict.kind === 'unsupported') {
      return {
        kind: 'deny',
        reason: `MYSQL_WRITE_AUTH_REQUIRED: "${verdict.keyword}" statements are not permitted through this bridge; `
          + 'only SELECT/SHOW/DESCRIBE/EXPLAIN reads and the six explicitly enabled write kinds may run.',
      }
    }
    if (config[verdict.setting] !== true) {
      return {
        kind: 'deny',
        reason: `MYSQL_WRITE_AUTH_REQUIRED: ${verdict.setting} is off, so this statement is disabled. `
          + 'Enable it in the profile configuration and set the matching environment variable.',
      }
    }
    if (exec.agent === undefined) {
      return { kind: 'deny', reason: `MYSQL_WRITE_AUTH_REQUIRED: ${exec.name} has no agent to route an approval through.` }
    }
    const outcome: ApprovalOutcome = await ctx.approval.request({
      agent: exec.agent,
      toolName: exec.name,
      callId: exec.callId,
      reason: safeSummary(exec),
      signal: exec.signal,
    })
    if (outcome !== 'allowed-once') {
      return { kind: 'deny', reason: `MYSQL_WRITE_AUTH_REQUIRED: approval outcome was ${outcome}.` }
    }
    return next()
  }, { prepend: true })
}

export default { name, inject, apply }
