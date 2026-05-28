# Export v2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend project export/import to cover all project-scoped data (configs, connections, workflows, guardrails, evals, search, channels, vocabulary) with layered architecture, 3-tier SHA verification, staged import with rollback, two-tier async performance, and Git sync.

**Architecture:** Layered export where each layer (core, connections, guardrails, workflows, evals, search, channels, vocabulary) has an independent assembler, size guard, and SHA hash. DSL-authoritative dependency graph. Staged import with atomic per-layer activation in dependency order. BullMQ async path for large exports. Git sync extends existing GitHub provider to all layers with branch-per-environment.

**Tech Stack:** Mongoose (models), BullMQ (async jobs), Zod (validation), JSZip (ZIP), crypto (SHA-256), ioredis (rate limiting), Vitest (tests). No new dependencies needed — all exist in platform-toolkit.

**Design doc:** `docs/plans/2026-03-07-export-v2-comprehensive-design.md`

---

## Cross-Cutting Rules (Apply to EVERY task)

These are non-negotiable for every file created or modified:

- **Tenant isolation**: Every DB query includes `{ projectId, tenantId }`. Never `findById()`.
- **Logging**: `createLogger('module-name')` from `@abl/compiler/platform`. Never `console.log`.
- **Error handling**: `err instanceof Error ? err.message : String(err)`. Never `(err as Error).message`. Never empty `.catch(() => {})`.
- **Error envelope**: Return `{ success, data?, error?: { code, message } }` on failure.
- **Types**: No `any`. Use discriminated unions. Zod at system boundaries.
- **Async**: `fs.promises` only. No sync I/O in async paths.
- **Constants**: No magic numbers. Named constants for limits, timeouts, TTLs.
- **Security**: No secrets in source. Encrypt sensitive fields at rest. SSRF protection on URLs.
- **Tests**: Every new module gets tests. Test error paths, not just happy paths.
- **Prettier**: Run `npx prettier --write <files>` before every commit.
- **Commits**: `[ABLP-2] type(scope): description` format. Valid scopes: `shared`, `core`, `studio`, `runtime`, `cli`.

---

## Phase 1: Types & Layer Assembler Foundation

**Exit criteria:** All v2 types defined. Layer assembler interface established. Core assembler working with tests. Lockfile v2 generating per-file + per-layer + root hashes.

### Task 1: Define v2 Types

**Files:**

- Modify: `packages/project-io/src/types.ts`

**Step 1: Write the type definitions**

Add these types to the existing `types.ts`:

```typescript
// Layer names
export type LayerName =
  | 'core'
  | 'connections'
  | 'guardrails'
  | 'workflows'
  | 'evals'
  | 'search'
  | 'channels'
  | 'vocabulary';

// Layer defaults
export const LAYER_DEFAULTS: Record<LayerName, 'always' | 'on' | 'off'> = {
  core: 'always',
  connections: 'always',
  guardrails: 'on',
  workflows: 'on',
  evals: 'off',
  search: 'off',
  channels: 'off',
  vocabulary: 'off',
};

// Size guards per layer
export const LAYER_SIZE_LIMITS: Record<LayerName, { entity: string; max: number }> = {
  core: { entity: 'agents', max: 1000 },
  connections: { entity: 'connections', max: 200 },
  guardrails: { entity: 'policies', max: 100 },
  workflows: { entity: 'workflows', max: 200 },
  evals: { entity: 'scenarios', max: 500 },
  search: { entity: 'indexes', max: 100 },
  channels: { entity: 'channels', max: 50 },
  vocabulary: { entity: 'entries', max: 10000 },
};

// Export options v2
export interface ExportOptionsV2 {
  projectId: string;
  userId: string;
  tenantId: string;
  format: 'folder' | 'zip' | 'tar.gz';
  layers: LayerName[];
  dslFormat?: 'yaml' | 'legacy';
  includeDeployments?: boolean;
  environments?: string[];
  compileFn?: (dsl: string) => Record<string, unknown> | null;
}

// Layer assembler output
export interface LayerAssemblyResult {
  layer: LayerName;
  files: Map<string, string>;
  entityCount: number;
  warnings: string[];
}

// Manifest v2
export interface ProjectManifestV2 {
  format_version: '2.0';
  name: string;
  slug: string;
  description: string | null;
  abl_version: string;
  exported_at: string;
  exported_by: string;
  entry_agent: string | null;
  dsl_format: 'yaml' | 'legacy';
  layers_included: LayerName[];
  agents: Record<string, ManifestAgent>;
  tools: Record<string, ManifestTool>;
  behavior_profiles?: Record<string, ManifestProfile>;
  metadata: {
    entity_counts: Record<string, number>;
    required_env_vars: string[];
    required_connectors: string[];
    required_mcp_servers: string[];
  };
}

// Lockfile v2
export interface LockFileV2 {
  lockfile_version: '2.0';
  generated_at: string;
  agents: Record<string, { version: string; source_hash: string; status: string }>;
  tools: Record<string, { source_hash: string }>;
  configs: Record<string, { source_hash: string }>;
  connections: Record<string, { source_hash: string }>;
  guardrails: Record<string, { source_hash: string }>;
  workflows: Record<string, { source_hash: string }>;
  evals: Record<string, { source_hash: string }>;
  search: Record<string, { source_hash: string }>;
  channels: Record<string, { source_hash: string }>;
  vocabulary: Record<string, { source_hash: string }>;
  layer_hashes: Partial<Record<LayerName, string>>;
  integrity: string;
}

// Export result v2
export interface ExportResultV2 {
  success: boolean;
  manifest: ProjectManifestV2;
  files: Map<string, string>;
  lockfile: LockFileV2;
  warnings: string[];
  error?: { code: string; message: string };
}

// Import operation status (for staged import)
export type ImportPhase =
  | 'validating'
  | 'staging'
  | 'activating'
  | 'completed'
  | 'failed'
  | 'rolling_back';
export type LayerImportStatus = 'pending' | 'staged' | 'activated' | 'rolled_back';

export interface ImportOperationState {
  projectId: string;
  tenantId: string;
  status: ImportPhase;
  layers: Record<string, { status: LayerImportStatus }>;
  stagedRecordIds: Record<string, string[]>;
  supersededRecordIds: Record<string, string[]>;
  error?: { phase: string; layer: string; message: string };
  createdAt: Date;
  expiresAt: Date;
}
```

**Step 2: Run type check**

Run: `npx tsc --noEmit --project packages/project-io/tsconfig.json`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/project-io/src/types.ts
git commit -m "[ABLP-2] feat(shared): add Export v2 type definitions"
```

---

### Task 2: Layer Assembler Interface & Core Assembler

**Files:**

- Create: `packages/project-io/src/export/layer-assemblers/types.ts`
- Create: `packages/project-io/src/export/layer-assemblers/core-assembler.ts`
- Create: `packages/project-io/src/export/layer-assemblers/index.ts`
- Test: `packages/project-io/src/__tests__/core-assembler.test.ts`

**Step 1: Write the assembler interface**

```typescript
// layer-assemblers/types.ts
import type { LayerName, LayerAssemblyResult } from '../../types.js';

export interface LayerQueryContext {
  projectId: string;
  tenantId: string;
}

/**
 * Each layer assembler queries its own data and builds file entries.
 * Assemblers are independent — they don't depend on each other's output.
 */
export interface LayerAssembler {
  readonly layer: LayerName;
  assemble(ctx: LayerQueryContext): Promise<LayerAssemblyResult>;
  countEntities(ctx: LayerQueryContext): Promise<number>;
}
```

**Step 2: Write the failing test for core assembler**

```typescript
// __tests__/core-assembler.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CoreAssembler } from '../export/layer-assemblers/core-assembler.js';

// Mock the database models
vi.mock('@agent-platform/database', () => ({
  ProjectAgent: { find: vi.fn(), countDocuments: vi.fn() },
  ProjectTool: { find: vi.fn(), countDocuments: vi.fn() },
  ProjectSettings: { findOne: vi.fn() },
  ProjectRuntimeConfig: { findOne: vi.fn() },
  ProjectLLMConfig: { findOne: vi.fn() },
  AgentModelConfig: { find: vi.fn() },
  EnvironmentVariable: { find: vi.fn() },
  ProjectConfigVariable: { find: vi.fn() },
  MCPServerConfig: { find: vi.fn() },
}));

import {
  ProjectAgent,
  ProjectTool,
  ProjectSettings,
  ProjectRuntimeConfig,
  ProjectLLMConfig,
  AgentModelConfig,
  EnvironmentVariable,
  ProjectConfigVariable,
  MCPServerConfig,
} from '@agent-platform/database';

const CTX = { projectId: 'proj-1', tenantId: 'tenant-1' };

function mockLean(data: unknown[]) {
  return { lean: () => ({ select: () => Promise.resolve(data) }) };
}

describe('CoreAssembler', () => {
  let assembler: CoreAssembler;

  beforeEach(() => {
    vi.clearAllMocks();
    assembler = new CoreAssembler();
  });

  it('should have layer name "core"', () => {
    expect(assembler.layer).toBe('core');
  });

  it('should assemble agents into agents/ directory', async () => {
    (ProjectAgent.find as any).mockReturnValue(
      mockLean([
        {
          name: 'Supervisor',
          dslContent: 'SUPERVISOR: Main',
          description: 'Routes',
          ownerId: 'u1',
          ownerTeamId: null,
          version: '1.0',
          status: 'active',
        },
      ]),
    );
    (ProjectTool.find as any).mockReturnValue(mockLean([]));
    (ProjectSettings.findOne as any).mockResolvedValue(null);
    (ProjectRuntimeConfig.findOne as any).mockResolvedValue(null);
    (ProjectLLMConfig.findOne as any).mockResolvedValue(null);
    (AgentModelConfig.find as any).mockReturnValue(mockLean([]));
    (EnvironmentVariable.find as any).mockReturnValue(mockLean([]));
    (ProjectConfigVariable.find as any).mockReturnValue(mockLean([]));
    (MCPServerConfig.find as any).mockReturnValue(mockLean([]));

    const result = await assembler.assemble(CTX);

    expect(result.layer).toBe('core');
    expect(result.files.has('agents/supervisor.agent.abl')).toBe(true);
    expect(result.files.get('agents/supervisor.agent.abl')).toBe('SUPERVISOR: Main');
    expect(result.entityCount).toBeGreaterThan(0);
  });

  it('should export project settings as config/project-settings.json', async () => {
    (ProjectAgent.find as any).mockReturnValue(
      mockLean([
        {
          name: 'Agent1',
          dslContent: 'AGENT: A1',
          description: null,
          ownerId: 'u1',
          ownerTeamId: null,
          version: '1.0',
          status: 'active',
        },
      ]),
    );
    (ProjectTool.find as any).mockReturnValue(mockLean([]));
    (ProjectSettings.findOne as any).mockResolvedValue({
      enableThinking: true,
      thinkingBudget: 5000,
      compactionThreshold: 50,
    });
    (ProjectRuntimeConfig.findOne as any).mockResolvedValue(null);
    (ProjectLLMConfig.findOne as any).mockResolvedValue(null);
    (AgentModelConfig.find as any).mockReturnValue(mockLean([]));
    (EnvironmentVariable.find as any).mockReturnValue(mockLean([]));
    (ProjectConfigVariable.find as any).mockReturnValue(mockLean([]));
    (MCPServerConfig.find as any).mockReturnValue(mockLean([]));

    const result = await assembler.assemble(CTX);
    expect(result.files.has('config/project-settings.json')).toBe(true);

    const settings = JSON.parse(result.files.get('config/project-settings.json')!);
    expect(settings.enableThinking).toBe(true);
  });

  it('should export env vars as references only (no values)', async () => {
    (ProjectAgent.find as any).mockReturnValue(
      mockLean([
        {
          name: 'A1',
          dslContent: 'AGENT: A1',
          description: null,
          ownerId: 'u1',
          ownerTeamId: null,
          version: '1.0',
          status: 'active',
        },
      ]),
    );
    (ProjectTool.find as any).mockReturnValue(mockLean([]));
    (ProjectSettings.findOne as any).mockResolvedValue(null);
    (ProjectRuntimeConfig.findOne as any).mockResolvedValue(null);
    (ProjectLLMConfig.findOne as any).mockResolvedValue(null);
    (AgentModelConfig.find as any).mockReturnValue(mockLean([]));
    (EnvironmentVariable.find as any).mockReturnValue(
      mockLean([
        {
          key: 'OPENAI_API_KEY',
          description: 'OpenAI key',
          isSecret: true,
          environment: 'production',
        },
        { key: 'DB_URL', description: 'Database URL', isSecret: false, environment: 'production' },
      ]),
    );
    (ProjectConfigVariable.find as any).mockReturnValue(mockLean([]));
    (MCPServerConfig.find as any).mockReturnValue(mockLean([]));

    const result = await assembler.assemble(CTX);
    expect(result.files.has('environment/env-vars.json')).toBe(true);

    const envVars = JSON.parse(result.files.get('environment/env-vars.json')!);
    // Must NOT contain actual values
    expect(envVars[0].key).toBe('OPENAI_API_KEY');
    expect(envVars[0]).not.toHaveProperty('encryptedValue');
    expect(envVars[0]).not.toHaveProperty('value');
  });

  it('should strip API keys from LLM config', async () => {
    (ProjectAgent.find as any).mockReturnValue(
      mockLean([
        {
          name: 'A1',
          dslContent: 'AGENT: A1',
          description: null,
          ownerId: 'u1',
          ownerTeamId: null,
          version: '1.0',
          status: 'active',
        },
      ]),
    );
    (ProjectTool.find as any).mockReturnValue(mockLean([]));
    (ProjectSettings.findOne as any).mockResolvedValue(null);
    (ProjectRuntimeConfig.findOne as any).mockResolvedValue(null);
    (ProjectLLMConfig.findOne as any).mockResolvedValue({
      modelProvider: 'openai',
      defaultModel: 'gpt-4o',
      temperature: 0.7,
      apiKey: 'sk-secret-key',
    });
    (AgentModelConfig.find as any).mockReturnValue(mockLean([]));
    (EnvironmentVariable.find as any).mockReturnValue(mockLean([]));
    (ProjectConfigVariable.find as any).mockReturnValue(mockLean([]));
    (MCPServerConfig.find as any).mockReturnValue(mockLean([]));

    const result = await assembler.assemble(CTX);
    expect(result.files.has('config/llm-config.json')).toBe(true);

    const llmConfig = JSON.parse(result.files.get('config/llm-config.json')!);
    expect(llmConfig.modelProvider).toBe('openai');
    expect(llmConfig).not.toHaveProperty('apiKey');
    expect(llmConfig).not.toHaveProperty('encryptedApiKey');
  });

  it('should count entities correctly', async () => {
    (ProjectAgent.countDocuments as any).mockResolvedValue(5);
    (ProjectTool.countDocuments as any).mockResolvedValue(3);

    const count = await assembler.countEntities(CTX);
    expect(count).toBe(8);
  });
});
```

**Step 3: Run test to verify it fails**

Run: `cd packages/project-io && npx vitest run src/__tests__/core-assembler.test.ts`
Expected: FAIL — module not found

**Step 4: Implement CoreAssembler**

```typescript
// layer-assemblers/core-assembler.ts
import type { LayerAssembler, LayerQueryContext } from './types.js';
import type { LayerAssemblyResult } from '../../types.js';
import { createLogger } from '@abl/compiler/platform';
import {
  ProjectAgent,
  ProjectTool,
  ProjectSettings,
  ProjectRuntimeConfig,
  ProjectLLMConfig,
  AgentModelConfig,
  EnvironmentVariable,
  ProjectConfigVariable,
  MCPServerConfig,
} from '@agent-platform/database';

const log = createLogger('core-assembler');
const AGENT_SELECT = 'name description dslContent ownerId ownerTeamId version status';
const TOOL_SELECT = 'name slug dslContent';

function sanitizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

function stripSecrets<T extends Record<string, unknown>>(obj: T, keys: string[]): Partial<T> {
  const result = { ...obj };
  for (const key of keys) {
    delete result[key];
  }
  return result;
}

export class CoreAssembler implements LayerAssembler {
  readonly layer = 'core' as const;

  async assemble(ctx: LayerQueryContext): Promise<LayerAssemblyResult> {
    const { projectId, tenantId } = ctx;
    const files = new Map<string, string>();
    const warnings: string[] = [];
    let entityCount = 0;

    // Wave 1: All core queries in parallel
    const [
      agents,
      tools,
      settings,
      runtimeConfig,
      llmConfig,
      modelConfigs,
      envVars,
      configVars,
      mcpServers,
    ] = await Promise.all([
      ProjectAgent.find({ projectId, tenantId }).lean().select(AGENT_SELECT),
      ProjectTool.find({ projectId, tenantId }).lean().select(TOOL_SELECT),
      ProjectSettings.findOne({ projectId, tenantId }),
      ProjectRuntimeConfig.findOne({ projectId, tenantId }),
      ProjectLLMConfig.findOne({ projectId, tenantId }),
      AgentModelConfig.find({ projectId, tenantId }).lean(),
      EnvironmentVariable.find({ projectId, tenantId })
        .lean()
        .select('key description isSecret environment'),
      ProjectConfigVariable.find({ projectId, tenantId }).lean().select('name description'),
      MCPServerConfig.find({ projectId, tenantId })
        .lean()
        .select('serverName endpoint capabilities status'),
    ]);

    // Agents
    for (const agent of agents) {
      const path = `agents/${sanitizeName(agent.name)}.agent.abl`;
      files.set(path, agent.dslContent);
      entityCount++;
    }

    // Tools
    for (const tool of tools) {
      const path = `tools/${sanitizeName(tool.name)}.tools.abl`;
      files.set(path, tool.dslContent);
      entityCount++;
    }

    // Project settings
    if (settings) {
      const clean = stripSecrets(settings.toObject ? settings.toObject() : settings, [
        '_id',
        '__v',
        'projectId',
        'tenantId',
        'createdAt',
        'updatedAt',
      ]);
      files.set('config/project-settings.json', JSON.stringify(clean, null, 2));
    }

    // Runtime config
    if (runtimeConfig) {
      const clean = stripSecrets(
        runtimeConfig.toObject ? runtimeConfig.toObject() : runtimeConfig,
        ['_id', '__v', 'projectId', 'tenantId', 'createdAt', 'updatedAt'],
      );
      files.set('config/runtime-config.json', JSON.stringify(clean, null, 2));
    }

    // LLM config (strip API keys)
    if (llmConfig) {
      const clean = stripSecrets(llmConfig.toObject ? llmConfig.toObject() : llmConfig, [
        '_id',
        '__v',
        'projectId',
        'tenantId',
        'apiKey',
        'encryptedApiKey',
        'createdAt',
        'updatedAt',
      ]);
      files.set('config/llm-config.json', JSON.stringify(clean, null, 2));
    }

    // Agent model configs
    for (const config of modelConfigs) {
      const clean = stripSecrets(config, [
        '_id',
        '__v',
        'projectId',
        'tenantId',
        'createdAt',
        'updatedAt',
      ]);
      const path = `config/agent-model-configs/${sanitizeName(config.agentName)}.model-config.json`;
      files.set(path, JSON.stringify(clean, null, 2));
    }

    // Environment variables (references only — no values)
    if (envVars.length > 0) {
      const refs = envVars.map((v) => ({
        key: v.key,
        description: v.description ?? null,
        isSecret: v.isSecret ?? false,
        environment: v.environment ?? null,
      }));
      files.set('environment/env-vars.json', JSON.stringify(refs, null, 2));
    }

    // Config variables (references only)
    if (configVars.length > 0) {
      const refs = configVars.map((v) => ({
        name: v.name,
        description: v.description ?? null,
      }));
      files.set('environment/config-vars.json', JSON.stringify(refs, null, 2));
    }

    // MCP server configs (strip auth)
    for (const server of mcpServers) {
      const path = `connections/mcp-servers/${sanitizeName(server.serverName)}.mcp-config.json`;
      files.set(
        path,
        JSON.stringify(
          {
            serverName: server.serverName,
            endpoint: server.endpoint,
            capabilities: server.capabilities,
            status: server.status,
          },
          null,
          2,
        ),
      );
    }

    log.info('Core layer assembled', { projectId, agents: agents.length, tools: tools.length });
    return { layer: 'core', files, entityCount, warnings };
  }

  async countEntities(ctx: LayerQueryContext): Promise<number> {
    const [agentCount, toolCount] = await Promise.all([
      ProjectAgent.countDocuments({ projectId: ctx.projectId, tenantId: ctx.tenantId }),
      ProjectTool.countDocuments({ projectId: ctx.projectId, tenantId: ctx.tenantId }),
    ]);
    return agentCount + toolCount;
  }
}
```

**Step 5: Create index barrel**

```typescript
// layer-assemblers/index.ts
export { CoreAssembler } from './core-assembler.js';
export type { LayerAssembler, LayerQueryContext } from './types.js';
```

**Step 6: Run tests to verify they pass**

Run: `cd packages/project-io && npx vitest run src/__tests__/core-assembler.test.ts`
Expected: All tests PASS

**Step 7: Commit**

```bash
git add packages/project-io/src/export/layer-assemblers/ packages/project-io/src/__tests__/core-assembler.test.ts
git commit -m "[ABLP-2] feat(shared): add layer assembler interface and core assembler"
```

---

### Task 3: Connections Layer Assembler

**Files:**

- Create: `packages/project-io/src/export/layer-assemblers/connections-assembler.ts`
- Test: `packages/project-io/src/__tests__/connections-assembler.test.ts`

Follow same pattern as core assembler. Queries `ConnectorConnection` and `ConnectorConfig`. Strips `encryptedCredentials`, `oauth2RefreshToken`. Outputs to `connections/connectors/{name}.connection.json`. Test that credentials are never in output.

---

### Task 4: Guardrails Layer Assembler

**Files:**

- Create: `packages/project-io/src/export/layer-assemblers/guardrails-assembler.ts`
- Test: `packages/project-io/src/__tests__/guardrails-assembler.test.ts`

Queries `GuardrailPolicy` scoped to `{ tenantId, $or: [{ scope: 'project', projectId }, { scope: 'agent', projectId }] }`. Outputs to `guardrails/{name}.guardrail.json`.

---

### Task 5: Workflows Layer Assembler

**Files:**

- Create: `packages/project-io/src/export/layer-assemblers/workflows-assembler.ts`
- Test: `packages/project-io/src/__tests__/workflows-assembler.test.ts`

Queries `Workflow` by `{ projectId, tenantId }`. Exports definition only (triggers, steps, escalation rules, SLA targets). Excludes execution history. Outputs to `workflows/{name}.workflow.json`.

---

### Task 6: Evals Layer Assembler

**Files:**

- Create: `packages/project-io/src/export/layer-assemblers/evals-assembler.ts`
- Test: `packages/project-io/src/__tests__/evals-assembler.test.ts`

Queries `EvalSet`, `EvalScenario`, `EvalPersona`, `EvalEvaluator`. Nested output: `evals/{set-name}/eval-set.json`, `evals/{set-name}/scenarios/{name}.scenario.json`, `evals/evaluators/{name}.evaluator.json`.

---

### Task 7: Search Layer Assembler

**Files:**

- Create: `packages/project-io/src/export/layer-assemblers/search-assembler.ts`
- Test: `packages/project-io/src/__tests__/search-assembler.test.ts`

Queries `SearchIndex`, `SearchSource`, `KnowledgeBase`, `CrawlPattern`. Config only — no documents, embeddings, or chunks. Outputs to `search/indexes/`, `search/sources/`, `search/knowledge-bases/`.

---

### Task 8: Channels Layer Assembler

**Files:**

- Create: `packages/project-io/src/export/layer-assemblers/channels-assembler.ts`
- Test: `packages/project-io/src/__tests__/channels-assembler.test.ts`

Queries `ChannelConnection`, `WebhookSubscription`, `WidgetConfig`. Strips `encryptedCredentials`, `encryptedSecret`. Outputs to `channels/`, `channels/webhooks/`, `channels/widgets/`.

---

### Task 9: Vocabulary Layer Assembler

**Files:**

- Create: `packages/project-io/src/export/layer-assemblers/vocabulary-assembler.ts`
- Test: `packages/project-io/src/__tests__/vocabulary-assembler.test.ts`

Queries `DomainVocabulary`, `LookupEntry`, `CanonicalSchema`, `Fact`. Outputs to `vocabulary/domain-vocabulary.json`, `vocabulary/lookup-tables/`, `vocabulary/schemas/`, `vocabulary/facts.json`.

---

### Task 10: Update Lockfile Generator for v2

**Files:**

- Modify: `packages/project-io/src/export/lockfile-generator.ts`
- Test: `packages/project-io/src/__tests__/lockfile-v2.test.ts`

**Step 1: Write failing test**

Test that lockfile v2 includes per-file hashes for all layers, per-layer composite hashes, and root integrity hash. Test `verifyLockfileIntegrity()` detects tampering.

**Step 2: Implement**

Extend `generateLockfile()` to accept `Map<LayerName, Map<string, string>>` (layer → files), compute per-file `source_hash`, per-layer `layer_hashes`, and root `integrity`.

**Step 3: Commit**

```bash
git commit -m "[ABLP-2] feat(shared): extend lockfile generator for v2 3-tier SHA"
```

---

### Task 11: Update Manifest Generator for v2

**Files:**

- Modify: `packages/project-io/src/export/manifest-generator.ts`
- Test: `packages/project-io/src/__tests__/manifest-v2.test.ts`

Add `format_version: '2.0'`, `layers_included`, and `metadata` block with `required_env_vars`, `required_connectors`, `required_mcp_servers`. Derive `metadata.required_*` from DSL parsing (scan for connector refs, env var refs in agent/tool DSL).

---

## Phase 2: Export Orchestrator & API

**Exit criteria:** Full layered export working end-to-end through Studio API. Sync path for small exports. Preview endpoint returns layer counts.

### Task 12: Export Orchestrator v2

**Files:**

- Modify: `packages/project-io/src/export/project-exporter.ts`
- Test: `packages/project-io/src/__tests__/project-exporter-v2.test.ts`

Orchestrate layer assemblers:

1. Resolve requested layers (apply defaults from `LAYER_DEFAULTS`)
2. Count entities per layer (parallel `countEntities()`)
3. Check size guards per layer
4. Assemble layers (Wave 1: core + connections, Wave 2: remaining requested layers)
5. Merge file maps
6. Generate manifest v2
7. Generate lockfile v2
8. Return `ExportResultV2`

Test: export with all layers, export with subset, size guard rejection, empty layers produce warnings.

---

### Task 13: Update Studio Export Route

**Files:**

- Modify: `apps/studio/src/app/api/projects/[id]/export/route.ts`

Add `layers` query param (comma-separated). Route to v2 orchestrator. Keep backward compat: if no `layers` param and no `format_version` header, use v1 path.

---

### Task 14: Update Export Preview Route

**Files:**

- Modify: `apps/studio/src/app/api/projects/[id]/export/preview/route.ts`

Return per-layer entity counts, estimated size, and required provisioning (env vars, connectors).

---

## Phase 3: Async Export (BullMQ)

**Exit criteria:** Large exports (>500 entities or 3+ layers) processed via BullMQ job. Client can poll for status. Result stored temporarily for download.

### Task 15: Export Job Definition

**Files:**

- Create: `packages/project-io/src/export/async-export-job.ts`
- Create: `apps/studio/src/app/api/projects/[id]/export/job/route.ts`

**Pattern:** Follow `packages/agent-transfer/src/events/durable-event-queue.ts` pattern.

Job data: `{ projectId, tenantId, userId, layers, format, dslFormat }`.
Job handler: calls `exportProject()`, stores result in GridFS (`@aws-sdk/client-s3` from platform-toolkit) or MongoDB GridFS.
Status route: `GET /api/projects/:id/export/job?jobId=xxx` returns `{ status, progress, downloadUrl? }`.

Concurrency: max 2 per tenant. TTL: 15 minutes for stored result.

---

## Phase 4: Staged Import with Rollback

**Exit criteria:** Import creates staged records, activates per-layer in dependency order, supports rollback on failure. ImportOperation record tracks progress. Post-import validation report.

### Task 16: ImportOperation Model

**Files:**

- Create: `packages/database/src/models/import-operation.model.ts`

**Pattern:** Follow `packages/database/src/models/deployment.model.ts` pattern.

```typescript
// Fields: _id (uuidv7), projectId, tenantId, status (ImportPhase), layers, stagedRecordIds,
// supersededRecordIds, error, createdAt, expiresAt
// Indexes: { projectId: 1, tenantId: 1, status: 1 }
// TTL index on expiresAt for auto-cleanup of abandoned operations
```

---

### Task 17: Folder Reader v2

**Files:**

- Modify: `packages/project-io/src/import/folder-reader.ts`
- Test: `packages/project-io/src/__tests__/folder-reader-v2.test.ts`

Extend `readFolder()` to recognize v2 directories (`config/`, `connections/`, `guardrails/`, `workflows/`, `evals/`, `search/`, `channels/`, `vocabulary/`). Categorize files by layer. Parse `format_version` from manifest. V1 migration: if no `format_version` or `"1.0"`, treat as core-only, warn.

---

### Task 18: Import Validator v2

**Files:**

- Modify: `packages/project-io/src/import/import-validator.ts`
- Test: `packages/project-io/src/__tests__/import-validator-v2.test.ts`

Add SHA verification (3-tier: integrity → layer → per-file). Add cross-layer dependency validation (agents reference tools that exist, tools reference connectors that exist). DSL-authoritative: parse DSL to derive actual dependency graph, cross-check manifest warnings.

---

### Task 19: Staged Importer

**Files:**

- Create: `packages/project-io/src/import/staged-importer.ts`
- Test: `packages/project-io/src/__tests__/staged-importer.test.ts`

Implement Phase 2-4:

- **Stage**: Write records with `status: 'staged'`
- **Activate**: Per-layer in order (connections → tools → agents → workflows → guardrails → evals → channels → vocabulary). Single `bulkWrite` per collection.
- **Rollback**: On failure, flip staged→deleted, superseded→active.
- **Track progress**: Update `ImportOperation` at each step.

Test: successful activation, crash recovery (resume from partial), rollback on error.

---

### Task 20: Post-Import Validator

**Files:**

- Create: `packages/project-io/src/import/post-import-validator.ts`
- Test: `packages/project-io/src/__tests__/post-import-validator.test.ts`

After successful import, scan project and report:

- Missing env vars (referenced in DSL but not provisioned)
- Connectors needing credentials
- MCP servers needing auth
- Guardrail providers not configured in tenant

Return as structured `PostImportReport`.

---

### Task 21: Update Import API Routes

**Files:**

- Modify: `apps/studio/src/app/api/projects/[id]/import/apply/route.ts`

Wire staged importer. Return `ImportOperation` ID for tracking. Add `GET /import/status?operationId=xxx` endpoint.

---

## Phase 5: Git Sync

**Exit criteria:** GitHub provider pushes/pulls all v2 layers. Branch-per-environment with merge/promote. Sync status reporting.

### Task 22: Extend GitHub Provider

**Files:**

- Modify: `packages/project-io/src/git/github-provider.ts`
- Test: `packages/project-io/src/__tests__/github-provider-v2.test.ts`

Extend `pushProject()` and `pullProject()` to handle full v2 folder structure. All layer directories are synced. File FETCH_BATCH_SIZE=10 pattern already exists — reuse.

---

### Task 23: Branch Management

**Files:**

- Create: `packages/project-io/src/git/branch-manager.ts`
- Test: `packages/project-io/src/__tests__/branch-manager.test.ts`

Implement:

- `createEnvironmentBranch(env: 'staging' | 'production')` — creates branch from main
- `promoteBranch(from: string, to: string)` — merge from→to via GitHub API
- `getBranchStatus(branch: string)` — compare local vs remote
- `listBranches()` — list environment branches

---

### Task 24: Git Sync Studio API

**Files:**

- Create: `apps/studio/src/app/api/projects/[id]/git/route.ts`
- Create: `apps/studio/src/app/api/projects/[id]/git/promote/route.ts`

Endpoints:

- `POST /git/push` — commit + push to configured branch
- `POST /git/pull` — pull from branch, run staged import
- `GET /git/status` — local vs remote diff
- `POST /git/promote` — merge between environment branches

---

## Phase 6: CLI & UI

**Exit criteria:** CLI has `export --layers`, `git *`, `verify`, `doctor` commands. Studio export/import dialogs show layer selection, SHA verification, and validation report.

### Task 25: CLI Export v2

**Files:**

- Modify: `packages/kore-platform-cli/src/commands/export.ts`

Add `--layers` flag (comma-separated), `--all-layers` flag. Default: core,connections,guardrails,workflows. Async job detection: if response returns `jobId`, poll until complete.

---

### Task 26: CLI Git Commands

**Files:**

- Create: `packages/kore-platform-cli/src/commands/git.ts`

Commands: `git init`, `git push`, `git pull`, `git status`, `git promote`. Follow commander pattern from existing export command.

---

### Task 27: CLI Verify & Doctor

**Files:**

- Create: `packages/kore-platform-cli/src/commands/verify.ts`
- Create: `packages/kore-platform-cli/src/commands/doctor.ts`

`verify` — Offline SHA verification of an export folder. No server needed.
`doctor` — Calls post-import validator API, displays formatted report.

---

### Task 28: Studio Export Dialog v2

**Files:**

- Modify: `apps/studio/src/components/projects/ExportDialog.tsx`

Add layer checklist (checkboxes per layer with entity counts). Show "Git sync" toggle if repo configured. Progress indicator for async exports.

---

### Task 29: Studio Import Dialog v2

**Files:**

- Modify: `apps/studio/src/components/projects/ImportDialog.tsx`

Show per-layer diff preview. SHA verification badge. Post-import validation report: "3 env vars need provisioning, 1 connector needs credentials." Add "Pull from Git" button alongside ZIP upload.

---

## Phase 7: Arch AI & Forward Compat

**Exit criteria:** Arch understands export v2. v1 imports handled gracefully.

### Task 30: Arch System Context Update

**Files:**

- Modify: `apps/studio/src/app/api/arch/chat/route.ts` (system prompt)

Add export v2 layer model, Git workflow guidance, dependency awareness to Arch's system context. When proposing tools with external deps, include connection + env var in proposal.

---

### Task 31: v1 → v2 Migration Handler

**Files:**

- Create: `packages/project-io/src/import/v1-migration.ts`
- Test: `packages/project-io/src/__tests__/v1-migration.test.ts`

When `format_version` is missing or `"1.0"`:

- Treat as core-only (agents + tools)
- Generate warnings: "v1 format — configs, connections, workflows not included"
- Skip lockfile v2 verification (v1 lockfile has different shape)

---

## Phase 8: Integration Testing & Hardening

**Exit criteria:** Full round-trip test (export → modify → import) passes. Recovery from crash scenarios verified. Performance under load acceptable.

### Task 32: Round-Trip Integration Tests

**Files:**

- Create: `packages/project-io/src/__tests__/export-import-roundtrip.test.ts`

Test: export project → verify all layers in output → modify an agent → re-import → verify diff shows only the modification → verify SHA mismatch detected on tampered file.

---

### Task 33: Crash Recovery Tests

**Files:**

- Create: `packages/project-io/src/__tests__/import-crash-recovery.test.ts`

Test: simulate crash during Phase 2 (staging) — verify cleanup. Simulate crash during Phase 3 (activation) — verify resume from ImportOperation record. Verify TTL cleanup of abandoned operations.

---

### Task 34: Performance Test

**Files:**

- Create: `packages/project-io/src/__tests__/export-performance.test.ts`

Test with fixtures:

- Small project (5 agents, 3 tools, 2 configs): target <2s sync
- Medium project (50 agents, 20 tools, all layers): target <10s sync
- Large project (500 agents, 200 tools, all layers): should route to async path

---

## Dependency Order

```
Phase 1 (Tasks 1-11): Types → Assemblers → Lockfile → Manifest
Phase 2 (Tasks 12-14): Orchestrator → API routes [depends on Phase 1]
Phase 3 (Task 15): Async export [depends on Phase 2]
Phase 4 (Tasks 16-21): Staged import [depends on Phase 1 types, can parallel with Phase 2-3]
Phase 5 (Tasks 22-24): Git sync [depends on Phase 2]
Phase 6 (Tasks 25-29): CLI + UI [depends on Phases 2-5 for APIs]
Phase 7 (Tasks 30-31): Arch + compat [depends on Phase 1 types]
Phase 8 (Tasks 32-34): Integration tests [depends on all phases]
```

**Parallelizable work:**

- Tasks 3-9 (layer assemblers) can all be done in parallel
- Phase 4 (import) can start after Phase 1, parallel with Phase 2-3
- Phase 7 (Arch) can start after Phase 1, parallel with everything else
- Tasks 25-27 (CLI) can parallel with Tasks 28-29 (UI)

## Rollback Strategy

Each phase is independently deployable:

- Phase 1-2: New export path behind `format_version=2` query param. v1 unchanged.
- Phase 3: Async path is additive — small exports still use sync.
- Phase 4: Staged import is opt-in via `staged=true` flag. Old import path unchanged.
- Phase 5: Git sync is opt-in per project.
- Phase 6: UI changes behind feature flag if needed.

If any phase fails in production, revert that phase's commits. Earlier phases continue working.
