# Export v2: Layered, Git-Synced, SHA-Verified Project Export

**Date:** 2026-03-07
**Status:** Design approved
**Scope:** `packages/project-io`, `apps/studio`, `apps/runtime`, `packages/kore-platform-cli`

## Problem Statement

The current export covers ~20% of project-scoped data. It handles core DSL artifacts (agents + tools) but misses virtually everything that configures how agents **run**: model configs, runtime parameters, environment variables, connections, workflows, guardrails, evals, search/knowledge, channels, and vocabulary.

An exported project imports cleanly (agents + tools parse fine) but **doesn't function** because the runtime configuration is missing. The import succeeds but the project is broken.

### Current Export Coverage

| Included                | Missing                                               |
| ----------------------- | ----------------------------------------------------- |
| Agents (DSL + metadata) | Agent model configs, project settings, runtime config |
| Tools (DSL)             | LLM config, env var refs, config var refs             |
| Behavior profiles       | Connector connections, MCP server configs             |
| Deployments (optional)  | Workflows, guardrails, evals                          |
| Locales                 | Search indexes, knowledge bases, channels             |
| Manifest + lockfile     | Webhooks, vocabulary, lookup tables, schemas          |

## Design Decisions

| Decision                         | Choice                                              | Rationale                                                                                                                                 |
| -------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Dependency graph source of truth | **DSL-authoritative**                               | Manifest carries metadata; dependency graph always derived from parsing actual content. Supports offline editing without stale manifests. |
| Secret handling                  | **References only**                                 | Key names, descriptions, and shapes export. Values come from env vars at runtime. No encrypted envelope complexity.                       |
| Export structure                 | **Layered**                                         | Core always included, heavy layers opt-in. Independent size guards per layer.                                                             |
| Integrity verification           | **Three-tier SHA**                                  | Per-file, per-layer, and root integrity hash in lockfile.                                                                                 |
| Backward compatibility           | **Format v2 with v1 migration**                     | v1 imports treated as core-only with warnings. Unknown future versions rejected.                                                          |
| Git integration                  | **Level 2 — built-in sync, branch-per-environment** | Extends existing GitHub provider to all layers. Git optional but recommended.                                                             |
| Performance                      | **Two-tier: sync HTTP + async BullMQ**              | Small exports (<500 entities, <=2 layers) sync. Large exports async with job polling.                                                     |
| Import safety                    | **Staged activation with atomic swap**              | Shadow records, per-layer activation in dependency order, crash recovery via ImportOperation tracking.                                    |

## Export Layers

| Layer           | Contents                                                                                                                                                                   | Default     | Size Guard             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ---------------------- |
| **Core**        | Agents, tools, behavior profiles, project settings, runtime config, LLM config (no keys), env var refs, config var refs, agent model configs, MCP server configs (no auth) | Always      | 1000 agents, 500 tools |
| **Connections** | Connector connections (auth type + config shape, no credentials), connector configs                                                                                        | Always      | 200 connections        |
| **Guardrails**  | Project-scoped guardrail policies, provider config refs                                                                                                                    | Default ON  | 100 policies           |
| **Workflows**   | Workflow definitions (triggers, steps, escalation rules, SLA targets)                                                                                                      | Default ON  | 200 workflows          |
| **Evals**       | Eval sets, scenarios, personas, evaluators                                                                                                                                 | Default OFF | 500 scenarios          |
| **Search**      | Search index configs, source configs, KB mappings, crawl patterns                                                                                                          | Default OFF | 100 indexes            |
| **Channels**    | Channel connections (type + config shape, no creds), webhook subscriptions, widget configs                                                                                 | Default OFF | 50 channels            |
| **Vocabulary**  | Domain vocabulary, lookup entries, canonical schemas, facts                                                                                                                | Default OFF | 10k entries            |

## Folder Structure (v2)

```
<project-slug>/
├── project.json                              # manifest v2
├── abl.lock                                  # lockfile v2 (3-tier SHA)
├── .gitignore                                # exclude runtime artifacts
│
├── agents/                                   # CORE
│   └── {name}.agent.abl | .agent.yaml
├── tools/                                    # CORE
│   └── {name}.tools.abl
├── behavior_profiles/                        # CORE
│   └── {name}.behavior_profile.abl
├── config/                                   # CORE
│   ├── project-settings.json
│   ├── runtime-config.json
│   ├── llm-config.json                       # provider + model refs, no API keys
│   └── agent-model-configs/
│       └── {agent-name}.model-config.json
├── environment/                              # CORE
│   ├── env-vars.json                         # key names + descriptions, no values
│   └── config-vars.json
│
├── connections/                              # CONNECTIONS
│   ├── connectors/
│   │   └── {name}.connection.json            # auth type, scope, config shape
│   └── mcp-servers/
│       └── {name}.mcp-config.json            # endpoint, capabilities, no auth
│
├── guardrails/                               # GUARDRAILS
│   └── {name}.guardrail.json
│
├── workflows/                                # WORKFLOWS
│   └── {name}.workflow.json
│
├── evals/                                    # EVALS
│   ├── evaluators/
│   │   └── {name}.evaluator.json
│   └── {eval-set-name}/
│       ├── eval-set.json
│       ├── scenarios/
│       │   └── {name}.scenario.json
│       └── personas/
│           └── {name}.persona.json
│
├── search/                                   # SEARCH
│   ├── indexes/
│   │   └── {name}.search-index.json
│   ├── sources/
│   │   └── {name}.search-source.json
│   └── knowledge-bases/
│       └── {name}.knowledge-base.json
│
├── channels/                                 # CHANNELS
│   ├── {name}.channel.json
│   ├── webhooks/
│   │   └── {name}.webhook.json
│   └── widgets/
│       └── {name}.widget.json
│
├── vocabulary/                               # VOCABULARY
│   ├── domain-vocabulary.json
│   ├── lookup-tables/
│   │   └── {table-name}.lookup.json
│   ├── schemas/
│   │   └── {name}.schema.json
│   └── facts.json
│
├── locales/                                  # CORE (if present)
│   └── {lang}/
│       └── {agent-name}.json
│
└── deployments/                              # Optional (opt-in)
    └── {env}.deployment.json
```

## Manifest v2 (`project.json`)

```json
{
  "format_version": "2.0",
  "name": "Hotel Booking System",
  "slug": "hotel-booking-system",
  "description": "Multi-agent hotel booking with escalation",
  "abl_version": "1.0",
  "exported_at": "2026-03-07T10:30:00Z",
  "exported_by": "user-123",
  "entry_agent": "MainSupervisor",
  "dsl_format": "legacy",

  "layers_included": ["core", "connections", "guardrails", "workflows"],

  "agents": {
    "MainSupervisor": {
      "path": "agents/main_supervisor.agent.abl",
      "owner": "user-123",
      "ownerTeam": null,
      "description": "Routes customer requests",
      "version": "1.0"
    }
  },
  "tools": {
    "HotelsAPI": {
      "path": "tools/hotels_api.tools.abl",
      "owner": "user-456"
    }
  },
  "behavior_profiles": {
    "formal_tone": {
      "name": "formal_tone",
      "path": "behavior_profiles/formal_tone.behavior_profile.abl",
      "priority": 1,
      "when_summary": "when user requests formal language",
      "used_by": ["MainSupervisor"]
    }
  },

  "metadata": {
    "entity_counts": {
      "agents": 12,
      "tools": 8,
      "connections": 3,
      "workflows": 2,
      "guardrails": 4,
      "eval_scenarios": 0
    },
    "required_env_vars": ["OPENAI_API_KEY", "SLACK_BOT_TOKEN", "DB_CONNECTION_STRING"],
    "required_connectors": ["salesforce", "zendesk"],
    "required_mcp_servers": ["internal-tools-server"]
  }
}
```

The `metadata.required_*` fields are derived from DSL parsing at export time. They tell the importer exactly what needs to be provisioned before the project can run.

## Lockfile v2 (`abl.lock`)

```json
{
  "lockfile_version": "2.0",
  "generated_at": "2026-03-07T10:30:00Z",

  "agents": {
    "Supervisor": { "version": "1.0", "source_hash": "a1b2c3d4e5f6g7h8", "status": "active" }
  },
  "tools": {
    "HotelsAPI": { "source_hash": "x9y8z7w6v5u4t3s2" }
  },
  "configs": {
    "project-settings": { "source_hash": "..." },
    "runtime-config": { "source_hash": "..." }
  },
  "connections": {
    "salesforce": { "source_hash": "..." }
  },
  "guardrails": {
    "input-filter": { "source_hash": "..." }
  },
  "workflows": {
    "escalation-flow": { "source_hash": "..." }
  },

  "layer_hashes": {
    "core": "sha256-...",
    "connections": "sha256-...",
    "guardrails": "sha256-...",
    "workflows": "sha256-..."
  },

  "integrity": "sha256-of-entire-lockfile"
}
```

**Verification order on import:**

1. Root `integrity` hash — fast reject if corrupted
2. `layer_hashes` — skip unchanged layers
3. Per-file `source_hash` — pinpoint what changed

When Git sync is active, Git's own SHA object model handles integrity. The lockfile SHA scheme is skipped (redundant) but the lockfile is still generated for non-Git consumers.

## Performance: Two-Tier Export

### Threshold Detection

```typescript
const counts = await Promise.all([
  ProjectAgent.countDocuments({ projectId, tenantId }),
  ProjectTool.countDocuments({ projectId, tenantId }),
  Workflow.countDocuments({ projectId, tenantId }),
  // ... per requested layer
]);
const totalEntities = counts.reduce((a, b) => a + b, 0);
```

| Condition                        | Path                 | Mechanism                                                                     |
| -------------------------------- | -------------------- | ----------------------------------------------------------------------------- |
| Core + <=2 layers, <500 entities | **Sync HTTP**        | Parallel queries (2 waves), in-memory assembly, direct response. Target: <10s |
| 3+ layers or >500 entities       | **Async BullMQ job** | Return `jobId`, client polls/SSE. Result stored in GridFS with 15min TTL      |

### DB Impact Mitigations

1. **Staggered parallel queries** — Wave 1 (core: agents, tools, settings, env vars) always fires. Wave 2 (optional layers) fires only for requested layers, after Wave 1 completes.
2. **Lean queries with projection** — `.lean()` + `.select()` fetches only export-relevant fields.
3. **Read preference: `secondaryPreferred`** — Routes export reads to replica set secondaries.
4. **Rate limiting** — 10 exports/min/tenant (existing). Max 2 concurrent async export jobs/tenant.
5. **Index coverage** — Every query filters by `{ projectId, tenantId }`, which are indexed.

## Import: Staged Activation with Rollback

### Four-Phase Import

```
Phase 1: VALIDATE (read-only)
    Parse all files
    Derive dependency graph from DSL content (authoritative)
    Cross-check manifest metadata (advisory — mismatches produce warnings)
    SHA verification (integrity → layer → per-file)
    Diff calculation per layer
    Return preview — STOP here unless user confirms

Phase 2: STAGE (write shadow records)
    Write all new/updated entities with status: "staged"
    Staged records are invisible to runtime (queries filter by status: "active")
    If anything fails → delete all "staged" records (safe, they were never live)

Phase 3: ACTIVATE (atomic swap, dependency order)
    For each layer, in order: connections → tools → agents → workflows → guardrails → evals → channels
        1. Mark old records as status: "superseded"
        2. Mark staged records as status: "active"
        3. Both operations in a single bulkWrite per collection
    ImportOperation record tracks per-layer progress for crash recovery

Phase 4: CLEANUP (async, non-blocking)
    Delete "superseded" records
    Idempotent — safe to re-run
```

### Crash Recovery

| Crash Point                                | State                       | Recovery                                                                                                                          |
| ------------------------------------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Before any layer activates                 | All records "staged"        | Cleanup job deletes staged records                                                                                                |
| After some layers activated                | Mixed state                 | ImportOperation tracks which layers completed. Resume from last incomplete, or rollback by flipping "superseded" back to "active" |
| After all layers activated, before cleanup | "superseded" records linger | Background cleanup job handles this                                                                                               |

### ImportOperation Record

```typescript
interface ImportOperation {
  _id: ObjectId;
  projectId: string;
  tenantId: string;
  status: 'validating' | 'staging' | 'activating' | 'completed' | 'failed' | 'rolling_back';
  layers: Record<
    string,
    {
      status: 'pending' | 'staged' | 'activated' | 'rolled_back';
    }
  >;
  stagedRecordIds: Record<string, ObjectId[]>;
  supersededRecordIds: Record<string, ObjectId[]>;
  error?: { phase: string; layer: string; message: string };
  createdAt: Date;
  expiresAt: Date; // TTL — auto-cleanup if abandoned
}
```

Background recovery job scans for `ImportOperation` records stuck in `staging` or `activating` for >5 minutes.

### Post-Import Validation Report

After successful import, a validation scan reports:

```json
{
  "status": "imported_with_warnings",
  "provisioning_required": {
    "env_vars": ["OPENAI_API_KEY", "SLACK_BOT_TOKEN"],
    "connectors_needing_credentials": ["salesforce", "zendesk"],
    "mcp_servers_needing_auth": ["internal-tools-server"]
  },
  "warnings": [
    "Guardrail 'input-filter' references provider 'azure-content-safety' which is not configured in this tenant"
  ]
}
```

## Git Sync (Level 2)

### Branch-Per-Environment Strategy

```
main          <- source of truth (all dev work merges here)
staging       <- tracks staging deployment
production    <- tracks production deployment
```

### Operations

| Action                | What Happens                                                                    |
| --------------------- | ------------------------------------------------------------------------------- |
| **Save in Studio**    | Auto-commit to `main` (debounced, batched per save session)                     |
| **Export**            | Git configured: commit + push to `main`. Not configured: ZIP download           |
| **Import**            | Git configured: pull from `main`, run staged import. Not configured: upload ZIP |
| **Deploy to staging** | Merge `main` -> `staging`, push, trigger deployment                             |
| **Promote to prod**   | Merge `staging` -> `production`, push, trigger deployment                       |
| **Rollback**          | `git revert` on the environment branch, re-deploy                               |

### What Git Replaces vs. What We Still Need

| Concern                 | With Git                                                 | Without Git                           |
| ----------------------- | -------------------------------------------------------- | ------------------------------------- |
| File integrity          | Git SHA object model                                     | Lockfile 3-tier SHA                   |
| Version history         | Git commits                                              | Manifest `exported_at` timestamp only |
| Rollback                | `git revert`                                             | Re-import old ZIP                     |
| Diff/merge on import    | Git three-way merge                                      | Our diff calculator                   |
| Offline development     | Clone -> branch -> push -> PR                            | Export -> edit -> re-import           |
| **DB state activation** | **Still needed** — Git manages files, we manage DB state | Staged import with atomic swap        |

### Extending the GitHub Provider

The existing `packages/project-io/src/git/github-provider.ts` supports push/pull for agents and tools only. Extended to:

- Push/pull all v2 layer directories
- Branch management (create, merge, list)
- Per-environment branch tracking
- Sync status reporting (local vs remote diff)
- Conflict detection (not resolution — flag for manual merge)

Git is **optional**. Projects without Git configured use ZIP export/import with the full lockfile SHA scheme. A recommendation banner appears for complex projects (>10 agents, >5 tools, or workflows/evals present).

## CLI Changes

### Export Commands

```bash
# Export with layer selection
kore export --project <id> --layers core,connections,guardrails,workflows
kore export --project <id> --all-layers
kore export --project <id>                     # default layers

# Format options
kore export --project <id> --format yaml --output ./my-project

# Import with validation
kore import --project <id> --path ./my-project
kore import --project <id> --path ./my-project --preview    # dry-run
kore import --project <id> --path ./my-project --force       # skip missing ref warnings
```

### Git Commands

```bash
kore git init --project <id> --repo <url> --branch main
kore git push --project <id> --message "Added escalation workflow"
kore git pull --project <id>
kore git status --project <id>                 # local vs remote diff
kore git promote --project <id> --from main --to staging
```

### Verification & Health

```bash
kore verify --path ./my-project                # offline SHA verification
kore verify --project <id> --against ./my-project  # compare DB vs export

kore doctor --project <id>                     # check missing env vars,
                                                # unresolved connectors,
                                                # broken refs
```

`kore doctor` scans a live project and reports what's missing or misconfigured — essential after import or environment setup.

## Arch AI Assistant Changes

Arch needs awareness of the export/import system to provide contextual guidance:

| Capability                 | Change                                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Export guidance**        | When user mentions deploying to another environment or backing up, Arch suggests export with appropriate layers            |
| **Import troubleshooting** | When import validation reports missing env vars or connectors, Arch walks user through provisioning                        |
| **Git workflow**           | Arch explains branch strategy, suggests when to commit, helps with promotion                                               |
| **Dependency awareness**   | When Arch proposes adding a tool with external dependencies, it includes connection config + env var setup in the proposal |

**Implementation:** System prompt and context updates — Arch's `propose_modification` tool learns that adding a connector-dependent tool implies a connection config and env var reference. No new Arch tools needed.

## Forward Compatibility

| Import Source                              | Behavior                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| v1 export (no `format_version` or `"1.0"`) | Core-only. Warning: "v1 format — configs, connections, workflows not included" |
| v2 export                                  | Full layer support                                                             |
| v2 export with unknown layer               | Skip unknown layer, warn                                                       |
| Future v3 export                           | Reject: "please upgrade Studio/CLI to import format v3"                        |

## Entities Excluded (By Design)

| Entity                                  | Reason                                                       |
| --------------------------------------- | ------------------------------------------------------------ |
| Tool secrets / LLM credentials (values) | Env var references only — values never leave the environment |
| Sessions / messages                     | Runtime conversation data — separate export concern          |
| Eval runs (results)                     | Historical execution data, not portable                      |
| Workflow executions                     | Runtime execution history                                    |
| Audit logs                              | Compliance data, tenant-scoped                               |
| Billing / subscriptions                 | Tenant-scoped, not project-portable                          |
| Contacts                                | Tenant-scoped PII                                            |
| End-user OAuth tokens                   | Session-scoped, environment-bound                            |

## Files to Create/Modify

### New Files

| File                                                        | Purpose                                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `packages/project-io/src/export/layer-assemblers/`          | One assembler per layer (core, connections, guardrails, workflows, evals, search, channels, vocabulary) |
| `packages/project-io/src/export/async-export-job.ts`        | BullMQ job handler for large exports                                                                    |
| `packages/project-io/src/import/staged-importer.ts`         | Phase 2-4 staged activation logic                                                                       |
| `packages/project-io/src/import/import-operation.ts`        | ImportOperation model and recovery                                                                      |
| `packages/project-io/src/import/post-import-validator.ts`   | Post-import health check                                                                                |
| `packages/database/src/models/import-operation.model.ts`    | ImportOperation MongoDB model                                                                           |
| `apps/studio/src/app/api/projects/[id]/export/job/route.ts` | Async export job status polling                                                                         |
| `packages/kore-platform-cli/src/commands/git.ts`            | Git subcommands                                                                                         |
| `packages/kore-platform-cli/src/commands/verify.ts`         | Verification command                                                                                    |
| `packages/kore-platform-cli/src/commands/doctor.ts`         | Project health check command                                                                            |

### Modified Files

| File                                                          | Change                                                                      |
| ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `packages/project-io/src/types.ts`                            | v2 types: LayerName, ExportOptionsV2, ExportResultV2, ImportOperationStatus |
| `packages/project-io/src/export/project-exporter.ts`          | Orchestrate layer assemblers, two-tier routing                              |
| `packages/project-io/src/export/folder-builder.ts`            | v2 folder structure with all layer directories                              |
| `packages/project-io/src/export/manifest-generator.ts`        | v2 manifest with layers*included, metadata.required*\*                      |
| `packages/project-io/src/export/lockfile-generator.ts`        | Per-file + per-layer + root hashes                                          |
| `packages/project-io/src/import/project-importer.ts`          | Layer-aware import, staged activation                                       |
| `packages/project-io/src/import/folder-reader.ts`             | Recognize v2 directories, categorize by layer                               |
| `packages/project-io/src/git/github-provider.ts`              | Push/pull all layers, branch management                                     |
| `apps/studio/src/app/api/projects/[id]/export/route.ts`       | Layer selection, async threshold, v2 queries                                |
| `apps/studio/src/app/api/projects/[id]/import/apply/route.ts` | Staged import, ImportOperation tracking                                     |
| `apps/studio/src/components/projects/ExportDialog.tsx`        | Layer checklist, Git toggle, async progress                                 |
| `apps/studio/src/components/projects/ImportDialog.tsx`        | Per-layer diff, SHA badge, validation report                                |
| `packages/kore-platform-cli/src/commands/export.ts`           | Layer flags, async job handling                                             |
| `packages/kore-platform-cli/src/commands/import.ts`           | Preview, force, validation report                                           |
