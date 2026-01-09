import * as fsp from 'node:fs/promises'

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function safeUnlink(p: string): Promise<void> {
  await fsp.unlink(p).catch(() => {})
}
