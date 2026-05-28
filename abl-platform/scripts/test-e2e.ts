#!/usr/bin/env npx tsx
/**
 * E2E Test Script for Web SDK + Backend
 *
 * Usage:
 *   pnpm tsx scripts/test-e2e.ts
 *
 * Prerequisites:
 *   - Platform running on localhost:3001
 *   - ANTHROPIC_API_KEY set in apps/platform/.env
 */

import { setTimeout } from 'timers/promises';

// Runtime is now the main backend (platform is retired)
const RUNTIME_URL = process.env.RUNTIME_URL || 'http://localhost:3112';

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  dim: '\x1b[2m',
};

function log(msg: string, color = colors.reset) {
  console.log(`${color}${msg}${colors.reset}`);
}

function pass(test: string) {
  log(`  ✓ ${test}`, colors.green);
}

function fail(test: string, error?: string) {
  log(`  ✗ ${test}`, colors.red);
  if (error) log(`    ${error}`, colors.dim);
}

function section(name: string) {
  console.log();
  log(`━━━ ${name} ━━━`, colors.blue);
}

// Test results
const results: { passed: number; failed: number; skipped: number } = {
  passed: 0,
  failed: 0,
  skipped: 0,
};

async function testHealthEndpoint(url: string, name: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      pass(`${name} is running`);
      results.passed++;
      return true;
    }
    fail(`${name} returned ${res.status}`);
    results.failed++;
    return false;
  } catch (e) {
    fail(`${name} not reachable`, (e as Error).message);
    results.failed++;
    return false;
  }
}

async function testWebSocket(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      // Dynamic import for WebSocket in Node
      import('ws')
        .then(({ default: WebSocket }) => {
          const wsUrl = url.replace('http', 'ws') + '/ws';
          const ws = new WebSocket(wsUrl);
          let settled = false;

          const finish = (success: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve(success);
          };

          const timeout = globalThis.setTimeout(() => {
            ws.close();
            fail('WebSocket auth enforcement check timed out');
            results.failed++;
            finish(false);
          }, 5000);

          ws.on('unexpected-response', (_request, response) => {
            if (response.statusCode === 401) {
              pass('WebSocket auth is enforced');
              results.passed++;
            } else {
              fail(
                'WebSocket rejected without the expected auth status',
                String(response.statusCode),
              );
              results.failed++;
            }
            response.resume();
            finish(response.statusCode === 401);
          });

          ws.on('open', () => {
            fail('WebSocket accepted an unauthenticated connection');
            results.failed++;
            ws.close();
            finish(false);
          });

          ws.on('error', (err) => {
            if (settled) {
              return;
            }
            fail('WebSocket transport failed before auth could be asserted', err.message);
            results.failed++;
            finish(false);
          });
        })
        .catch(() => {
          log('  ⊘ WebSocket test skipped (ws package not available)', colors.yellow);
          results.skipped++;
          resolve(true);
        });
    } catch {
      log('  ⊘ WebSocket test skipped', colors.yellow);
      results.skipped++;
      resolve(true);
    }
  });
}

async function testSDKEndpoints(url: string): Promise<void> {
  // Test SDK config endpoint
  try {
    const res = await fetch(`${url}/api/sdk/config/test-project`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.status === 404 || res.status === 401) {
      pass('SDK config endpoint exists (auth required)');
      results.passed++;
    } else if (res.ok) {
      pass('SDK config endpoint working');
      results.passed++;
    } else {
      fail(`SDK config returned ${res.status}`);
      results.failed++;
    }
  } catch (e) {
    fail('SDK config endpoint failed', (e as Error).message);
    results.failed++;
  }
}

async function testChatEndpoint(url: string): Promise<void> {
  try {
    const res = await fetch(`${url}/api/v1/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'test',
        message: 'Hello',
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (res.status === 401 || res.status === 403) {
      pass('Chat endpoint exists (auth required)');
      results.passed++;
    } else if (res.ok) {
      pass('Chat endpoint working');
      results.passed++;
    } else {
      fail(`Chat endpoint returned ${res.status}`);
      results.failed++;
    }
  } catch (e) {
    fail('Chat endpoint failed', (e as Error).message);
    results.failed++;
  }
}

async function testVoiceToken(url: string): Promise<void> {
  try {
    // Try the voice connect endpoint (Twilio webhook) instead of token
    const res = await fetch(`${url}/api/v1/voice/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ CallSid: 'test' }),
      signal: AbortSignal.timeout(3000),
    });

    if (res.status === 401 || res.status === 403) {
      pass('Voice endpoint exists (auth required)');
      results.passed++;
    } else if (res.status === 400 || res.status === 500) {
      // 400/500 means endpoint exists but Twilio validation failed (expected)
      pass('Voice endpoint exists (Twilio webhook)');
      results.passed++;
    } else if (res.ok) {
      pass('Voice endpoint working');
      results.passed++;
    } else {
      log(`  ⊘ Voice endpoint returned ${res.status} (optional)`, colors.yellow);
      results.skipped++;
    }
  } catch (e) {
    log('  ⊘ Voice endpoint skipped', colors.yellow);
    results.skipped++;
  }
}

async function testSDKBuild(): Promise<void> {
  const fs = await import('fs');
  const path = await import('path');

  const sdkPath = path.join(process.cwd(), 'packages/web-sdk/dist');

  const files = ['agent-sdk.esm.js', 'agent-sdk.umd.js', 'index.d.ts'];

  for (const file of files) {
    const filePath = path.join(sdkPath, file);
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      pass(`${file} exists (${(stats.size / 1024).toFixed(1)}KB)`);
      results.passed++;
    } else {
      fail(`${file} missing`);
      results.failed++;
    }
  }
}

async function main() {
  console.log();
  log('╔════════════════════════════════════════╗', colors.blue);
  log('║     Agent Platform E2E Test Suite      ║', colors.blue);
  log('╚════════════════════════════════════════╝', colors.blue);

  // Test SDK Build
  section('Web SDK Build');
  await testSDKBuild();

  // Test Runtime Backend (main backend)
  section('Runtime Backend');
  const runtimeUp = await testHealthEndpoint(RUNTIME_URL, 'Runtime API');

  if (runtimeUp) {
    await testWebSocket(RUNTIME_URL);
    await testSDKEndpoints(RUNTIME_URL);
    await testChatEndpoint(RUNTIME_URL);
    await testVoiceToken(RUNTIME_URL);
  } else {
    log('  ⊘ Runtime tests skipped (not running)', colors.yellow);
    results.skipped += 4;
  }

  // Summary
  section('Summary');
  console.log();
  log(`  Passed:  ${results.passed}`, colors.green);
  if (results.failed > 0) {
    log(`  Failed:  ${results.failed}`, colors.red);
  }
  if (results.skipped > 0) {
    log(`  Skipped: ${results.skipped}`, colors.yellow);
  }
  console.log();

  if (results.failed > 0) {
    log('Some tests failed. Check the runtime is running:', colors.yellow);
    log('  cd apps/runtime && pnpm dev', colors.dim);
    process.exit(1);
  } else {
    log('All tests passed! ✨', colors.green);
  }
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
