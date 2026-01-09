import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'

import { jest } from '@jest/globals'

import { ActionsCacheBackend } from '../src/cache/actionsCacheBackend.js'
import { buildBazelRemoteCacheServer } from '../src/server/app.js'

if (!process.env.ACTIONS_RUNTIME_URL || !process.env.ACTIONS_RUNTIME_TOKEN) {
  test.skip('skipping: not running on GitHub Actions', () => {})
} else {
  jest.setTimeout(60_000)

  // Unique prefix for this test run to avoid key collisions
  const runId = process.env.GITHUB_RUN_ID ?? 'local'
  const attempt = process.env.GITHUB_RUN_ATTEMPT ?? '0'
  const testRunPrefix = `test-${runId}-${attempt}-${Date.now()}`

  let tmpDir: string
  let backend: ActionsCacheBackend

  beforeAll(async () => {
    const base = process.env.RUNNER_TEMP ?? os.tmpdir()
    tmpDir = await fsp.mkdtemp(path.join(base, 'bazel-cache-test-'))
    backend = new ActionsCacheBackend({
      namespace: testRunPrefix,
      rootDir: tmpDir
    })
  })

  afterAll(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true })
  })

  describe('ActionsCacheBackend', () => {
    test('healthz returns ok', async () => {
      const health = await backend.healthz()
      expect(health.ok).toBe(true)
    })

    test('put then get returns the blob', async () => {
      const sha = randomSha('put-get')
      const content = 'test-content-' + Date.now()

      const srcPath = path.join(tmpDir, 'src-' + sha)
      await fsp.writeFile(srcPath, content)
      await backend.putFile('cas', sha, srcPath)

      // Use fresh backend to force restore from Actions cache
      const backend2 = new ActionsCacheBackend({
        namespace: testRunPrefix,
        rootDir: await fsp.mkdtemp(path.join(tmpDir, 'restore-'))
      })

      const restored = await backend2.getFile('cas', sha)
      expect(restored).toBeDefined()
      expect(await fsp.readFile(restored!, 'utf8')).toBe(content)
    })

    test('duplicate put does not fail', async () => {
      const sha = randomSha('dup')
      const content = 'duplicate-content'

      const src1 = path.join(tmpDir, 'dup1')
      const src2 = path.join(tmpDir, 'dup2')
      await fsp.writeFile(src1, content)
      await fsp.writeFile(src2, content)

      await expect(backend.putFile('ac', sha, src1)).resolves.toBeUndefined()
      await expect(backend.putFile('ac', sha, src2)).resolves.toBeUndefined()
    })

    test('get missing returns undefined', async () => {
      const sha = randomSha('missing')
      const result = await backend.getFile('cas', sha)
      expect(result).toBeUndefined()
    })
  })

  describe('HTTP server', () => {
    test('GET /healthz', async () => {
      const app = buildBazelRemoteCacheServer({ backend, logger: false })
      const res = await app.inject({ method: 'GET', url: '/healthz' })
      expect(res.statusCode).toBe(200)
      expect(res.json().status).toBe('ok')
      await app.close()
    })

    test('invalid sha returns 400', async () => {
      const app = buildBazelRemoteCacheServer({ backend, logger: false })
      const res = await app.inject({ method: 'GET', url: '/cas/bad-sha' })
      expect(res.statusCode).toBe(400)
      await app.close()
    })

    test('missing blob returns 404', async () => {
      const app = buildBazelRemoteCacheServer({ backend, logger: false })
      const sha = randomSha('404')
      const res = await app.inject({ method: 'GET', url: `/cas/${sha}` })
      expect(res.statusCode).toBe(404)
      await app.close()
    })

    test('PUT then GET round-trip', async () => {
      const app = buildBazelRemoteCacheServer({
        backend,
        logger: false,
        tmpDir
      })
      const sha = randomSha('http')
      const payload = 'http-test-payload'

      const putRes = await app.inject({
        method: 'PUT',
        url: `/cas/${sha}`,
        payload,
        headers: { 'content-type': 'application/octet-stream' }
      })
      expect(putRes.statusCode).toBe(200)

      // Fresh backend to test restore from Actions cache
      const backend2 = new ActionsCacheBackend({
        namespace: testRunPrefix,
        rootDir: await fsp.mkdtemp(path.join(tmpDir, 'http-restore-'))
      })
      const app2 = buildBazelRemoteCacheServer({
        backend: backend2,
        logger: false,
        tmpDir
      })

      const getRes = await app2.inject({ method: 'GET', url: `/cas/${sha}` })
      expect(getRes.statusCode).toBe(200)
      expect(getRes.payload).toBe(payload)

      await app.close()
      await app2.close()
    })

    test('HEAD returns content-length', async () => {
      const app = buildBazelRemoteCacheServer({
        backend,
        logger: false,
        tmpDir
      })
      const sha = randomSha('head')
      const payload = 'head-test'

      await app.inject({
        method: 'PUT',
        url: `/ac/${sha}`,
        payload,
        headers: { 'content-type': 'application/octet-stream' }
      })

      // Fresh backend
      const backend2 = new ActionsCacheBackend({
        namespace: testRunPrefix,
        rootDir: await fsp.mkdtemp(path.join(tmpDir, 'head-restore-'))
      })
      const app2 = buildBazelRemoteCacheServer({
        backend: backend2,
        logger: false,
        tmpDir
      })

      const headRes = await app2.inject({ method: 'HEAD', url: `/ac/${sha}` })
      expect(headRes.statusCode).toBe(200)
      expect(headRes.headers['content-length']).toBe(String(payload.length))

      await app.close()
      await app2.close()
    })
  })

  function randomSha(prefix: string): string {
    const rand = randomBytes(28).toString('hex')
    const tag = prefix.padEnd(8, '0').slice(0, 8)
    return tag + rand
  }
}
