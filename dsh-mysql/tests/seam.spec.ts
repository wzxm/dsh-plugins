/**
 * Authorization seam tests.
 *
 * These pin the fail-closed properties of the gate itself, which the
 * classifier cannot express: the seam must stay registered when it is switched
 * off, must deny writes when no approval service is mounted, and must refuse a
 * multi-DB write that no schema permission narrows.
 *
 * @module tests/seam
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { apply, WriteSwitchesSchema, type Config } from '../src/index.ts'
import { WRITE_SWITCH_NAMESPACE } from '../src/write-switches.ts'

/** A recorded `tools/pre-execute` listener. */
type Listener = (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>

/** The minimum of `Context` the seam uses, plus a spy on the registered listener. */
function harness(options: {
  approval?: { request: (req: unknown) => Promise<ApprovalOutcome> }
  config?: Config
  /** Mount a fake settings provider; omitted means no `settings` service exists. */
  settings?: {
    /** The section the namespace resolves to, as `scope.get()` would return it. */
    section: Record<string, unknown>
    /** Observe the namespace and schema the seam registers. */
    onInstall?: (ns: string, schema: unknown) => void
  }
} = {}) {
  let listener: Listener | undefined
  const warn = vi.fn()
  // The fake provider records the registration and reports the configured
  // section as the resolved value, which is what `setSource` reads back.
  const settingsService = {
    installSection: (
      _owner: unknown,
      ns: string,
      schema: unknown,
      _entry: unknown,
      hooks: { setSource: (current: () => unknown) => void },
    ) => {
      options.settings?.onInstall?.(ns, schema)
      hooks.setSource(() => options.settings?.section)
    },
  }
  const ctx = {
    on: (name: string, fn: Listener) => {
      if (name === 'tools/pre-execute') listener = fn
      return () => {}
    },
    get: (name: string) => {
      if (name === 'approval') return options.approval
      if (name === 'settings' && options.settings !== undefined) return settingsService
      return undefined
    },
    // `installSection` is reached through `ctx.inject(['settings'], cb)`. Cordis
    // runs that callback once the service is present; the fake runs it inline
    // when one is configured, and never when it is not.
    inject: (_names: string[], cb: (scoped: unknown) => void) => {
      if (options.settings !== undefined) cb({ settings: settingsService })
      return () => {}
    },
    logger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  } as unknown as Context
  apply(ctx, options.config ?? {})
  if (listener === undefined) throw new Error('the seam registered no listener')
  return { listener, warn }
}

/** A call to the MySQL tool carrying `sql`. */
function call(sql: string, agent: unknown = { session: {} }): ToolExecution {
  return { name: 'mcp__mysql__mysql_query', arguments: { sql }, agent, callId: 'c1' } as unknown as ToolExecution
}

/** Run the seam and report the decision, treating a pass-through as `allow`. */
async function decide(
  sql: string,
  options: Parameters<typeof harness>[0] = {},
): Promise<PreToolDecision> {
  const { listener } = harness(options)
  return await listener(call(sql), async () => ({ kind: 'allow' }))
}

describe('disabled bridge', () => {
  // Unregistering the gate would leave the MCP tools live with no policy at
  // all; denying keeps the failure closed instead.
  it('denies reads too when the bridge is switched off', async () => {
    const decision = await decide('SELECT 1', { config: { enabled: false } })
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('MYSQL_BRIDGE_DISABLED')
  })
})

describe('missing approval service', () => {
  it('denies an enabled write when no approval seam is mounted', async () => {
    const decision = await decide('UPDATE t SET a = 1', { config: { allowUpdate: true, database: 'app' } })
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('no approval channel is available')
  })

  it('still allows a read when no approval seam is mounted', async () => {
    expect((await decide('SELECT 1')).kind).toBe('allow')
  })

  it('warns once, not once per call', async () => {
    const { listener, warn } = harness({ config: { allowUpdate: true, database: 'app' } })
    await listener(call('UPDATE t SET a = 1'), async () => ({ kind: 'allow' }))
    await listener(call('UPDATE t SET a = 2'), async () => ({ kind: 'allow' }))
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('approval outcomes', () => {
  it('allows a write only on allowed-once', async () => {
    const request = vi.fn(async (): Promise<ApprovalOutcome> => 'allowed-once')
    const decision = await decide('DELETE FROM t', {
      config: { allowDelete: true, database: 'app' },
      approval: { request },
    })
    expect(decision.kind).toBe('allow')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each(['rejected', 'cancelled', 'unavailable'] as const)(
    'denies a write when the outcome is %s',
    async (outcome) => {
      const decision = await decide('DELETE FROM t', {
        config: { allowDelete: true, database: 'app' },
        approval: { request: async () => outcome },
      })
      expect(decision.kind).toBe('deny')
      expect(decision.kind === 'deny' && decision.reason).toContain(outcome)
    },
  )

  it('never asks for approval on a read', async () => {
    const request = vi.fn(async (): Promise<ApprovalOutcome> => 'allowed-once')
    const decision = await decide('SELECT 1', { approval: { request } })
    expect(decision.kind).toBe('allow')
    expect(request).not.toHaveBeenCalled()
  })
})

describe('write toggles', () => {
  it('denies a write whose toggle is off', async () => {
    const decision = await decide('DROP TABLE t', {
      config: { allowDrop: false, database: 'app' },
      approval: { request: async () => 'allowed-once' },
    })
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('allowDrop is off')
  })

  it('denies an unsupported statement even with every toggle on', async () => {
    const decision = await decide('CALL drop_everything()', {
      config: {
        allowInsert: true, allowUpdate: true, allowDelete: true,
        allowAlter: true, allowTruncate: true, allowDrop: true, database: 'app',
      },
      approval: { request: async () => 'allowed-once' },
    })
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('CALL'.toLowerCase())
  })
})

describe('multi-DB writes', () => {
  // With no database pinned the server takes the target from the statement, so
  // one global toggle would authorize a write against any reachable schema.
  it('denies an enabled write while no database is pinned', async () => {
    const decision = await decide('UPDATE t SET a = 1', {
      config: { allowUpdate: true },
      approval: { request: async () => 'allowed-once' },
    })
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('MYSQL_MULTI_DB_WRITE_DENIED')
  })

  it('allows it once the operator opts in explicitly', async () => {
    const decision = await decide('UPDATE t SET a = 1', {
      config: { allowUpdate: true, allowMultiDbWrites: true },
      approval: { request: async () => 'allowed-once' },
    })
    expect(decision.kind).toBe('allow')
  })

  it('does not restrict reads in multi-DB mode', async () => {
    expect((await decide('SELECT 1')).kind).toBe('allow')
  })
})

describe('argument shape', () => {
  it('denies a namespaced call whose sql argument is unreadable', async () => {
    const { listener } = harness()
    const exec = { name: 'mcp__mysql__mysql_query', arguments: {}, agent: undefined, callId: 'c1' } as unknown as ToolExecution
    const decision = await listener(exec, async () => ({ kind: 'allow' }))
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('MYSQL_SQL_UNREADABLE')
  })

  it('leaves calls outside its namespace alone', async () => {
    const { listener } = harness()
    const exec = { name: 'mcp__other__thing', arguments: {}, agent: undefined, callId: 'c1' } as unknown as ToolExecution
    expect((await listener(exec, async () => ({ kind: 'allow' }))).kind).toBe('allow')
  })
})

describe('settings-backed switches', () => {
  it('registers the write-switch namespace with its schema', () => {
    let seen: { ns: string; schema: unknown } | undefined
    harness({
      settings: {
        section: {},
        onInstall: (ns, schema) => { seen = { ns, schema } },
      },
    })
    expect(seen?.ns).toBe(WRITE_SWITCH_NAMESPACE)
    expect(seen?.schema).toBe(WriteSwitchesSchema)
  })

  // The settings section is the override layer: it grants what the composition
  // entry did not, which is the whole point of the card.
  it('lets the stored section grant a write the entry left off', async () => {
    const decision = await decide('UPDATE t SET a = 1', {
      config: { database: 'app' },
      settings: { section: { allowUpdate: true } },
      approval: { request: async () => 'allowed-once' },
    })
    expect(decision.kind).toBe('allow')
  })

  // And the reverse: clearing a switch in the card must actually revoke it,
  // not fall back to the entry's value.
  it('lets the stored section revoke a write the entry granted', async () => {
    const decision = await decide('UPDATE t SET a = 1', {
      config: { allowUpdate: true, database: 'app' },
      settings: { section: {} },
      approval: { request: async () => 'allowed-once' },
    })
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('allowUpdate is off')
  })

  it('reads only literal true as permission', async () => {
    // A hand-edited document could hold a string or a number; neither may be
    // read as a grant.
    const decision = await decide('DROP TABLE t', {
      config: { database: 'app' },
      settings: { section: { allowDrop: 'true' } },
      approval: { request: async () => 'allowed-once' },
    })
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('allowDrop is off')
  })

  it('falls back to the composition entry when no settings provider is mounted', async () => {
    const decision = await decide('UPDATE t SET a = 1', {
      config: { allowUpdate: true, database: 'app' },
      approval: { request: async () => 'allowed-once' },
    })
    expect(decision.kind).toBe('allow')
  })

  it('does not read a section shared with connection settings', async () => {
    // The namespace is narrower than Config on purpose: even if a section
    // carried connection fields, they must not reach the gate.
    const decision = await decide('UPDATE t SET a = 1', {
      config: { allowUpdate: true, database: 'app' },
      settings: { section: { allowUpdate: true, database: '' } },
      approval: { request: async () => 'allowed-once' },
    })
    expect(decision.kind).toBe('allow')
  })
})
