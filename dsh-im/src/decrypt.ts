/**
 * Decryption of an encrypted Feishu event callback.
 *
 * When an Encrypt Key is configured, Feishu replaces the whole callback body
 * with `{"encrypt":"<base64>"}`. The plaintext is recovered as:
 *
 *     key        = SHA256(encryptKey)          // raw 32 bytes, not hex
 *     payload    = base64decode(encrypt)
 *     iv         = payload[0..16]
 *     ciphertext = payload[16..]
 *     plaintext  = AES-256-CBC(key, iv, ciphertext), PKCS#7 unpadded
 *
 * Two details are easy to get wrong and are deliberate here:
 *
 * - **The key is the digest bytes, not the hex string.** Passing
 *   `digest('hex')` would give a 64-byte key and `createDecipheriv` would reject
 *   it outright.
 * - **The IV is transmitted in-band**, prefixed to the ciphertext inside the
 *   same base64 blob. It is not a separate header.
 *
 * @module dsh-im/decrypt
 */

import { createDecipheriv, createHash } from 'node:crypto'

/** Length of the AES block, and therefore of the in-band IV prefix. */
const IV_BYTES = 16

/**
 * Decrypt one Feishu `encrypt` payload.
 * @param encrypted - the base64 `encrypt` field from the callback body.
 * @param encryptKey - the app's Encrypt Key, used as digest input.
 * @returns the decrypted UTF-8 JSON text.
 * @throws {Error} when the payload is too short to hold an IV, or the ciphertext
 *   is not authentic — a wrong key or a tampered body fails here, because
 *   PKCS#7 unpadding rejects a plaintext whose padding is malformed.
 */
export function decryptFeishuEvent (
  encrypted: string,
  encryptKey: string
): string {
  const key = createHash('sha256').update(encryptKey).digest()
  const payload = Buffer.from(encrypted, 'base64')
  // A payload of exactly one block carries an IV and no ciphertext, which cannot
  // be valid; `<= IV_BYTES` also rejects the empty and truncated cases.
  if (payload.length <= IV_BYTES) {
    throw new Error('feishu encrypted payload is too short to contain an IV')
  }
  const iv = payload.subarray(0, IV_BYTES)
  const ciphertext = payload.subarray(IV_BYTES)
  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  // `final()` performs the PKCS#7 unpadding and throws when it is malformed.
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]).toString('utf8')
}
