import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Verify a Feishu/Lark event-subscription callback signature.
 *
 * Feishu computes `SHA256(timestamp + nonce + encryptKey)` over the *concatenated
 * UTF-8 text* and then appends the raw request body to that digest input — the
 * concatenation order below is the whole algorithm:
 *
 *     digest = SHA256(timestamp + nonce + encryptKey + rawBody)
 *
 * Two easy mistakes this implementation deliberately avoids:
 *
 * - **It is not HMAC.** `encryptKey` is a literal segment of the message, not a
 *   key. Using `createHmac('sha256', encryptKey)` produces a different digest for
 *   every input, so every genuine callback would be rejected.
 * - **The digest is hex, lowercase.** Comparison is case-folded so an uppercase
 *   `X-Lark-Signature` header still verifies; the bytes are compared with
 *   `timingSafeEqual` rather than `===`, so a wrong signature cannot be found
 *   byte-by-byte through response timing.
 *
 * @param raw - the exact request body bytes, decoded as UTF-8. It must be the
 *   unmodified body: any reserialization of the JSON invalidates the digest.
 * @param timestamp - the `X-Lark-Request-Timestamp` header.
 * @param nonce - the `X-Lark-Request-Nonce` header.
 * @param signature - the `X-Lark-Signature` header to check.
 * @param encryptKey - the event subscription's Encrypt Key.
 * @returns `true` only when the signature matches.
 */
export function verifyFeishuSignature (
  raw: string,
  timestamp: string,
  nonce: string,
  signature: string,
  encryptKey: string
): boolean {
  const expected = createHash('sha256')
    .update(timestamp + nonce + encryptKey + raw)
    .digest()
  // A non-hex or wrong-length header cannot match; bail before the constant-time
  // compare, whose buffers must be the same length.
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false
  const provided = Buffer.from(signature, 'hex')
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}
