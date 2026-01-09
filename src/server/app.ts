import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'

import pino from 'pino'

import type { ActionsCacheBackend } from '../cache/actionsCacheBackend.js'
import { errorMessage } from '../utils.js'

export interface BazelRemoteCacheServerOptions {
  backend: ActionsCacheBackend
  tmpDir?: string
  logger?: pino.Logger | boolean
}

const SHA256_HEX = /^[0-9a-f]{64}$/i

export function buildBazelRemoteCacheServer(
  opts: BazelRemoteCacheServerOptions
) {
  const tmpDir =
    opts.tmpDir ||
    path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'bazel-remote-cache-tmp')

  const log =
    opts.logger === false
      ? pino({ level: 'silent' })
      : opts.logger === true || opts.logger === undefined
        ? pino()
        : opts.logger

  let boundPort = 0

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    const method = req.method || 'GET'

    try {
      if (url.pathname === '/healthz') {
        const health = await opts.backend.healthz().catch((e) => ({
          ok: false,
          message: errorMessage(e)
        }))
        res.writeHead(health.ok ? 200 : 503, {
          'Content-Type': 'application/json'
        })
        res.end(
          JSON.stringify({
            status: health.ok ? 'ok' : 'degraded',
            backend: health,
            pid: process.pid,
            now: new Date().toISOString()
          })
        )
        return
      }

      const match = url.pathname.match(/^\/(ac|cas)\/([^/]+)$/)
      if (!match) {
        res.writeHead(404).end()
        return
      }

      const [, kind, sha] = match

      if (!SHA256_HEX.test(sha)) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid_sha256' }))
        return
      }

      if (method === 'HEAD') {
        const filePath = await opts.backend.getFile(kind, sha)
        if (!filePath) {
          res.writeHead(404).end()
          return
        }
        const stat = await fsp.stat(filePath)
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': stat.size
        })
        res.end()
        opts.backend.deleteLocal(kind, sha)
        return
      }

      if (method === 'GET') {
        const filePath = await opts.backend.getFile(kind, sha)
        if (!filePath) {
          log.debug({ kind, sha }, 'miss')
          res.writeHead(404).end()
          return
        }
        const stat = await fsp.stat(filePath)
        log.debug({ kind, sha, bytes: stat.size }, 'hit')
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': stat.size
        })
        const stream = fs.createReadStream(filePath)
        stream.pipe(res)
        stream.on('close', () => opts.backend.deleteLocal(kind, sha))
        return
      }

      if (method === 'PUT') {
        await fsp.mkdir(tmpDir, { recursive: true })
        const tmpPath = path.join(
          tmpDir,
          `${kind}-${sha}-${process.pid}-${Date.now()}`
        )

        const writeStream = fs.createWriteStream(tmpPath)
        req.pipe(writeStream)

        await new Promise<void>((resolve, reject) => {
          writeStream.on('finish', resolve)
          writeStream.on('error', reject)
        })

        await opts.backend.putFile(kind, sha, tmpPath)
        res.writeHead(200).end()
        return
      }

      res.writeHead(405).end()
    } catch (error) {
      log.error({ err: error }, 'request error')
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          error: 'internal_error',
          message: errorMessage(error)
        })
      )
    }
  })

  return {
    listen: (listenOpts: { host: string; port: number }) =>
      new Promise<void>((resolve) => {
        server.listen(listenOpts.port, listenOpts.host, () => {
          const addr = server.address()
          boundPort =
            typeof addr === 'object' && addr ? addr.port : listenOpts.port
          resolve()
        })
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    inject: async (injectOpts: {
      method: string
      url: string
      payload?: string | Buffer
      headers?: Record<string, string>
    }) => {
      if (!boundPort) {
        await new Promise<void>((resolve) => {
          server.listen(0, '127.0.0.1', () => {
            const addr = server.address()
            boundPort = typeof addr === 'object' && addr ? addr.port : 0
            resolve()
          })
        })
      }

      return new Promise<{
        statusCode: number
        payload: string
        headers: http.IncomingHttpHeaders
        json: () => unknown
      }>((resolve, reject) => {
        const url = new URL(injectOpts.url, `http://127.0.0.1:${boundPort}`)
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: boundPort,
            method: injectOpts.method,
            path: url.pathname + url.search,
            headers: injectOpts.headers || {}
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('end', () => {
              const payload = Buffer.concat(chunks).toString()
              resolve({
                statusCode: res.statusCode || 500,
                payload,
                headers: res.headers,
                json: () => JSON.parse(payload)
              })
            })
          }
        )

        req.on('error', reject)
        if (injectOpts.payload) req.write(injectOpts.payload)
        req.end()
      })
    },
    log
  }
}
