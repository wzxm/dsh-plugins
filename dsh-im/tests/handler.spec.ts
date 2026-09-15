import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createFeishuHandler } from '../src/handler.ts'
import type { NormalizedMessage } from '../src/event.ts'

const BOT = 'ou_bot'
const ENCRYPT_KEY = 'encrypt_key_for_tests'
const VERIFICATION_TOKEN = 'verify-token'

/** Official Feishu signature: plain SHA-256 over the concatenated prefix. */
function sign (raw: string, timestamp: string, nonce: string, key: string): string {
  return createHash('sha256').update(timestamp + nonce + key + raw).digest('hex')
}

/** Encrypt the way Feishu does: SHA256(key) raw bytes, in-band IV, base64. */
function encrypt (plaintext: string, encryptKey: string): string {
  const key = createHash('sha256').update(encryptKey).digest()
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, body]).toString('base64')
}

/** Minimal IncomingMessage backed by a buffer. */
function request (
  body: string,
  init: { method?: string; contentType?: string; headers?: Record<string, string> } = {},
): IncomingMessage {
  const stream = Readable.from([Buffer.from(body, 'utf8')]) as unknown as IncomingMessage
  const headers: Record<string, string> = {
    'content-type': init.contentType ?? 'application/json',
    ...init.headers,
  }
  stream.method = init.method ?? 'POST'
  stream.headers = headers
  // The handler reads distinct headers to reject ambiguity, so mirror them.
  stream.headersDistinct = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), [v]]),
  )
  Object.defineProperty(stream, 'complete', { value: true })
  return stream
}

/** Minimal ServerResponse that records what was written. */
function response (): ServerResponse & { status: number; body: string; headers: Record<string, string> } {
  const state = {
    status: 0,
    body: '',
    headers: {} as Record<string, string>,
    setHeader (name: string, value: string) { state.headers[name.toLowerCase()] = value },
    writeHead (status: number, extra?: Record<string, string>) {
      state.status = status
      if (extra !== undefined) {
        for (const [k, v] of Object.entries(extra)) state.headers[k.toLowerCase()] = v
      }
      return state as unknown as ServerResponse
    },
    end (chunk?: string) { state.body = chunk ?? '' },
  }
  return state as unknown as ServerResponse & { status: number; body: string; headers: Record<string, string> }
}

/** A plausible context: only `logger.warn` is exercised. */
const context = () => ({ logger: { warn: vi.fn() } }) as never

/** A v2.0 envelope carrying a text message. */
function envelope (overrides: {
  chatType?: string
  text?: string
  mentions?: unknown[]
  eventId?: string
  chatId?: string
  senderOpenId?: string
} = {}): string {
  const {
    chatType = 'p2p',
    text = 'hello',
    mentions,
    eventId = 'evt_1',
    chatId = 'oc_chat_1',
    senderOpenId = 'ou_user_1',
  } = overrides
  return JSON.stringify({
    schema: '2.0',
    header: { event_id: eventId, event_type: 'im.message.receive_v1' },
    event: {
      sender: { sender_id: { open_id: senderOpenId } },
      message: {
        message_id: 'om_msg_1',
        chat_id: chatId,
        chat_type: chatType,
        message_type: 'text',
        content: JSON.stringify({ text }),
        ...(mentions === undefined ? {} : { mentions }),
      },
    },
  })
}

/** Build a handler plus a recorder of dispatched messages. */
function harness (config: Partial<Parameters<typeof createFeishuHandler>[1]> = {}) {
  const dispatched: NormalizedMessage[] = []
  const handler = createFeishuHandler(context(), {
    encryptKey: ENCRYPT_KEY,
    verificationToken: VERIFICATION_TOKEN,
    botOpenId: BOT,
    maxBodyBytes: 1_048_576,
    onMessage: (m) => { dispatched.push(m) },
    ...config,
  })
  return { handler, dispatched }
}

/** POST a signed, encrypted callback and return the response. */
async function postEncrypted (
  handler: ReturnType<typeof createFeishuHandler>,
  plaintext: string,
  opts: { key?: string; tamperSignature?: boolean; omitHeaders?: string[] } = {},
) {
  const key = opts.key ?? ENCRYPT_KEY
  const body = JSON.stringify({ encrypt: encrypt(plaintext, key) })
  const timestamp = '1700000000'
  const nonce = 'nonce-1'
  const headers: Record<string, string> = {
    'x-lark-request-timestamp': timestamp,
    'x-lark-request-nonce': nonce,
    'x-lark-signature': sign(body, timestamp, nonce, key),
  }
  if (opts.tamperSignature === true) headers['x-lark-signature'] = 'f'.repeat(64)
  for (const omit of opts.omitHeaders ?? []) delete headers[omit]
  const res = response()
  await handler(request(body, { headers }), res)
  return res
}

describe('createFeishuHandler — method and content type', () => {
  it('rejects non-POST with 405 and an Allow header', async () => {
    const { handler } = harness()
    const res = response()
    await handler(request('{}', { method: 'GET' }), res)
    expect(res.status).toBe(405)
    expect(res.headers['allow']).toBe('POST')
  })

  it('rejects a non-JSON content type with 415', async () => {
    const { handler } = harness()
    const res = response()
    await handler(request('{}', { contentType: 'text/plain' }), res)
    expect(res.status).toBe(415)
  })

  it('accepts application/json with a utf-8 charset', async () => {
    const { handler } = harness({ encryptKey: undefined, verificationToken: undefined })
    const res = response()
    await handler(request(envelope(), { contentType: 'application/json; charset=utf-8' }), res)
    expect(res.status).toBe(200)
  })
})

describe('createFeishuHandler — signature is verified before anything else', () => {
  it('accepts a correctly signed encrypted callback', async () => {
    const { handler, dispatched } = harness()
    const res = await postEncrypted(handler, envelope({ text: 'hi' }))
    expect(res.status).toBe(200)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]?.text).toBe('hi')
  })

  it('rejects a bad signature with 401 and dispatches nothing', async () => {
    const { handler, dispatched } = harness()
    const res = await postEncrypted(handler, envelope(), { tamperSignature: true })
    // The signature verifies but the ciphertext was encrypted with a different
    // key, so decryption produces garbage that fails JSON parsing. The handler
    // returns 401 and does not dispatch.
    expect(res.status).toBe(401)
    expect(dispatched).toHaveLength(0)
  })

  it('rejects an HMAC-signed body, pinning the algorithm', async () => {
    // The exact regression from the previous implementation: these are the bytes
    // an HMAC-based verifier would have accepted.
    const { handler, dispatched } = harness()
    const body = JSON.stringify({ encrypt: encrypt(envelope(), ENCRYPT_KEY) })
    const timestamp = '1700000000'
    const nonce = 'nonce-1'
    const hmac = createHmac('sha256', ENCRYPT_KEY)
      .update(timestamp + nonce + ENCRYPT_KEY + body).digest('hex')
    const res = response()
    await handler(
      request(body, { headers: { 'x-lark-request-timestamp': timestamp, 'x-lark-request-nonce': nonce, 'x-lark-signature': hmac } }),
      res,
    )
    // The HMAC does not match a plain-SHA-256 signature, so the
    // handler rejects the body with 401.
    expect(res.status).toBe(401)
    expect(dispatched).toHaveLength(0)
  })

  it('rejects a missing signature header with 400', async () => {
    const { handler } = harness()
    const res = await postEncrypted(handler, envelope(), { omitHeaders: ['x-lark-signature'] })
    expect(res.status).toBe(400)
  })

  it('rejects an unsigned callback rather than processing it', async () => {
    // Signature enforcement is not optional when a key is configured.
    const { handler, dispatched } = harness()
    const res = response()
    await handler(request(envelope()), res)
    expect(res.status).toBe(400)
    expect(dispatched).toHaveLength(0)
  })
})

describe('createFeishuHandler — decryption', () => {
  it('rejects a callback encrypted with the wrong key', async () => {
    const { handler, dispatched } = harness()
    // Signature is computed with the configured key (so it verifies), but the
    // ciphertext itself was produced with a different key.
    const body = JSON.stringify({ encrypt: encrypt(envelope(), 'a_different_key') })
    const timestamp = '1700000000'
    const nonce = 'nonce-1'
    const res = response()
    await handler(
      request(body, { headers: { 'x-lark-request-timestamp': timestamp, 'x-lark-request-nonce': nonce, 'x-lark-signature': sign(body, timestamp, nonce, ENCRYPT_KEY) } }),
      res,
    )
    // The signature verifies but the ciphertext was encrypted with a different
    // key, so decryption produces garbage that fails JSON parsing. The handler
    // returns 401 and does not dispatch.
    expect(res.status).toBe(401)
    expect(dispatched).toHaveLength(0)
  })

  it('refuses an encrypted body when no key is configured', async () => {
    const { handler } = harness({ encryptKey: undefined, verificationToken: undefined })
    const res = response()
    await handler(request(JSON.stringify({ encrypt: encrypt(envelope(), ENCRYPT_KEY) })), res)
    expect(res.status).toBe(503)
  })

  it('accepts a plaintext body when no key is configured', async () => {
    const { handler, dispatched } = harness({ encryptKey: undefined, verificationToken: undefined })
    const res = response()
    await handler(request(envelope({ text: 'plain' })), res)
    expect(res.status).toBe(200)
    expect(dispatched[0]?.text).toBe('plain')
  })
})

describe('createFeishuHandler — url_verification handshake', () => {
  it('echoes the challenge and creates no delivery', async () => {
    const { handler, dispatched } = harness()
    const payload = JSON.stringify({ type: 'url_verification', challenge: 'chal-123', token: VERIFICATION_TOKEN })
    const res = await postEncrypted(handler, payload)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ challenge: 'chal-123' })
    expect(dispatched).toHaveLength(0)
  })

  it('rejects a challenge carrying the wrong verification token', async () => {
    const { handler } = harness()
    const payload = JSON.stringify({ type: 'url_verification', challenge: 'c', token: 'wrong' })
    const res = await postEncrypted(handler, payload)
    expect(res.status).toBe(401)
  })
})

describe('createFeishuHandler — messages not addressed to the bot', () => {
  it('answers 200 without dispatching so Feishu does not retry', async () => {
    // A group message with no mention, and a non-text message: both are
    // non-actionable, and a non-2xx would schedule endless redelivery.
    const { handler, dispatched } = harness()
    const res = await postEncrypted(handler, envelope({ chatType: 'group', text: 'just chatting' }))
    expect(res.status).toBe(200)
    expect(dispatched).toHaveLength(0)
  })

  it('dispatches a group message that mentions the bot', async () => {
    const { handler, dispatched } = harness()
    const res = await postEncrypted(
      handler,
      envelope({
        chatType: 'group',
        text: '@_user_1 do the thing',
        mentions: [{ key: '@_user_1', name: 'Bot', id: { open_id: BOT } }],
      }),
    )
    expect(res.status).toBe(200)
    expect(dispatched[0]?.text).toBe('do the thing')
  })

  it('does not dispatch when a group message mentions only someone else', async () => {
    const { handler, dispatched } = harness()
    const res = await postEncrypted(
      handler,
      envelope({ chatType: 'group', text: '@_user_2 hi', mentions: [{ key: '@_user_2', id: { open_id: 'ou_other' } }] }),
    )
    expect(res.status).toBe(200)
    expect(dispatched).toHaveLength(0)
  })
})

describe('createFeishuHandler — failure containment', () => {
  it('answers 500 without leaking the body when the sink throws', async () => {
    const ctx = context()
    const handler = createFeishuHandler(ctx, {
      encryptKey: ENCRYPT_KEY,
      verificationToken: VERIFICATION_TOKEN,
      botOpenId: BOT,
      maxBodyBytes: 1_048_576,
      onMessage: () => { throw new Error('sink exploded') },
    })
    const res = await postEncrypted(handler, envelope())
    expect(res.status).toBe(500)
    expect(res.body).not.toContain('sink exploded')
  })

  it('answers 413 for a body over the ceiling', async () => {
    const { handler } = harness({ maxBodyBytes: 16 })
    const res = response()
    await handler(request(envelope()), res)
    expect(res.status).toBe(413)
  })

  it('rejects a non-JSON body with 400', async () => {
    const { handler } = harness({ encryptKey: undefined, verificationToken: undefined })
    const res = response()
    await handler(request('not json at all'), res)
    expect(res.status).toBe(400)
  })
})
