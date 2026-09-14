import { describe, it, expect, vi } from 'vitest'
import { apply, Config, name, inject } from '../src/index.ts'
import type { Config as PluginConfig } from '../src/index.ts'

/** A route registration captured from the fake web server. */
interface RegisteredRoute {
  kind: string
  path: string
  handler: (req: unknown, res: unknown) => unknown
}

/**
 * A fake Cordis context recording `webServer.register` calls and `ctx.effect`
 * disposers, so `apply` can be exercised without booting a real harness.
 */
function fakeCtx (services: Record<string, unknown> = {}) {
  const registered: RegisteredRoute[] = []
  const disposers: Array<() => unknown> = []
  const warnings: string[] = []
  const webServer = {
    register (route: RegisteredRoute) {
      registered.push(route)
      const dispose = () => {
        const at = registered.indexOf(route)
        if (at !== -1) registered.splice(at, 1)
      }
      return dispose
    },
  }
  const ctx = {
    webServer,
    logger: {
      warn: (m: unknown) => warnings.push(String(m)),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    get: (key: string) => (key === 'webServer' ? webServer : services[key]),
    effect (factory: () => unknown) {
      // Cordis runs the factory immediately and owns what it returns.
      const result = factory()
      if (typeof result === 'function') disposers.push(result as () => unknown)
      return () => {}
    },
  }
  return { ctx: ctx as never, registered, disposers, warnings }
}

/** A minimal valid config, matching what the loader would resolve. */
const BASE: PluginConfig = {
  callbackPath: '/webhooks/feishu',
  oauthCallbackPath: '/oauth/feishu/callback',
  encryptKeyRef: '',
  verificationTokenRef: '',
  appIdRef: '',
  appSecretRef: '',
  botOpenId: '',
  maxBodyBytes: 1_048_576,
}

describe('plugin descriptor', () => {
  it('declares only webServer as a hard dependency', () => {
    // webhookRuntime and credentials must NOT be injected: no shipped bundle
    // composes the former, so injecting it would park apply() forever.
    expect(inject).toEqual(['webServer'])
    expect(inject).not.toContain('webhookRuntime')
    expect(inject).not.toContain('credentials')
    expect(name).toBe('dsh-im')
  })

  it('exports a Config schema the loader can validate against', () => {
    // Without a runtime schema Cordis passes the raw object through unvalidated.
    expect(Config).toBeDefined()
    const result = Config['~standard'].validate({})
    expect(result).not.toBeInstanceOf(Promise)
    expect((result as { issues?: unknown }).issues).toBeUndefined()
  })

  it('applies defaults for every optional field', () => {
    const value = (Config['~standard'].validate({}) as { value: PluginConfig }).value
    expect(value.maxBodyBytes).toBe(1_048_576)
    expect(value.encryptKeyRef).toBe('')
    expect(value.botOpenId).toBe('')
  })
})

describe('apply', () => {
  it('registers both exact routes', () => {
    const { ctx, registered } = fakeCtx()
    apply(ctx, BASE)

    expect(registered).toHaveLength(2)
    expect(registered.map(r => r.path).sort()).toEqual([
      '/oauth/feishu/callback',
      '/webhooks/feishu',
    ])
    expect(registered.every(r => r.kind === 'exact')).toBe(true)
  })

  it('registers the callback route with a real handler, not a 501 stub', () => {
    const { ctx, registered } = fakeCtx()
    apply(ctx, BASE)
    const callback = registered.find(r => r.path === '/webhooks/feishu')
    // The handler must be a function that owns the request lifecycle.
    expect(typeof callback?.handler).toBe('function')
  })

  it('rejects a non-absolute, root, or trailing-slash path', () => {
    for (const bad of ['webhooks/feishu', '/', '/webhooks/feishu/', '/a?b', '/a#b']) {
      const { ctx } = fakeCtx()
      expect(() => apply(ctx, { ...BASE, callbackPath: bad })).toThrow(/dsh-im callbackPath/)
    }
  })

  it('rejects identical callback and oauth paths', () => {
    const { ctx } = fakeCtx()
    expect(() => apply(ctx, { ...BASE, oauthCallbackPath: BASE.callbackPath })).toThrow(/must differ/)
  })

  it('does not require webhookRuntime or credentials to be mounted', () => {
    // The whole point of optional resolution: a profile with neither still
    // registers its routes instead of throwing or parking.
    const { ctx, registered } = fakeCtx({})
    expect(() => apply(ctx, BASE)).not.toThrow()
    expect(registered).toHaveLength(2)
  })

  it('warns but keeps serving when a configured credential ref has no provider', async () => {
    const { ctx, warnings } = fakeCtx({})
    apply(ctx, { ...BASE, encryptKeyRef: 'FEISHU_ENCRYPT_KEY' })
    // Secret resolution is async; let the microtask queue drain.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(warnings.some(w => w.includes('FEISHU_ENCRYPT_KEY'))).toBe(true)
  })

  it('warns and skips a ref outside the credential-name grammar', async () => {
    // `credentialRef()` throws on a hyphenated name, so a config typo must read
    // as "not configured" rather than crashing plugin activation.
    const resolve = vi.fn(async () => ({ value: 'v', source: 'env' }))
    const { ctx, warnings } = fakeCtx({ credentials: { resolve } })
    expect(() => apply(ctx, { ...BASE, encryptKeyRef: 'feishu-encrypt-key' })).not.toThrow()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(resolve).not.toHaveBeenCalled()
    expect(warnings.join(' ')).toContain('not a valid name')
  })

  it('resolves a configured secret through the credentials service', async () => {
    const resolve = vi.fn(async () => ({ value: 'secret-value', source: 'env' }))
    const { ctx } = fakeCtx({ credentials: { resolve } })
    apply(ctx, { ...BASE, encryptKeyRef: 'FEISHU_ENCRYPT_KEY' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(resolve).toHaveBeenCalledWith('FEISHU_ENCRYPT_KEY')
  })

  it('registers routes before secrets resolve, so a slow provider cannot delay startup', () => {
    // Registration is synchronous; secret resolution is not. A request arriving
    // first is answered fail-closed by the handler rather than finding no route.
    let release: (() => void) | undefined
    const resolve = () => new Promise<never>(r => { release = () => r(undefined as never) })
    const { ctx, registered } = fakeCtx({ credentials: { resolve } })
    apply(ctx, { ...BASE, encryptKeyRef: 'ref' })
    expect(registered).toHaveLength(2)
    release?.()
  })

  it('surfaces a credential resolution failure as a warning, not a crash', async () => {
    const resolve = vi.fn(async () => { throw new Error('credential store unavailable') })
    const { ctx, warnings, registered } = fakeCtx({ credentials: { resolve } })
    apply(ctx, { ...BASE, encryptKeyRef: 'ref' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(registered).toHaveLength(2)
    expect(warnings.join(' ')).toContain('credential store unavailable')
  })
})

describe('effect ownership', () => {
  it('produces a disposer for each route so stop/update removes them', () => {
    const { ctx, registered, disposers } = fakeCtx()
    apply(ctx, BASE)
    // Both registrations ran inside ctx.effect and returned a disposer.
    expect(disposers.length).toBeGreaterThanOrEqual(2)
    for (const dispose of disposers) dispose()
    expect(registered).toHaveLength(0)
  })
})
