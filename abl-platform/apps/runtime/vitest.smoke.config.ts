/**
 * Vitest SMOKE tier — critical-path tests only.
 *
 * Runs ~20 core execution tests that cover the most important runtime paths:
 *   - Constraint checking & control flow
 *   - Reasoning executor (guards, streaming)
 *   - Flow execution (gather, ON_INPUT, step transitions)
 *   - Extraction pipeline & strategy
 *   - Guardrail pipeline & output guardrails
 *   - Routing conditions & delegate failures
 *   - CEL expression evaluation
 *   - Prompt building
 *   - Gather utilities
 *
 * Used by `pnpm test:smoke` and the pre-push hook for fastest feedback.
 * Target: <15s wall-clock.
 *
 * Run with:
 *   npx vitest run --config vitest.smoke.config.ts
 *   pnpm test:smoke
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      // ── Constraint engine ─────────────────────────────────────────────
      'src/__tests__/extraction/constraint-checker.test.ts',
      'src/__tests__/extraction/constraint-control-flow-enhanced.test.ts',

      // ── Reasoning executor (core LLM interaction loop) ────────────────
      'src/__tests__/execution/reasoning-executor-guards.test.ts',
      'src/__tests__/execution/reasoning-executor-streaming.test.ts',

      // ── Flow execution ────────────────────────────────────────────────
      'src/__tests__/execution/flow-execution-coverage.test.ts',
      'src/__tests__/execution/flow-gather-oninput.test.ts',
      'src/__tests__/execution/flow-step-helpers.test.ts',

      // ── Entity extraction ─────────────────────────────────────────────
      'src/__tests__/extraction/extraction-pipeline.test.ts',
      'src/__tests__/extraction/extraction-strategy.test.ts',

      // ── Guardrails ────────────────────────────────────────────────────
      'src/__tests__/guardrail-pipeline-expanded.test.ts',
      'src/__tests__/output-guardrails.test.ts',

      // ── Routing ───────────────────────────────────────────────────────
      'src/__tests__/routing/routing-conditions.test.ts',
      'src/__tests__/routing/routing-delegate-failures.test.ts',

      // ── CEL expressions ───────────────────────────────────────────────
      'src/__tests__/cel-runtime-integration.test.ts',

      // ── Prompt building ───────────────────────────────────────────────
      'src/__tests__/routing/prompt-builder.test.ts',
      'src/__tests__/query-token-transport-guard.test.ts',

      // ── Gather utilities ──────────────────────────────────────────────
      'src/__tests__/extraction/gather-utils.test.ts',

      // ── Transport guardrails ──────────────────────────────────────────
      'src/__tests__/runtime-ws-client-guard.test.ts',
    ],

    pool: 'threads',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
