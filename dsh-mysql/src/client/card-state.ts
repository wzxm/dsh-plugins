/**
 * The MySQL settings card's view state.
 *
 * The card is a *revocation* control, not a grant: the composition layer (the
 * profile's `DSH_MYSQL_ALLOW_*` environment variables) is what the upstream MCP
 * server reads to decide whether a write kind is admitted at all, and the
 * server fixes that decision when the child process spawns. A settings write
 * cannot reach it.
 *
 * So each switch is rendered against the layer beneath it:
 *
 * - `base` off  → the server will refuse this write kind no matter what the
 *   card says, so the row is shown as gated and its switch is disabled.
 * - `base` on   → the card's value decides, and turning it off revokes the
 *   write kind live, without a restart.
 *
 * @module @wzxm/dsh-mysql/client/card-state
 */

import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  WRITE_SWITCHES, readWriteSwitches,
  type WriteSwitchField, type WriteSwitches,
} from '../write-switches.ts'

/** Why a row's switch cannot be turned on. */
export type SwitchGate = 'open' | 'env-required'

/** One rendered row of the card. */
export interface SwitchRow {
  /** The settings field this row writes. */
  field: WriteSwitchField
  /** Statements the switch governs, for the row's hint. */
  statements: string
  /** Whether the settings layer currently grants the write. */
  enabled: boolean
  /** Whether the user layer overrides the composition layer for this field. */
  overridden: boolean
  /** Whether turning this on could ever take effect. */
  gate: SwitchGate
}

/** Everything the card renders. */
export interface MysqlCardState {
  /** `loading` before the first host answer, `ready` once sections resolve. */
  status: SettingsScopeSnapshot<unknown>['status']
  /** Whether the host document accepts writes at all. */
  writable: boolean
  /** The six rows, in presentation order. */
  rows: SwitchRow[]
  /** A pending write's failure message, or undefined. */
  error: string | undefined
}

/**
 * Project one settings snapshot into the card's view state.
 *
 * The composition layer arrives as `base` (the entry the host registered),
 * which is exactly the layer the MCP server's environment mirrors — so it is
 * what decides whether a switch can have any effect.
 * @param snapshot - the bound `dsh-mysql` scope snapshot.
 * @returns the card state.
 */
export function projectCardState(snapshot: SettingsScopeSnapshot<unknown>): MysqlCardState {
  // `user` presence marks an override; a stored value equal to the base is
  // still an override, so presence is the only reliable signal.
  const user = (snapshot.user ?? {}) as Record<string, unknown>
  const base = readWriteSwitches(snapshot.base as Partial<Record<WriteSwitchField, unknown>>)
  const resolved: WriteSwitches = snapshot.value === undefined
    ? readWriteSwitches(undefined)
    : readWriteSwitches(snapshot.value as Partial<Record<WriteSwitchField, unknown>>)

  return {
    status: snapshot.status,
    writable: snapshot.writable,
    error: undefined,
    rows: WRITE_SWITCHES.map((entry): SwitchRow => ({
      field: entry.field,
      statements: entry.statements,
      enabled: resolved[entry.field],
      overridden: Object.prototype.hasOwnProperty.call(user, entry.field),
      // The base layer is the server's ceiling: a kind the profile did not
      // authorize cannot be granted from here.
      gate: base[entry.field] ? 'open' : 'env-required',
    })),
  }
}
