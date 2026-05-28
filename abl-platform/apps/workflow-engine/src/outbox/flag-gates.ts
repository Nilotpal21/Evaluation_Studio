/**
 * Feature-flag gates for the workflow event-sourcing pipeline.
 *
 * All 4 flags default to `false` — enabling them is a deployment-config
 * change (`abl-platform-deploy`), not a code change. Pure function keeps
 * the flag-truth consolidated here; no other code path should read
 * `process.env.WORKFLOW_*` directly.
 *
 * Flags:
 * - WORKFLOW_OUTBOX_ENABLED      — write-path: domain+outbox tx + poller
 * - WORKFLOW_CH_SINK_ENABLED     — consumer sink + initWorkflowEventTables
 * - WORKFLOW_DUAL_READ_ENABLED   — read-path: HybridExecutionReader merge
 * - WORKFLOW_MONGO_TTL_ENABLED   — Phase 6: Mongo domain-doc TTL reaper
 */

export interface WorkflowEventSourcingFlags {
  outboxEnabled: boolean;
  chSinkEnabled: boolean;
  dualReadEnabled: boolean;
  mongoTtlEnabled: boolean;
}

export function readFlags(env: NodeJS.ProcessEnv = process.env): WorkflowEventSourcingFlags {
  return {
    outboxEnabled: env.WORKFLOW_OUTBOX_ENABLED === 'true',
    chSinkEnabled: env.WORKFLOW_CH_SINK_ENABLED === 'true',
    dualReadEnabled: env.WORKFLOW_DUAL_READ_ENABLED === 'true',
    mongoTtlEnabled: env.WORKFLOW_MONGO_TTL_ENABLED === 'true',
  };
}
