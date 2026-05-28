// apps/runtime/src/__tests__/e2e/ai4hc-payer/assertions.ts

/**
 * Shared assertion helpers for AI4HC Payer E2E tests.
 * English text matching, agent routing verification, timing checks.
 */

import { expect } from 'vitest';
import type { ParsedResponse } from './sse-client';
import type { Turn } from './scenarios';

/**
 * Normalize text for comparison: lowercase, collapse whitespace.
 */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Check if text contains any of the expected keywords (case-insensitive).
 */
export function containsAny(text: string, keywords: string[]): boolean {
  const normalized = normalizeText(text);
  return keywords.some((kw) => normalized.includes(normalizeText(kw)));
}

/**
 * Check if text contains none of the forbidden keywords.
 */
export function containsNone(text: string, keywords: string[]): boolean {
  const normalized = normalizeText(text);
  return keywords.every((kw) => !normalized.includes(normalizeText(kw)));
}

/**
 * Assert a turn response matches expected behavior.
 */
export function assertTurnResponse(
  result: ParsedResponse,
  turn: Turn,
  turnIndex: number,
  scenarioName: string,
): void {
  const ctx = `[${scenarioName} Turn ${turnIndex + 1}]`;

  // Must have non-empty response
  expect(result.fullText.length, `${ctx} Empty response`).toBeGreaterThan(0);

  // Check expected keywords
  if (turn.expectAny && turn.expectAny.length > 0) {
    const found = containsAny(result.fullText, turn.expectAny);
    if (!found) {
      console.log(`${ctx} Response text: "${result.fullText.slice(0, 500)}"`);
      console.log(`${ctx} Expected any of: ${turn.expectAny.join(', ')}`);
    }
    expect(found, `${ctx} Expected keywords not found in response`).toBe(true);
  }

  // Check forbidden keywords
  if (turn.expectNone && turn.expectNone.length > 0) {
    const clean = containsNone(result.fullText, turn.expectNone);
    expect(clean, `${ctx} Forbidden keywords found in response`).toBe(true);
  }

  // Check agent routing (if detectable)
  if (turn.expectAgent && result.agentInfo?.displayName) {
    const actualAgent = result.agentInfo.displayName;
    const expectedNorm = normalizeText(turn.expectAgent);
    const actualNorm = normalizeText(actualAgent);
    const agentMatch = actualNorm.includes(expectedNorm) || expectedNorm.includes(actualNorm);
    if (!agentMatch) {
      console.log(`${ctx} Agent mismatch: expected="${turn.expectAgent}" got="${actualAgent}"`);
    }
  }

  // Check timing
  if (turn.maxTimeMs) {
    const totalMs = result.timing.endMs - result.timing.startMs;
    if (totalMs > turn.maxTimeMs) {
      console.warn(
        `${ctx} Slow response: ${(totalMs / 1000).toFixed(1)}s > ${(turn.maxTimeMs / 1000).toFixed(1)}s limit`,
      );
    }
  }
}

/**
 * Log detailed timing and event info for a turn.
 */
export function logTurnDetails(
  result: ParsedResponse,
  turnIndex: number,
  scenarioName: string,
): void {
  const t = result.timing;
  const ttfb = t.firstChunkMs ? t.firstChunkMs - t.startMs : 0;
  const ttft = t.firstTokenMs ? t.firstTokenMs - t.startMs : 0;
  const total = t.endMs - t.startMs;

  console.log(`\n── ${scenarioName} · Turn ${turnIndex + 1} ──`);
  console.log(
    `  TTFB: ${(ttfb / 1000).toFixed(2)}s | TTFT: ${(ttft / 1000).toFixed(2)}s | Total: ${(total / 1000).toFixed(2)}s`,
  );
  console.log(`  Events: ${result.events.length} | Chars: ${result.fullText.length}`);
  if (result.agentInfo) {
    console.log(`  Agent: ${result.agentInfo.displayName}`);
  }
  console.log(
    `  Response: "${result.fullText.slice(0, 200)}${result.fullText.length > 200 ? '...' : ''}"`,
  );
}
