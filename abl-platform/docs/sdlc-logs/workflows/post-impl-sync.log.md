# Post-Impl Sync Log — workflows

## 2026-04-19 — Narrow sync (deferred full SDLC-compliant sync)

**Commits synced** (most recent at top):

- `91b92c11dd` fix(runtime): preserve empty node configs in draft→Workflow back-sync
- `8bf86b99b6` fix(workflow-engine): wire TriggerScheduler with WorkflowVersion + re-register connector triggers on resume
- `f1406d51d2` refactor(studio): remove dead saveWorkflowCanvas
- `0c45727808` fix(workflow-engine,runtime): close two schema-validation gaps (registerTriggerSchema, updateWorkflowRequestSchema)
- `4ef598f158` fix(studio): unwrap workflow usage envelope so `.tools` is defined
- `10805fdf31` feat(studio): surface workflow usage on the list card and detail overview
- `1375a01ad9` feat(runtime): workflow usage endpoint + list enrichment
- `b2980e497c` fix(studio): render workflow card badge from the right trigger field
- `53c910d99f` fix(studio): forward request body on the Fire Now proxy route
- `e4f1bd7456` fix(workflow-engine): seed ctx.vars from triggerPayload
- `ae13e2a936` fix(workflow-engine): unify debug and fire-now on the draft WorkflowVersion
- `dee3c5ca4e` fix(runtime): sync inputSchema/outputSchema from draft version to Workflow doc
- `d74c655876` feat(studio): derive workflow input/output schema from canvas authoring
- `ae87caeb07` feat(workflow-engine): accept typed end-node outputMapping without strict validation
- `df4f5a31a7` feat(studio): derive curl and Fire Now sample from workflow inputSchema
- `37a340263c` feat(studio): Fire Now payload editor for webhook and app triggers
- `0e2d449947` feat(runtime): proxy trigger sample-payload endpoint
- `2f9ca51ccf` feat(workflow-engine): add trigger sample-payload endpoint for Fire Now replay
- `a2242fea72` refactor(studio): inline cron description in trigger card header + webhook-only collapse
- `7f2002bd67` fix(workflow-engine): preserve triggerType when firing triggers internally

## Docs updated (this pass)

- `docs/features/workflows.md` — Last Updated → 2026-04-19; added `/usage` + `/sample-payload` + `/fire` rows to API tables; added 12 new entries (GAP-18 … GAP-29) to Mitigated Gaps

## Docs deferred (still to sync)

- `docs/features/workflows.md` §8 Architecture Components — new files (FireTriggerModal, json-schema-sample, variables-to-json-schema, usage route, sample-payload route) not yet listed
- `docs/testing/workflows.md` — coverage matrix not updated. No new tests were authored in this session; existing E2E/integration coverage unchanged. Testing index not updated.
- `docs/testing/README.md` — not updated
- HLD / LLD docs for the Fire Now payload editor, workflow usage, canvas-authored schema derivation — no specs authored yet. Recommend `/feature-spec` + `/test-spec` for each in a dedicated session before a full SDLC-compliant sync.
- `agents.md` for touched packages (apps/studio, apps/runtime, apps/workflow-engine, packages/connectors) — not updated

## Phase auditor

Skipped — narrow sync, not a full SDLC gate. Run the auditor on a full sync pass.

## Coverage delta

No new unit / integration / E2E tests authored in this session. Existing
trigger-fire-resolution (13), canvas-to-steps (47), workflow-handler (24),
executions-semver (6) all pass against the updated code.
