/**
 * High-Throughput Stress Test — 300 turns/sec target with realistic LLM latency
 *
 * Simulates production-realistic conditions:
 *   - LLM latency: 1000–1500ms per call (chatLatencyMs=1250, jitter=0.2)
 *   - Target throughput: 300 turns/sec sustained
 *   - Progressive ramp-up: 100 → 150 → 200 → 300 concurrent sessions
 *
 * All interaction is via HTTP POST on a real Express server — no platform mocks.
 * These are single-node benchmarks — production would use horizontal scaling.
 */

import { describe, test, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { E2EStressRunner, type StateVerification } from './e2e-stress-runner.js';
import {
  MetricsAggregator,
  ReportGenerator,
  type LoadScenarioConfig,
} from './runtime-load-test.js';

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

// Realistic LLM latency: 1250ms base ± 20% jitter → 1000–1500ms range
const REALISTIC_LLM_LATENCY = { chatLatencyMs: 1250, jitter: 0.2 };

const SERVER_CONFIG = {
  dsl: HOTEL_BOOKING_DSL,
  agentName: 'Hotel_Booking',
  llmLatency: REALISTIC_LLM_LATENCY,
};

// 3-turn conversation for each session
const CONVERSATION = ['Paris', '2025-06-15 to 2025-06-20', '2 guests'];

// Entity values the Hotel_Booking agent should extract from the conversation
const EXPECTED_ENTITIES = ['destination', 'num_guests'];

// Helper to print a summary line for each scenario
function printSummary(
  metrics: ReturnType<typeof MetricsAggregator.compute>,
  result: { concurrentPeak: number; memoryDeltaMB: number },
): void {
  console.log(`\n  ╔══════════════════════════════════════════════════════════╗`);
  console.log(
    `  ║  Throughput:     ${metrics.throughputTurnsPerSec.toFixed(1).padStart(8)} turns/sec              ║`,
  );
  console.log(
    `  ║  Success Rate:   ${(metrics.successRate * 100).toFixed(1).padStart(7)}%                        ║`,
  );
  console.log(
    `  ║  Total Turns:    ${String(metrics.totalTurns).padStart(8)}                        ║`,
  );
  console.log(
    `  ║  Turn P50:       ${metrics.turnExecution.p50.toFixed(0).padStart(7)}ms                        ║`,
  );
  console.log(
    `  ║  Turn P95:       ${metrics.turnExecution.p95.toFixed(0).padStart(7)}ms                        ║`,
  );
  console.log(
    `  ║  Turn P99:       ${metrics.turnExecution.p99.toFixed(0).padStart(7)}ms                        ║`,
  );
  console.log(
    `  ║  Peak Concurrent:${String(result.concurrentPeak).padStart(8)}                        ║`,
  );
  console.log(
    `  ║  Memory Delta:   ${result.memoryDeltaMB.toFixed(1).padStart(7)} MB                       ║`,
  );
  console.log(`  ╚══════════════════════════════════════════════════════════╝`);
}

function printVerification(verifications: StateVerification[]): void {
  const passed = verifications.filter((v) => v.success).length;
  const initOk = verifications.filter((v) => v.checks.initialized).length;
  const histOk = verifications.filter((v) => v.checks.historyLengthCorrect).length;
  const entOk = verifications.filter((v) => v.checks.entityValuesPresent).length;
  console.log(`\n  ── State Verification ──`);
  console.log(`  Sessions verified: ${verifications.length}`);
  console.log(`  All checks passed: ${passed}/${verifications.length}`);
  console.log(`  Initialized:       ${initOk}/${verifications.length}`);
  console.log(`  History correct:   ${histOk}/${verifications.length}`);
  console.log(`  Entities present:  ${entOk}/${verifications.length}`);
  if (passed < verifications.length) {
    const failed = verifications.filter((v) => !v.success).slice(0, 3);
    for (const f of failed) {
      console.log(
        `  FAIL ${f.sessionId}: missing=[${f.checks.missingEntities}] hist=${f.checks.actualHistoryLength}/${f.checks.expectedHistoryLength}`,
      );
    }
  }
}

describe('High-Throughput Stress Test (300 turns/sec target, 1000-1500ms LLM latency)', () => {
  // -------------------------------------------------------------------------
  // Scenario 1: Baseline — 100 sessions × 3 turns, pool of 100
  // -------------------------------------------------------------------------
  test('tier 1: 100 sessions × 3 turns, 100 concurrent (300 total turns)', async () => {
    const runner = await E2EStressRunner.create(SERVER_CONFIG);

    try {
      const config: LoadScenarioConfig = {
        name: 'Tier 1: 100 sessions, 100 concurrent, 1-1.5s LLM',
        agentDSL: HOTEL_BOOKING_DSL,
        agentName: 'Hotel_Booking',
        conversationInputs: CONVERSATION,
        concurrency: 100,
        totalSessions: 100,
        mode: 'pool',
      };

      const result = await runner.run(config);
      const metrics = MetricsAggregator.compute(result);
      ReportGenerator.print(metrics, config.name);
      printSummary(metrics, result);

      expect(result.sessions).toHaveLength(100);
      expect(metrics.successRate).toBeGreaterThanOrEqual(0.95);

      const ids = result.sessions.map((s) => s.sessionId);
      expect(new Set(ids).size).toBe(ids.length);

      // Verify session state: entity values and history for successful sessions
      const verifications = await runner.verifySessionStates(
        result.sessions,
        CONVERSATION.length,
        EXPECTED_ENTITIES,
      );
      printVerification(verifications);
      const verifyRate = verifications.filter((v) => v.success).length / verifications.length;
      expect(verifyRate).toBeGreaterThanOrEqual(0.9);
    } finally {
      await runner.dispose();
    }
  }, 120_000);

  // -------------------------------------------------------------------------
  // Scenario 2: Scale — 200 sessions × 3 turns, pool of 150
  // -------------------------------------------------------------------------
  test('tier 2: 200 sessions × 3 turns, 150 concurrent (600 total turns)', async () => {
    const runner = await E2EStressRunner.create(SERVER_CONFIG);

    try {
      const config: LoadScenarioConfig = {
        name: 'Tier 2: 200 sessions, 150 concurrent, 1-1.5s LLM',
        agentDSL: HOTEL_BOOKING_DSL,
        agentName: 'Hotel_Booking',
        conversationInputs: CONVERSATION,
        concurrency: 150,
        totalSessions: 200,
        mode: 'pool',
      };

      const result = await runner.run(config);
      const metrics = MetricsAggregator.compute(result);
      ReportGenerator.print(metrics, config.name);
      printSummary(metrics, result);

      expect(result.sessions).toHaveLength(200);
      expect(metrics.successRate).toBeGreaterThanOrEqual(0.85);

      const ids = result.sessions.map((s) => s.sessionId);
      expect(new Set(ids).size).toBe(ids.length);

      // Verify state for successful sessions
      const verifications = await runner.verifySessionStates(
        result.sessions,
        CONVERSATION.length,
        EXPECTED_ENTITIES,
      );
      printVerification(verifications);
      const verifyRate = verifications.filter((v) => v.success).length / verifications.length;
      expect(verifyRate).toBeGreaterThanOrEqual(0.8);
    } finally {
      await runner.dispose();
    }
  }, 180_000);

  // -------------------------------------------------------------------------
  // Scenario 3: Push — 300 sessions × 3 turns, pool of 200
  // -------------------------------------------------------------------------
  test('tier 3: 300 sessions × 3 turns, 200 concurrent (900 total turns)', async () => {
    const runner = await E2EStressRunner.create(SERVER_CONFIG);

    try {
      const config: LoadScenarioConfig = {
        name: 'Tier 3: 300 sessions, 200 concurrent, 1-1.5s LLM',
        agentDSL: HOTEL_BOOKING_DSL,
        agentName: 'Hotel_Booking',
        conversationInputs: CONVERSATION,
        concurrency: 200,
        totalSessions: 300,
        mode: 'pool',
      };

      const result = await runner.run(config);
      const metrics = MetricsAggregator.compute(result);
      ReportGenerator.print(metrics, config.name);
      printSummary(metrics, result);

      expect(result.sessions).toHaveLength(300);
      // At this scale, measure degradation — don't hard-fail
      expect(metrics.successRate).toBeGreaterThanOrEqual(0.5);

      const ids = result.sessions.map((s) => s.sessionId);
      expect(new Set(ids).size).toBe(ids.length);

      // Verify state — lower threshold at high concurrency
      const verifications = await runner.verifySessionStates(
        result.sessions,
        CONVERSATION.length,
        EXPECTED_ENTITIES,
      );
      printVerification(verifications);
      // At 200 concurrent, expect ≥50% of successful sessions to have correct state
      const verifyRate = verifications.filter((v) => v.success).length / verifications.length;
      expect(verifyRate).toBeGreaterThanOrEqual(0.5);
    } finally {
      await runner.dispose();
    }
  }, 300_000);

  // -------------------------------------------------------------------------
  // Scenario 4: Saturation — 500 sessions × 3 turns, pool of 300
  // Find the single-node ceiling under realistic LLM latency
  // -------------------------------------------------------------------------
  test('tier 4 (saturation): 500 sessions × 3 turns, 300 concurrent (1500 total turns)', async () => {
    const runner = await E2EStressRunner.create(SERVER_CONFIG);

    try {
      const config: LoadScenarioConfig = {
        name: 'Tier 4 (Saturation): 500 sessions, 300 concurrent, 1-1.5s LLM',
        agentDSL: HOTEL_BOOKING_DSL,
        agentName: 'Hotel_Booking',
        conversationInputs: CONVERSATION,
        concurrency: 300,
        totalSessions: 500,
        mode: 'pool',
      };

      const result = await runner.run(config);
      const metrics = MetricsAggregator.compute(result);
      ReportGenerator.print(metrics, config.name);
      printSummary(metrics, result);

      expect(result.sessions).toHaveLength(500);
      // Saturation test — report results, don't gate on success rate
      // This finds the ceiling
      console.log(
        `\n  → SATURATION RESULT: ${(metrics.successRate * 100).toFixed(1)}% success at ${metrics.throughputTurnsPerSec.toFixed(1)} turns/sec`,
      );

      const ids = result.sessions.map((s) => s.sessionId);
      expect(new Set(ids).size).toBe(ids.length);

      // Report state verification — no hard gate at saturation, just observe
      const verifications = await runner.verifySessionStates(
        result.sessions,
        CONVERSATION.length,
        EXPECTED_ENTITIES,
      );
      printVerification(verifications);
      const verifyRate = verifications.filter((v) => v.success).length / verifications.length;
      console.log(
        `\n  → STATE VERIFICATION: ${(verifyRate * 100).toFixed(1)}% of successful sessions have correct state`,
      );
    } finally {
      await runner.dispose();
    }
  }, 600_000);

  // -------------------------------------------------------------------------
  // Scenario 5: Persistence under load — 30 sessions × 3 turns, pool of 30
  // Smaller pool because runWithPersistence verifies sequentially (~1.25s each)
  // -------------------------------------------------------------------------
  test('persistence: 30 sessions × 3 turns, 30 concurrent + verification', async () => {
    const runner = await E2EStressRunner.create(SERVER_CONFIG);

    try {
      const config: LoadScenarioConfig = {
        name: 'Persistence: 30 sessions, 30 concurrent, 1-1.5s LLM + verify',
        agentDSL: HOTEL_BOOKING_DSL,
        agentName: 'Hotel_Booking',
        conversationInputs: CONVERSATION,
        concurrency: 30,
        totalSessions: 30,
        mode: 'pool',
      };

      const result = await runner.runWithPersistence(config, EXPECTED_ENTITIES);
      const metrics = MetricsAggregator.compute(result);
      ReportGenerator.print(metrics, config.name);
      printSummary(metrics, result);

      expect(result.sessions).toHaveLength(30);
      expect(metrics.successRate).toBeGreaterThanOrEqual(0.9);

      // stateMatch now verifies: initialized + entity values present
      // historyMatch now verifies: history length correct + follow-up response
      const persistSuccess = result.persistence.filter((p) => p.stateMatch);
      const historySuccess = result.persistence.filter((p) => p.historyMatch);
      expect(persistSuccess.length).toBeGreaterThanOrEqual(result.persistence.length * 0.85);
      expect(historySuccess.length).toBeGreaterThanOrEqual(result.persistence.length * 0.85);

      console.log(
        `\n  → Persistence state:   ${persistSuccess.length}/${result.persistence.length} verified (entities + initialized)`,
      );
      console.log(
        `  → Persistence history: ${historySuccess.length}/${result.persistence.length} verified (history length + follow-up)`,
      );

      const ids = result.sessions.map((s) => s.sessionId);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      await runner.dispose();
    }
  }, 120_000);
});
