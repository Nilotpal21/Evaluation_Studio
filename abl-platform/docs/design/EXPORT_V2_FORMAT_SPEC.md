# Export v2 Format Specification

## Overview

The ABL export system produces a self-contained snapshot of a project as a directory of files. v2 introduces **layered exports** — each layer captures a distinct concern (agents, connections, guardrails, etc.) and can be independently included or excluded.

Source: `packages/project-io/src/export/`

## Directory Structure

```
<project-slug>/
  project.json                          # Manifest (v2)
  abl.lock                              # Lockfile (v2, 3-tier SHA)
  agents/
    supervisor.agent.abl                # Agent DSL files
    booking_manager.agent.abl
  tools/
    hotels_api.tools.abl                # Tool DSL files
  behavior_profiles/
    formal_tone.behavior_profile.abl    # Behavior profiles
  config/
    project-settings.json               # Project settings
    runtime-config.json                 # Runtime config
    llm-config.json                     # LLM config (API keys stripped)
    agent-model-configs/
      booking_manager.model-config.json # Per-agent model overrides
  environment/
    env-vars.json                       # Env var references (no values)
    config-vars.json                    # Config var references
  connections/
    connectors/
      salesforce.connection.json        # Connector connections (secrets stripped)
    configs/
      salesforce.connector-config.json  # Connector configs
    mcp-servers/
      weather_api.mcp-config.json       # MCP server configs (auth stripped)
  guardrails/
    pii_filter.guardrail.json           # Guardrail policies
  workflows/
    escalation.workflow.json            # Workflow definitions
  evals/
    regression_suite/
      eval-set.json                     # Eval set definition
      scenarios/
        happy_path.scenario.json
      personas/
        impatient_user.persona.json
    evaluators/
      goal_completion.evaluator.json    # Shared evaluators
  search/
    indexes/
      knowledge.index.json             # Search index config
    sources/
      docs.source.json                 # Search source config (credentials stripped)
    knowledge-bases/
      product_kb.kb.json               # Knowledge base config
    crawl-patterns.json                # Crawl patterns (tenant-scoped)
  channels/
    slack_bot.channel.json             # Channel connections (creds stripped)
    webhooks/
      order_updates.webhook.json       # Webhook subscriptions
    widgets/
      widget-config.json               # Widget config
  vocabulary/
    domain-vocabulary.json             # Domain vocabularies (tenant-scoped)
    lookup-tables/
      airports.lookup.json             # Lookup table entries
    schemas/
      product.schema.json              # Canonical schemas (tenant-scoped)
    facts.json                         # Project-scoped facts
  deployments/                         # Optional
    dev.deployment.json
    staging.deployment.json
  locales/                             # Optional
    en/
      booking_agent.json
```

## Layers

### Layer Names and Activation

| Layer         | Default  | Wave | Description                                                                          |
| ------------- | -------- | ---- | ------------------------------------------------------------------------------------ |
| `core`        | `always` | 1    | Agents, tools, profiles, settings, runtime config, LLM config, env vars, MCP servers |
| `connections` | `always` | 1    | Connector connections and configs                                                    |
| `guardrails`  | `on`     | 2    | Guardrail policies (project + agent scope)                                           |
| `workflows`   | `on`     | 2    | Workflow definitions                                                                 |
| `evals`       | `off`    | 2    | Eval sets, scenarios, personas, evaluators                                           |
| `search`      | `off`    | 2    | Search indexes, sources, knowledge bases, crawl patterns                             |
| `channels`    | `off`    | 2    | Channel connections, webhook subscriptions, widget config                            |
| `vocabulary`  | `off`    | 2    | Domain vocabularies, lookup tables, canonical schemas, facts                         |

- **Wave 1** layers (`core`, `connections`) always run first.
- **Wave 2** layers run in parallel after Wave 1 completes.
- `core` is always included regardless of the `layers` parameter.

### Layer Size Limits

Each layer has a maximum entity count guard to prevent OOM:

| Layer       | Entity      | Max    |
| ----------- | ----------- | ------ |
| core        | agents      | 1,000  |
| connections | connections | 200    |
| guardrails  | policies    | 100    |
| workflows   | workflows   | 200    |
| evals       | scenarios   | 500    |
| search      | indexes     | 100    |
| channels    | channels    | 50     |
| vocabulary  | entries     | 10,000 |

Exceeding any limit returns `SIZE_LIMIT_EXCEEDED`.

### Layer Assembler Interface

Each layer implements `LayerAssembler`:

```typescript
interface LayerAssembler {
  readonly layer: LayerName;
  assemble(ctx: { projectId: string; tenantId: string }): Promise<LayerAssemblyResult>;
  countEntities(ctx: { projectId: string; tenantId: string }): Promise<number>;
}
```

Assemblers are independent and query their own data. Source: `packages/project-io/src/export/layer-assemblers/`.

## Manifest Schema (project.json)

### v2 Manifest

```json
{
  "format_version": "2.0",
  "name": "Travel Bot",
  "slug": "travel-bot",
  "description": "Multi-agent travel assistant",
  "abl_version": "1.0",
  "exported_at": "2026-03-08T12:00:00.000Z",
  "exported_by": "user_abc123",
  "entry_agent": "supervisor",
  "dsl_format": "legacy",
  "layers_included": ["core", "connections", "guardrails", "workflows"],
  "agents": {
    "supervisor": {
      "path": "agents/supervisor.agent.abl",
      "owner": "user_abc123",
      "ownerTeam": null,
      "description": "Main routing agent",
      "version": null
    }
  },
  "tools": {
    "hotels-api": {
      "path": "tools/hotels_api.tools.abl",
      "owner": null
    }
  },
  "behavior_profiles": {
    "formal_tone": {
      "name": "formal_tone",
      "path": "behavior_profiles/formal_tone.behavior_profile.abl",
      "priority": 10,
      "when_summary": "customer is VIP",
      "used_by": ["supervisor"]
    }
  },
  "metadata": {
    "entity_counts": { "agents": 3, "tools": 2 },
    "required_env_vars": ["HOTEL_API_KEY", "BOOKING_SECRET"],
    "required_connectors": ["salesforce"],
    "required_mcp_servers": ["weather_api"]
  }
}
```

### v1 Manifest (legacy)

v1 manifests lack `format_version`, `layers_included`, and `metadata`. They include a `dependencies` block:

```json
{
  "name": "Travel Bot",
  "slug": "travel-bot",
  "version": "1.0.0",
  "abl_version": "1.0",
  "dependencies": {
    "agent_references": [{ "from": "supervisor", "to": "booking", "type": "handoff" }],
    "tool_imports": [{ "agent": "booking", "source": "hotels-api", "tools": ["search"] }]
  }
}
```

## Lockfile Schema (abl.lock)

### v2 Lockfile (3-tier SHA)

Three-tier integrity verification:

1. **Tier 1 (per-file)**: Truncated SHA-256 (first 16 hex chars) of each file's content
2. **Tier 2 (per-layer)**: Full SHA-256 over sorted `"path:hash"` pairs for all files in that layer
3. **Tier 3 (root)**: Full SHA-256 over the entire lockfile payload (all tiers 1+2 combined)

```json
{
  "lockfile_version": "2.0",
  "generated_at": "2026-03-08T12:00:00.000Z",
  "agents": {
    "supervisor": { "version": "1.0", "source_hash": "a1b2c3d4e5f6a7b8", "status": "active" }
  },
  "tools": {
    "tools/hotels_api.tools.abl": { "source_hash": "1122334455667788" }
  },
  "configs": {},
  "connections": {
    "connections/connectors/salesforce.connection.json": { "source_hash": "aabbccdd11223344" }
  },
  "guardrails": {},
  "workflows": {},
  "evals": {},
  "search": {},
  "channels": {},
  "vocabulary": {},
  "layer_hashes": {
    "core": "sha256-full-hash-of-all-core-files...",
    "connections": "sha256-full-hash-of-all-connection-files..."
  },
  "integrity": "sha256-root-hash-over-entire-lockfile..."
}
```

### v1 Lockfile

Simpler structure with only agents and tools:

```json
{
  "lockfile_version": "1.0",
  "generated_at": "2026-03-08T12:00:00.000Z",
  "agents": {
    "supervisor": { "version": "1.0", "source_hash": "a1b2c3d4e5f6a7b8", "status": "active" }
  },
  "tools": {
    "hotels-api": { "source_hash": "1122334455667788" }
  },
  "integrity": "sha256-over-sorted-agents-and-tools..."
}
```

### Integrity Verification

```typescript
// v2: recompute root hash from all sections
const payload = JSON.stringify({
  agents: sortRecord(lockfile.agents),
  tools: sortRecord(lockfile.tools),
  configs: sortRecord(lockfile.configs),
  // ... all 10 sections + layer_hashes
});
const valid = sha256(payload) === lockfile.integrity;
```

### Repairing a Local v2 Lockfile

Do not hand-edit `source_hash`, `layer_hashes`, or `integrity` when changing an exported project folder. Recompute them from the files on disk:

```bash
kore-platform-cli lockfile recompute ./exports/my-project
kore-platform-cli lockfile recompute ./exports/my-project --check
```

The recompute command repairs stale or `null` v2 hash fields by recalculating per-file hashes, layer hashes, and root integrity using the same v2 algorithm as export/import verification. Use `--check` in CI or before import to fail when `abl.lock` is stale without rewriting it.

## v1 vs v2 Differences

| Feature             | v1                           | v2                                                                                  |
| ------------------- | ---------------------------- | ----------------------------------------------------------------------------------- |
| Format version      | None / `"1.0"`               | `"2.0"`                                                                             |
| Layers              | Core only (agents + tools)   | 8 layers, selectable                                                                |
| Manifest `metadata` | None                         | `entity_counts`, `required_env_vars`, `required_connectors`, `required_mcp_servers` |
| Lockfile sections   | `agents`, `tools`            | 10 sections + `layer_hashes`                                                        |
| Lockfile integrity  | Single SHA over agents+tools | 3-tier (file, layer, root)                                                          |
| Connections         | Not exported                 | Connectors + MCP servers (secrets stripped)                                         |
| Guardrails          | Not exported                 | Policies with webhook secrets stripped                                              |
| Evals               | Not exported                 | Sets, scenarios, personas, evaluators                                               |
| Search              | Not exported                 | Indexes, sources, knowledge bases, crawl patterns                                   |
| Channels            | Not exported                 | Connections, webhooks, widget config                                                |
| Vocabulary          | Not exported                 | Vocabularies, lookups, schemas, facts                                               |

## Security: Stripped Fields

Every assembler strips sensitive data before export:

- **Core**: `apiKey`, `encryptedApiKey` from LLM config; env var values omitted (references only)
- **Connections**: `encryptedCredentials`, `encryptionKeyVersion`, `oauth2RefreshToken`, `oauthTokenId`
- **Guardrails**: `webhookSecret`
- **Search**: `sourceConfig` (may contain credentials)
- **Channels**: `encryptedCredentials`, `verifyTokenHash`, `encryptedSecret`
- **All layers**: `_id`, `__v`, `projectId`, `tenantId`, `createdAt`, `updatedAt`

## Env Var Scanning

The exporter scans all agent and tool DSL for `{{env.KEY}}` and `{{secrets.KEY}}` references and includes them in the manifest's `required_env_vars`. This enables the import doctor to check provisioning completeness.

Source: `packages/project-io/src/export/env-var-scanner.ts`
