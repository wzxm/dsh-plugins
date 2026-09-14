import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/write-switches.d.ts
/**
 * One permission the bridge can grant, and the settings field that grants it.
 *
 * Order is presentation order in the card and is deliberately
 * least-destructive first, so the two switches an operator should think twice
 * about sit at the bottom.
 */
declare const WRITE_SWITCHES: readonly [{
  readonly field: "allowInsert";
  readonly keyword: "INSERT";
  /** Statements this switch permits, for the card's hint text. */
  readonly statements: "INSERT / REPLACE / LOAD";
}, {
  readonly field: "allowUpdate";
  readonly keyword: "UPDATE";
  readonly statements: "UPDATE, and SELECT … FOR UPDATE";
}, {
  readonly field: "allowDelete";
  readonly keyword: "DELETE";
  readonly statements: "DELETE";
}, {
  readonly field: "allowAlter";
  readonly keyword: "ALTER";
  readonly statements: "ALTER / CREATE / RENAME";
}, {
  readonly field: "allowTruncate";
  readonly keyword: "TRUNCATE";
  readonly statements: "TRUNCATE";
}, {
  readonly field: "allowDrop";
  readonly keyword: "DROP";
  readonly statements: "DROP";
}];
/** One entry of {@link WRITE_SWITCHES}. */
type WriteSwitch = (typeof WRITE_SWITCHES)[number];
/** A settings field name that grants a write. */
type WriteSwitchField = WriteSwitch['field'];
/** The resolved switch values, keyed by field. */
type WriteSwitches = Record<WriteSwitchField, boolean>;
//#endregion
//#region src/index.d.ts
declare const name = "dsh-mysql";
/**
 * Only `tools` is required. `approval` and `settings` are both resolved with
 * `ctx.get` at the point of use: a hard dependency would keep `apply` from ever
 * running in a profile that composes neither, and the write gate would not be
 * installed at all.
 */
declare const inject: string[];
interface Config {
  /**
   * When false, every call in this server's namespace is denied. The gate stays
   * registered on purpose — see the module docblock.
   */
  enabled?: boolean;
  serverName?: string;
  /**
   * Composition-layer defaults for the six write switches, used when a settings
   * namespace is mounted and as the whole value when one is not. These are the
   * `base` layer: a stored `dsh-mysql` settings section (written from the
   * settings card) overrides them field by field.
   */
  allowInsert?: boolean;
  allowUpdate?: boolean;
  allowDelete?: boolean;
  allowAlter?: boolean;
  allowTruncate?: boolean;
  allowDrop?: boolean;
  /**
   * The database this bridge is scoped to. Empty means the upstream server runs
   * in multi-DB mode, where a write is allowed against ANY schema the account
   * can reach and the per-schema `SCHEMA_*_PERMISSIONS` list is the only
   * narrowing. Writes are therefore refused in that mode unless
   * {@link allowMultiDbWrites} is set.
   */
  database?: string;
  /**
   * Permit writes while no database is pinned (multi-DB mode). Off by default:
   * one global toggle would otherwise authorize writes across every reachable
   * schema, not just the intended one.
   */
  allowMultiDbWrites?: boolean;
}
declare const Config: z<Config>;
/**
 * The six write switches as a settings section.
 *
 * Deliberately narrower than {@link Config}: the settings card edits write
 * permission, not the connection target or the multi-DB escape hatch. Those
 * stay composition-only so that granting cross-schema writes remains a
 * deliberate edit of the profile rather than a switch in a form.
 */
declare const WriteSwitchesSchema: z<WriteSwitches>;
/** The `allow*` switches, keyed by the write they permit. */
type WriteSetting = WriteSwitchField;
/**
 * Split a SQL script into statements on top-level semicolons, with the bodies
 * of executable comments inlined as the SQL they carry.
 * @param sql - the script to split.
 * @returns each statement with surrounding whitespace and comments trimmed.
 */
declare function splitStatements(sql: string): string[];
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
declare function maskLiterals(statement: string): string;
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
declare function cteHead(masked: string): {
  verb: string;
  rest: string;
} | undefined;
/** What one SQL statement requires before it may run. */
type StatementVerdict = {
  kind: 'read';
} | {
  kind: 'write';
  setting: WriteSetting;
} | {
  kind: 'unsupported';
  keyword: string;
} |
/** `INTO OUTFILE` / `INTO DUMPFILE`: writes a file on the database host. */
{
  kind: 'file';
  keyword: string;
};
/** What one SQL payload requires before it may run. */
type SqlVerdict = StatementVerdict |
/** More than one statement was submitted; this bridge runs exactly one. */
{
  kind: 'multiple';
  count: number;
} | {
  kind: 'empty';
};
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
declare function classifySql(sql: string): SqlVerdict;
declare function apply(ctx: Context, config?: Config): void;
declare const _default: {
  name: string;
  inject: string[];
  apply: typeof apply;
};
//#endregion
export { Config, SqlVerdict, StatementVerdict, WriteSwitchesSchema, apply, classifySql, cteHead, _default as default, inject, maskLiterals, name, splitStatements };
//# sourceMappingURL=index.d.ts.map