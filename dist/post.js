import * as fsp from 'node:fs/promises';
import { c as coreExports } from './core-CMpIyOOB.js';
import { e as errorMessage, s as sleep } from './utils-CY1cyEAq.js';
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

async function runPost() {
    try {
        const pidRaw = coreExports.getState('server_pid');
        const logPath = coreExports.getState('log_path');
        if (pidRaw) {
            const pid = parseInt(pidRaw, 10);
            if (Number.isFinite(pid)) {
                await terminateProcess(pid);
            }
        }
        if (logPath) {
            await printLogFile(logPath);
        }
    }
    catch (error) {
        // Post should never fail the job
        coreExports.warning(errorMessage(error));
    }
}
async function terminateProcess(pid) {
    if (!isRunning(pid))
        return;
    process.kill(pid, 'SIGTERM');
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (!isRunning(pid))
            return;
        await sleep(200);
    }
    // Force kill if still running
    if (isRunning(pid)) {
        process.kill(pid, 'SIGKILL');
    }
}
function isRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
async function printLogFile(logPath) {
    coreExports.startGroup(`bazel-remote-cache logs (${logPath})`);
    try {
        const stat = await fsp.stat(logPath);
        const maxBytes = 1024 * 1024;
        if (stat.size <= maxBytes) {
            const content = await fsp.readFile(logPath, 'utf8');
            process.stdout.write(content);
        }
        else {
            const fh = await fsp.open(logPath, 'r');
            const start = Math.max(0, stat.size - maxBytes);
            const buf = Buffer.alloc(stat.size - start);
            await fh.read(buf, 0, buf.length, start);
            await fh.close();
            process.stdout.write(`... (truncated, last ${buf.length} of ${stat.size} bytes) ...\n`);
            process.stdout.write(buf.toString('utf8'));
        }
    }
    catch (error) {
        coreExports.warning(`failed to read log: ${errorMessage(error)}`);
    }
    finally {
        coreExports.endGroup();
    }
}
/* istanbul ignore next */
runPost();

export { runPost };
//# sourceMappingURL=post.js.map
