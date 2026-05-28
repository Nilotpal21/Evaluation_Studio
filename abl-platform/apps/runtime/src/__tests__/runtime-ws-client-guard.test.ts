import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const RUNTIME_WS_CLIENT_FILES = [
  'apps/runtime/test-session-api.mjs',
  'apps/studio/src/app/preview/page.tsx',
  'apps/studio/src/app/preview/[projectId]/page.tsx',
  'apps/studio/public/widget-test.html',
  // Connects to workflow-engine /ws (not runtime), but uses the same
  // web-debug-auth subprotocol contract so it lives in the same registry.
  'apps/studio/src/components/workflows/canvas/useExecutionWebSocket.ts',
  'apps/studio/src/contexts/WebSocketContext.tsx',
  'benchmarks/integration/multi-agent-orchestration.ts',
  'benchmarks/saturation/runtime.ts',
  'benchmarks/services/runtime.ts',
  'packages/kore-platform-cli/src/commands/debug.ts',
  'packages/mcp-debug/src/client/websocket-client.ts',
  'packages/web-sdk/src/core/SessionManager.ts',
  'scripts/conversation-testing/src/conversation-runner.ts',
  'scripts/test-e2e.ts',
  'scripts/test-rich-content.ts',
] as const;

const RUNTIME_WS_REJECTION_PROBE_FILES = ['scripts/test-e2e.ts'] as const;

const WS_CALLER_PATTERNS = [
  /\bnew WebSocket\(/,
  /\bnew this\.webSocketConstructor\(/,
  /\bws\.connect\(/,
] as const;
const RUNTIME_WS_TARGET_PATTERNS = [
  /\/ws\/sdk\b/,
  /\/ws\b/,
  /\bDEFAULT_WS_URL\b/,
  /deriveDefaultWsUrl/,
  /deriveDefaultSdkWsUrl/,
] as const;
const AUTH_HELPER_PATTERNS = [
  /\bbuildWebDebugWSProtocols\b/,
  /\bbuildWebDebugWsProtocols\b/,
  /\bbuildSdkWSProtocols\b/,
  /Sec-WebSocket-Protocol/,
] as const;
const EXPLICIT_PROTOCOL_LITERAL_PATTERNS = [
  /\['sdk-auth'\s*,/,
  /\["sdk-auth"\s*,/,
  /\?token=/,
] as const;

function collectSourceFiles(rootDir: string): string[] {
  const files: string[] = [];

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'dist' || entry.name === 'node_modules') {
        continue;
      }

      files.push(...collectSourceFiles(fullPath));
      continue;
    }

    if (
      !entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.tsx') &&
      !entry.name.endsWith('.js') &&
      !entry.name.endsWith('.mjs') &&
      !entry.name.endsWith('.cjs') &&
      !entry.name.endsWith('.html')
    ) {
      continue;
    }

    files.push(fullPath);
  }

  return files;
}

function fileContainsAllPatterns(filePath: string, patterns: readonly RegExp[]): boolean {
  const contents = fs.readFileSync(filePath, 'utf8');
  return patterns.every((pattern) => pattern.test(contents));
}

function fileContainsAnyPattern(filePath: string, patterns: readonly RegExp[]): boolean {
  const contents = fs.readFileSync(filePath, 'utf8');
  return patterns.some((pattern) => pattern.test(contents));
}

describe('runtime WebSocket client guard', () => {
  test(
    'limits runtime /ws and /ws/sdk callers to the documented source files',
    { timeout: 120_000 },
    () => {
      const clientRoots = [
        'apps/runtime',
        'apps/studio/src',
        'apps/studio/public',
        'benchmarks',
        'packages/kore-platform-cli/src',
        'packages/mcp-debug/src',
        'packages/web-sdk/src',
        'scripts',
      ].map((relativePath) => path.join(REPO_ROOT, relativePath));

      const matchedFiles = clientRoots
        .flatMap((rootDir) => collectSourceFiles(rootDir))
        .map((filePath) => path.relative(REPO_ROOT, filePath))
        .filter((relativePath) =>
          fileContainsAnyPattern(path.join(REPO_ROOT, relativePath), WS_CALLER_PATTERNS),
        )
        .filter((relativePath) =>
          fileContainsAnyPattern(path.join(REPO_ROOT, relativePath), RUNTIME_WS_TARGET_PATTERNS),
        )
        .sort();

      expect(matchedFiles).toEqual([...RUNTIME_WS_CLIENT_FILES].sort());
    },
  );

  test('requires shared auth helpers or explicit subprotocol headers for live runtime WS callers', () => {
    for (const relativePath of RUNTIME_WS_CLIENT_FILES) {
      if (
        RUNTIME_WS_REJECTION_PROBE_FILES.includes(
          relativePath as (typeof RUNTIME_WS_REJECTION_PROBE_FILES)[number],
        )
      ) {
        continue;
      }

      const absolutePath = path.join(REPO_ROOT, relativePath);
      expect(
        fileContainsAnyPattern(absolutePath, AUTH_HELPER_PATTERNS) ||
          fileContainsAnyPattern(absolutePath, EXPLICIT_PROTOCOL_LITERAL_PATTERNS),
      ).toBe(true);
    }
  });

  test('documents the unauthenticated runtime WS rejection probe explicitly', () => {
    for (const relativePath of RUNTIME_WS_REJECTION_PROBE_FILES) {
      expect(
        fileContainsAllPatterns(path.join(REPO_ROOT, relativePath), [
          /\bunexpected-response\b/,
          /WebSocket auth is enforced/,
        ]),
      ).toBe(true);
    }
  });
});
