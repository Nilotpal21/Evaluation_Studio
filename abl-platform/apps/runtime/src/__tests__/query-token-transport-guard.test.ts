import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  QUERY_TOKEN_TRANSPORT_ALLOWLIST,
  type QueryTokenTransport,
} from '@agent-platform/shared-kernel/security';

const RUNTIME_SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const QUERY_TOKEN_CONSUMER_FILES_BY_TRANSPORT = {
  audiocodes_http: ['routes/channel-audiocodes.ts'],
  audiocodes_ws: ['server.ts'],
  korevg_ws: ['services/voice/korevg/korevg-router.ts'],
  twilio_ws: ['websocket/twilio-media-handler.ts'],
  vxml_http: ['routes/channel-vxml.ts'],
} satisfies Record<QueryTokenTransport, readonly string[]>;

const QUERY_TOKEN_EMITTER_FILES_BY_TRANSPORT = {
  audiocodes_http: ['routes/channel-audiocodes.ts'],
  audiocodes_ws: ['routes/channel-audiocodes.ts'],
  korevg_ws: ['routes/channel-connections.ts'],
  twilio_ws: ['routes/voice.ts'],
  vxml_http: ['routes/channel-vxml.ts'],
} satisfies Partial<Record<QueryTokenTransport, readonly string[]>>;

const QUERY_TOKEN_CONSUMER_PATTERNS = [
  /searchParams\.get\(['"]token['"]\)/,
  /req\.query\.token/,
  /allowQueryTokenFor:\s*['"][a-z_]+['"]/,
] as const;

function collectSourceFiles(rootDir: string): string[] {
  const files: string[] = [];

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === '__tests__') {
        continue;
      }

      files.push(...collectSourceFiles(fullPath));
      continue;
    }

    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) {
      continue;
    }

    files.push(fullPath);
  }

  return files;
}

function fileContainsAnyPattern(filePath: string, patterns: readonly RegExp[]): boolean {
  const contents = fs.readFileSync(filePath, 'utf8');
  return patterns.some((pattern) => pattern.test(contents));
}

describe('query token transport guard', () => {
  test('keeps the runtime query-token allowlist manifest aligned with the shared transport allowlist', () => {
    const allowlistKeys = Object.keys(QUERY_TOKEN_TRANSPORT_ALLOWLIST).sort();
    const consumerKeys = Object.keys(QUERY_TOKEN_CONSUMER_FILES_BY_TRANSPORT).sort();
    const emitterKeys = Object.keys(QUERY_TOKEN_EMITTER_FILES_BY_TRANSPORT).sort();

    expect(consumerKeys).toEqual(allowlistKeys);
    expect(emitterKeys).toEqual([
      'audiocodes_http',
      'audiocodes_ws',
      'korevg_ws',
      'twilio_ws',
      'vxml_http',
    ]);
  });

  test('limits runtime query-token consumers to the documented legacy transport files', () => {
    const allowedFiles = new Set(
      Object.values(QUERY_TOKEN_CONSUMER_FILES_BY_TRANSPORT).flatMap((files) => files),
    );
    const matchedFiles = collectSourceFiles(RUNTIME_SRC_ROOT)
      .map((filePath) => path.relative(RUNTIME_SRC_ROOT, filePath))
      .filter((relativePath) =>
        fileContainsAnyPattern(
          path.join(RUNTIME_SRC_ROOT, relativePath),
          QUERY_TOKEN_CONSUMER_PATTERNS,
        ),
      );

    const unexpectedMatches = matchedFiles.filter(
      (relativePath) => !allowedFiles.has(relativePath),
    );

    expect(unexpectedMatches).toEqual([]);
    expect(matchedFiles.sort()).toEqual(Array.from(allowedFiles).sort());
  });

  test('limits runtime query-token URL emitters to the documented legacy provisioning files', () => {
    const allowedFiles = new Set(
      Object.values(QUERY_TOKEN_EMITTER_FILES_BY_TRANSPORT).flatMap((files) => files),
    );
    const emitterPatterns = [
      /\?token=\$\{/,
      /appendLegacyQueryToken\(/,
      /searchParams\.set\(['"]token['"]/,
    ];
    const matchedFiles = collectSourceFiles(RUNTIME_SRC_ROOT)
      .map((filePath) => path.relative(RUNTIME_SRC_ROOT, filePath))
      .filter((relativePath) =>
        fileContainsAnyPattern(path.join(RUNTIME_SRC_ROOT, relativePath), emitterPatterns),
      );

    const unexpectedMatches = matchedFiles.filter(
      (relativePath) => !allowedFiles.has(relativePath),
    );

    expect(unexpectedMatches).toEqual([]);
    expect(matchedFiles.sort()).toEqual(Array.from(allowedFiles).sort());
  });
});
