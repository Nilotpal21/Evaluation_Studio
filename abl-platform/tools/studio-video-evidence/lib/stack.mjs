import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO_ROOT, SDK_BROWSER_STACK_SCRIPT, STARTUP_TIMEOUT_MS } from './constants.mjs';
import {
  SDK_BROWSER_STUDIO_READY_PATH,
  resolveRuntimeBaseUrl,
  resolveStudioBaseUrl,
} from './env.mjs';
import { delay, readEnvValue } from './utils.mjs';

function recentLogSuffix(recentLogs) {
  if (recentLogs.length === 0) return '';
  return ` recent logs: ${recentLogs.slice(-12).join(' | ')}`;
}

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

export function startIsolatedStack() {
  const recentLogs = [];
  const child = spawn(process.execPath, ['--import', 'tsx', SDK_BROWSER_STACK_SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      SDK_BROWSER_E2E_ISOLATED: 'true',
      ANTHROPIC_API_KEY:
        process.env.ANTHROPIC_API_KEY ||
        readEnvValue(path.join(REPO_ROOT, '.env'), 'ANTHROPIC_API_KEY'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const captureChunk = (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      recentLogs.push(trimmed);
      if (recentLogs.length > 120) recentLogs.shift();
    }
  };

  child.stdout.on('data', captureChunk);
  child.stderr.on('data', captureChunk);

  return { child, recentLogs };
}

export async function waitForIsolatedStack(stackHandle) {
  const studioBaseUrl = resolveStudioBaseUrl();
  const runtimeBaseUrl = resolveRuntimeBaseUrl();
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (stackHandle.child.exitCode !== null) {
      throw new Error(
        `Isolated Studio stack exited before becoming ready.${recentLogSuffix(stackHandle.recentLogs)}`,
      );
    }

    try {
      const [
        { response: runtimeResponse, body: runtimeBody },
        { response: studioResponse, body: studioBody },
      ] = await Promise.all([
        fetchJson(`${runtimeBaseUrl}/health`),
        fetchJson(`${studioBaseUrl}${SDK_BROWSER_STUDIO_READY_PATH}`),
      ]);

      if (
        runtimeResponse.ok &&
        studioResponse.ok &&
        ['ok', 'healthy'].includes(runtimeBody?.status ?? '') &&
        studioBody?.status === 'ready'
      ) {
        return { studioBaseUrl, runtimeBaseUrl };
      }
    } catch {
      // Retry until the stack comes up.
    }

    await delay(500);
  }

  throw new Error(
    `Timed out waiting for isolated Studio stack.${recentLogSuffix(stackHandle.recentLogs)}`,
  );
}

export async function waitForExistingEndpoints(options = {}) {
  const studioBaseUrl = resolveStudioBaseUrl();
  const runtimeBaseUrl = resolveRuntimeBaseUrl();
  if (options.skipReadyCheck) {
    return { studioBaseUrl, runtimeBaseUrl };
  }
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const [
        { response: runtimeResponse, body: runtimeBody },
        { response: studioResponse, body: studioBody },
      ] = await Promise.all([
        fetchJson(`${runtimeBaseUrl}/health`),
        fetchJson(`${studioBaseUrl}${SDK_BROWSER_STUDIO_READY_PATH}`),
      ]);

      if (
        runtimeResponse.ok &&
        studioResponse.ok &&
        ['ok', 'healthy'].includes(runtimeBody?.status ?? '') &&
        studioBody?.status === 'ready'
      ) {
        return { studioBaseUrl, runtimeBaseUrl };
      }
    } catch {
      // Retry until the stack comes up.
    }

    await delay(500);
  }

  throw new Error(
    `Timed out waiting for Studio (${studioBaseUrl}) and Runtime (${runtimeBaseUrl}).`,
  );
}

export async function stopIsolatedStack(stackHandle) {
  if (!stackHandle || stackHandle.child.exitCode !== null) return;

  stackHandle.child.kill('SIGTERM');
  const deadline = Date.now() + 15_000;
  while (stackHandle.child.exitCode === null && Date.now() < deadline) {
    await delay(250);
  }
  if (stackHandle.child.exitCode === null) {
    stackHandle.child.kill('SIGKILL');
  }
}
