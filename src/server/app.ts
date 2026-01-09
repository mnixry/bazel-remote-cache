import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { pipeline } from 'node:stream/promises'

import Fastify from 'fastify'
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify'

import type { ActionsCacheBackend } from '../cache/actionsCacheBackend.js'
import { errorMessage, safeUnlink } from '../utils.js'

export interface BazelRemoteCacheServerOptions {
  backend: ActionsCacheBackend
  tmpDir?: string
  logger?: boolean | FastifyBaseLogger | Record<string, unknown>
  bodyLimitBytes?: number
}

const SHA256_HEX = /^[0-9a-f]{64}$/i

export function buildBazelRemoteCacheServer(
  opts: BazelRemoteCacheServerOptions
): FastifyInstance {
  const tmpDir =
    opts.tmpDir ||
    path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'bazel-remote-cache-tmp')

  const fastify = Fastify({
    logger: opts.logger ?? true,
    bodyLimit: opts.bodyLimitBytes ?? 1024 * 1024 * 1024,
    exposeHeadRoutes: false
  })

  fastify.addContentTypeParser('*', (_req, payload, done) =>
    done(null, payload)
  )

  fastify.get('/healthz', async (_request, reply) => {
    const health = await opts.backend
      .healthz()
      .catch((e) => ({ ok: false, message: errorMessage(e) }))
    reply.code(health.ok ? 200 : 503).send({
      status: health.ok ? 'ok' : 'degraded',
      backend: health,
      pid: process.pid,
      now: new Date().toISOString()
    })
  })

  fastify.get('/ac/:sha', (req, reply) =>
    handleGet(
      fastify,
      opts.backend,
      'ac',
      (req.params as { sha: string }).sha,
      reply
    )
  )
  fastify.head('/ac/:sha', (req, reply) =>
    handleHead(opts.backend, 'ac', (req.params as { sha: string }).sha, reply)
  )
  fastify.put('/ac/:sha', (req, reply) =>
    handlePut(
      opts.backend,
      'ac',
      (req.params as { sha: string }).sha,
      req.body,
      tmpDir,
      reply
    )
  )

  fastify.get('/cas/:sha', (req, reply) =>
    handleGet(
      fastify,
      opts.backend,
      'cas',
      (req.params as { sha: string }).sha,
      reply
    )
  )
  fastify.head('/cas/:sha', (req, reply) =>
    handleHead(opts.backend, 'cas', (req.params as { sha: string }).sha, reply)
  )
  fastify.put('/cas/:sha', (req, reply) =>
    handlePut(
      opts.backend,
      'cas',
      (req.params as { sha: string }).sha,
      req.body,
      tmpDir,
      reply
    )
  )

  return fastify
}

async function handleHead(
  backend: ActionsCacheBackend,
  kind: string,
  sha: string,
  reply: FastifyReply
) {
  if (!SHA256_HEX.test(sha))
    return reply.code(400).send({ error: 'invalid_sha256' })

  const filePath = await backend.getFile(kind, sha)
  if (!filePath) return reply.code(404).send()

  const stat = await fsp.stat(filePath)
  // Clean up after getting size
  backend.deleteLocal(kind, sha)
  reply
    .header('Content-Type', 'application/octet-stream')
    .header('Content-Length', stat.size)
    .code(200)
    .send()
}

async function handleGet(
  instance: FastifyInstance,
  backend: ActionsCacheBackend,
  kind: string,
  sha: string,
  reply: FastifyReply
) {
  if (!SHA256_HEX.test(sha))
    return reply.code(400).send({ error: 'invalid_sha256' })

  const filePath = await backend.getFile(kind, sha)
  if (!filePath) {
    instance.log.debug({ kind, sha }, 'miss')
    return reply.code(404).send()
  }

  const stat = await fsp.stat(filePath)
  instance.log.debug({ kind, sha, bytes: stat.size }, 'hit')

  const stream = fs.createReadStream(filePath)
  // Clean up local file after streaming completes
  stream.once('close', () => backend.deleteLocal(kind, sha))

  reply
    .header('Content-Type', 'application/octet-stream')
    .header('Content-Length', stat.size)
    .code(200)
    .send(stream)
}

async function handlePut(
  backend: ActionsCacheBackend,
  kind: string,
  sha: string,
  body: unknown,
  tmpDir: string,
  reply: FastifyReply
) {
  if (!SHA256_HEX.test(sha))
    return reply.code(400).send({ error: 'invalid_sha256' })

  await fsp.mkdir(tmpDir, { recursive: true })
  const tmpPath = path.join(
    tmpDir,
    `${kind}-${sha}-${process.pid}-${Date.now()}`
  )

  try {
    if (body == null) {
      await fsp.writeFile(tmpPath, '')
    } else if (typeof body === 'string' || Buffer.isBuffer(body)) {
      await fsp.writeFile(tmpPath, body)
    } else if (isStream(body)) {
      await pipeline(body, fs.createWriteStream(tmpPath))
    } else {
      return reply.code(400).send({ error: 'invalid_body' })
    }

    await backend.putFile(kind, sha, tmpPath)
    reply.code(200).send()
  } catch (error) {
    await safeUnlink(tmpPath)
    reply.code(500).send({ error: 'put_failed', message: errorMessage(error) })
  }
}

function isStream(value: unknown): value is NodeJS.ReadableStream {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { pipe?: unknown }).pipe === 'function'
  )
}
