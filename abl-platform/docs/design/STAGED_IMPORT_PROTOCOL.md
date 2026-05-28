# Staged Import Protocol

## Overview

The staged import system provides a multi-phase import with rollback guarantees. It replaces the legacy "apply immediately" approach with a stage-activate-cleanup pipeline that ensures atomicity per layer.

Source: `packages/project-io/src/import/staged-importer.ts`

## Import Flows

### Legacy Import (v1)

Simple read-validate-apply flow with basic rollback:

```
Upload files → readFolder → validateManifest → validateImport → computeApplyOperations → apply
```

- Applies creates/updates/deletes in batch
- On failure: rolls back created agents (deletes them), but cannot undo updates
- No operation tracking

### Staged Import (v2)

Four-phase pipeline with per-layer atomicity:

```
Upload files → readFolderV2 → detectLayers → Stage → Activate → Cleanup
```

Triggered by adding `?staged=true` to the apply endpoint.

## State Machine

```
   ┌─────────┐
   │ pending  │  (initial state per layer)
   └────┬─────┘
        │ createImportOperation()
        v
   ┌──────────┐
   │ staging   │  Phase 2: insert records with status='staged'
   └────┬──────┘
        │ success
        v
   ┌──────────┐
   │activating │  Phase 3: per-layer bulkWrite (staged→active, old→superseded)
   └────┬──────┘
        │ success          │ failure
        v                  v
   ┌───────────┐    ┌──────────────┐
   │ completed  │    │ rolling_back │  Reverse: staged→deleted, superseded→active
   └───────────┘    └──────┬───────┘
                           v
                    ┌──────────┐
                    │  failed   │
                    └──────────┘
```

Per-layer statuses tracked independently: `pending → staged → activated | rolled_back`.

## Phases

### Phase 1: Validation (client-side)

Before calling apply, the client calls `/import/preview` which runs:

1. `readFolderV2()` — parse files into layer buckets
2. `validateManifest()` — check manifest fields and file references
3. `validateImport()` — ABL syntax checks and dependency graph validation
4. `calculateImportDiffs()` — compute added/modified/removed/unchanged

### Phase 2: Stage

Insert all new/updated records with `status: 'staged'`. Records are invisible to the running system because queries filter on `status: 'active'`.

```typescript
for (const [collection, docs] of byCollection) {
  const ids = await db.insertStagedRecords(collection, docs); // status='staged'
  stagedRecordIds[collection] = ids;
}
```

**On failure**: delete all staged records created so far (cleanup). No active data is affected.

### Phase 3: Activate

Per-layer, in dependency order, execute a single `bulkWrite`:

1. Mark existing active records as `superseded`
2. Mark staged records as `active`

This is atomic per collection — either both operations succeed or neither does.

**On failure**: rollback all completed layers in reverse order (staged→deleted, superseded→active).

### Phase 4: Cleanup

Fire-and-forget deletion of superseded records. Idempotent, safe to retry. Failures are logged but don't affect the import result.

## Activation Order

Layers activate in dependency order — dependencies before dependents:

```typescript
const ACTIVATION_ORDER: LayerName[] = [
  'connections', // 1. connectors first (tools may reference them)
  'core', // 2. agents + tools
  'workflows', // 3. workflows (may reference agents)
  'guardrails', // 4. guardrails (may reference agents)
  'evals', // 5. evals (reference agents + scenarios)
  'channels', // 6. channels (reference agents + deployments)
  'vocabulary', // 7. vocabulary (independent)
];
```

The `search` layer is not yet in the activation order — search index import requires separate handling.

## Rollback Guarantees

| Phase                | Failure Mode    | Rollback                                                 |
| -------------------- | --------------- | -------------------------------------------------------- |
| Staging              | DB insert fails | Delete all staged records created so far                 |
| Activation (layer N) | bulkWrite fails | Reverse layers 1..N-1: staged→deleted, superseded→active |
| Cleanup              | Delete fails    | Logged, retried via TTL expiration                       |

Rollback happens in **reverse activation order** to respect dependencies.

## Supported Entities

The MongoDB adapter maps collection names to models:

| Collection              | Model               | Layer       |
| ----------------------- | ------------------- | ----------- |
| `project_agents`        | ProjectAgent        | core        |
| `project_tools`         | ProjectTool         | core        |
| `connector_connections` | ConnectorConnection | connections |
| `connector_configs`     | ConnectorConfig     | connections |
| `guardrail_policies`    | GuardrailPolicy     | guardrails  |
| `workflows`             | Workflow            | workflows   |
| `eval_sets`             | EvalSet             | evals       |
| `channel_connections`   | ChannelConnection   | channels    |
| `domain_vocabularies`   | DomainVocabulary    | vocabulary  |

## Import Operation Record

Each staged import creates an `ImportOperation` document:

```typescript
{
  projectId: string;
  tenantId: string;
  status: 'staging' | 'activating' | 'rolling_back' | 'completed' | 'failed';
  layers: Record<string, { status: string }>;
  stagedRecordIds: Record<string, string[]>;
  supersededRecordIds: Record<string, string[]>;
  error?: { phase: string; layer: string; message: string };
  expiresAt: Date;  // TTL: 1 hour
}
```

Poll via `GET /api/projects/:id/import/status?operationId=xxx`.

## v1 Migration

When importing a v1 export (no `format_version` or `"1.0"`), the `migrateV1ToV2()` function:

1. Wraps the v1 manifest into a v2 manifest with `layers_included: ['core']`
2. Skips lockfile v2 verification (v1 lockfiles have a different shape)
3. Emits a warning: `"v1 format — configs, connections, workflows not included"`

Unknown future versions (`format_version > "2.0"`) are rejected with an upgrade prompt.

Source: `packages/project-io/src/import/v1-migration.ts`

## Cross-Layer Validation

After folder reading, `validateCrossLayerDeps()` checks:

- Agent DSL `TOOLS:` and `USE:` references resolve to available tool files
- Tool DSL `CONNECTOR:` references resolve to available connection files
- Missing dependencies are reported as `missingDependencies` with source/target layer info

Source: `packages/project-io/src/import/import-validator.ts`

## Post-Import Doctor

After import, `GET /api/projects/:id/import/doctor` runs a read-only scan:

```json
{
  "status": "action_required",
  "provisioning_required": {
    "env_vars": ["HOTEL_API_KEY"],
    "connectors_needing_credentials": ["salesforce"],
    "mcp_servers_needing_auth": ["weather_api"]
  },
  "warnings": ["Guardrail 'pii_filter' references provider 'openai' which is not configured"],
  "layer_summary": { "core": { "imported": 5, "skipped": 0 } }
}
```

Reports status as `ready`, `imported_with_warnings`, or `action_required`.

Source: `packages/project-io/src/import/post-import-validator.ts`

## Error Scenarios

| Error                 | Cause                                      | Recovery                               |
| --------------------- | ------------------------------------------ | -------------------------------------- |
| `INVALID_FOLDER`      | No agent files, invalid JSON               | Fix files and retry                    |
| `INVALID_MANIFEST`    | Missing required fields, broken references | Fix manifest and retry                 |
| Syntax errors         | Agent files missing header                 | Fix DSL syntax                         |
| Staging failure       | DB write error                             | Automatic cleanup of staged records    |
| Activation failure    | bulkWrite error                            | Automatic rollback of completed layers |
| `UNSUPPORTED_VERSION` | Future format version                      | Upgrade Studio/CLI                     |
| `MISSING_MANIFEST`    | No project.json                            | Add manifest or use v1 import          |
