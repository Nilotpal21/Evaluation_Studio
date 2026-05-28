// apps/runtime/src/__tests__/e2e/ai4hc-payer/ai4hc-koreai.e2e.test.ts

/**
 * AI4HC Payer — Live Kore.ai Baseline E2E Test
 *
 * Tests against the LIVE Kore.ai Agent Platform API.
 * Validates conversational flows, agent routing, and response quality.
 *
 * Required env vars:
 *   AI4HC_API_KEY   – Kore.ai x-api-key
 *   AI4HC_APP_ID    – Kore.ai app ID
 *   AI4HC_BASE_URL  – Kore.ai base URL (default: https://agent-platform.kore.ai)
 *
 * Run with:
 *   AI4HC_API_KEY=kg-... AI4HC_APP_ID=aa-... npx vitest run --config vitest.integration.config.ts src/__tests__/e2e/ai4hc-payer/ai4hc-koreai.e2e.test.ts
 */

import { describe, test, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import { SCENARIOS } from './scenarios';
import type { AI4HCClientConfig } from './sse-client';
import { sendMessage, makeSessionIdentity, extractJSONObjects } from './sse-client';
import { assertTurnResponse, logTurnDetails } from './assertions';

dotenvConfig({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..', '.env'),
});

// ─── Config ──────────────────────────────────────────────────────────────────

const AI4HC_API_KEY = process.env.AI4HC_API_KEY ?? '';
const AI4HC_APP_ID = process.env.AI4HC_APP_ID ?? '';
const AI4HC_BASE_URL = process.env.AI4HC_BASE_URL ?? 'https://agent-platform.kore.ai';

const SKIP_REASON = !AI4HC_API_KEY
  ? 'AI4HC_API_KEY not set — skipping live Kore.ai E2E tests'
  : !AI4HC_APP_ID
    ? 'AI4HC_APP_ID not set — skipping live Kore.ai E2E tests'
    : '';

const config: AI4HCClientConfig = {
  apiKey: AI4HC_API_KEY,
  appId: AI4HC_APP_ID,
  baseUrl: AI4HC_BASE_URL,
};

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe.skipIf(!!SKIP_REASON)('AI4HC Payer — Live Kore.ai Baseline E2E', () => {
  beforeAll(() => {
    if (SKIP_REASON) return;
    console.log(`[AI4HC E2E] Endpoint: ${AI4HC_BASE_URL}`);
    console.log(`[AI4HC E2E] App ID: ${AI4HC_APP_ID}`);
    console.log(`[AI4HC E2E] Scenarios: ${SCENARIOS.length}`);
  });

  for (const scenario of SCENARIOS) {
    describe(scenario.name, () => {
      const identity = makeSessionIdentity('ai4hc');

      for (let t = 0; t < scenario.turns.length; t++) {
        const turn = scenario.turns[t];
        const turnLabel = `Turn ${t + 1}: "${turn.user.slice(0, 50)}${turn.user.length > 50 ? '...' : ''}"`;

        test(
          turnLabel,
          async () => {
            const result = await sendMessage(config, turn.user, identity);

            logTurnDetails(result, t, scenario.name);
            assertTurnResponse(result, turn, t, scenario.name);

            expect(result.fullText.length).toBeGreaterThan(0);
          },
          turn.maxTimeMs ? turn.maxTimeMs + 15000 : 60000,
        );
      }
    });
  }
});

// ─── SSE Parser Unit Tests (always run) ──────────────────────────────────────

describe('AI4HC SSE Parser — extractJSONObjects', () => {
  test('parses single JSON object', () => {
    const result = extractJSONObjects(
      'data: {"eventIndex":0,"output":[{"type":"text","content":"Hello"}]}',
    );
    expect(result).toHaveLength(1);
    expect(JSON.parse(result[0]).output[0].content).toBe('Hello');
  });

  test('parses concatenated JSON objects', () => {
    const result = extractJSONObjects(
      '{"eventIndex":1,"output":[{"type":"text","content":"Welcome"}]}{"eventIndex":2,"output":[{"type":"text","content":" to"}]}',
    );
    expect(result).toHaveLength(2);
  });

  test('returns empty for non-JSON lines', () => {
    expect(extractJSONObjects('')).toHaveLength(0);
    expect(extractJSONObjects('event: message')).toHaveLength(0);
  });
});
