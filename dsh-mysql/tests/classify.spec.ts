/**
 * Classifier regression tests.
 *
 * Each group pins one authorization property this bridge must keep: a write
 * cannot reach the server as a read, a switch cannot authorize a write it does
 * not name, and a statement the classifier cannot prove is a read is refused.
 *
 * @module tests/classify
 */

import { describe, expect, it } from 'vitest'
import { classifySql, cteHead, maskLiterals, splitStatements } from '../src/index.ts'

/** The verdict kinds and settings in a compact, diffable form. */
function verdict(sql: string): unknown {
  const result = classifySql(sql)
  return result.kind === 'write' ? { kind: 'write', setting: result.setting } : result
}

describe('read classification', () => {
  it.each([
    'SELECT 1',
    'select * from t',
    'SHOW TABLES',
    'DESCRIBE t',
    'DESC t',
    'EXPLAIN SELECT 1',
    'USE app',
    'VALUES ROW(1)',
    'HELP SELECT',
  ])('treats %s as a read', (sql) => {
    expect(verdict(sql)).toEqual({ kind: 'read' })
  })

  it('ignores keywords that appear only inside literals', () => {
    // A keyword scan over the raw text would call every one of these a write.
    expect(verdict("SELECT 'insert' AS op")).toEqual({ kind: 'read' })
    expect(verdict('SELECT 1 FROM `delete`')).toEqual({ kind: 'read' })
    expect(verdict("SELECT * FROM t WHERE a = 'drop table x'")).toEqual({ kind: 'read' })
    expect(verdict('SELECT "update"')).toEqual({ kind: 'read' })
  })

  it('reads a semicolon inside a literal as data, not a statement break', () => {
    expect(splitStatements("SELECT '; DROP TABLE t'")).toHaveLength(1)
    expect(verdict("SELECT '; DROP TABLE t'")).toEqual({ kind: 'read' })
  })
})

describe('write classification', () => {
  it.each([
    ['INSERT INTO t VALUES (1)', 'allowInsert'],
    ['REPLACE INTO t VALUES (1)', 'allowInsert'],
    ["LOAD DATA INFILE '/tmp/f' INTO TABLE t", 'allowInsert'],
    ['UPDATE t SET a = 1', 'allowUpdate'],
    ['DELETE FROM t', 'allowDelete'],
    ['ALTER TABLE t ADD c INT', 'allowAlter'],
    ['CREATE TABLE t2 (a INT)', 'allowAlter'],
    ['RENAME TABLE a TO b', 'allowAlter'],
    ['TRUNCATE TABLE t', 'allowTruncate'],
    ['DROP TABLE t', 'allowDrop'],
  ])('maps %s to %s', (sql, setting) => {
    expect(verdict(sql)).toEqual({ kind: 'write', setting })
  })

  it('requires write authorization for a locking read', () => {
    expect(verdict('SELECT * FROM t FOR UPDATE')).toEqual({ kind: 'write', setting: 'allowUpdate' })
    expect(verdict('SELECT * FROM t LOCK IN SHARE MODE')).toEqual({ kind: 'write', setting: 'allowUpdate' })
  })
})

describe('executable comments', () => {
  // MySQL runs the body of `/*! … */`; dropping it let a write present as a read.
  it('classifies SQL hidden in a version comment', () => {
    expect(verdict('SELECT 1 /*!50000 INTO OUTFILE \'/tmp/x\' */')).toEqual({
      kind: 'file',
      keyword: 'select … into outfile',
    })
    expect(verdict('/*!50000 DROP TABLE users */')).toEqual({ kind: 'write', setting: 'allowDrop' })
  })

  it('classifies a version comment appended to a real statement', () => {
    expect(verdict('SELECT 1; /*!50000 DROP TABLE users */')).toEqual({ kind: 'multiple', count: 2 })
  })

  it('still ignores an ordinary block comment', () => {
    // A DROP written inside an ordinary comment is never executed, so a read
    // carrying it stays a read.
    expect(verdict('SELECT 1 /* DROP TABLE users */')).toEqual({ kind: 'read' })
    expect(verdict('/* DROP TABLE users */ SELECT 1')).toEqual({ kind: 'read' })
  })

  it('does not treat an optimizer hint as executable', () => {
    expect(verdict('SELECT /*+ MAX_EXECUTION_TIME(1000) */ 1')).toEqual({ kind: 'read' })
  })
})

describe('comment lexing', () => {
  it('treats `--` without trailing whitespace as arithmetic, like MySQL', () => {
    // MySQL evaluates `SELECT 1--2` as 3; only `-- ` (or a control character)
    // opens a comment.
    expect(splitStatements('SELECT 1--2')).toEqual(['SELECT 1--2'])
    expect(verdict('SELECT 1--2')).toEqual({ kind: 'read' })
  })

  it('treats `-- ` with trailing whitespace as a comment', () => {
    expect(splitStatements('SELECT 1-- DROP TABLE t')).toEqual(['SELECT 1'])
  })

  it('keeps a statement after a line-comment newline', () => {
    expect(verdict('SELECT 1; -- x\nDROP TABLE t')).toEqual({ kind: 'multiple', count: 2 })
    expect(verdict('SELECT 1 #x\n; DROP TABLE t')).toEqual({ kind: 'multiple', count: 2 })
  })
})

describe('CTE (WITH) classification', () => {
  it('classifies by the main verb, not by any word in the statement', () => {
    expect(verdict('WITH c AS (SELECT 1) DELETE FROM t')).toEqual({ kind: 'write', setting: 'allowDelete' })
    expect(verdict('WITH c AS (SELECT 1) DROP TABLE t')).toEqual({ kind: 'write', setting: 'allowDrop' })
    expect(verdict('WITH c AS (SELECT 1) TRUNCATE TABLE t')).toEqual({ kind: 'write', setting: 'allowTruncate' })
    expect(verdict('WITH c AS (SELECT 1) ALTER TABLE t ADD c INT')).toEqual({ kind: 'write', setting: 'allowAlter' })
    expect(verdict('WITH c AS (SELECT 1) CREATE TABLE t2 (a INT)')).toEqual({ kind: 'write', setting: 'allowAlter' })
    expect(verdict('WITH c AS (SELECT 1) UPDATE t SET a = 1')).toEqual({ kind: 'write', setting: 'allowUpdate' })
    expect(verdict('WITH c AS (SELECT 1) INSERT INTO t VALUES (1)')).toEqual({ kind: 'write', setting: 'allowInsert' })
  })

  it('does not let a CTE label pick the switch', () => {
    // Previously the first write keyword anywhere in the text won, so a label
    // chose the toggle: `SELECT 'insert'` authorized a DROP.
    expect(verdict("WITH c AS (SELECT 'insert') DROP TABLE t")).toEqual({ kind: 'write', setting: 'allowDrop' })
    expect(verdict("WITH c AS (SELECT 'update') ALTER TABLE t ADD c INT")).toEqual({ kind: 'write', setting: 'allowAlter' })
    expect(verdict('WITH c AS (SELECT 1 FROM `insert`) DELETE FROM t')).toEqual({ kind: 'write', setting: 'allowDelete' })
  })

  it('accepts a read CTE whose body mentions a write keyword as a string', () => {
    expect(verdict("WITH c AS (SELECT 'delete' AS label) SELECT * FROM c")).toEqual({ kind: 'read' })
    expect(verdict('WITH c AS (SELECT 1) SELECT 1')).toEqual({ kind: 'read' })
  })

  it('parses multiple and column-listed CTE definitions', () => {
    expect(verdict('WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a')).toEqual({ kind: 'read' })
    expect(verdict('WITH a (x) AS (SELECT 1) DELETE FROM t')).toEqual({ kind: 'write', setting: 'allowDelete' })
    expect(verdict('WITH RECURSIVE a AS (SELECT 1) SELECT 1')).toEqual({ kind: 'read' })
  })

  it('does not mistake a paren inside a CTE body for the header end', () => {
    expect(verdict("WITH a AS (SELECT replace('(', ')')) DELETE FROM t")).toEqual({
      kind: 'write',
      setting: 'allowDelete',
    })
  })

  it('denies a CTE whose header cannot be parsed', () => {
    expect(cteHead('with')).toBeUndefined()
    expect(verdict('WITH')).toEqual({ kind: 'unsupported', keyword: 'with' })
  })
})

describe('EXPLAIN classification', () => {
  it('classifies the statement EXPLAIN wraps', () => {
    // EXPLAIN ANALYZE really executes the statement (MySQL 8.0.18+).
    expect(verdict('EXPLAIN ANALYZE INSERT INTO t VALUES (1)')).toEqual({ kind: 'write', setting: 'allowInsert' })
    expect(verdict('EXPLAIN ANALYZE DELETE FROM t')).toEqual({ kind: 'write', setting: 'allowDelete' })
    expect(verdict('EXPLAIN INSERT INTO t VALUES (1)')).toEqual({ kind: 'write', setting: 'allowInsert' })
    expect(verdict('EXPLAIN FORMAT=JSON SELECT 1')).toEqual({ kind: 'read' })
  })

  it('treats a connection-only EXPLAIN as a read', () => {
    expect(verdict('EXPLAIN FOR CONNECTION 5')).toEqual({ kind: 'read' })
  })
})

describe('server-side file writes', () => {
  it('refuses SELECT … INTO OUTFILE / DUMPFILE', () => {
    expect(verdict("SELECT * FROM t INTO OUTFILE '/tmp/x'")).toEqual({
      kind: 'file',
      keyword: 'select … into outfile',
    })
    expect(verdict("SELECT * FROM t INTO DUMPFILE '/tmp/y'")).toEqual({
      kind: 'file',
      keyword: 'select … into outfile',
    })
  })
})

describe('unsupported statements', () => {
  it.each([
    'CALL p()',
    'SET @x = 1',
    'GRANT ALL ON *.* TO u',
    'LOCK TABLES t WRITE',
    'SHUTDOWN',
    'ANALYZE TABLE t',
  ])('denies %s with no enabling switch', (sql) => {
    expect(classifySql(sql).kind).toBe('unsupported')
  })

  it('denies a construct the classifier cannot parse', () => {
    expect(verdict('(SELECT 1)')).toEqual({ kind: 'unsupported', keyword: '(unparsable)' })
    expect(verdict('')).toEqual({ kind: 'empty' })
    expect(verdict('   ')).toEqual({ kind: 'empty' })
  })
})

describe('multi-statement scripts', () => {
  // Each statement would need its own decision, and the driver rejects the
  // payload anyway, so it is refused rather than judged by a single switch.
  it('refuses a script holding more than one statement', () => {
    expect(verdict('SELECT 1; SELECT 2')).toEqual({ kind: 'multiple', count: 2 })
    expect(verdict('INSERT INTO t VALUES (1); DROP TABLE users')).toEqual({ kind: 'multiple', count: 2 })
  })

  it('does not count a trailing semicolon as a second statement', () => {
    expect(verdict('SELECT 1;')).toEqual({ kind: 'read' })
  })
})

describe('maskLiterals', () => {
  it('preserves length so offsets stay aligned', () => {
    for (const sql of ["SELECT 'abc'", 'SELECT `a b`', 'SELECT "x\\"y"', 'SELECT 1']) {
      expect(maskLiterals(sql)).toHaveLength(sql.length)
    }
  })

  it('spells out no keyword from a literal or identifier', () => {
    expect(maskLiterals("SELECT 'drop'")).not.toMatch(/drop/i)
    expect(maskLiterals('SELECT `drop`')).not.toMatch(/drop/i)
  })
})
