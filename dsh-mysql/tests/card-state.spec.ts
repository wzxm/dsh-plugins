/**
 * Card projection tests.
 *
 * The card's honesty rests on one rule: the composition layer (the profile's
 * environment variables, which the MCP server actually reads) is the ceiling,
 * so a switch it did not authorize must render as gated rather than as an
 * available control that silently does nothing.
 *
 * @module tests/card-state
 */

import { describe, expect, it } from 'vitest'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { projectCardState } from '../src/client/card-state.ts'

/** A ready snapshot with the given layers. */
function snapshot(parts: {
  value?: unknown
  base?: unknown
  user?: unknown
  writable?: boolean
}): SettingsScopeSnapshot<unknown> {
  return {
    status: 'ready',
    value: parts.value ?? {},
    base: parts.base ?? {},
    user: parts.user,
    revision: 1,
    writable: parts.writable ?? true,
    mode: 'host',
  }
}

describe('card projection', () => {
  it('renders six rows in presentation order', () => {
    const state = projectCardState(snapshot({}))
    expect(state.rows.map(r => r.field)).toEqual([
      'allowInsert', 'allowUpdate', 'allowDelete', 'allowAlter', 'allowTruncate', 'allowDrop',
    ])
  })

  // The base layer is what the MCP server's environment mirrors, so an
  // unauthorized kind must be visibly gated.
  it('gates every switch the composition layer did not authorize', () => {
    const state = projectCardState(snapshot({ base: { allowUpdate: true } }))
    const byField = Object.fromEntries(state.rows.map(r => [r.field, r]))
    expect(byField.allowUpdate?.gate).toBe('open')
    expect(byField.allowDrop?.gate).toBe('env-required')
    expect(byField.allowInsert?.gate).toBe('env-required')
  })

  it('reports the resolved value, not the base', () => {
    // A section that grants what the base left off still shows as enabled, so
    // the operator sees the effective state rather than the composition state.
    const state = projectCardState(snapshot({ base: {}, value: { allowUpdate: true } }))
    expect(state.rows.find(r => r.field === 'allowUpdate')?.enabled).toBe(true)
  })

  it('marks a field the user layer carries as overridden', () => {
    const state = projectCardState(snapshot({ user: { allowDelete: false }, value: {} }))
    const rows = Object.fromEntries(state.rows.map(r => [r.field, r]))
    expect(rows.allowDelete?.overridden).toBe(true)
    expect(rows.allowInsert?.overridden).toBe(false)
  })

  // Presence, not value: an override that equals the base is still an override,
  // and comparing values could not see it.
  it('treats a stored value equal to the base as an override', () => {
    const state = projectCardState(snapshot({ base: { allowInsert: false }, user: { allowInsert: false } }))
    expect(state.rows.find(r => r.field === 'allowInsert')?.overridden).toBe(true)
  })

  it('reads only literal true as permission', () => {
    const state = projectCardState(snapshot({ value: { allowDrop: 'true', allowInsert: 1 } }))
    const rows = Object.fromEntries(state.rows.map(r => [r.field, r]))
    expect(rows.allowDrop?.enabled).toBe(false)
    expect(rows.allowInsert?.enabled).toBe(false)
  })

  it('passes through status and writability', () => {
    const loading: SettingsScopeSnapshot<unknown> = {
      status: 'loading', value: undefined, base: undefined, user: undefined,
      revision: undefined, writable: false, mode: 'host',
    }
    expect(projectCardState(loading).status).toBe('loading')
    expect(projectCardState(snapshot({ writable: false })).writable).toBe(false)
  })
})
