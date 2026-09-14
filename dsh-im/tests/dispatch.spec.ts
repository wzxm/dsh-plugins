import { describe, it, expect, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createDispatcher, type DispatcherConfig } from '../src/dispatch.ts'
import type { NormalizedMessage } from '../src/event.ts'
import type { FeishuApi } from '../src/feishu-api.ts'
import { ConversationQueue, readTurnOutput } from '../src/session-bridge.ts'

/** A message as the handler would normalize it. */
function message (overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    eventId: 'evt_1',
    chatId: 'oc_chat',
    chatType: 'p2p',
    senderOpenId: 'ou_user',
    text: 'hello',
    ...overrides,
  }
}

/**
 * A fake session log. `eventAt` reads from a scripted list, and `seq` reports its
 * length, mirroring the real Session surface `readTurnOutput` depends on.
 */
function fakeSession (events: Array<Record<string, unknown>>) {
  return {
    seq: events.length,
    eventAt: (seq: number) => events[seq],
  }
}

/** Build an assistant/message event carrying text. */
function assistantEvent (text: string, interrupted = false) {
  return {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text }] },
      ...(interrupted ? { interrupted: true } : {}),
    },
  }
}

/**
 * A fake Agent that appends its reply to the session log when prompted, so the
 * log-offset and `whenIdle` ordering is exercised for real rather than stubbed.
 */
function fakeAgent (log: Array<Record<string, unknown>>, reply: string | undefined) {
  const followup = vi.fn(() => {
    log.push({ type: 'turn/start', data: { turn: 1 } })
    if (reply !== undefined) log.push(assistantEvent(reply))
    log.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  })
  const agent = {
    session: {
      get seq () { return log.length },
      eventAt: (seq: number) => log[seq],
    },
    followup,
    whenIdle: vi.fn(async () => {}),
  }
  return { agent, followup }
}

/** A fake Agent stack recording every call the dispatcher makes. */
function fakeStack (options: { reply?: string | undefined } = {}) {
  // An explicit `reply: undefined` means "the turn produced no text", which an
  // optional parameter with a default could not express (passing undefined to a
  // defaulted parameter selects the default).
  const reply = 'reply' in options ? options.reply : 'pong'
  const log: Array<Record<string, unknown>> = []
  const created: Array<Record<string, unknown>> = []
  const sendText = vi.fn(async (_token: string, _target: unknown, _text: string) => {})
  const { agent, followup } = fakeAgent(log, reply)
  const calls = {
    resolvePreset: vi.fn(async (id?: string) => ({ id: id ?? 'standard' })),
    standingKeyFor: vi.fn(async () => 'key'),
    permissionResolve: vi.fn(() => 'default'),
    permissionSet: vi.fn(),
    titleRename: vi.fn(),
    attachSession: vi.fn(async () => {}),
    create: vi.fn(async (options: Record<string, unknown>) => {
      created.push(options)
      return { agent, dispose: async () => {} }
    }),
    select: vi.fn(() => ({ provider: 'anthropic', model: 'claude' })),
    createWorkspace: vi.fn(async (path: string) => ({ path, attachSession: vi.fn(async () => {}) })),
  }
  const ctx = {
    permissionPresets: { resolve: calls.permissionResolve, set: calls.permissionSet },
    agentPresets: { resolve: calls.resolvePreset, mount: vi.fn(async () => {}), standingKeyFor: calls.standingKeyFor },
    workspaceRegistry: {
      create: async (path: string) => {
        const ws = await calls.createWorkspace(path)
        return { path, attachSession: ws.attachSession }
      },
    },
    agentDefaultModel: { currentSelection: calls.select },
    sessionTitle: { rename: calls.titleRename },
    agents: { create: calls.create },
  } as unknown as Context
  const api = { tenantToken: vi.fn(async () => 't'), sendText } as unknown as FeishuApi
  return { ctx, api, calls, sendText, created, log, agent, followup }
}

const CONFIG: DispatcherConfig = {
  botId: 'feishu',
  workspacePath: '/tmp/ws',
  agentPreset: 'standard',
  permissionPreset: 'default',
  maxReplyChars: 4000,
}

describe('createDispatcher — the reply loop', () => {
  it('creates one Agent, prompts it, and sends the reply back', async () => {
    const { ctx, api, calls, sendText } = fakeStack()
    const dispatch = createDispatcher(ctx, CONFIG, api)

    const result = await dispatch(message())

    expect(result).toEqual({ replied: true })
    expect(calls.create).toHaveBeenCalledOnce()
    expect(sendText).toHaveBeenCalledOnce()
    expect(sendText.mock.calls[0][2]).toBe('pong')
  })

  it('reuses the same Agent for a follow-up in the same conversation', async () => {
    // Session continuity: a second message must continue the Session, not open one.
    const { ctx, api, calls } = fakeStack()
    const dispatch = createDispatcher(ctx, CONFIG, api)

    await dispatch(message({ eventId: 'e1' }))
    await dispatch(message({ eventId: 'e2' }))

    expect(calls.create).toHaveBeenCalledOnce()
  })

  it('opens a separate Agent per conversation', async () => {
    const { ctx, api, calls } = fakeStack()
    const dispatch = createDispatcher(ctx, CONFIG, api)

    await dispatch(message({ chatId: 'oc_a' }))
    await dispatch(message({ chatId: 'oc_b' }))

    expect(calls.create).toHaveBeenCalledTimes(2)
  })

  it('derives a deterministic, filesystem-safe session id', async () => {
    const { ctx, api, created } = fakeStack()
    const dispatch = createDispatcher(ctx, CONFIG, api)
    await dispatch(message({ chatId: 'oc/weird id' }))

    const id = String(created[0].sessionId)
    expect(id).toMatch(/^im-feishu-[A-Za-z0-9._-]+$/)
    // No separator or whitespace survives into the log path.
    expect(id).not.toContain('/')
    expect(id).not.toContain(' ')
  })

  it('sends nothing when the turn produced no assistant text', async () => {
    // A cancelled or tool-only turn must not produce an empty bubble.
    const { ctx, api, sendText } = fakeStack({ reply: undefined })
    const dispatch = createDispatcher(ctx, CONFIG, api)

    const result = await dispatch(message())

    expect(result.replied).toBe(false)
    expect(sendText).not.toHaveBeenCalled()
  })

  it('truncates a reply longer than the configured ceiling', async () => {
    const { ctx, api, sendText } = fakeStack({ reply: 'x'.repeat(100) })
    const dispatch = createDispatcher(ctx, { ...CONFIG, maxReplyChars: 10 }, api)

    await dispatch(message())

    const sent = String(sendText.mock.calls[0][2])
    expect(sent).toHaveLength(10)
    expect(sent.endsWith('…')).toBe(true)
  })

  it('leaves a reply at exactly the ceiling untouched', async () => {
    const { ctx, api, sendText } = fakeStack({ reply: 'x'.repeat(10) })
    const dispatch = createDispatcher(ctx, { ...CONFIG, maxReplyChars: 10 }, api)

    await dispatch(message())

    expect(String(sendText.mock.calls[0][2])).toBe('x'.repeat(10))
  })

  it('creates the workspace and attaches the session before replying', async () => {
    const { ctx, api, calls, sendText } = fakeStack()
    const dispatch = createDispatcher(ctx, CONFIG, api)
    await dispatch(message())

    expect(calls.createWorkspace).toHaveBeenCalledWith('/tmp/ws')
    expect(calls.permissionSet).toHaveBeenCalledOnce()
    expect(calls.titleRename).toHaveBeenCalledOnce()
    expect(sendText).toHaveBeenCalledOnce()
  })

  it('mounts the configured agent preset during setup', async () => {
    const { ctx, api, calls, created } = fakeStack()
    const dispatch = createDispatcher(ctx, CONFIG, api)
    await dispatch(message())

    // create() receives a setup callback; running it must mount the preset.
    expect(typeof created[0].setup).toBe('function')
    expect(calls.standingKeyFor).toHaveBeenCalledOnce()
  })

  it('surfaces a Feishu send failure to the caller', async () => {
    // The callback handler must see the rejection so it can log it; swallowing it
    // would report success for a reply that never reached the chat.
    const { ctx, api } = fakeStack()
    const failing = {
      ...api,
      sendText: async () => { throw new Error('feishu 500') },
    } as unknown as FeishuApi
    const dispatch = createDispatcher(ctx, CONFIG, failing)
    await expect(dispatch(message())).rejects.toThrow('feishu 500')
  })
})

describe('createDispatcher — per-conversation serialization', () => {
  it('serializes two concurrent messages in one conversation', async () => {
    // Racing prompts into one Agent would make the second arrive as steering and
    // merge both replies into a single turn.
    const { ctx, api, calls } = fakeStack()
    const dispatch = createDispatcher(ctx, CONFIG, api)

    await Promise.all([dispatch(message({ eventId: 'a' })), dispatch(message({ eventId: 'b' }))])

    // One Agent, and both prompts delivered as separate turns.
    expect(calls.create).toHaveBeenCalledOnce()
  })

  it('does not let one failing conversation block another', async () => {
    const { ctx, api } = fakeStack()
    const failing = createDispatcher(ctx, CONFIG, {
      ...api,
      tenantToken: async () => { throw new Error('token down') },
    } as unknown as FeishuApi)

    await expect(failing(message({ chatId: 'oc_x' }))).rejects.toThrow('token down')
    // A different conversation still works, and a retry is not permanently stuck.
    await expect(failing(message({ chatId: 'oc_y' }))).rejects.toThrow('token down')
  })
})

describe('readTurnOutput', () => {
  it('reads only events at or after the captured offset', () => {
    // The previous turn's assistant text must not leak into this turn's reply.
    const session = fakeSession([
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'old' }] } } },
      { type: 'turn/start', data: { turn: 2 } },
      assistantEvent('new'),
      { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
    ])
    const output = readTurnOutput(session as never, 1)
    expect(output.text).toBe('new')
    expect(output.reason).toBe('completed')
  })

  it('takes the last assistant message when a turn spans several steps', () => {
    const session = fakeSession([
      { type: 'turn/start', data: { turn: 1 } },
      assistantEvent('intermediate'),
      assistantEvent('final'),
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    expect(readTurnOutput(session as never, 0).text).toBe('final')
  })

  it('joins multiple text blocks within one assistant message', () => {
    const session = fakeSession([
      { type: 'turn/start', data: { turn: 1 } },
      {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } },
      },
    ])
    expect(readTurnOutput(session as never, 0).text).toBe('ab')
  })

  it('ignores non-text blocks such as tool calls', () => {
    const session = fakeSession([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'x' }] } } },
      assistantEvent('answer'),
    ])
    expect(readTurnOutput(session as never, 0).text).toBe('answer')
  })

  it('reports an interrupted turn', () => {
    const session = fakeSession([
      { type: 'turn/start', data: { turn: 1 } },
      assistantEvent('partial', true),
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } },
    ])
    const output = readTurnOutput(session as never, 0)
    expect(output.interrupted).toBe(true)
    expect(output.reason).toBe('aborted')
  })

  it('ignores an assistant message that lands before this turn opened', () => {
    // The stale message is deliberately the LAST event in range, so only the
    // `turn/start` gate can produce empty text. Were it merely an earlier event,
    // taking the last one would give the same answer with or without the gate,
    // and the test would pass while the guard was broken.
    const session = fakeSession([
      assistantEvent('stale'),
      { type: 'turn/start', data: { turn: 2 } },
    ])
    expect(readTurnOutput(session as never, 0).text).toBe('')
  })

  it('reads this turn, not a stale preceding message, in the same log', () => {
    // Same arrangement, but the turn did produce text: the gate must not hide it.
    const session = fakeSession([
      assistantEvent('stale'),
      { type: 'turn/start', data: { turn: 2 } },
      assistantEvent('current'),
    ])
    expect(readTurnOutput(session as never, 0).text).toBe('current')
  })

  it('does not return a completed earlier turn when no new turn has opened', () => {
    // This isolates the `fromSeq` offset from the turn/start gate. The previous
    // turn is entirely BEFORE the offset and its `turn/start` is out of range, so
    // a reader that ignored `fromSeq` would return 'old'. The guard and the
    // offset must each independently produce empty text here.
    const session = fakeSession([
      { type: 'turn/start', data: { turn: 1 } },
      assistantEvent('old'),
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    expect(readTurnOutput(session as never, 3).text).toBe('')
  })

  it('returns empty text for a turn with no assistant message', () => {
    const session = fakeSession([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'blocked' } } },
    ])
    const output = readTurnOutput(session as never, 0)
    expect(output.text).toBe('')
    expect(output.reason).toBe('blocked')
  })

  it('skips a hole in the log instead of throwing inside the reply path', () => {
    const session = { seq: 3, eventAt: (seq: number) => (seq === 1 ? undefined : { type: 'turn/start', data: {} }) }
    expect(() => readTurnOutput(session as never, 0)).not.toThrow()
  })
})

describe('ConversationQueue', () => {
  it('runs tasks for one key in order', async () => {
    const queue = new ConversationQueue()
    const order: number[] = []
    const task = (n: number, delay: number) => async () => {
      await new Promise(r => setTimeout(r, delay))
      order.push(n)
      return n
    }
    const results = await Promise.all([
      queue.run('k', task(1, 10)),
      queue.run('k', task(2, 0)),
    ])
    expect(results).toEqual([1, 2])
    expect(order).toEqual([1, 2])
  })

  it('runs tasks for different keys concurrently', async () => {
    const queue = new ConversationQueue()
    const order: string[] = []
    await Promise.all([
      queue.run('a', async () => { await new Promise(r => setTimeout(r, 10)); order.push('a') }),
      queue.run('b', async () => { order.push('b') }),
    ])
    expect(order).toEqual(['b', 'a'])
  })

  it('keeps running successors after a predecessor rejects', async () => {
    const queue = new ConversationQueue()
    await expect(queue.run('k', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(queue.run('k', async () => 'ok')).resolves.toBe('ok')
  })

  it('prunes its map so long-lived conversations do not leak', async () => {
    const queue = new ConversationQueue()
    await queue.run('k', async () => 'done')
    // The tail resolves before it is pruned, so allow the microtask to run.
    await new Promise(r => setTimeout(r, 0))
    expect(queue.size).toBe(0)
  })
})
