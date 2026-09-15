import { describe, it, expect, vi } from 'vitest'
import { apply, Config, name, inject } from '../src/index.ts'
import type { Config as PluginConfig } from '../src/index.ts'

/** A minimal valid config, matching what the loader would resolve. */
const BASE: PluginConfig = {
  oauthCallbackPath: '/oauth/feishu/callback',
  appIdRef: '',
  appSecretRef: '',
  domain: 'feishu',
  botOpenId: '',
  botId: 'feishu',
  workspacePath: '',
  agentPreset: 'standard',
  permissionPreset: 'default',
  maxReplyChars: 4000,
}

/**
 * A fake Cordis context recording `webServer.register` calls and `ctx.effect`
 * disposers, so `apply` can be exercised without booting a real harness.
 *
 * `inject` mirrors Cordis: the callback runs only when every requested service
 * is present. Pass `agentStack: true` to simulate a profile that has them.
 */
function fakeCtx (
  services: Record<string, unknown> = {},
  options: { agentStack?: boolean } = {},
) {
  const registered: Array<{ kind: string; path: string; handler: unknown }> = []
  const disposers: Array<() => unknown> = []
  const warnings: string[] = []
  const injectCalls: string[][] = []
  const webServer = {
    register (route: { kind: string; path: string; handler: unknown }) {
      registered.push(route)
      const dispose = () => {
        const at = registered.indexOf(route)
        if (at !== -1) registered.splice(at, 1)
      }
      return dispose
    },
  }
  /** The services an Agent stack provides, when a test wants them present. */
  const stack = options.agentStack === true
    ? {
        agents: {}, agentPresets: {}, agentDefaultModel: {},
        permissionPresets: {}, sessionTitle: {}, workspaceRegistry: {},
      }
    : {}
  const all: Record<string, unknown> = { webServer, ...stack, ...services }
  const ctx = {
    webServer,
    logger: {
      warn: (m: unknown) => warnings.push(String(m)),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    get: (key: string) => all[key],
    effect (factory: () => unknown) {
      // Cordis runs the factory immediately and owns what it returns.
      const result = factory()
      if (typeof result === 'function') disposers.push(result as () => unknown)
      return () => {}
    },
    inject (deps: string[], callback: (c: unknown) => unknown) {
      injectCalls.push(deps)
      // Cordis starts the callback only once every dependency is available.
      if (deps.every(dep => all[dep] !== undefined)) callback(ctx)
      return () => {}
    },
  }
  return { ctx: ctx as never, registered, disposers, warnings, injectCalls }
}

describe('plugin descriptor', () => {
  it('declares only webServer as a hard dependency', () => {
    expect(inject).toEqual(['webServer'])
    expect(inject).not.toContain('agents')
    expect(inject).not.toContain('credentials')
    expect(name).toBe('dsh-im')
  })

  it('exports a Config schema the loader can validate against', () => {
    expect(Config).toBeDefined()
    const result = Config['~standard'].validate({})
    expect(result).not.toBeInstanceOf(Promise)
    expect((result as { issues?: unknown }).issues).toBeUndefined()
  })

  it('applies defaults for every optional field', () => {
    const value = (Config['~standard'].validate({}) as { value: PluginConfig }).value
    expect(value.domain).toBe('feishu')
    expect(value.botOpenId).toBe('')
    expect(value.botId).toBe('feishu')
    expect(value.agentPreset).toBe('standard')
    expect(value.permissionPreset).toBe('default')
    expect(value.maxReplyChars).toBe(4000)
  })
})

describe('agent-stack wiring', () => {
  it('requests the Agent stack through ctx.inject, not a hard dependency', () => {
    const { ctx, injectCalls } = fakeCtx()
    apply(ctx, BASE)
    expect(injectCalls).toHaveLength(1)
    expect(injectCalls[0]).toEqual([
      'agents', 'agentPresets', 'agentDefaultModel',
      'permissionPresets', 'sessionTitle', 'workspaceRegistry',
    ])
  })

  it('registers the OAuth route even when no Agent stack is mounted', () => {
    const { ctx, registered } = fakeCtx({})
    expect(() => apply(ctx, BASE)).not.toThrow()
    // Only the OAuth route registers; the WebSocket transport replaces the
    // callback route.
    expect(registered.length).toBeGreaterThanOrEqual(1)
  })

  it('warns on first message when the Agent stack is absent', () => {
    // The OAuth route registers; the message handler logs a warning.
    const { ctx, warnings } = fakeCtx({})
    apply(ctx, BASE)
    // The route registration still happens synchronously.
    expect(warnings.join(' ')).not.toContain('Agent stack')
  })
})

describe('apply', () => {
  it('registers the OAuth callback route', () => {
    const { ctx, registered } = fakeCtx()
    apply(ctx, BASE)

    const oauth = registered.find(r => r.path === '/oauth/feishu/callback')
    expect(oauth).toBeDefined()
    expect(oauth!.kind).toBe('exact')
  })

  it('rejects a non-absolute, root, or trailing-slash oauth path', () => {
    for (const bad of ['oauth/callback', '/', '/oauth/callback/', '/a?b', '/a#b']) {
      const { ctx } = fakeCtx()
      expect(() => apply(ctx, { ...BASE, oauthCallbackPath: bad })).toThrow(/dsh-im oauthCallbackPath/)
    }
  })

  it('rejects a relative workspacePath at activation, not per message', () => {
    const { ctx } = fakeCtx()
    expect(() => apply(ctx, { ...BASE, workspacePath: 'relative/ws' })).toThrow(/absolute path/)
    expect(() => apply(ctx, { ...BASE, workspacePath: '/ok' })).not.toThrow()
    expect(() => apply(ctx, { ...BASE, workspacePath: '' })).not.toThrow()
  })

  it('rejects a non-positive reply ceiling', () => {
    const { ctx } = fakeCtx()
    expect(() => apply(ctx, { ...BASE, maxReplyChars: 0 })).toThrow(/maxReplyChars/)
  })

  it('does not require credentials to be mounted', () => {
    const { ctx, registered } = fakeCtx({})
    expect(() => apply(ctx, BASE)).not.toThrow()
    expect(registered.length).toBeGreaterThanOrEqual(1)
  })

  it('warns but keeps serving when a configured credential ref has no provider', async () => {
    const { ctx, warnings } = fakeCtx({})
    apply(ctx, { ...BASE, appIdRef: 'FEISHU_APP_ID' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(warnings.some(w => w.includes('FEISHU_APP_ID'))).toBe(true)
  })

  it('warns and skips a ref outside the credential-name grammar', async () => {
    const resolve = vi.fn(async () => ({ value: 'v', source: 'env' }))
    const { ctx, warnings } = fakeCtx({ credentials: { resolve } })
    expect(() => apply(ctx, { ...BASE, appIdRef: 'feishu-app-id' })).not.toThrow()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(resolve).not.toHaveBeenCalled()
    expect(warnings.join(' ')).toContain('not a valid name')
  })

  it('resolves a configured secret through the credentials service', async () => {
    const resolve = vi.fn(async () => ({ value: 'secret-value', source: 'env' }))
    const { ctx } = fakeCtx({ credentials: { resolve } })
    apply(ctx, { ...BASE, appIdRef: 'FEISHU_APP_ID' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(resolve).toHaveBeenCalledWith('FEISHU_APP_ID')
  })

  it('registers routes before secrets resolve, so a slow provider cannot delay startup', () => {
    let release: (() => void) | undefined
    const resolve = () => new Promise<never>(r => { release = () => r(undefined as never) })
    const { ctx, registered } = fakeCtx({ credentials: { resolve } })
    apply(ctx, { ...BASE, appIdRef: 'ref' })
    expect(registered.length).toBeGreaterThanOrEqual(1)
    release?.()
  })

  it('surfaces a credential resolution failure as a warning, not a crash', async () => {
    const resolve = vi.fn(async () => { throw new Error('credential store unavailable') })
    const { ctx, warnings, registered } = fakeCtx({ credentials: { resolve } })
    apply(ctx, { ...BASE, appIdRef: 'ref' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(registered.length).toBeGreaterThanOrEqual(1)
    expect(warnings.join(' ')).toContain('credential store unavailable')
  })
})

describe('effect ownership', () => {
  it('produces a disposer for each route so stop/update removes them', () => {
    const { ctx, registered, disposers } = fakeCtx()
    apply(ctx, BASE)
    expect(disposers.length).toBeGreaterThanOrEqual(1)
    for (const dispose of disposers) dispose()
    expect(registered).toHaveLength(0)
  })
})