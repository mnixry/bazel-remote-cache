import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import * as core from '@actions/core'
import { sleep, errorMessage } from './utils.js'

type HealthzResponse = {
  status?: string
  backend?: { ok?: boolean; message?: string }
}

export async function run(): Promise<void> {
  try {
    const host = core.getInput('host') || '127.0.0.1'
    const port = parseInt(core.getInput('port') || '7777', 10)
    const namespace = core.getInput('namespace') || 'bazel-remote-cache'
    const healthTimeoutMs = parseInt(
      core.getInput('health_timeout_ms') || '15000',
      10
    )
    const logLevel = core.getInput('log_level') || 'info'

    const connectHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
    const remoteCacheUrl = `http://${connectHost}:${port}`

    const tmpBaseDir = process.env.RUNNER_TEMP ?? os.tmpdir()
    const logDir = path.join(tmpBaseDir, 'bazel-remote-cache-logs')
    fs.mkdirSync(logDir, { recursive: true })

    const logPath = path.join(logDir, `server-${Date.now()}-${process.pid}.log`)
    core.saveState('log_path', logPath)

    const storeDir = path.join(tmpBaseDir, 'bazel-remote-cache-store')

    const logFd = fs.openSync(logPath, 'a')
    const serverPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'server.js'
    )

    const child = spawn(process.execPath, [serverPath], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        BAZEL_REMOTE_CACHE_HOST: host,
        BAZEL_REMOTE_CACHE_PORT: String(port),
        BAZEL_REMOTE_CACHE_NAMESPACE: namespace,
        BAZEL_REMOTE_CACHE_LOG_LEVEL: logLevel,
        BAZEL_REMOTE_CACHE_STORE_DIR: storeDir
      }
    })

    fs.closeSync(logFd)

    if (!child.pid) {
      throw new Error('failed to spawn server process')
    }

    core.saveState('server_pid', String(child.pid))
    child.unref()

    await waitForHealthz(remoteCacheUrl, healthTimeoutMs)
    core.setOutput('remote_cache_url', remoteCacheUrl)
  } catch (error) {
    core.setFailed(errorMessage(error))
  }
}

async function waitForHealthz(
  baseUrl: string,
  timeoutMs: number
): Promise<void> {
  const healthzUrl = `${baseUrl}/healthz`
  const deadline = Date.now() + timeoutMs

  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthzUrl)
      const body = (await res.json().catch(() => ({}))) as HealthzResponse
      if (res.ok && body?.backend?.ok !== false) return
      lastError = new Error(
        `not ready: status=${res.status} backend_ok=${body?.backend?.ok}`
      )
    } catch (err) {
      lastError = err
    }
    await sleep(250)
  }

  throw new Error(
    `health check timed out: ${errorMessage(lastError)} (${healthzUrl})`
  )
}
