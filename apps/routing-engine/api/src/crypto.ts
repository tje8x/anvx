// Stub — full envelope decryption lands on Day 12.
// For now, use ANVX_DEV_OPENAI_KEY env var for testing.

export function decryptProviderKey(_workspaceId: string, _envelope: unknown): string {
  const devKey = process.env.ANVX_DEV_OPENAI_KEY
  if (!devKey) {
    throw new Error('ANVX_DEV_OPENAI_KEY not set — crypto.ts stub requires it until Day 12')
  }
  return devKey
}
