/**
 * Bounded raw-body intake for Feishu callback verification.
 *
 * Feishu signs the *exact bytes it sent*, so the body has to be read verbatim:
 * parsing it and re-serializing would change key order and whitespace and
 * invalidate the digest. Mirroring the GitHub adapter's reader keeps the same
 * guarantee without taking a dependency on another adapter package.
 *
 * @module dsh-im/body
 */

import type { IncomingMessage } from 'node:http'

/** HTTP refusal whose message is safe to return to the sender verbatim. */
export class CallbackHttpError extends Error {
  override readonly name = 'CallbackHttpError'

  constructor (
    readonly status: 400 | 401 | 403 | 405 | 413 | 415 | 503,
    message: string
  ) {
    super(message)
  }
}

/** Parse a decimal Content-Length or reject an ambiguous header. */
function contentLength (request: IncomingMessage): number | undefined {
  const value = request.headers['content-length']
  if (value === undefined) return undefined
  if (!/^(0|[1-9]\d*)$/.test(value))
    throw new CallbackHttpError(400, 'invalid Content-Length')
  const length = Number(value)
  if (!Number.isSafeInteger(length))
    throw new CallbackHttpError(413, 'request body is too large')
  return length
}

/**
 * Read one request body as exact, bounded UTF-8 text.
 * @param request - incoming request before any parser consumes it.
 * @param maxBodyBytes - positive byte ceiling.
 * @returns the decoded body after EOF.
 * @throws {CallbackHttpError} for invalid length, excess bytes, invalid UTF-8, or an aborted stream.
 */
export async function readBoundedUtf8Body (
  request: IncomingMessage,
  maxBodyBytes: number
): Promise<string> {
  const declared = contentLength(request)
  if (declared !== undefined && declared > maxBodyBytes) {
    request.resume()
    throw new CallbackHttpError(413, 'request body is too large')
  }

  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const raw of request) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string)
      size += chunk.byteLength
      if (size > maxBodyBytes) {
        request.resume()
        throw new CallbackHttpError(413, 'request body is too large')
      }
      chunks.push(chunk)
    }
  } catch (error: unknown) {
    if (error instanceof CallbackHttpError) throw error
    throw new CallbackHttpError(400, 'request body was aborted')
  }
  if (!request.complete)
    throw new CallbackHttpError(400, 'request body was aborted')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks, size)
    )
  } catch {
    // TextDecoder is the only statement in the try; Feishu sends UTF-8 JSON.
    throw new CallbackHttpError(400, 'request body is not valid UTF-8')
  }
}
