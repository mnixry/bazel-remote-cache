import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

import * as cache from '@actions/cache'
import pLimit from 'p-limit'

import { sleep, errorMessage, safeUnlink } from '../utils.js'

export interface ActionsCacheBackendOptions {
  namespace: string
  rootDir: string
  concurrency?: number
  maxRetries?: number
}

export class ActionsCacheBackend {
  private readonly namespace: string
  private readonly rootDir: string
  private readonly maxRetries: number
  private readonly limit: ReturnType<typeof pLimit>

  private readonly pendingRestores = new Map<
    string,
    Promise<string | undefined>
  >()
  private readonly pendingSaves = new Map<string, Promise<void>>()

  constructor(opts: ActionsCacheBackendOptions) {
    this.namespace = sanitizeKey(opts.namespace)
    this.rootDir = opts.rootDir
    this.maxRetries = opts.maxRetries ?? 5
    this.limit = pLimit(opts.concurrency ?? 4)
  }

  private cacheKey(kind: string, sha256: string): string {
    return `${this.namespace}-${kind}-${sha256}`
  }

  private entryDir(kind: string, sha256: string): string {
    return path.join(this.rootDir, kind, sha256)
  }

  private blobPath(kind: string, sha256: string): string {
    return path.join(this.entryDir(kind, sha256), 'data')
  }

  async getFile(kind: string, sha256: string): Promise<string | undefined> {
    const key = this.cacheKey(kind, sha256)
    const pending = this.pendingRestores.get(key)
    if (pending) return pending

    const promise = this.limit(async () => {
      const entryDir = this.entryDir(kind, sha256)
      const blobPath = this.blobPath(kind, sha256)

      await fsp.mkdir(entryDir, { recursive: true })

      const restored = await this.retry(() =>
        cache.restoreCache([entryDir], key)
      )
      if (!restored) return undefined

      return (await fileExists(blobPath)) ? blobPath : undefined
    })

    this.pendingRestores.set(key, promise)
    return promise.finally(() => this.pendingRestores.delete(key))
  }

  async putFile(
    kind: string,
    sha256: string,
    sourcePath: string
  ): Promise<void> {
    const key = this.cacheKey(kind, sha256)
    const pending = this.pendingSaves.get(key)
    if (pending) {
      await safeUnlink(sourcePath)
      return pending
    }

    const promise = this.limit(async () => {
      const entryDir = this.entryDir(kind, sha256)
      const blobPath = this.blobPath(kind, sha256)
      await fsp.mkdir(entryDir, { recursive: true })
      await moveFile(sourcePath, blobPath)

      try {
        await this.retry(() => cache.saveCache([entryDir], key))
      } catch (error) {
        if (!errorMessage(error).toLowerCase().includes('already exists'))
          throw error
      }

      // Clean up local copy after upload
      await fsp.rm(entryDir, { recursive: true, force: true }).catch(() => {})
    })

    this.pendingSaves.set(key, promise)
    return promise.finally(() => this.pendingSaves.delete(key))
  }

  async deleteLocal(kind: string, sha256: string): Promise<void> {
    await fsp
      .rm(this.entryDir(kind, sha256), { recursive: true, force: true })
      .catch(() => {})
  }

  async healthz(): Promise<{ ok: boolean; message?: string }> {
    try {
      await fsp.mkdir(this.rootDir, { recursive: true })
    } catch (error) {
      return {
        ok: false,
        message: `local dir unusable: ${errorMessage(error)}`
      }
    }

    if (
      !process.env.ACTIONS_RUNTIME_TOKEN ||
      !process.env.ACTIONS_RUNTIME_URL
    ) {
      return {
        ok: false,
        message: 'missing ACTIONS_RUNTIME_TOKEN or ACTIONS_RUNTIME_URL'
      }
    }

    return { ok: true }
  }

  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await fn()
      } catch (error) {
        lastError = error
        if (attempt < this.maxRetries - 1) {
          await sleep(200 * 2 ** attempt + Math.random() * 200)
        }
      }
    }
    throw lastError
  }
}

function sanitizeKey(s: string): string {
  return s.trim().replace(/[^A-Za-z0-9._-]/g, '-') || 'bazel-remote-cache'
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile()
  } catch {
    return false
  }
}

async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await fsp.rename(src, dest)
  } catch {
    await fsp.copyFile(src, dest)
    await safeUnlink(src)
  }
}
