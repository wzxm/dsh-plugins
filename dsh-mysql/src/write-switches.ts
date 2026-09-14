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
export const WRITE_SWITCH_NAMESPACE = 'dsh-mysql'

/**
 * One permission the bridge can grant, and the settings field that grants it.
 *
 * Order is presentation order in the card and is deliberately
 * least-destructive first, so the two switches an operator should think twice
 * about sit at the bottom.
 */
export const WRITE_SWITCHES = [
  {
    field: 'allowInsert',
    keyword: 'INSERT',
    /** Statements this switch permits, for the card's hint text. */
    statements: 'INSERT / REPLACE / LOAD',
  },
  {
    field: 'allowUpdate',
    keyword: 'UPDATE',
    statements: 'UPDATE, and SELECT … FOR UPDATE',
  },
  {
    field: 'allowDelete',
    keyword: 'DELETE',
    statements: 'DELETE',
  },
  {
    field: 'allowAlter',
    keyword: 'ALTER',
    statements: 'ALTER / CREATE / RENAME',
  },
  {
    field: 'allowTruncate',
    keyword: 'TRUNCATE',
    statements: 'TRUNCATE',
  },
  {
    field: 'allowDrop',
    keyword: 'DROP',
    statements: 'DROP',
  },
] as const

/** One entry of {@link WRITE_SWITCHES}. */
export type WriteSwitch = (typeof WRITE_SWITCHES)[number]

/** A settings field name that grants a write. */
export type WriteSwitchField = WriteSwitch['field']

/** Every write field, in presentation order. */
export const WRITE_SWITCH_FIELDS: readonly WriteSwitchField[] = WRITE_SWITCHES.map(s => s.field)

/** The resolved switch values, keyed by field. */
export type WriteSwitches = Record<WriteSwitchField, boolean>

/** All switches off: the value used when no settings provider is mounted. */
export const WRITE_SWITCHES_ALL_OFF: WriteSwitches = {
  allowInsert: false,
  allowUpdate: false,
  allowDelete: false,
  allowAlter: false,
  allowTruncate: false,
  allowDrop: false,
}

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
export function readWriteSwitches(section: Partial<Record<WriteSwitchField, unknown>> | undefined): WriteSwitches {
  const read = (field: WriteSwitchField): boolean => section?.[field] === true
  return {
    allowInsert: read('allowInsert'),
    allowUpdate: read('allowUpdate'),
    allowDelete: read('allowDelete'),
    allowAlter: read('allowAlter'),
    allowTruncate: read('allowTruncate'),
    allowDrop: read('allowDrop'),
  }
}
