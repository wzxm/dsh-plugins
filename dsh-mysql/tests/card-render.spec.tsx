/**
 * Card render tests.
 *
 * These exercise the component against the props shape the renderer binds, so
 * a wrong assumption about `InjectFace` (the business face spread as top-level
 * props, not nested under `inject`) fails here rather than in the browser.
 *
 * @module tests/card-render
 */

// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createElement } from 'react'

// The platform supplies `Switch` to the browser bundle at load time (verified
// separately by scripts/verify-client-bundle.mjs). Importing the real package
// here would drag its whole rendering barrel — shiki, katex, the markdown
// pipeline — into the test run to exercise one 15-line component, so the stub
// stands in for it. What these tests cover is this card's logic, not the
// shared control's.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Switch: ({ checked, onChange, label, disabled, title }: {
    checked: boolean
    onChange: (next: boolean) => void
    label: string
    disabled?: boolean
    title?: string
  }) => createElement('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': checked,
    'aria-label': label,
    ...(title === undefined ? {} : { title }),
    ...(disabled === true ? { disabled: true } : {}),
    onClick: () => { onChange(!checked) },
  }),
}))

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { MysqlCard } from '../src/client/MysqlCard.tsx'
import type { MysqlCardState } from '../src/client/card-state.ts'
import { en } from '../src/client/locales.ts'

/** Stand-in for the framework `t` seat: resolves keys against the English dict. */
const t = ((key: keyof typeof en) => en[key]) as unknown as (key: string) => string

/** Build the props the renderer binds, minus the framework's own seats. */
function props(state: MysqlCardState, setSwitch = vi.fn()) {
  return {
    t,
    useMysqlCard: (selector: (snapshot: MysqlCardState) => unknown) => selector(state),
    setSwitch,
  } as unknown as Parameters<typeof MysqlCard>[0]
}

/** A ready state with every row gated off, then patched per test. */
function state(patch: Partial<MysqlCardState> = {}): MysqlCardState {
  return {
    status: 'ready',
    writable: true,
    error: undefined,
    rows: [
      { field: 'allowInsert', statements: 'INSERT / REPLACE / LOAD', enabled: false, overridden: false, gate: 'env-required' },
      { field: 'allowUpdate', statements: 'UPDATE', enabled: true, overridden: false, gate: 'open' },
    ],
    ...patch,
  }
}

describe('card render', () => {
  it('renders one switch per row', () => {
    render(createElement(MysqlCard, props(state())))
    expect(screen.getAllByRole('switch')).toHaveLength(2)
  })

  it('reflects each row in its switch state', () => {
    render(createElement(MysqlCard, props(state())))
    const switches = screen.getAllByRole('switch')
    expect(switches[0]?.getAttribute('aria-checked')).toBe('false')
    expect(switches[1]?.getAttribute('aria-checked')).toBe('true')
  })

  // The composition layer is the ceiling: a kind the profile never authorized
  // must not look turnable-on.
  it('disables a switch the environment did not authorize', () => {
    render(createElement(MysqlCard, props(state())))
    const [gated, open] = screen.getAllByRole('switch')
    expect(gated?.hasAttribute('disabled')).toBe(true)
    expect(open?.hasAttribute('disabled')).toBe(false)
  })

  it('calls setSwitch with the field and the requested value', () => {
    const setSwitch = vi.fn()
    render(createElement(MysqlCard, props(state(), setSwitch)))
    screen.getAllByRole('switch')[1]?.click()
    expect(setSwitch).toHaveBeenCalledWith('allowUpdate', false)
  })

  it('shows the loading state before the first host answer', () => {
    render(createElement(MysqlCard, props(state({ status: 'loading' }))))
    expect(screen.getByText(en.loading)).toBeDefined()
  })

  it('reports an unavailable settings session', () => {
    render(createElement(MysqlCard, props(state({ status: 'unavailable' }))))
    expect(screen.getByText(en.unavailable)).toBeDefined()
  })

  it('disables every switch when the document rejects writes', () => {
    render(createElement(MysqlCard, props(state({ writable: false }))))
    for (const control of screen.getAllByRole('switch')) {
      expect(control.hasAttribute('disabled')).toBe(true)
    }
    expect(screen.getByText(en.readOnly)).toBeDefined()
  })

  it('surfaces a failed write', () => {
    render(createElement(MysqlCard, props(state({ error: 'revision conflict' }))))
    expect(screen.getByText('revision conflict')).toBeDefined()
  })

  it('marks an overridden field', () => {
    const withOverride = state()
    withOverride.rows[1] = { ...withOverride.rows[1]!, overridden: true }
    render(createElement(MysqlCard, props(withOverride)))
    expect(screen.getByText(en.overridden)).toBeDefined()
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

  it('writes the field through the scope', async () => {
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
    face.setSwitch('allowInsert', true)
    expect(set).toHaveBeenCalledWith('allowInsert', true)
  })

  // A rejected write must not vanish: the operator needs to see why the switch
  // did not stick.
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
    // The catch rides a microtask chain; let it settle.
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(face.hooks.mysqlCard.getSnapshot().error).toBe('revision conflict')
  })
})

describe('store availability', () => {
  it('creates a snapshot store the hook can select from', () => {
    const store = createSnapshotStore(state())
    expect(store.getSnapshot().rows.length).toBe(2)
  })
})
