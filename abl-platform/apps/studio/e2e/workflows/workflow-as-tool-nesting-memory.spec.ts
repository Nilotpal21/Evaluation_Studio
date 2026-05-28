/**
 * Workflow-as-Tool Nesting — Agent Context Propagation (E2E-5)
 *
 * Covers test-spec scenario E2E-5 — "Workflow-as-tool nesting propagates
 * outermost agent context" — from
 * `docs/testing/sub-features/workflow-first-class-memory-and-context.md`.
 *
 * STATUS: closed at the contract level via integration tests; HTTP-end-to-end
 * coverage stays scaffolded.
 *
 * GAP-018 closure (2026-04-28): the actual contract — that the inner
 * workflow's `actor.endUserId` matches the outermost agent's `endUserId`
 * AND that two runs sharing the same end-user actor see the same
 * `memory.user.*` state — is now covered at the runtime boundary by:
 *
 *   • `apps/workflow-engine/src/__tests__/workflow-memory-isolate.test.ts`
 *     "INT-3 + INT-13 — agentSession ↔ memory.user actor derivation
 *     (GAP-018 contract)" — two tests using a real V8 isolate, real
 *     `/api/internal/memory` route, real Mongo, and synthetic `agentSession`
 *     matching what `workflow-tool-executor.ts` would build for an
 *     agent-bound run. Asserts: (a) script reads `context.agentSession.
 *     endUserId` and `memory.user.set` persists under that same endUserId
 *     (cross-run readable), (b) two runs with the same end-user actor see
 *     each other's `memory.user.*` writes (the nesting surrogate), and
 *     (c) a different end-user actor sees `__none__` (negative isolation).
 *   • `apps/runtime/src/__tests__/workflow-tool-executor-projection.test.ts`
 *     (INT-13) — proves the upstream propagation: `workflow-tool-executor.ts`
 *     enriches `triggerMetadata` with the positive-list `agentSession`
 *     projection, secrets/tokens/transcripts/binaries excluded.
 *   • `apps/runtime/src/__tests__/agent-projection.test.ts` —
 *     positive-list schema and deep-freeze contract.
 *
 * What this E2E spec would add ON TOP of those: a live HTTP-end-to-end
 * chat → agent → workflow-tool invocation with a real LLM-driven
 * tool-call decision. That requires: a deterministic mock LLM provider
 * injected via DI (or real LLM with deterministic prompts and accepted
 * flakiness), an SDK channel session bootstrap, and a WS chat-frame
 * driver. None of that infrastructure exists in
 * `apps/studio/e2e/workflows/` today, and adding it as part of this
 * feature would balloon scope past the BETA → STABLE bar. Tracked as
 * residual GAP-018 — `test.skip` retained so the scaffold structure
 * stays in place for the v1.1 chat E2E harness work.
 */

import { test } from '@playwright/test';

test.describe('Workflow-as-Tool Nesting — Agent Context (E2E-5)', () => {
  test.skip('HTTP-end-to-end chat → agent → outer-wf → inner-wf with real WS chat session (deferred to v1.1)', async () => {
    // The contract this scenario tests is closed at the integration
    // layer — see file-level docstring above for the cross-references.
    // The remaining E2E delta is the chat-WS driver, which depends on
    // infrastructure outside this feature's scope.
  });
});
