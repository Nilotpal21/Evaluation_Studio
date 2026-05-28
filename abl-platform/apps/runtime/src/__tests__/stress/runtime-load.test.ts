/**
 * Runtime E2E Stress Tests
 *
 * Multi-turn E2E stress tests exercising the runtime via HTTP API.
 * No platform components are mocked in test code — all interaction is
 * through POST /api/v1/chat/agent on a real Express server backed by
 * real RuntimeExecutor + SessionService + compilation pipeline.
 *
 * The only external-service mock (LLM provider) is injected via DI
 * inside the server infrastructure — invisible to this test file.
 */

import { describe, test, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { E2EStressRunner } from './e2e-stress-runner.js';
import {
  MetricsAggregator,
  ReportGenerator,
  type LoadScenarioConfig,
} from './runtime-load-test.js';

// =============================================================================
// DSL LOADING
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = path.resolve(__dirname, '../../../../../examples');

function loadDSL(relativePath: string): string {
  const fullPath = path.join(EXAMPLES_DIR, relativePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`DSL file not found: ${fullPath}`);
  }
  return fs.readFileSync(fullPath, 'utf-8');
}

const HOTEL_BOOKING_DSL = loadDSL('flow-test/agents/hotel_booking.agent.abl');

// Conversation inputs for hotel booking flow
const BOOKING_CONVERSATION = ['Paris', '2025-06-15 to 2025-06-20', '2 guests'];

// Extended conversation for deeper flow execution
const EXTENDED_BOOKING_CONVERSATION = [
  'Paris',
  '2025-06-15',
  '2025-06-20',
  '2 guests',
  'Search results look good',
  'Hotel #1',
  'Standard room',
  'No promo code',
  'John Smith, john@example.com',
  'Credit card',
];

// Shared server configuration — LLM mock is injected here, not in tests
const SERVER_CONFIG = {
  dsl: HOTEL_BOOKING_DSL,
  agentName: 'Hotel_Booking',
  llmLatency: { chatLatencyMs: 3, jitter: 0.1 },
};

// =============================================================================
// TEST SUITE
// =============================================================================

describe('Runtime E2E Stress Tests', () => {
  // ---------------------------------------------------------------------------
  // Scenario 1: Single session, 10-turn booking via HTTP
  // ---------------------------------------------------------------------------
  test('single session, 10-turn booking flow via HTTP', async () => {
    const runner = await E2EStressRunner.create(SERVER_CONFIG);

    try {
      const config: LoadScenarioConfig = {
        name: 'E2E: Single session, 10-turn booking',
        agentDSL: HOTEL_BOOKING_DSL,
        agentName: 'Hotel_Booking',
        conversationInputs: EXTENDED_BOOKING_CONVERSATION,
        concurrency: 1,
        totalSessions: 1,
        mode: 'burst',
      };

      const result = await runner.run(config);
      const metrics = MetricsAggregator.compute(result);
      ReportGenerator.print(metrics, config.name);

      // Every turn should succeed through the full HTTP stack
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].success).toBe(true);
      expect(result.sessions[0].turns.length).toBe(EXTENDED_BOOKING_CONVERSATION.length);
      expect(metrics.successRate).toBeGreaterThanOrEqual(0.95);
    } finally {
      await runner.dispose();
    }
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Scenario 2: Burst — 20 simultaneous sessions via HTTP
  // ---------------------------------------------------------------------------
  test('burst: 20 simultaneous sessions via HTTP', async () => {
    const runner = await E2EStressRunner.create(SERVER_CONFIG);

    try {
      const config: LoadScenarioConfig = {
        name: 'E2E: Burst — 20 simultaneous sessions',
        agentDSL: HOTEL_BOOKING_DSL,
        agentName: 'Hotel_Booking',
        conversationInputs: BOOKING_CONVERSATION,
        concurrency: 20,
        totalSessions: 20,
        mode: 'burst',
      };

      const result = await runner.run(config);
      const metrics = MetricsAggregator.compute(result);
      ReportGenerator.print(metrics, config.name);

      expect(result.sessions).toHaveLength(20);
      expect(result.concurrentPeak).toBeGreaterThan(1);
      expect(metrics.successRate).toBeGreaterThanOrEqual(0.95);
      expect(metrics.totalSessions).toBe(20);

      // All sessions should have completed their turns
      const totalTurnsExpected = 20 * BOOKING_CONVERSATION.length;
      const completedTurns = result.sessions
        .flatMap((s) => s.turns)
        .filter((t) => t.success).length;
      expect(completedTurns).toBeGreaterThanOrEqual(totalTurnsExpected * 0.95);

      // Session isolation: every session gets a unique ID
      const ids = result.sessions.map((s) => s.sessionId);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      await runner.dispose();
    }
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Scenario 3: Sustained — 50 sessions, 10 concurrent pool via HTTP
  // ---------------------------------------------------------------------------
  test('sustained: 50 sessions, 10 concurrent pool via HTTP', async () => {
    const runner = await E2EStressRunner.create(SERVER_CONFIG);

    try {
      const config: LoadScenarioConfig = {
        name: 'E2E: Sustained — 50 sessions, 10 concurrent',
        agentDSL: HOTEL_BOOKING_DSL,
        agentName: 'Hotel_Booking',
        conversationInputs: BOOKING_CONVERSATION,
        concurrency: 10,
        totalSessions: 50,
        mode: 'pool',
      };

      const result = await runner.run(config);
      const metrics = MetricsAggregator.compute(result);
      ReportGenerator.print(metrics, config.name);

      expect(result.sessions).toHaveLength(50);
      expect(metrics.successRate).toBeGreaterThanOrEqual(0.95);
      expect(metrics.throughputTurnsPerSec).toBeGreaterThan(0);
      // Pool mode caps concurrency — allow some async timing slack
      expect(result.concurrentPeak).toBeLessThanOrEqual(15);
    } finally {
      await runner.dispose();
    }
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Scenario 4: Session persistence — multi-turn then verify resume via HTTP
  // ---------------------------------------------------------------------------
  test('session persistence round-trip via HTTP', async () => {
    const runner = await E2EStressRunner.create(SERVER_CONFIG);

    try {
      const config: LoadScenarioConfig = {
        name: 'E2E: Persistence round-trip',
        agentDSL: HOTEL_BOOKING_DSL,
        agentName: 'Hotel_Booking',
        conversationInputs: BOOKING_CONVERSATION.slice(0, 3),
        concurrency: 5,
        totalSessions: 5,
        mode: 'burst',
      };

      const result = await runner.runWithPersistence(config);
      const metrics = MetricsAggregator.compute(result);
      ReportGenerator.print(metrics, config.name);

      expect(result.sessions).toHaveLength(5);
      expect(metrics.successRate).toBeGreaterThanOrEqual(0.95);

      // Follow-up messages should succeed — session was preserved
      const successfulPersistence = result.persistence.filter((p) => p.stateMatch);
      expect(successfulPersistence.length).toBeGreaterThan(0);

      for (const p of result.persistence) {
        expect(p.stateMatch).toBe(true);
        expect(p.historyMatch).toBe(true);
      }

      if (metrics.persistence) {
        expect(metrics.persistence.save.count).toBeGreaterThan(0);
        expect(metrics.persistence.load.count).toBeGreaterThan(0);
      }
    } finally {
      await runner.dispose();
    }
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Scenario 5: Mixed session groups — concurrent isolation via HTTP
  // ---------------------------------------------------------------------------
  test('mixed session groups: concurrent isolation via HTTP', async () => {
    const runner = await E2EStressRunner.create(SERVER_CONFIG);

    try {
      const configs: LoadScenarioConfig[] = [
        {
          name: 'Group A: short conversations',
          agentDSL: HOTEL_BOOKING_DSL,
          agentName: 'Hotel_Booking',
          conversationInputs: BOOKING_CONVERSATION,
          concurrency: 5,
          totalSessions: 10,
          mode: 'pool',
        },
        {
          name: 'Group B: extended conversations',
          agentDSL: HOTEL_BOOKING_DSL,
          agentName: 'Hotel_Booking',
          conversationInputs: EXTENDED_BOOKING_CONVERSATION.slice(0, 5),
          concurrency: 5,
          totalSessions: 10,
          mode: 'pool',
        },
      ];

      const result = await runner.runMixed(configs);
      const metrics = MetricsAggregator.compute(result);
      ReportGenerator.print(metrics, 'E2E: Mixed groups — concurrent isolation');

      expect(result.sessions).toHaveLength(20);
      expect(metrics.successRate).toBeGreaterThanOrEqual(0.95);
      expect(result.concurrentPeak).toBeGreaterThan(1);

      // Session isolation: all IDs unique across both groups
      const ids = result.sessions.map((s) => s.sessionId);
      expect(new Set(ids).size).toBe(ids.length);

      const successfulSessions = result.sessions.filter((s) => s.success);
      expect(successfulSessions.length).toBeGreaterThanOrEqual(18);
    } finally {
      await runner.dispose();
    }
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Scenario 6: Redis-backed persistence stress via HTTP
  // ---------------------------------------------------------------------------
  describe('Redis-backed persistence', () => {
    test('30 sessions, 8 turns each, Redis persistence via HTTP', async () => {
      const runner = await E2EStressRunner.createWithRedis(SERVER_CONFIG);

      try {
        const config: LoadScenarioConfig = {
          name: `E2E: Redis persistence stress (${runner.storeType})`,
          agentDSL: HOTEL_BOOKING_DSL,
          agentName: 'Hotel_Booking',
          conversationInputs: [
            'Paris',
            '2025-06-15 to 2025-06-20',
            '2 guests',
            'Search results look good',
            'Hotel #1',
            'Standard room',
            'No promo code',
            'John Smith, john@example.com',
          ],
          concurrency: 10,
          totalSessions: 30,
          mode: 'pool',
        };

        const result = await runner.runWithPersistence(config);
        const metrics = MetricsAggregator.compute(result);
        ReportGenerator.print(metrics, config.name);

        expect(result.sessions).toHaveLength(30);
        expect(metrics.successRate).toBeGreaterThanOrEqual(0.95);
        expect(result.storeType).toMatch(/^(memory|redis)$/);

        // Persistence verification: follow-up messages succeed
        const persistSuccess = result.persistence.filter((p) => p.stateMatch);
        expect(persistSuccess.length).toBeGreaterThanOrEqual(result.persistence.length * 0.85);

        // Session isolation under load
        const ids = result.sessions.map((s) => s.sessionId);
        expect(new Set(ids).size).toBe(ids.length);
      } finally {
        await runner.dispose();
      }
    }, 120_000);

    test('store type auto-detection', async () => {
      const runner = await E2EStressRunner.createWithRedis(SERVER_CONFIG);
      try {
        expect(runner.storeType).toMatch(/^(memory|redis)$/);
      } finally {
        await runner.dispose();
      }
    }, 10_000);
  });
});
