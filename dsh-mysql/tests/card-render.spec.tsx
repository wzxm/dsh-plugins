/**
 * Card render tests for the staged-edit PluginCard-style MySQL card.
 *
 * The card now uses PluginCard-like staged-edit semantics: changing a switch
 * sets a pending value read only by Save. These tests verify that pending
 * values are reflected, that Save writes them, and that Discard drops them.
 *
 * @module tests/card-render
 */

// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { createElement } from 'react'

// The platform supplies `Switch` to the browser bundle at load time (verified
// separately by scripts/verify-client-bundle.mjs).
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Switch: ({ checked, onChange, label, disabled }: {
    checked: boolean
    onChange: (next: boolean) => void
    label: string
    disabled?: boolean
  }) => createElement('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': checked,
    'aria-label': label,
    ...(disabled === true ? { disabled: true } : {}),
    onClick: () => { onChange(!checked) },
  }),
  IconChevronDownOutline14: (props: Record<string, unknown>) => createElement('svg', { ...props, 'data-testid': 'chevron' }),
}))

import { MysqlCard } from '../src/client/MysqlCard.tsx'
import type { MysqlCardState } from '../src/client/card-state.ts'
import { en } from '../src/client/locales.ts'

/** Stand-in for the framework `t` seat. */
const t = ((key: keyof typeof en) => en[key]) as unknown as (key: string) => string

/** Build the props the renderer binds. */
function props(state: MysqlCardState, setSwitch = vi.fn()) {
  return {
    t,
    useMysqlCard: (selector: (snapshot: MysqlCardState) => unknown) => selector(state),
    setSwitch,
  } as unknown as Parameters<typeof MysqlCard>[0]
}

/** A ready state. */
function state(patch: Partial<MysqlCardState> = {}): MysqlCardState {
  return {
    status: 'ready',
    writable: true,
    error: undefined,
    rows: [
      { field: 'allowInsert', statements: 'INSERT / REPLACE / LOAD', environment: 'DSH_MYSQL_ALLOW_INSERT', enabled: false, overridden: false, gate: 'open' },
      { field: 'allowUpdate', statements: 'UPDATE', environment: 'DSH_MYSQL_ALLOW_UPDATE', enabled: true, overridden: false, gate: 'open' },
    ],
    ...patch,
  }
}

/** Helper: click the expand toggle. */
function expand() {
  fireEvent.click(screen.getByRole('button', { name: `${en.expand}: ${en.title}` }))
}

describe('card render', () => {
  it('is collapsed by default', () => {
    render(createElement(MysqlCard, props(state())))
    expect(screen.getByRole('button', { name: `${en.expand}: ${en.title}` })).toBeDefined()
    expect(screen.queryAllByRole('switch')).toHaveLength(0)
  })

  it('expands on first click, collapses on second', () => {
    render(createElement(MysqlCard, props(state())))
    const toggle = screen.getByRole('button', { name: `${en.expand}: ${en.title}` })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('switch')).toHaveLength(2)

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryAllByRole('switch')).toHaveLength(0)
  })

  it('renders one switch per row after expansion', () => {
    render(createElement(MysqlCard, props(state())))
    expand()
    expect(screen.getAllByRole('switch')).toHaveLength(2)
  })

  it('reflects each row in its switch state', () => {
    render(createElement(MysqlCard, props(state())))
    expand()
    const switches = screen.getAllByRole('switch')
    expect(switches[0]?.getAttribute('aria-checked')).toBe('false')
    expect(switches[1]?.getAttribute('aria-checked')).toBe('true')
  })

  it('renders a switch only for kinds the environment authorized', () => {
    const s = state()
    s.rows[0] = { ...s.rows[0]!, gate: 'env-required' }
    render(createElement(MysqlCard, props(s)))
    expand()
    expect(screen.getAllByRole('switch')).toHaveLength(1)
  })

  it('shows the required environment variable instead of an ineffective switch', () => {
    const s = state()
    s.rows[0] = { ...s.rows[0]!, gate: 'env-required' }
    render(createElement(MysqlCard, props(s)))
    expand()
    expect(screen.getByText('DSH_MYSQL_ALLOW_INSERT=true')).toBeDefined()
    expect(screen.getByText(en.envUnauthorized)).toBeDefined()
  })

  it('disables every switch when the document rejects writes', () => {
    render(createElement(MysqlCard, props(state({ writable: false }))))
    expand()
    for (const control of screen.getAllByRole('switch')) {
      expect(control.hasAttribute('disabled')).toBe(true)
    }
    expect(screen.getByText(en.readOnly)).toBeDefined()
  })

  it('shows the loading state', () => {
    render(createElement(MysqlCard, props(state({ status: 'loading' }))))
    expect(screen.getByText(en.loading)).toBeDefined()
  })

  it('shows the unavailable state', () => {
    render(createElement(MysqlCard, props(state({ status: 'unavailable' }))))
    expect(screen.getByText(en.unavailable)).toBeDefined()
  })

  it('marks an overridden field from the scope', () => {
    const s = state()
    s.rows[1] = { ...s.rows[1]!, overridden: true }
    render(createElement(MysqlCard, props(s)))
    expand()
    expect(screen.getByText(en.overridden)).toBeDefined()
  })
})

describe('staged edit', () => {
  it('shows pending switch changes before save', () => {
    render(createElement(MysqlCard, props(state())))
    expand()
    // Default: row 0 is false. Click to stage true.
    fireEvent.click(screen.getAllByRole('switch')[0]!)
    // The staged indicator ("staged") should appear
    expect(screen.getByText(en.staged)).toBeDefined()
    // The switch should reflect the staged value
    expect(screen.getAllByRole('switch')[0]?.getAttribute('aria-checked')).toBe('true')
  })

  it('writes staged edits on save', () => {
    const setSwitch = vi.fn(async () => {})
    render(createElement(MysqlCard, props(state(), setSwitch)))
    expand()
    // Stage a change
    fireEvent.click(screen.getAllByRole('switch')[0]!)
    // Click Save
    fireEvent.click(screen.getByText(en.save))
    expect(setSwitch).toHaveBeenCalledWith('allowInsert', true)
  })

  it('drops staged edits on discard', () => {
    const setSwitch = vi.fn(async () => {})
    render(createElement(MysqlCard, props(state(), setSwitch)))
    expand()
    // Stage a change
    fireEvent.click(screen.getAllByRole('switch')[0]!)
    expect(screen.getByText(en.staged)).toBeDefined()
    // Discard
    fireEvent.click(screen.getByText(en.discard))
    expect(screen.queryByText(en.staged)).toBeNull()
    // The switch should return to its original state
    expect(screen.getAllByRole('switch')[0]?.getAttribute('aria-checked')).toBe('false')
    // setSwitch should NOT have been called
    expect(setSwitch).not.toHaveBeenCalled()
  })

  it('disables save button when no staged edits', () => {
    render(createElement(MysqlCard, props(state())))
    expand()
    expect(screen.getByText(en.save)).toBeDisabled()
  })

  it('disables save and discard while saving', async () => {
    const setSwitch = vi.fn(async () => { /* never resolves during this microtask */ })
    render(createElement(MysqlCard, props(state(), setSwitch)))
    expand()
    fireEvent.click(screen.getAllByRole('switch')[0]!)
    // Click save; before it settles, save and discard should be disabled
    fireEvent.click(screen.getByText(en.save))
    // Wait for React to flush the saving state
    await screen.findByText(en.saving)
    expect(screen.getByText(en.save)).toBeDisabled()
    expect(screen.getByText(en.discard)).toBeDisabled()
  })
})

describe('card controller', () => {
  it('projects the scope snapshot into the store the hook reads', async () => {
    const { MysqlCardController } = await import('../src/client/card-controller.ts')
    const scope = {
      getSnapshot: () => ({
        status: 'ready' as const,
        value: { allowDrop: true },
        base: { allowDrop: true },
        user: undefined,
        revision: 1,
        writable: true,
        mode: 'host' as const,
      }),
      subscribe: () => () => {},
      set: async () => {},
      mutate: async () => {},
      unset: async () => {},
    }
    const face = new MysqlCardController(scope as never).inject()
    const snapshot = face.hooks.mysqlCard.getSnapshot()
    expect(snapshot.rows.find(r => r.field === 'allowDrop')?.enabled).toBe(true)
    expect(snapshot.rows.find(r => r.field === 'allowDrop')?.gate).toBe('open')
  })

  it('writes the field through the scope on setSwitch', async () => {
    const { MysqlCardController } = await import('../src/client/card-controller.ts')
    const set = vi.fn(async () => {})
    const scope = {
      getSnapshot: () => ({
        status: 'ready' as const, value: {}, base: {}, user: undefined,
        revision: 1, writable: true, mode: 'host' as const,
      }),
      subscribe: () => () => {},
      set,
      mutate: async () => {},
      unset: async () => {},
    }
    const face = new MysqlCardController(scope as never).inject()
    await face.setSwitch('allowInsert', true)
    expect(set).toHaveBeenCalledWith('allowInsert', true)
  })

  it('surfaces a rejected write in the snapshot', async () => {
    const { MysqlCardController } = await import('../src/client/card-controller.ts')
    const scope = {
      getSnapshot: () => ({
        status: 'ready' as const, value: {}, base: {}, user: undefined,
        revision: 1, writable: true, mode: 'host' as const,
      }),
      subscribe: () => () => {},
      set: async () => { throw new Error('revision conflict') },
      mutate: async () => {},
      unset: async () => {},
    }
    const face = new MysqlCardController(scope as never).inject()
    face.setSwitch('allowInsert', true)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(face.hooks.mysqlCard.getSnapshot().error).toBe('revision conflict')
  })
})