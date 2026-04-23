import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

const HKDF_INFO = Buffer.from('anvx-dek-v1', 'utf-8')
const NONCE_LEN = 12

function masterKey(): Buffer {
  const raw = process.env.ANVX_MASTER_ENCRYPTION_KEY
  if (!raw) throw new Error('ANVX_MASTER_ENCRYPTION_KEY not set')
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) throw new Error('ANVX_MASTER_ENCRYPTION_KEY must decode to 32 bytes')
  return key
}

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '')
  if (hex.length !== 32) throw new Error('invalid UUID')
  return Buffer.from(hex, 'hex')
}

export function deriveWorkspaceDek(workspaceId: string): Buffer {
  const salt = uuidToBytes(workspaceId)
  const dek = hkdfSync('sha256', masterKey(), salt, HKDF_INFO, 32)
  return Buffer.from(dek)
}

export function encryptProviderKey(plaintext: string, workspaceId: string): string {
  if (!plaintext) throw new Error('plaintext must not be empty')
  const dek = deriveWorkspaceDek(workspaceId)
  const nonce = randomBytes(NONCE_LEN)
  const cipher = createCipheriv('aes-256-gcm', dek, nonce)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([nonce, ct, tag]).toString('base64')
}

export function decryptProviderKey(ciphertextB64: string, workspaceId: string): string {
  const blob = Buffer.from(ciphertextB64, 'base64')
  const nonce = blob.subarray(0, NONCE_LEN)
  const tag = blob.subarray(blob.length - 16)
  const ct = blob.subarray(NONCE_LEN, blob.length - 16)
  const dek = deriveWorkspaceDek(workspaceId)
  const decipher = createDecipheriv('aes-256-gcm', dek, nonce)
  decipher.setAuthTag(tag)
  const pt = Buffer.concat([decipher.update(ct), decipher.final()])
  return pt.toString('utf-8')
}
