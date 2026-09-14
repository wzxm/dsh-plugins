import { describe, it, expect } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import { verifyFeishuSignature } from '../src/signature.ts'

/**
 * Known-answer vectors for the official Feishu algorithm:
 * `SHA256(timestamp + nonce + encryptKey + rawBody)`, lowercase hex.
 *
 * These are hard-coded on purpose. The previous version of this file computed
 * the expected signature with the same primitive it was testing, so swapping
 * SHA-256 for HMAC kept the suite green while breaking every real callback.
 * A literal digest cannot drift along with the implementation.
 */
const VECTORS = [
  {
    timestamp: '1700000000',
    nonce: 'abc123',
    encryptKey: 'test_secret',
    raw: '{"type":"event"}',
    signature: '1dfa32fb35e406239ad3d2291a30093e6e8a36d983597d1f2889ad36e6392935',
  },
  {
    timestamp: '1609430400',
    nonce: 'nonce-xyz',
    encryptKey: 'go4kwHmzAbCdEfGhIjKlMnOpQrStUvWx',
    raw: '{"schema":"2.0"}',
    signature: '1523c88652171738f0cd53ca86f83a13bc114917de476bd40fca86fadbb67156',
  },
  {
    // Empty body: the digest covers the three-part prefix alone.
    timestamp: '1',
    nonce: '2',
    encryptKey: 'k',
    raw: '',
    signature: '6d30b5ec8051d2dba74e747d2e99dda6b084e93b0d1af6146af659d5889457ab',
  },
] as const

describe('verifyFeishuSignature', () => {
  it('accepts every known-answer vector', () => {
    for (const v of VECTORS) {
      expect(verifyFeishuSignature(v.raw, v.timestamp, v.nonce, v.signature, v.encryptKey), v.signature).toBe(true)
    }
  })

  it('matches plain SHA-256 over the concatenated prefix, not HMAC', () => {
    const v = VECTORS[0]
    const sha256 = createHash('sha256').update(v.timestamp + v.nonce + v.encryptKey + v.raw).digest('hex')
    const hmac = createHmac('sha256', v.encryptKey).update(v.timestamp + v.nonce + v.encryptKey + v.raw).digest('hex')
    // The vector equals the SHA-256 digest, and differs from the HMAC digest the
    // old implementation would have produced — this is the exact regression guard.
    expect(sha256).toBe(v.signature)
    expect(hmac).not.toBe(v.signature)
    expect(verifyFeishuSignature(v.raw, v.timestamp, v.nonce, hmac, v.encryptKey)).toBe(false)
  })

  it('accepts an uppercase hex header', () => {
    const v = VECTORS[0]
    expect(verifyFeishuSignature(v.raw, v.timestamp, v.nonce, v.signature.toUpperCase(), v.encryptKey)).toBe(true)
  })

  it('rejects a tampered body, timestamp, nonce, or key', () => {
    const v = VECTORS[0]
    expect(verifyFeishuSignature(`${v.raw} `, v.timestamp, v.nonce, v.signature, v.encryptKey)).toBe(false)
    expect(verifyFeishuSignature(v.raw, '1700000001', v.nonce, v.signature, v.encryptKey)).toBe(false)
    expect(verifyFeishuSignature(v.raw, v.timestamp, 'abc124', v.signature, v.encryptKey)).toBe(false)
    expect(verifyFeishuSignature(v.raw, v.timestamp, v.nonce, v.signature, 'wrong_key')).toBe(false)
  })

  it('rejects malformed signatures without throwing', () => {
    const v = VECTORS[0]
    // Non-hex, wrong length, and empty must all fail closed rather than throw
    // from timingSafeEqual on mismatched buffer lengths.
    for (const bad of ['', 'zz'.repeat(32), v.signature.slice(0, -1), `${v.signature}a`, 'not-hex']) {
      expect(() => verifyFeishuSignature(v.raw, v.timestamp, v.nonce, bad, v.encryptKey)).not.toThrow()
      expect(verifyFeishuSignature(v.raw, v.timestamp, v.nonce, bad, v.encryptKey)).toBe(false)
    }
  })
})
