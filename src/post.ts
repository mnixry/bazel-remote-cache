import * as fs from 'node:fs/promises'

import * as core from '@actions/core'
import { sleep, errorMessage } from './utils.js'

export async function runPost(): Promise<void> {
  try {
    const pidRaw = core.getState('server_pid')
    const logPath = core.getState('log_path')

    if (pidRaw) {
      const pid = parseInt(pidRaw, 10)
      if (Number.isFinite(pid)) {
        await terminateProcess(pid)
      }
    }

    if (logPath) {
      await printLogFile(logPath)
    }
  } catch (error) {
    // Post should never fail the job
    core.warning(errorMessage(error))
  }
}

async function terminateProcess(pid: number): Promise<void> {
  if (!isRunning(pid)) return

  process.kill(pid, 'SIGTERM')

  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (!isRunning(pid)) return
    await sleep(200)
  }

  // Force kill if still running
  if (isRunning(pid)) {
    process.kill(pid, 'SIGKILL')
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function printLogFile(logPath: string): Promise<void> {
  core.startGroup(`bazel-remote-cache logs (${logPath})`)
  try {
    const stat = await fs.stat(logPath)
    const maxBytes = 1024 * 1024

    if (stat.size <= maxBytes) {
      const content = await fs.readFile(logPath, 'utf8')
      process.stdout.write(content)
    } else {
      const fh = await fs.open(logPath, 'r')
      const start = Math.max(0, stat.size - maxBytes)
      const buf = Buffer.alloc(stat.size - start)
      await fh.read(buf, 0, buf.length, start)
      await fh.close()
      process.stdout.write(
        `... (truncated, last ${buf.length} of ${stat.size} bytes) ...\n`
      )
      process.stdout.write(buf.toString('utf8'))
    }
  } catch (error) {
    core.warning(`failed to read log: ${errorMessage(error)}`)
  } finally {
    core.endGroup()
  }
}

/* istanbul ignore next */
runPost()
