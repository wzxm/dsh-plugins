/**
 * Feishu callback HTTP handler: authenticate, parse, normalize, dispatch.
 *
 * Ordering is the whole security story, and each step must precede the next:
 *
 * 1. **Method and content type** — a POST of JSON, else 405/415.
 * 2. **Read the raw body verbatim** — the signature covers the exact bytes, so
 *    the body must not be parsed before it is verified.
 * 3. **Verify the signature** — before decrypting, before parsing, before any
 *    work an unauthenticated sender could amplify. Feishu sends
 *    `X-Lark-Signature` on every callback once an Encrypt Key exists.
 * 4. **Decrypt if the body is an envelope** — a `{"encrypt":"…"}` wrapper is not
 *    an event, and its plaintext is what carries the challenge or event.
 * 5. **Answer `url_verification`** — the one-time handshake returns the
 *    `challenge` verbatim and never becomes a delivery.
 * 6. **Normalize and dispatch** — anything not addressed to the bot is answered
 *    `200` without a delivery, because a non-2xx makes Feishu retry.
 *
 * @module dsh-im/handler
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { CallbackHttpError, readBoundedUtf8Body } from './body.ts'
import { decryptFeishuEvent } from './decrypt.ts'
import { normalizeCallback, parseCallback, type NormalizedMessage } from './event.ts'
import { verifyFeishuSignature } from './signature.ts'

/** Resolved ingress configuration for one bot instance. */
export interface FeishuHandlerConfig {
  /** Encrypt Key; enables signature verification and payload decryption. */
  readonly encryptKey: string | undefined
  /** Verification Token from the app's event subscription page. */
  readonly verificationToken: string | undefined
  /** The bot's own open_id, matched against message mentions. */
  readonly botOpenId: string
  /** Raw body ceiling in bytes. */
  readonly maxBodyBytes: number
  /** Called for each message addressed to the bot. */
  readonly onMessage: (message: NormalizedMessage) => void | Promise<void>
}

/** Send one empty or plain-text response exactly once. */
function respond (response: ServerResponse, status: number, message?: string): void {
  if (message === undefined) {
    response.writeHead(status)
    response.end()
    return
  }
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(message)
}

/** Answer with a JSON body, for the challenge handshake. */
function respondJson (response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  })
  response.end(body)
}

/** Read one unambiguous non-empty request header. */
function requiredHeader (request: IncomingMessage, name: string): string {
  const values = request.headersDistinct[name]
  const value = values?.[0]
  if (values?.length !== 1 || value === undefined || value.trim() === '') {
    throw new CallbackHttpError(400, `missing ${name} header`)
  }
  return value
}

/** Whether Content-Type names JSON, with at most one UTF-8 charset parameter. */
function isJsonContentType (value: string | undefined): boolean {
  if (value === undefined) return false
  const parts = value.split(';').map(part => part.trim())
  const [mediaType, parameter, ...extra] = parts
  if (mediaType?.toLowerCase() !== 'application/json') return false
  if (parameter === undefined) return true
  return extra.length === 0 && /^charset=(?:utf-8|"utf-8")$/i.test(parameter)
}

/**
 * Unwrap a `{"encrypt":"…"}` envelope.
 * @param raw - the verified raw body.
 * @param encryptKey - the configured Encrypt Key.
 * @returns the plaintext JSON, or the original body when it is not an envelope.
 * @throws {CallbackHttpError} when the body claims to be encrypted but cannot be decrypted.
 */
function unwrap (raw: string, encryptKey: string | undefined): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Not JSON at all; the caller's parser reports the shape problem.
    return raw
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return raw
  const encrypted = (parsed as Record<string, unknown>)['encrypt']
  if (typeof encrypted !== 'string' || encrypted === '') return raw
  if (encryptKey === undefined || encryptKey === '') {
    throw new CallbackHttpError(503, 'an encrypted callback arrived but no Encrypt Key is configured')
  }
  try {
    return decryptFeishuEvent(encrypted, encryptKey)
  } catch {
    // A decrypt failure means the key is wrong or the body was tampered with.
    // Either way the content is not trustworthy, so it never reaches parsing.
    throw new CallbackHttpError(401, 'encrypted callback could not be decrypted')
  }
}

/**
 * Create the callback handler for one bot.
 * @param _ctx - plugin context, reserved for logging.
 * @param config - resolved ingress configuration.
 * @returns an HTTP handler that answers after in-memory dispatch.
 */
export function createFeishuHandler (
  _ctx: Context,
  config: FeishuHandlerConfig
): WebRoute['handler'] {
  return async (request, response) => {
    try {
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST')
        throw new CallbackHttpError(405, 'method not allowed')
      }
      if (!isJsonContentType(request.headers['content-type'])) {
        throw new CallbackHttpError(415, 'content type must be application/json')
      }

      const raw = await readBoundedUtf8Body(request, config.maxBodyBytes)

      // Verification precedes decryption and parsing: nothing derived from an
      // unauthenticated body is allowed to influence the response.
      if (config.encryptKey !== undefined && config.encryptKey !== '') {
        const timestamp = requiredHeader(request, 'x-lark-request-timestamp')
        const nonce = requiredHeader(request, 'x-lark-request-nonce')
        const signature = requiredHeader(request, 'x-lark-signature')
        if (!verifyFeishuSignature(raw, timestamp, nonce, signature, config.encryptKey)) {
          throw new CallbackHttpError(401, 'invalid signature')
        }
      }

      const plaintext = unwrap(raw, config.encryptKey)
      // `parseCallback` raises a plain Error for malformed JSON, which is a
      // client fault and must be a 400 rather than a 500.
      let callback: ReturnType<typeof parseCallback>
      try {
        callback = parseCallback(plaintext)
      } catch {
        throw new CallbackHttpError(400, 'callback body is not a valid JSON object')
      }

      // The one-time URL verification handshake: echo the challenge back and
      // stop. It is not an event and must never create a delivery.
      if (callback.type === 'url_verification' || callback.challenge !== undefined) {
        if (config.verificationToken !== undefined && config.verificationToken !== ''
          && callback.token !== config.verificationToken) {
          throw new CallbackHttpError(401, 'invalid verification token')
        }
        respondJson(response, 200, { challenge: callback.challenge ?? '' })
        return
      }

      const message = normalizeCallback(callback, config.botOpenId)
      if (message === null) {
        // Not addressed to us, or nothing actionable. Answer 200 so Feishu stops
        // retrying; a non-2xx would schedule redelivery of a message we will
        // never act on.
        respond(response, 200)
        return
      }

      await config.onMessage(message)
      respond(response, 200)
    } catch (error: unknown) {
      if (error instanceof CallbackHttpError) {
        respond(response, error.status, error.message)
        return
      }
      // Unknown failures are logged without the body, which may hold tenant data.
      _ctx.logger.warn('dsh-im: callback handling failed')
      respond(response, 500, 'callback handling failed')
    }
  }
}
