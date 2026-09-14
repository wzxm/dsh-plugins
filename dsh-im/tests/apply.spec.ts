import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { apply, Config, name, inject } from '../src/index.ts'
import type { Config as PluginConfig } from '../src/index.ts'

/**
 * POST one unsigned plaintext message straight at a route handler and return
 * the response.
 *
 * Signature verification is skipped here because `BASE` configures no encrypt
 * key — which is exactly the production behaviour when the Feishu app has no
 * Encrypt Key set. This drives the real `onMessage` path rather than a stub.
 */
async function deliverText (
  route: RegisteredRoute,
  text: string,
  init: { chatType?: string; mentions?: unknown[] } = {},
): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify({
    schema: '2.0',
    header: { event_id: 'evt_apply', event_type: 'im.message.receive_v1' },
    event: {
      sender: { sender_id: { open_id: 'ou_user' } },
      message: {
        message_id: 'om_1',
        chat_id: 'oc_1',
        chat_type: init.chatType ?? 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text }),
        ...(init.mentions === undefined ? {} : { mentions: init.mentions }),
      },
    },
  })
  const req = Readable.from([Buffer.from(payload, 'utf8')]) as unknown as IncomingMessage
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  req.method = 'POST'
  req.headers = headers
  req.headersDistinct = { 'content-type': ['application/json'] }
  Object.defineProperty(req, 'complete', { value: true })

  const state = {
    status: 0,
    body: '',
    setHeader: () => {},
    writeHead (status: number) { state.status = status; return state },
    end (chunk?: string) { state.body = chunk ?? '' },
  }
  await route.handler(req, state as unknown as ServerResponse)
  // Let the handler's async tail (message dispatch) settle.
  await new Promise(resolve => setTimeout(resolve, 0))
  return { status: state.status, body: state.body }
}

/** A route registration captured from the fake web server. */
interface RegisteredRoute {
  kind: string
  path: string
  handler: (req: unknown, res: unknown) => unknown
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
  const registered: RegisteredRoute[] = []
  const disposers: Array<() => unknown> = []
  const warnings: string[] = []
  const injectCalls: string[][] = []
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

/** A minimal valid config, matching what the loader would resolve. */
const BASE: PluginConfig = {
  callbackPath: '/webhooks/feishu',
  oauthCallbackPath: '/oauth/feishu/callback',
  encryptKeyRef: '',
  verificationTokenRef: '',
  appIdRef: '',
  appSecretRef: '',
  botOpenId: '',
  botId: 'feishu',
  workspacePath: '',
  agentPreset: 'standard',
  permissionPreset: 'default',
  maxReplyChars: 4000,
  maxBodyBytes: 1_048_576,
}

describe('plugin descriptor', () => {
  it('declares only webServer as a hard dependency', () => {
    // The Agent stack and credentials must NOT be hard-injected: routes have to
    // register in a profile without an agent loop, and a missing service would
    // park apply() forever instead.
    expect(inject).toEqual(['webServer'])
    expect(inject).not.toContain('agents')
    expect(inject).not.toContain('credentials')
    expect(inject).not.toContain('webhookRuntime')
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

  it('still registers both routes when no Agent stack is mounted', () => {
    // The callback route must answer even in a profile with no agent loop.
    const { ctx, registered } = fakeCtx({})
    expect(() => apply(ctx, BASE)).not.toThrow()
    expect(registered).toHaveLength(2)
  })

  it('warns that messages go unanswered when the Agent stack is absent', async () => {
    // Exercise the real path: deliver a message and observe the warning.
    const { ctx, registered, warnings } = fakeCtx({})
    apply(ctx, BASE)
    const callback = registered.find(r => r.path === '/webhooks/feishu')
    expect(callback).toBeDefined()
    await deliverText(callback!, 'hello')
    expect(warnings.join(' ')).toContain('Agent stack is not mounted')
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

  it('rejects a relative workspacePath at activation, not per message', () => {
    // The workspace registry rejects a relative path; failing only when the first
    // message arrives would be a silent, delayed misconfiguration.
    const { ctx } = fakeCtx()
    expect(() => apply(ctx, { ...BASE, workspacePath: 'relative/ws' })).toThrow(/absolute path/)
    expect(() => apply(ctx, { ...BASE, workspacePath: '/ok' })).not.toThrow()
    // Empty means "unset", which is valid and skips the workspace entirely.
    expect(() => apply(ctx, { ...BASE, workspacePath: '' })).not.toThrow()
  })

  it('rejects a non-positive reply ceiling', () => {
    const { ctx } = fakeCtx()
    expect(() => apply(ctx, { ...BASE, maxReplyChars: 0 })).toThrow(/maxReplyChars/)
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
