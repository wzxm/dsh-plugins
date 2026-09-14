import z from "@deepseek-ai/schemastery";
//#region src/write-switches.ts
/**
* The write-switch vocabulary shared by the host gate and the browser card.
*
* Both halves must agree on the namespace, the field names, and their labels
* without importing each other: the browser bundle is built with a purity gate
* that forbids cross-plugin value imports, so the two sides meet only through
* this file's *data*, duplicated by their own builds.
*
* @module dsh-mysql/write-switches
*/
/** The settings namespace holding this bridge's write switches. */
const WRITE_SWITCH_NAMESPACE = "dsh-mysql";
[
	{
		field: "allowInsert",
		keyword: "INSERT",
		environment: "DSH_MYSQL_ALLOW_INSERT",
		/** Statements this switch permits, for the card's hint text. */
		statements: "INSERT / REPLACE / LOAD"
	},
	{
		field: "allowUpdate",
		keyword: "UPDATE",
		environment: "DSH_MYSQL_ALLOW_UPDATE",
		statements: "UPDATE, and SELECT … FOR UPDATE"
	},
	{
		field: "allowDelete",
		keyword: "DELETE",
		environment: "DSH_MYSQL_ALLOW_DELETE",
		statements: "DELETE"
	},
	{
		field: "allowAlter",
		keyword: "ALTER",
		environment: "DSH_MYSQL_ALLOW_ALTER",
		statements: "ALTER / CREATE / RENAME"
	},
	{
		field: "allowTruncate",
		keyword: "TRUNCATE",
		environment: "DSH_MYSQL_ALLOW_TRUNCATE",
		statements: "TRUNCATE"
	},
	{
		field: "allowDrop",
		keyword: "DROP",
		environment: "DSH_MYSQL_ALLOW_DROP",
		statements: "DROP"
	}
].map((s) => s.field);
/**
* Narrow an untrusted section to the switch values, treating anything that is
* not literally `true` as off.
*
* The gate must never read a truthy-but-not-boolean value as permission: a
* stored `"false"` string or a `1` from a hand-edited document would otherwise
* enable a write the operator meant to disable.
* @param section - the resolved section, from settings or from entry config.
* @returns the six switches, each strictly boolean.
*/
function readWriteSwitches(section) {
	const read = (field) => section?.[field] === true;
	return {
		allowInsert: read("allowInsert"),
		allowUpdate: read("allowUpdate"),
		allowDelete: read("allowDelete"),
		allowAlter: read("allowAlter"),
		allowTruncate: read("allowTruncate"),
		allowDrop: read("allowDrop")
	};
}
//#endregion
//#region src/index.ts
const name = "dsh-mysql";
/**
* Only `tools` is required. `approval` and `settings` are both resolved with
* `ctx.get` at the point of use: a hard dependency would keep `apply` from ever
* running in a profile that composes neither, and the write gate would not be
* installed at all.
*/
const inject = ["tools"];
const Config = z.object({
	enabled: z.boolean().default(true),
	serverName: z.string().default("mysql"),
	allowInsert: z.boolean().default(false),
	allowUpdate: z.boolean().default(false),
	allowDelete: z.boolean().default(false),
	allowAlter: z.boolean().default(false),
	allowTruncate: z.boolean().default(false),
	allowDrop: z.boolean().default(false),
	database: z.string().default(""),
	allowMultiDbWrites: z.boolean().default(false)
});
/**
* The six write switches as a settings section.
*
* Deliberately narrower than {@link Config}: the settings card edits write
* permission, not the connection target or the multi-DB escape hatch. Those
* stay composition-only so that granting cross-schema writes remains a
* deliberate edit of the profile rather than a switch in a form.
*/
const WriteSwitchesSchema = z.object({
	allowInsert: z.boolean().default(false),
	allowUpdate: z.boolean().default(false),
	allowDelete: z.boolean().default(false),
	allowAlter: z.boolean().default(false),
	allowTruncate: z.boolean().default(false),
	allowDrop: z.boolean().default(false)
});
/** Leading keywords that are unambiguously reads and never need approval. */
const READ_KEYWORDS = /* @__PURE__ */ new Set([
	"select",
	"show",
	"describe",
	"desc",
	"use",
	"values",
	"help"
]);
/** Leading keywords mapped to the switch that permits them. */
const WRITE_KEYWORDS = /* @__PURE__ */ new Map([
	["insert", "allowInsert"],
	["replace", "allowInsert"],
	["load", "allowInsert"],
	["update", "allowUpdate"],
	["delete", "allowDelete"],
	["alter", "allowAlter"],
	["create", "allowAlter"],
	["rename", "allowAlter"],
	["truncate", "allowTruncate"],
	["drop", "allowDrop"]
]);
/**
* Remaining statement-leading keywords that write or change state but have no
* dedicated switch. They are denied outright, so an operator cannot turn them
* on by enabling one of the six named toggles.
*
* `load` is deliberately absent: it reaches the table-writing `LOAD DATA`
* forms, so it maps to `allowInsert` above.
*/
const UNSUPPORTED_WRITE_KEYWORDS = /* @__PURE__ */ new Set([
	"call",
	"do",
	"execute",
	"grant",
	"revoke",
	"kill",
	"lock",
	"unlock",
	"flush",
	"reset",
	"purge",
	"install",
	"uninstall",
	"shutdown",
	"set",
	"prepare",
	"deallocate",
	"savepoint",
	"xa",
	"analyze",
	"optimize",
	"repair",
	"check",
	"checksum",
	"handler",
	"import"
]);
/** How deeply executable comments may nest before their bodies are dropped. */
const MAX_EXEC_COMMENT_DEPTH = 8;
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
function scanSql(sql, state, depth = 0) {
	let index = 0;
	while (index < sql.length) {
		const char = sql[index];
		const next = sql[index + 1];
		if (char === "/" && next === "*" && sql[index + 2] === "!") {
			const end = sql.indexOf("*/", index + 3);
			const close = end === -1 ? sql.length : end;
			const body = sql.slice(index + 3, close).replace(/^\d{5,6}/, "");
			state.current += " ";
			if (depth < MAX_EXEC_COMMENT_DEPTH) scanSql(body, state, depth + 1);
			state.current += " ";
			index = end === -1 ? sql.length : end + 2;
			continue;
		}
		if (char === "/" && next === "*") {
			const end = sql.indexOf("*/", index + 2);
			state.current += " ";
			index = end === -1 ? sql.length : end + 2;
			continue;
		}
		if (char === "-" && next === "-" && (index + 2 >= sql.length || /[\s\u0000-\u001f]/.test(sql[index + 2]))) {
			const end = sql.indexOf("\n", index);
			state.current += " ";
			index = end === -1 ? sql.length : end + 1;
			continue;
		}
		if (char === "#") {
			const end = sql.indexOf("\n", index);
			state.current += " ";
			index = end === -1 ? sql.length : end + 1;
			continue;
		}
		if (char === "'" || char === "\"" || char === "`") {
			const quote = char;
			state.current += char;
			index += 1;
			while (index < sql.length) {
				const inner = sql[index];
				state.current += inner;
				index += 1;
				if (inner === "\\" && quote !== "`") {
					if (index < sql.length) state.current += sql[index];
					index += 1;
					continue;
				}
				if (inner !== quote) continue;
				if (sql[index] === quote) {
					state.current += sql[index];
					index += 1;
					continue;
				}
				break;
			}
			continue;
		}
		if (char === ";") {
			state.statements.push(state.current);
			state.current = "";
			index += 1;
			continue;
		}
		state.current += char;
		index += 1;
	}
}
/**
* Split a SQL script into statements on top-level semicolons, with the bodies
* of executable comments inlined as the SQL they carry.
* @param sql - the script to split.
* @returns each statement with surrounding whitespace and comments trimmed.
*/
function splitStatements(sql) {
	const state = {
		statements: [],
		current: ""
	};
	scanSql(sql, state);
	state.statements.push(state.current);
	return state.statements.map((statement) => statement.trim()).filter((statement) => statement !== "");
}
/** Placeholder filling a masked quoted identifier; not a keyword character. */
const IDENTIFIER_FILL = "_";
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
function maskLiterals(statement) {
	let masked = "";
	let index = 0;
	while (index < statement.length) {
		const char = statement[index];
		if (char !== "'" && char !== "\"" && char !== "`") {
			masked += char;
			index += 1;
			continue;
		}
		const quote = char;
		const start = index;
		index += 1;
		while (index < statement.length) {
			const inner = statement[index];
			index += 1;
			if (inner === "\\" && quote !== "`") {
				index += 1;
				continue;
			}
			if (inner !== quote) continue;
			if (statement[index] === quote) {
				index += 1;
				continue;
			}
			break;
		}
		const width = index - start;
		masked += (quote === "`" ? IDENTIFIER_FILL : " ").repeat(width);
	}
	return masked;
}
/** Whether `char` may appear in a (possibly masked) MySQL identifier. */
function isIdentifierChar(char) {
	return char !== void 0 && /[0-9A-Za-z_$\u0080-\uffff]/.test(char);
}
/** The bare word starting at `index`, lowercased, or `''` when none starts there. */
function wordAt(masked, index) {
	let end = index;
	while (isIdentifierChar(masked[end])) end += 1;
	return masked.slice(index, end).toLowerCase();
}
/** Advance past whitespace from `index`. */
function skipSpaces(masked, index) {
	let cursor = index;
	while (cursor < masked.length && /\s/.test(masked[cursor])) cursor += 1;
	return cursor;
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
function skipBalanced(masked, index) {
	let depth = 0;
	let cursor = index;
	while (cursor < masked.length) {
		const char = masked[cursor];
		if (char === "(") depth += 1;
		else if (char === ")") {
			depth -= 1;
			if (depth === 0) return cursor + 1;
		}
		cursor += 1;
	}
	return -1;
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
function cteHead(masked) {
	let cursor = skipSpaces(masked, wordAt(masked, 0) === "with" ? 4 : 0);
	if (wordAt(masked, cursor) === "recursive") cursor = skipSpaces(masked, cursor + 9);
	for (let guard = 0; guard < 512; guard += 1) {
		cursor = skipSpaces(masked, cursor);
		const name = wordAt(masked, cursor);
		if (name === "") return void 0;
		cursor = skipSpaces(masked, cursor + name.length);
		if (masked[cursor] === "(") {
			const afterColumns = skipBalanced(masked, cursor);
			if (afterColumns === -1) return void 0;
			cursor = skipSpaces(masked, afterColumns);
		}
		if (wordAt(masked, cursor) !== "as") return void 0;
		cursor = skipSpaces(masked, cursor + 2);
		if (masked[cursor] !== "(") return void 0;
		const afterBody = skipBalanced(masked, cursor);
		if (afterBody === -1) return void 0;
		cursor = skipSpaces(masked, afterBody);
		if (masked[cursor] !== ",") return {
			verb: wordAt(masked, cursor),
			rest: masked.slice(cursor)
		};
		cursor += 1;
	}
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
function stripExplainPrefix(masked) {
	let cursor = skipSpaces(masked, 0);
	if (wordAt(masked, cursor) !== "explain") return "";
	cursor = skipSpaces(masked, cursor + 7);
	for (let guard = 0; guard < 16; guard += 1) {
		const word = wordAt(masked, cursor);
		if (word === "analyze" || word === "extended" || word === "partitions") {
			cursor = skipSpaces(masked, cursor + word.length);
			continue;
		}
		if (word === "format") {
			cursor = skipSpaces(masked, cursor + word.length);
			if (masked[cursor] === "=") cursor += 1;
			cursor = skipSpaces(masked, cursor);
			const format = wordAt(masked, cursor);
			if (format === "") return "";
			cursor = skipSpaces(masked, cursor + format.length);
			continue;
		}
		if (word === "for") return "";
		break;
	}
	return masked.slice(cursor);
}
/**
* Classify one already-split statement.
* @param masked - the statement's masked text.
* @returns the approval requirement the statement carries.
*/
function classifyMasked(masked) {
	const keyword = wordAt(masked, skipSpaces(masked, 0));
	if (keyword === "explain") {
		const remainder = stripExplainPrefix(masked);
		if (remainder.trim() === "") return { kind: "read" };
		return classifyMasked(remainder);
	}
	if (keyword === "with") {
		const head = cteHead(masked);
		if (head === void 0 || head.verb === "") return {
			kind: "unsupported",
			keyword: "with"
		};
		return classifyMasked(head.rest);
	}
	if (keyword === "select") {
		if (/\binto\s+(?:outfile|dumpfile)\b/i.test(masked)) return {
			kind: "file",
			keyword: "select … into outfile"
		};
		if (/\bfor\s+update\b/i.test(masked) || /\block\s+in\s+share\s+mode\b/i.test(masked)) return {
			kind: "write",
			setting: "allowUpdate"
		};
		return { kind: "read" };
	}
	if (READ_KEYWORDS.has(keyword)) return { kind: "read" };
	const setting = WRITE_KEYWORDS.get(keyword);
	if (setting !== void 0) return {
		kind: "write",
		setting
	};
	if (UNSUPPORTED_WRITE_KEYWORDS.has(keyword)) return {
		kind: "unsupported",
		keyword
	};
	return {
		kind: "unsupported",
		keyword: keyword === "" ? "(unparsable)" : keyword
	};
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
function classifySql(sql) {
	const statements = splitStatements(sql);
	if (statements.length === 0) return { kind: "empty" };
	if (statements.length > 1) return {
		kind: "multiple",
		count: statements.length
	};
	return classifyMasked(maskLiterals(statements[0]));
}
/** The `sql` argument of a call, when the call carries one. */
function sqlArgument(exec) {
	const args = exec.arguments;
	if (typeof args !== "object" || args === null) return void 0;
	const sql = args.sql;
	return typeof sql === "string" ? sql : void 0;
}
/** A short, credential-free description of the pending call for the approval prompt. */
function safeSummary(exec) {
	let rendered;
	try {
		rendered = JSON.stringify(exec.arguments) ?? String(exec.arguments);
	} catch {
		rendered = "(unserializable arguments)";
	}
	return `MySQL statement via ${exec.name}: ${rendered.slice(0, 4e3)}`;
}
function apply(ctx, config = {}) {
	const prefix = `mcp__${config.serverName ?? "mysql"}__`;
	/** Set once the no-approval warning has been logged, so it is not repeated per call. */
	let warnedNoApproval = false;
	const entrySwitches = readWriteSwitches(config);
	let switches = entrySwitches;
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.installSection(ctx, WRITE_SWITCH_NAMESPACE, WriteSwitchesSchema, entrySwitches, {
			setSource: (current) => {
				switches = readWriteSwitches(current());
			},
			onChange: () => {}
		});
	});
	ctx.on("tools/pre-execute", async (exec, next) => {
		if (!exec.name.startsWith(prefix)) return next();
		if (config.enabled === false) return {
			kind: "deny",
			reason: "MYSQL_BRIDGE_DISABLED: this MySQL bridge is switched off (enabled: false), so no statement runs through it. Remove the plugin rows instead if the tools should be gone entirely."
		};
		const sql = sqlArgument(exec);
		if (sql === void 0) return {
			kind: "deny",
			reason: `MYSQL_SQL_UNREADABLE: ${exec.name} carried no string "sql" argument to classify.`
		};
		const verdict = classifySql(sql);
		if (verdict.kind === "read") return next();
		if (verdict.kind === "empty") return {
			kind: "deny",
			reason: "MYSQL_SQL_UNREADABLE: the \"sql\" argument held no statement."
		};
		if (verdict.kind === "multiple") return {
			kind: "deny",
			reason: `MYSQL_MULTI_STATEMENT: ${verdict.count} statements were submitted, and this bridge runs exactly one per call. Submit them one at a time so each carries its own authorization decision.`
		};
		if (verdict.kind === "unsupported") return {
			kind: "deny",
			reason: `MYSQL_WRITE_AUTH_REQUIRED: "${verdict.keyword}" statements are not permitted through this bridge; only SELECT/SHOW/DESCRIBE/EXPLAIN reads and the six explicitly enabled write kinds may run.`
		};
		if (verdict.kind === "file") return {
			kind: "deny",
			reason: `MYSQL_FILE_WRITE_DENIED: ${verdict.keyword} writes a file on the database host. That capability has no enable switch here; use a direct database client instead.`
		};
		if (switches[verdict.setting] !== true) return {
			kind: "deny",
			reason: `MYSQL_WRITE_AUTH_REQUIRED: ${verdict.setting} is off, so this statement is disabled. Enable it in the profile configuration or in the MySQL settings card.`
		};
		if ((config.database ?? "") === "" && config.allowMultiDbWrites !== true) return {
			kind: "deny",
			reason: `MYSQL_MULTI_DB_WRITE_DENIED: no database is pinned (MYSQL_DB is empty), so the target schema is taken from the statement and ${verdict.setting} would allow this write against any reachable schema. Pin DSH_MYSQL_DATABASE, or set allowMultiDbWrites with SCHEMA_*_PERMISSIONS to narrow it deliberately.`
		};
		if (exec.agent === void 0) return {
			kind: "deny",
			reason: `MYSQL_WRITE_AUTH_REQUIRED: ${exec.name} has no agent to route an approval through.`
		};
		const approval = ctx.get("approval");
		if (approval === void 0) {
			if (!warnedNoApproval) {
				warnedNoApproval = true;
				ctx.logger("dsh-mysql").warn("no approval service is mounted, so every enabled MySQL write will be denied; compose @deepseek-ai/dsh-user-approval (or disable the write toggles) to allow them");
			}
			return {
				kind: "deny",
				reason: "MYSQL_WRITE_AUTH_REQUIRED: no approval channel is available in this profile, so the write is refused. Compose an approval service or turn the write toggle off."
			};
		}
		const outcome = await approval.request({
			agent: exec.agent,
			toolName: exec.name,
			callId: exec.callId,
			reason: safeSummary(exec),
			signal: exec.signal
		});
		if (outcome !== "allowed-once") return {
			kind: "deny",
			reason: `MYSQL_WRITE_AUTH_REQUIRED: approval outcome was ${outcome}.`
		};
		return next();
	}, { prepend: true });
}
var src_default = {
	name,
	inject,
	apply
};
//#endregion
export { Config, WriteSwitchesSchema, apply, classifySql, cteHead, src_default as default, inject, maskLiterals, name, splitStatements };

//# sourceMappingURL=index.js.map