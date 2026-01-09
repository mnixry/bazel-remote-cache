import * as fs from 'node:fs';
import * as require$$1 from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { c as coreExports } from './core-Dt5xxjmW.js';
import { e as errorMessage, s as sleep } from './utils-BxHpAzOy.js';
import 'os';
import 'crypto';
import 'fs';
import 'path';
import 'http';
import 'https';
import 'net';
import 'tls';
import 'events';
import 'assert';
import 'util';
import 'stream';
import 'buffer';
import 'querystring';
import 'stream/web';
import 'node:stream';
import 'node:util';
import 'node:events';
import 'worker_threads';
import 'perf_hooks';
import 'util/types';
import 'async_hooks';
import 'console';
import 'url';
import 'zlib';
import 'string_decoder';
import 'diagnostics_channel';
import 'child_process';
import 'timers';
import 'node:fs/promises';

async function run() {
    try {
        const host = coreExports.getInput('host') || '127.0.0.1';
        const port = parseInt(coreExports.getInput('port') || '7777', 10);
        const namespace = coreExports.getInput('namespace') || 'bazel-remote-cache';
        const healthTimeoutMs = parseInt(coreExports.getInput('health_timeout_ms') || '15000', 10);
        const logLevel = coreExports.getInput('log_level') || 'info';
        const connectHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
        const remoteCacheUrl = `http://${connectHost}:${port}`;
        const tmpBaseDir = process.env.RUNNER_TEMP ?? require$$1.tmpdir();
        const logDir = path.join(tmpBaseDir, 'bazel-remote-cache-logs');
        fs.mkdirSync(logDir, { recursive: true });
        const logPath = path.join(logDir, `server-${Date.now()}-${process.pid}.log`);
        coreExports.saveState('log_path', logPath);
        const storeDir = path.join(tmpBaseDir, 'bazel-remote-cache-store');
        const logFd = fs.openSync(logPath, 'a');
        const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.js');
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
        });
        fs.closeSync(logFd);
        if (!child.pid) {
            throw new Error('failed to spawn server process');
        }
        coreExports.saveState('server_pid', String(child.pid));
        child.unref();
        await waitForHealthz(remoteCacheUrl, healthTimeoutMs);
        coreExports.setOutput('remote_cache_url', remoteCacheUrl);
    }
    catch (error) {
        coreExports.setFailed(errorMessage(error));
    }
}
async function waitForHealthz(baseUrl, timeoutMs) {
    const healthzUrl = `${baseUrl}/healthz`;
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(healthzUrl);
            const body = (await res.json().catch(() => ({})));
            if (res.ok && body?.backend?.ok !== false)
                return;
            lastError = new Error(`not ready: status=${res.status} backend_ok=${body?.backend?.ok}`);
        }
        catch (err) {
            lastError = err;
        }
        await sleep(250);
    }
    throw new Error(`health check timed out: ${errorMessage(lastError)} (${healthzUrl})`);
}

/**
 * The entrypoint for the action. This file simply imports and runs the action's
 * main logic.
 */
/* istanbul ignore next */
run();
//# sourceMappingURL=index.js.map
