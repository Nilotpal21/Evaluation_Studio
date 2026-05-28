/**
 * Orchestration Test Harness
 *
 * Thin wrapper over RuntimeExecutor providing helpers for multi-agent
 * orchestration testing. Supports both deterministic (scripted FLOW agents)
 * and live-LLM (reasoning agents) tiers.
 *
 * Uses the same patterns as flow-handoff-threads.test.ts:
 * - compileToResolvedAgent() to create multi-agent sessions
 * - registerAgent() for child agents
 * - executeMessage() with trace/chunk callbacks
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { expect } from 'vitest';
import {
  RuntimeExecutor,
  compileToResolvedAgent,
  getActiveThread,
  type RuntimeSession,
} from '../../services/runtime-executor';
import {
  assertSessionHistoryIntegrity,
  createTraceCollector,
  filterTraces,
  type CapturedTrace,
} from './history-validation';

// =============================================================================
// FIXTURE LOADER
// =============================================================================

const ORCHESTRATION_FIXTURES_DIR = join(import.meta.dirname, '../fixtures/orchestration');

export function loadOrchestrationFixture(filename: string): string {
  return readFileSync(join(ORCHESTRATION_FIXTURES_DIR, filename), 'utf-8');
}

// =============================================================================
// TYPES
// =============================================================================

export interface OrchestrationTestContext {
  executor: RuntimeExecutor;
  session: RuntimeSession;
  traces: CapturedTrace[];
  chunks: string[];
  onChunk: (chunk: string) => void;
  onTraceEvent: (event: { type: string; data: Record<string, unknown> }) => void;
}

export interface SendMessageResult {
  response: string;
  action: { type: string; [key: string]: unknown };
  chunks: string[];
  traces: CapturedTrace[];
}

// =============================================================================
// HARNESS HELPERS
// =============================================================================

/**
 * Create a multi-agent session from DSL strings.
 * Registers child agents and creates a session for the entry agent.
 */
export function createOrchestrationSession(
  executor: RuntimeExecutor,
  entryAgentDsl: string,
  childAgentDsls: string[],
  entryAgentName: string,
): RuntimeSession {
  // Register child agents individually
  for (const dsl of childAgentDsls) {
    const nameMatch = dsl.match(/^(?:AGENT|SUPERVISOR):\s*(\S+)/m);
    if (nameMatch) {
      executor.registerAgent(nameMatch[1], dsl);
    }
  }

  // Create session with all DSLs (entry + children)
  const allDsls = [entryAgentDsl, ...childAgentDsls];
  return executor.createSessionFromResolved(compileToResolvedAgent(allDsls, entryAgentName));
}

/**
 * Send a message to a session and collect results.
 */
export async function sendMessage(
  executor: RuntimeExecutor,
  sessionId: string,
  message: string,
): Promise<SendMessageResult> {
  const chunks: string[] = [];
  const { traces, callback: onTraceEvent } = createTraceCollector();

  const result = await executor.executeMessage(
    sessionId,
    message,
    (c) => chunks.push(c),
    onTraceEvent,
  );

  return {
    response: result.response,
    action: result.action,
    chunks,
    traces,
  };
}

// =============================================================================
// ASSERTION HELPERS
// =============================================================================

/**
 * Assert the number of threads in a session.
 */
export function assertThreadCount(session: RuntimeSession, expected: number): void {
  expect(
    session.threads.length,
    `Expected ${expected} threads, got ${session.threads.length}. ` +
      `Threads: ${session.threads.map((t) => `${t.agentName}(${t.status})`).join(', ')}`,
  ).toBe(expected);
}

/**
 * Assert which agent is currently active.
 */
export function assertActiveAgent(session: RuntimeSession, agentName: string): void {
  const active = getActiveThread(session);
  expect(
    active?.agentName,
    `Expected active agent "${agentName}", got "${active?.agentName}". ` +
      `activeThreadIndex=${session.activeThreadIndex}`,
  ).toBe(agentName);
}

/**
 * Assert a handoff trace event was emitted from one agent to another.
 */
export function assertHandoffOccurred(
  traces: CapturedTrace[],
  from: string,
  to: string,
): CapturedTrace {
  const handoffs = filterTraces(traces, 'handoff');
  const match = handoffs.find(
    (t) => (t.data.from === from || t.data.agent === from) && t.data.to === to,
  );
  expect(
    match,
    `No handoff trace found from "${from}" to "${to}". ` +
      `Found: ${handoffs.map((h) => `${h.data.from || h.data.agent}->${h.data.to}`).join(', ')}`,
  ).toBeDefined();
  return match!;
}

/**
 * Assert that data was passed to a thread via PASS fields.
 */
export function assertDataPassed(
  session: RuntimeSession,
  threadIndex: number,
  key: string,
  value: unknown,
): void {
  const thread = session.threads[threadIndex];
  expect(thread, `Thread at index ${threadIndex} does not exist`).toBeDefined();
  expect(
    thread.data.values[key],
    `Expected thread[${threadIndex}] (${thread.agentName}) data.values.${key} to be ${JSON.stringify(value)}, ` +
      `got ${JSON.stringify(thread.data.values[key])}`,
  ).toEqual(value);
}

/**
 * Assert a thread has a specific status.
 */
export function assertThreadStatus(
  session: RuntimeSession,
  threadIndex: number,
  status: string,
): void {
  const thread = session.threads[threadIndex];
  expect(thread, `Thread at index ${threadIndex} does not exist`).toBeDefined();
  expect(
    thread.status,
    `Expected thread[${threadIndex}] (${thread.agentName}) status "${status}", got "${thread.status}"`,
  ).toBe(status);
}

/**
 * Assert that the session has valid conversation history across all threads.
 */
export function assertOrchestrationIntegrity(session: RuntimeSession): void {
  assertSessionHistoryIntegrity(session);
}

/**
 * Assert that a specific trace type exists in the collected traces.
 */
export function assertTraceExists(traces: CapturedTrace[], type: string): CapturedTrace {
  const match = traces.find((t) => t.type === type);
  expect(
    match,
    `No trace of type "${type}" found. Types: ${[...new Set(traces.map((t) => t.type))].join(', ')}`,
  ).toBeDefined();
  return match!;
}
