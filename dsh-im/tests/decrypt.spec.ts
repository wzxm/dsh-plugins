import { describe, it, expect } from 'vitest'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { decryptFeishuEvent } from '../src/decrypt.ts'

/**
 * Encrypt the way Feishu does, so the test exercises the real wire format
 * rather than a fixture: key = SHA256(encryptKey) raw bytes, a random IV
 * prefixed in-band to the ciphertext, all base64-encoded.
 */
function feishuEncrypt (plaintext: string, encryptKey: string): string {
  const key = createHash('sha256').update(encryptKey).digest()
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, ciphertext]).toString('base64')
}

const KEY = 'test_encrypt_key_1234567890'

describe('decryptFeishuEvent', () => {
  it('round-trips a payload it encrypted the same way', () => {
    const plaintext = JSON.stringify({ schema: '2.0', header: { event_id: 'e1' } })
    expect(decryptFeishuEvent(feishuEncrypt(plaintext, KEY), KEY)).toBe(plaintext)
  })

  it('round-trips a multi-block payload', () => {
    // Longer than one AES block, so padding and block chaining are exercised.
    const plaintext = JSON.stringify({ text: 'x'.repeat(500) })
    expect(decryptFeishuEvent(feishuEncrypt(plaintext, KEY), KEY)).toBe(plaintext)
  })

  it('round-trips a payload whose length is an exact block multiple', () => {
    // PKCS#7 adds a full block here; a naive unpadding would drop real bytes.
    for (const length of [15, 16, 31, 32, 47, 48]) {
      const plaintext = 'y'.repeat(length)
      expect(decryptFeishuEvent(feishuEncrypt(plaintext, KEY), KEY)).toBe(plaintext)
    }
  })

  it('handles UTF-8 outside the BMP', () => {
    const plaintext = '多字节文本 🎉 café'
    expect(decryptFeishuEvent(feishuEncrypt(plaintext, KEY), KEY)).toBe(plaintext)
  })

  it('rejects a wrong key', () => {
    const encrypted = feishuEncrypt('{"a":1}', KEY)
    expect(() => decryptFeishuEvent(encrypted, 'a_different_key')).toThrow()
  })

  it('rejects a tampered ciphertext', () => {
    const encrypted = feishuEncrypt('{"a":1}', KEY)
    const bytes = Buffer.from(encrypted, 'base64')
    // Flip a bit in the body, past the IV.
    bytes[20] = (bytes[20] as number) ^ 0xff
    expect(() => decryptFeishuEvent(bytes.toString('base64'), KEY)).toThrow()
  })

  it('rejects payloads too short to hold an IV', () => {
    // 16 bytes is IV-only; anything shorter cannot even carry one.
    for (const bad of ['', 'AAAA', Buffer.alloc(16).toString('base64')]) {
      expect(() => decryptFeishuEvent(bad, KEY)).toThrow(/too short/)
    }
  })

  it('derives a 32-byte key so aes-256 accepts it', () => {
    // Guards the `digest('hex')` mistake, which would yield 64 bytes and make
    // createDecipheriv throw a key-length error instead of decrypting.
    const digest = createHash('sha256').update(KEY).digest()
    expect(digest).toHaveLength(32)
    expect(() => decryptFeishuEvent(feishuEncrypt('{}', KEY), KEY)).not.toThrow()
  })
})
