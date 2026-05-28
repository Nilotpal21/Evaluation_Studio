import type { PipelineTemplate } from '../../types.js';

const MINUTE_MS = 60_000;
const CONCERNS_AUDIT_TIMEOUT_MS = 10 * MINUTE_MS;

/**
 * Drift-Audit Pipeline
 *
 * Single deterministic stage over the `.helix/concerns/` registry. Lands
 * findings on the session so downstream consumers (slice packets, MCP
 * `search_findings`, JIRA adapter, daemon) see cross-cutting drift as
 * first-class artifacts rather than raw JSONL.
 *
 * Planning, fix, and ticket-creation stages are intentionally out of scope
 * here — they belong to the JIRA adapter (Step 4) and daemon loop (Step 5)
 * that consume this template's output.
 *
 * The `model` field is populated with a stub assignment to satisfy the
 * `StageDefinition` contract. The `concerns-audit` stage handler bypasses
 * the model router entirely; the stub is never invoked.
 */
export const driftAuditPipeline: PipelineTemplate = {
  name: 'Drift Audit',
  description:
    'Deterministic scan over .helix/concerns — emits drift findings to the session without running any model',
  applicableTo: ['drift-audit'],
  stages: [
    {
      name: 'Concerns Audit',
      type: 'concerns-audit',
      description:
        'Walk the repo once and run deterministic detectors from the concerns registry over scoped files',
      model: { primary: { engine: 'claude-code' } },
      canLoop: false,
      maxLoopIterations: 1,
      timeoutMs: CONCERNS_AUDIT_TIMEOUT_MS,
    },
  ],
};
