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
 * ## Fail-closed rules this module owns
 *
 * - `enabled: false` denies every call in the server's namespace. It does NOT
 *   unregister the gate: unregistering would leave the MCP tools live with no
 *   policy at all, which is strictly worse than refusing them.
 * - The `approval` service is consumed optionally (`ctx.get`). A profile that
 *   composes no approval seam cannot approve anything, so every write is denied
 *   rather than silently permitted. Declaring it in `inject` would instead park
 *   this plugin in PENDING and never run `apply` — the gate would not exist.
 * - Executable comments (the `/*!` and `/*!50000` forms) carry SQL the server
 *   really runs, so their bodies are inlined before classification instead of
 *   being dropped as comments. Conditional code is treated as live.
 *
 * @module @wzxm/dsh-mysql
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-approval'
// Type-only: pulls the `ctx.settings` Context merge and the settings service type.
import type {} from '@deepseek-ai/dsh-settings'
import {
  readWriteSwitches, WRITE_SWITCHES_ALL_OFF, WRITE_SWITCH_NAMESPACE,
  type WriteSwitchField, type WriteSwitches,
} from './write-switches.ts'

export const name = 'dsh-mysql'

/**
 * Only `tools` is required. `approval` and `settings` are both resolved with
 * `ctx.get` at the point of use: a hard dependency would keep `apply` from ever
 * running in a profile that composes neither, and the write gate would not be
 * installed at all.
 */
export const inject = ['tools']

export interface Config {
  /**
   * When false, every call in this server's namespace is denied. The gate stays
   * registered on purpose — see the module docblock.
   */
  enabled?: boolean
  serverName?: string
  /**
   * Composition-layer defaults for the six write switches, used when a settings
   * namespace is mounted and as the whole value when one is not. These are the
   * `base` layer: a stored `dsh-mysql` settings section (written from the
   * settings card) overrides them field by field.
   */
  allowInsert?: boolean
  allowUpdate?: boolean
  allowDelete?: boolean
  allowAlter?: boolean
  allowTruncate?: boolean
  allowDrop?: boolean
  /**
   * The database this bridge is scoped to. Empty means the upstream server runs
   * in multi-DB mode, where a write is allowed against ANY schema the account
   * can reach and the per-schema `SCHEMA_*_PERMISSIONS` list is the only
   * narrowing. Writes are therefore refused in that mode unless
   * {@link allowMultiDbWrites} is set.
   */
  database?: string
  /**
   * Permit writes while no database is pinned (multi-DB mode). Off by default:
   * one global toggle would otherwise authorize writes across every reachable
   * schema, not just the intended one.
   */
  allowMultiDbWrites?: boolean
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
  database: z.string().default(''),
  allowMultiDbWrites: z.boolean().default(false),
})

/**
 * The six write switches as a settings section.
 *
 * Deliberately narrower than {@link Config}: the settings card edits write
 * permission, not the connection target or the multi-DB escape hatch. Those
 * stay composition-only so that granting cross-schema writes remains a
 * deliberate edit of the profile rather than a switch in a form.
 */
export const WriteSwitchesSchema: z<WriteSwitches> = z.object({
  allowInsert: z.boolean().default(false),
  allowUpdate: z.boolean().default(false),
  allowDelete: z.boolean().default(false),
  allowAlter: z.boolean().default(false),
  allowTruncate: z.boolean().default(false),
  allowDrop: z.boolean().default(false),
})

/** The `allow*` switches, keyed by the write they permit. */
type WriteSetting = WriteSwitchField

/** Leading keywords that are unambiguously reads and never need approval. */
const READ_KEYWORDS = new Set(['select', 'show', 'describe', 'desc', 'use', 'values', 'help'])

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
 *
 * `load` is deliberately absent: it reaches the table-writing `LOAD DATA`
 * forms, so it maps to `allowInsert` above.
 */
const UNSUPPORTED_WRITE_KEYWORDS = new Set([
  'call', 'do', 'execute', 'grant', 'revoke', 'kill', 'lock', 'unlock',
  'flush', 'reset', 'purge', 'install', 'uninstall', 'shutdown', 'set',
  'prepare', 'deallocate', 'savepoint', 'xa', 'analyze', 'optimize',
  'repair', 'check', 'checksum', 'handler', 'import',
])

/** How deeply executable comments may nest before their bodies are dropped. */
const MAX_EXEC_COMMENT_DEPTH = 8

/** Mutable accumulator for {@link scanSql}. */
interface ScanState {
  readonly statements: string[]
  current: string
}

/**
 * Append `sql` to `state`, dropping comments, inlining executable comments, and
 * splitting on top-level semicolons.
 *
 * String literals, quoted identifiers, and the bodies of ordinary comments are
 * copied through untouched so a `;` inside `'a;b'` or inside a comment never
 * splits a statement — mis-splitting would let a write hide behind a read's
 * keyword (`SELECT 1; -- x\nDROP TABLE t`).
 *
 * MySQL *executes* the body of a version comment (the `/*!` and `/*!50000`
 * forms), so those bodies are scanned as SQL rather than discarded; otherwise
 * `SELECT 1 /*!50000 INTO OUTFILE …` would present itself as a bare read.
 * @param sql - the script text to scan.
 * @param state - accumulator receiving finished statements.
 * @param depth - executable-comment nesting level, bounded by {@link MAX_EXEC_COMMENT_DEPTH}.
 */
function scanSql(sql: string, state: ScanState, depth = 0): void {
  let index = 0
  while (index < sql.length) {
    const char = sql[index] as string
    const next = sql[index + 1]

    if (char === '/' && next === '*' && sql[index + 2] === '!') {
      const end = sql.indexOf('*/', index + 3)
      const close = end === -1 ? sql.length : end
      // The optional 5–6 digit version gate (`/*!50000`) is part of the marker.
      const body = sql.slice(index + 3, close).replace(/^\d{5,6}/, '')
      // A space on each side keeps tokens from fusing across the removed marker.
      state.current += ' '
      if (depth < MAX_EXEC_COMMENT_DEPTH) scanSql(body, state, depth + 1)
      state.current += ' '
      index = end === -1 ? sql.length : end + 2
      continue
    }

    if (char === '/' && next === '*') {
      // An ordinary block comment, or a `/*+ … */` optimizer hint: MySQL never
      // executes a statement written inside one of these.
      const end = sql.indexOf('*/', index + 2)
      state.current += ' '
      index = end === -1 ? sql.length : end + 2
      continue
    }

    if (
      char === '-' && next === '-'
      // MySQL needs whitespace (or a control character, or end of input) after
      // `--` before it counts as a comment; `SELECT 1--2` is arithmetic.
      && (index + 2 >= sql.length || /[\s\u0000-\u001f]/.test(sql[index + 2] as string))
    ) {
      const end = sql.indexOf('\n', index)
      state.current += ' '
      index = end === -1 ? sql.length : end + 1
      continue
    }

    if (char === '#') {
      const end = sql.indexOf('\n', index)
      state.current += ' '
      index = end === -1 ? sql.length : end + 1
      continue
    }

    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      state.current += char
      index += 1
      while (index < sql.length) {
        const inner = sql[index] as string
        state.current += inner
        index += 1
        if (inner === '\\' && quote !== '`') {
          // A backslash escape consumes the next character, so `\'` stays inside.
          if (index < sql.length) state.current += sql[index] as string
          index += 1
          continue
        }
        if (inner !== quote) continue
        if (sql[index] === quote) {
          // A doubled quote is an escaped quote, not the end of the literal.
          state.current += sql[index] as string
          index += 1
          continue
        }
        break
      }
      continue
    }

    if (char === ';') {
      state.statements.push(state.current)
      state.current = ''
      index += 1
      continue
    }

    state.current += char
    index += 1
  }
}

/**
 * Split a SQL script into statements on top-level semicolons, with the bodies
 * of executable comments inlined as the SQL they carry.
 * @param sql - the script to split.
 * @returns each statement with surrounding whitespace and comments trimmed.
 */
export function splitStatements(sql: string): string[] {
  const state: ScanState = { statements: [], current: '' }
  scanSql(sql, state)
  state.statements.push(state.current)
  return state.statements
    .map(statement => statement.trim())
    .filter(statement => statement !== '')
}

/** Placeholder filling a masked quoted identifier; not a keyword character. */
const IDENTIFIER_FILL = '_'

/**
 * Blank out the *contents* of every string literal and quoted identifier in one
 * statement, preserving length so offsets still line up.
 *
 * Keyword scans must not read text the server treats as data: without this,
 * `SELECT 'insert'` and `` SELECT 1 FROM `delete` `` look like writes. String
 * literals become spaces; quoted identifiers become {@link IDENTIFIER_FILL}
 * runs, which keeps them recognizable as a single identifier token without ever
 * spelling a keyword.
 * @param statement - one statement, comments already removed.
 * @returns an equal-length copy safe to scan for keywords.
 */
export function maskLiterals(statement: string): string {
  let masked = ''
  let index = 0
  while (index < statement.length) {
    const char = statement[index] as string
    if (char !== "'" && char !== '"' && char !== '`') {
      masked += char
      index += 1
      continue
    }
    const quote = char
    const start = index
    index += 1
    while (index < statement.length) {
      const inner = statement[index] as string
      index += 1
      if (inner === '\\' && quote !== '`') {
        index += 1
        continue
      }
      if (inner !== quote) continue
      if (statement[index] === quote) {
        index += 1
        continue
      }
      break
    }
    const width = index - start
    masked += (quote === '`' ? IDENTIFIER_FILL : ' ').repeat(width)
  }
  return masked
}

/** Whether `char` may appear in a (possibly masked) MySQL identifier. */
function isIdentifierChar(char: string | undefined): boolean {
  return char !== undefined && /[0-9A-Za-z_$\u0080-\uffff]/.test(char)
}

/** The bare word starting at `index`, lowercased, or `''` when none starts there. */
function wordAt(masked: string, index: number): string {
  let end = index
  while (isIdentifierChar(masked[end])) end += 1
  return masked.slice(index, end).toLowerCase()
}

/** Advance past whitespace from `index`. */
function skipSpaces(masked: string, index: number): number {
  let cursor = index
  while (cursor < masked.length && /\s/.test(masked[cursor] as string)) cursor += 1
  return cursor
}

/**
 * Advance past one balanced `( … )` group starting at `index`.
 *
 * Literals are already masked, so parentheses inside strings or identifiers
 * cannot unbalance the count.
 * @param masked - the masked statement.
 * @param index - offset of the opening `(`.
 * @returns the offset just past the matching `)`, or `-1` when unbalanced.
 */
function skipBalanced(masked: string, index: number): number {
  let depth = 0
  let cursor = index
  while (cursor < masked.length) {
    const char = masked[cursor]
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return cursor + 1
    }
    cursor += 1
  }
  return -1
}

/**
 * The main verb of a `WITH` (CTE) statement, with the text that follows it.
 *
 * The verb — not any word appearing anywhere in the statement — decides the
 * required switch, so `WITH c AS (SELECT 1) DROP TABLE t` is a DROP and
 * `WITH c AS (SELECT 'insert') SELECT 1` is a plain read. The CTE bodies were
 * already masked, so `insert` inside one is invisible here.
 * @param masked - the masked statement, whose leading word is `with`.
 * @returns the lowercased main verb and its remainder, or `undefined` when the
 *   CTE header cannot be parsed.
 */
export function cteHead(masked: string): { verb: string; rest: string } | undefined {
  let cursor = skipSpaces(masked, wordAt(masked, 0) === 'with' ? 4 : 0)
  if (wordAt(masked, cursor) === 'recursive') cursor = skipSpaces(masked, cursor + 'recursive'.length)
  // Each iteration consumes one `name [(cols)] AS ( body )` definition.
  for (let guard = 0; guard < 512; guard += 1) {
    cursor = skipSpaces(masked, cursor)
    const name = wordAt(masked, cursor)
    if (name === '') return undefined
    cursor = skipSpaces(masked, cursor + name.length)
    if (masked[cursor] === '(') {
      const afterColumns = skipBalanced(masked, cursor)
      if (afterColumns === -1) return undefined
      cursor = skipSpaces(masked, afterColumns)
    }
    if (wordAt(masked, cursor) !== 'as') return undefined
    cursor = skipSpaces(masked, cursor + 2)
    if (masked[cursor] !== '(') return undefined
    const afterBody = skipBalanced(masked, cursor)
    if (afterBody === -1) return undefined
    cursor = skipSpaces(masked, afterBody)
    if (masked[cursor] !== ',') return { verb: wordAt(masked, cursor), rest: masked.slice(cursor) }
    cursor += 1
  }
  return undefined
}

/**
 * Strip an `EXPLAIN` clause from a masked statement.
 *
 * `EXPLAIN ANALYZE INSERT …` really executes the INSERT, and plain
 * `EXPLAIN INSERT …` is still a statement about a write, so the remainder is
 * classified on its own. `EXPLAIN FOR CONNECTION n` inspects a running session
 * and has no statement to classify.
 * @param masked - the masked statement, whose leading word is `explain`.
 * @returns the masked remainder, or `''` when nothing executable follows.
 */
function stripExplainPrefix(masked: string): string {
  // Locate the keyword rather than assuming offset 0, so leading whitespace
  // cannot shift the slice.
  let cursor = skipSpaces(masked, 0)
  if (wordAt(masked, cursor) !== 'explain') return ''
  cursor = skipSpaces(masked, cursor + 'explain'.length)
  for (let guard = 0; guard < 16; guard += 1) {
    const word = wordAt(masked, cursor)
    if (word === 'analyze' || word === 'extended' || word === 'partitions') {
      cursor = skipSpaces(masked, cursor + word.length)
      continue
    }
    if (word === 'format') {
      cursor = skipSpaces(masked, cursor + word.length)
      if (masked[cursor] === '=') cursor += 1
      cursor = skipSpaces(masked, cursor)
      const format = wordAt(masked, cursor)
      if (format === '') return ''
      cursor = skipSpaces(masked, cursor + format.length)
      continue
    }
    if (word === 'for') return ''
    break
  }
  return masked.slice(cursor)
}

/** What one SQL statement requires before it may run. */
export type StatementVerdict =
  | { kind: 'read' }
  | { kind: 'write'; setting: WriteSetting }
  | { kind: 'unsupported'; keyword: string }
  /** `INTO OUTFILE` / `INTO DUMPFILE`: writes a file on the database host. */
  | { kind: 'file'; keyword: string }

/** What one SQL payload requires before it may run. */
export type SqlVerdict =
  | StatementVerdict
  /** More than one statement was submitted; this bridge runs exactly one. */
  | { kind: 'multiple'; count: number }
  | { kind: 'empty' }

/**
 * Classify one already-split statement.
 * @param masked - the statement's masked text.
 * @returns the approval requirement the statement carries.
 */
function classifyMasked(masked: string): StatementVerdict {
  const keyword = wordAt(masked, skipSpaces(masked, 0))

  if (keyword === 'explain') {
    const remainder = stripExplainPrefix(masked)
    if (remainder.trim() === '') return { kind: 'read' }
    return classifyMasked(remainder)
  }

  if (keyword === 'with') {
    const head = cteHead(masked)
    // An unparsable CTE header is not proven to be a read.
    if (head === undefined || head.verb === '') return { kind: 'unsupported', keyword: 'with' }
    return classifyMasked(head.rest)
  }

  if (keyword === 'select') {
    // A server-side file write has no toggle of its own and is never allowed.
    if (/\binto\s+(?:outfile|dumpfile)\b/i.test(masked)) {
      return { kind: 'file', keyword: 'select … into outfile' }
    }
    // A locking read needs write capability and takes write locks.
    if (/\bfor\s+update\b/i.test(masked) || /\block\s+in\s+share\s+mode\b/i.test(masked)) {
      return { kind: 'write', setting: 'allowUpdate' }
    }
    return { kind: 'read' }
  }

  if (READ_KEYWORDS.has(keyword)) return { kind: 'read' }

  const setting = WRITE_KEYWORDS.get(keyword)
  if (setting !== undefined) return { kind: 'write', setting }

  if (UNSUPPORTED_WRITE_KEYWORDS.has(keyword)) return { kind: 'unsupported', keyword }

  // An unknown leading keyword is not proven to be a read.
  return { kind: 'unsupported', keyword: keyword === '' ? '(unparsable)' : keyword }
}

/**
 * Classify one submitted SQL script.
 *
 * A script must hold exactly one statement. MySQL's driver already rejects
 * multi-statement payloads, and judging several statements by one verdict would
 * mean one switch silently authorizing the others, so a multi-statement script
 * is refused with a message that says what to do instead.
 * @param sql - the script from the tool call's `sql` argument.
 * @returns the approval requirement the script carries.
 */
export function classifySql(sql: string): SqlVerdict {
  const statements = splitStatements(sql)
  if (statements.length === 0) return { kind: 'empty' }
  if (statements.length > 1) return { kind: 'multiple', count: statements.length }
  return classifyMasked(maskLiterals(statements[0] as string))
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
  const prefix = `mcp__${config.serverName ?? 'mysql'}__`
  /** Set once the no-approval warning has been logged, so it is not repeated per call. */
  let warnedNoApproval = false

  // The authoritative write switches. Without a settings provider this stays the
  // composition entry, so a profile that never mounts settings behaves exactly
  // as before. `installSection` swaps in the resolved section while a provider
  // is attached and swaps back if it detaches.
  const entrySwitches: WriteSwitches = readWriteSwitches(config)
  let switches: WriteSwitches = entrySwitches
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(
      ctx,
      WRITE_SWITCH_NAMESPACE,
      WriteSwitchesSchema,
      entrySwitches,
      {
        setSource: (current) => { switches = readWriteSwitches(current()) },
        // The gate reads `switches` at each call, so nothing derived needs
        // rebuilding when the document changes.
        onChange: () => {},
      },
    )
  })

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (!exec.name.startsWith(prefix)) return next()

    if (config.enabled === false) {
      return {
        kind: 'deny',
        reason: 'MYSQL_BRIDGE_DISABLED: this MySQL bridge is switched off (enabled: false), '
          + 'so no statement runs through it. Remove the plugin rows instead if the tools should be gone entirely.',
      }
    }

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
    if (verdict.kind === 'multiple') {
      return {
        kind: 'deny',
        reason: `MYSQL_MULTI_STATEMENT: ${verdict.count} statements were submitted, and this bridge runs exactly one per call. `
          + 'Submit them one at a time so each carries its own authorization decision.',
      }
    }
    if (verdict.kind === 'unsupported') {
      return {
        kind: 'deny',
        reason: `MYSQL_WRITE_AUTH_REQUIRED: "${verdict.keyword}" statements are not permitted through this bridge; `
          + 'only SELECT/SHOW/DESCRIBE/EXPLAIN reads and the six explicitly enabled write kinds may run.',
      }
    }
    if (verdict.kind === 'file') {
      return {
        kind: 'deny',
        reason: `MYSQL_FILE_WRITE_DENIED: ${verdict.keyword} writes a file on the database host. `
          + 'That capability has no enable switch here; use a direct database client instead.',
      }
    }
    if (switches[verdict.setting] !== true) {
      return {
        kind: 'deny',
        reason: `MYSQL_WRITE_AUTH_REQUIRED: ${verdict.setting} is off, so this statement is disabled. `
          + 'Enable it in the profile configuration or in the MySQL settings card.',
      }
    }
    // No database pinned means the upstream server resolves the target from the
    // statement itself, so this one switch would authorize the write against any
    // schema the account reaches. Require an explicit opt-in for that.
    if ((config.database ?? '') === '' && config.allowMultiDbWrites !== true) {
      return {
        kind: 'deny',
        reason: 'MYSQL_MULTI_DB_WRITE_DENIED: no database is pinned (MYSQL_DB is empty), so the target schema is '
          + `taken from the statement and ${verdict.setting} would allow this write against any reachable schema. `
          + 'Pin DSH_MYSQL_DATABASE, or set allowMultiDbWrites with SCHEMA_*_PERMISSIONS to narrow it deliberately.',
      }
    }
    if (exec.agent === undefined) {
      return { kind: 'deny', reason: `MYSQL_WRITE_AUTH_REQUIRED: ${exec.name} has no agent to route an approval through.` }
    }
    // Optional on purpose: a profile without an approval seam must refuse the
    // write, not proceed ungated, and must not keep this plugin from loading.
    const approval = ctx.get('approval')
    if (approval === undefined) {
      if (!warnedNoApproval) {
        warnedNoApproval = true
        ctx.logger('dsh-mysql').warn(
          'no approval service is mounted, so every enabled MySQL write will be denied; '
          + 'compose @deepseek-ai/dsh-user-approval (or disable the write toggles) to allow them',
        )
      }
      return {
        kind: 'deny',
        reason: 'MYSQL_WRITE_AUTH_REQUIRED: no approval channel is available in this profile, so the write is refused. '
          + 'Compose an approval service or turn the write toggle off.',
      }
    }
    const outcome: ApprovalOutcome = await approval.request({
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
