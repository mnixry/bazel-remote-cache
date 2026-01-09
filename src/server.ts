import * as os from 'node:os'
import * as path from 'node:path'

import { ActionsCacheBackend } from './cache/actionsCacheBackend.js'
import { buildBazelRemoteCacheServer } from './server/app.js'

async function main(): Promise<void> {
  const host = process.env.BAZEL_REMOTE_CACHE_HOST?.trim() || '127.0.0.1'
  const port = parseInt(process.env.BAZEL_REMOTE_CACHE_PORT || '7777', 10)
  const logLevel = process.env.BAZEL_REMOTE_CACHE_LOG_LEVEL?.trim() || 'info'
  const namespace =
    process.env.BAZEL_REMOTE_CACHE_NAMESPACE?.trim() || 'bazel-remote-cache'
  const storeDir =
    process.env.BAZEL_REMOTE_CACHE_STORE_DIR ||
    path.join(
      process.env.RUNNER_TEMP || os.tmpdir(),
      'bazel-remote-cache-store'
    )

  const backend = new ActionsCacheBackend({ namespace, rootDir: storeDir })
  const app = buildBazelRemoteCacheServer({
    backend,
    logger: { level: logLevel }
  })

  app.log.info({ host, port, namespace, storeDir }, 'starting server')

  process.once('SIGTERM', () => app.close())
  process.once('SIGINT', () => app.close())

  await app.listen({ host, port })
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
