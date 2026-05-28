# Section 4: Security, Validation & Prerequisites

> **Scope:** Import-side hardening for manifest v2 — prerequisite checks, auth profile
> resolution, schema validation, SSRF/injection defense, redacted value handling, audit
> trail, and rate limiting.

---

## 4.1 Prerequisite Validation (Pre-Import Check)

### Problem

`ProjectManifestV2.metadata` declares `required_env_vars`, `required_connectors`,
`required_mcp_servers`, and `required_auth_profiles`. The import pipeline never checks
whether the target environment satisfies these requirements. A project that imports
cleanly may fail at runtime because an expected env var or connector is missing.

### Design

```
File: packages/project-io/src/import/prerequisite-validator.ts
```

#### Types

```typescript
import { z } from 'zod';
import type { ProjectManifestV2 } from '../types.js';

// ── Severity: blocking prevents import, warning allows it but flags degradation ──

export type PrerequisiteSeverity = 'blocking' | 'warning';

export interface PrerequisiteIssue {
  severity: PrerequisiteSeverity;
  category: 'env_var' | 'connector' | 'mcp_server' | 'auth_profile' | 'permission';
  key: string;
  message: string;
  /** Actionable guidance shown in Studio UI */
  remediation: string;
}

export interface PrerequisiteResult {
  satisfied: boolean;
  /** true if no blocking issues (warnings allowed) */
  canProceed: boolean;
  issues: PrerequisiteIssue[];
}

/** Injected context — avoids coupling to Mongoose models */
export interface PrereqContext {
  tenantId: string;
  projectId: string;
  environment: string;
  /** Keys present in EnvironmentVariable collection for this project+env */
  existingEnvVarKeys: Set<string>;
  /** Connector type names present in ConnectorConfig for this tenant */
  existingConnectorTypes: Set<string>;
  /** MCP server names present in MCPServerConfig for this project */
  existingMcpServerNames: Set<string>;
  /** Auth profile names present in AuthProfile for this tenant */
  existingAuthProfileNames: Set<string>;
  /** Permission strings for the importing user */
  userPermissions: string[];
}
```

#### Algorithm

```typescript
export function validateImportPrerequisites(
  manifest: ProjectManifestV2,
  ctx: PrereqContext,
): PrerequisiteResult {
  const issues: PrerequisiteIssue[] = [];

  // 1. Environment variables
  for (const varName of manifest.metadata.required_env_vars) {
    if (!ctx.existingEnvVarKeys.has(varName)) {
      issues.push({
        severity: 'blocking',
        category: 'env_var',
        key: varName,
        message: `Required environment variable "${varName}" is not set`,
        remediation: `Set "${varName}" at Settings > Environment Variables > ${ctx.environment}`,
      });
    }
  }

  // 2. Connectors
  for (const connType of manifest.metadata.required_connectors) {
    if (!ctx.existingConnectorTypes.has(connType)) {
      issues.push({
        severity: 'warning',
        category: 'connector',
        key: connType,
        message: `Connector "${connType}" is not configured in this environment`,
        remediation: `Configure "${connType}" at Settings > Connectors > Add Connector`,
      });
    }
  }

  // 3. MCP Servers
  for (const serverName of manifest.metadata.required_mcp_servers) {
    if (!ctx.existingMcpServerNames.has(serverName)) {
      issues.push({
        severity: 'warning',
        category: 'mcp_server',
        key: serverName,
        message: `MCP server "${serverName}" is not configured in this project`,
        remediation: `Add MCP server "${serverName}" at Settings > MCP Servers > Add Server`,
      });
    }
  }

  // 4. Auth Profiles
  const requiredProfiles = manifest.metadata.required_auth_profiles ?? [];
  for (const profile of requiredProfiles) {
    if (!ctx.existingAuthProfileNames.has(profile.name)) {
      issues.push({
        severity: 'blocking',
        category: 'auth_profile',
        key: profile.name,
        message:
          `Auth profile "${profile.name}" (${profile.authType}) ` +
          `is not available — referenced by: ${profile.referencedBy.join(', ')}`,
        remediation:
          `Create auth profile "${profile.name}" at Settings > Auth Profiles, ` +
          `or re-map during import`,
      });
    }
  }

  // 5. Per-layer permission check
  const layerPermissionMap: Record<string, string> = {
    core: 'project:import',
    connections: 'connector:write',
    guardrails: 'guardrail:write',
    workflows: 'workflow:write',
    evals: 'eval:write',
    search: 'search:write',
    channels: 'channel:write',
    vocabulary: 'vocabulary:write',
  };

  for (const layer of manifest.layers_included) {
    const requiredPerm = layerPermissionMap[layer];
    if (requiredPerm && !ctx.userPermissions.includes(requiredPerm)) {
      // Check wildcard permissions
      const [resource] = requiredPerm.split(':');
      const hasWildcard =
        ctx.userPermissions.includes('*:*') || ctx.userPermissions.includes(`${resource}:*`);
      if (!hasWildcard) {
        issues.push({
          severity: 'blocking',
          category: 'permission',
          key: requiredPerm,
          message: `Missing permission "${requiredPerm}" required to import the ${layer} layer`,
          remediation: `Request the "${requiredPerm}" permission from your administrator`,
        });
      }
    }
  }

  const hasBlocking = issues.some((i) => i.severity === 'blocking');
  return {
    satisfied: issues.length === 0,
    canProceed: !hasBlocking,
    issues,
  };
}
```

#### Route Integration

The prerequisite check runs at the start of both `POST /import/preview` and
`POST /import` in the v2 routes. The context is populated from database queries:

```typescript
// In the v2 import route handler (apps/runtime/src/routes/project-io-v2.ts)
const [envVars, connConfigs, mcpServers, authProfiles] = await Promise.all([
  EnvironmentVariable.find({
    tenantId,
    projectId,
    environment: targetEnvironment,
  })
    .select('key')
    .lean(),
  ConnectorConfig.find({ tenantId }).select('connectorType').lean(),
  MCPServerConfig.find({ tenantId, projectId }).select('name').lean(),
  AuthProfile.find({
    tenantId,
    $or: [{ projectId }, { projectId: null, scope: 'tenant' }],
  })
    .select('name')
    .lean(),
]);

const prereqResult = validateImportPrerequisites(manifest, {
  tenantId,
  projectId,
  environment: targetEnvironment,
  existingEnvVarKeys: new Set(envVars.map((v) => v.key)),
  existingConnectorTypes: new Set(connConfigs.map((c) => c.connectorType)),
  existingMcpServerNames: new Set(mcpServers.map((s) => s.name)),
  existingAuthProfileNames: new Set(authProfiles.map((p) => p.name)),
  userPermissions: req.tenantContext!.permissions,
});

if (!prereqResult.canProceed) {
  res.status(422).json({
    success: false,
    error: {
      code: 'PREREQUISITES_NOT_MET',
      message: 'Import blocked by unmet prerequisites',
    },
    prerequisites: prereqResult,
  });
  return;
}
```

---

## 4.2 Auth Profile Resolution

### Problem

Exported connections reference auth profiles by name (`authProfileName`). The target
environment may have the same auth profile under a different ID, or a compatible profile
under a different name. There is no code to resolve exported names to target IDs.

### Design

```
File: packages/project-io/src/import/auth-profile-resolver.ts
```

#### Types

```typescript
import type { ExportedAuthProfileRef } from '../export/layer-assemblers/connections-assembler.js';

// [R2 Fix: R2-AUTH-1] 'fuzzy_match' is no longer used as an auto-applied strategy.
// Only 'exact_name' and 'user_mapped' populate the resolved map.
// Fuzzy matches are returned as suggestions in unresolved entries.
export type ResolutionStrategy = 'exact_name' | 'user_mapped';

export interface ResolvedAuthProfile {
  exportedName: string;
  resolvedId: string;
  resolvedName: string;
  strategy: ResolutionStrategy;
  confidence: number; // 0.0 - 1.0
}

export interface UnresolvedAuthProfile {
  exportedName: string;
  authType: string;
  scope: 'tenant' | 'project';
  connector?: string;
  referencedBy: string[];
  /** Candidate matches found during fuzzy search */
  candidates: Array<{
    id: string;
    name: string;
    authType: string;
    score: number;
  }>;
  /**
   * [R2 Fix: R2-AUTH-1] Best fuzzy candidate with score >= 0.7, if any.
   * Presented in the preview UI as a suggestion for user confirmation.
   * NEVER auto-applied — the user must explicitly confirm via userMappings
   * in the import request to apply a fuzzy match.
   */
  suggestedMatch?: {
    id: string;
    name: string;
    authType: string;
    score: number;
  };
}

export interface AuthProfileResolution {
  resolved: Map<string, ResolvedAuthProfile>;
  unresolved: UnresolvedAuthProfile[];
  /** Pre-built mapping: exportedName -> targetId (for connection rewriting) */
  nameToIdMap: Record<string, string>;
}

/** Minimal auth profile record from the database */
export interface TargetAuthProfile {
  _id: string;
  name: string;
  authType: string;
  scope: 'tenant' | 'project';
  connector?: string;
  category?: string;
  visibility: 'shared' | 'personal';
  status: 'active' | 'expired' | 'revoked' | 'invalid';
}
```

#### Algorithm

```typescript
/**
 * Resolve exported auth profile references to target environment IDs.
 *
 * [R2 Fix: R2-AUTH-1] Resolution cascade (updated):
 * 1. User-provided manual mapping (from import options — highest priority)
 * 2. Exact name match (case-insensitive) — auto-applied (confidence 1.0)
 * 3. Fuzzy match by (authType + scope + connector) — NEVER auto-applied.
 *    Fuzzy matches are returned as `suggestedMatch` in the unresolved array.
 *    The preview endpoint presents these for user confirmation. The user must
 *    explicitly include confirmed fuzzy matches in `userMappings` to apply them.
 *
 * Only active profiles are considered as candidates.
 */
export function resolveAuthProfiles(
  required: ExportedAuthProfileRef[],
  targetProfiles: TargetAuthProfile[],
  userMappings?: Record<string, string>,
): AuthProfileResolution {
  const resolved = new Map<string, ResolvedAuthProfile>();
  const unresolved: UnresolvedAuthProfile[] = [];
  const nameToIdMap: Record<string, string> = {};

  // Filter to active profiles only
  const activeProfiles = targetProfiles.filter((p) => p.status === 'active');

  // Build lookup indexes
  const byNameLower = new Map<string, TargetAuthProfile>();
  for (const p of activeProfiles) {
    byNameLower.set(p.name.toLowerCase(), p);
  }

  for (const req of required) {
    // Step 0: Check user-provided mapping first
    if (userMappings && userMappings[req.name]) {
      const mappedId = userMappings[req.name];
      const target = activeProfiles.find((p) => p._id === mappedId);
      if (target) {
        const entry: ResolvedAuthProfile = {
          exportedName: req.name,
          resolvedId: target._id,
          resolvedName: target.name,
          strategy: 'user_mapped',
          confidence: 1.0,
        };
        resolved.set(req.name, entry);
        nameToIdMap[req.name] = target._id;
        continue;
      }
    }

    // Step 1: Exact name match (case-insensitive)
    const exactMatch = byNameLower.get(req.name.toLowerCase());
    if (exactMatch) {
      const entry: ResolvedAuthProfile = {
        exportedName: req.name,
        resolvedId: exactMatch._id,
        resolvedName: exactMatch.name,
        strategy: 'exact_name',
        confidence: 1.0,
      };
      resolved.set(req.name, entry);
      nameToIdMap[req.name] = exactMatch._id;
      continue;
    }

    // Step 2: Fuzzy match by (authType + scope + connector)
    // [R2 Fix: R2-AUTH-1 / INT-1] Fuzzy matches are NEVER auto-applied.
    // They are returned as suggestions that require explicit user confirmation
    // via the preview endpoint. Only exact_name (confidence 1.0) and user_mapped
    // strategies populate nameToIdMap. This prevents silently wiring production
    // connections to staging credentials (e.g., "Salesforce Production" matching
    // "Salesforce Staging" with score 0.9).
    const candidates = scoreCandidates(req, activeProfiles);

    // Step 3: Unresolved — user must confirm or manually map.
    // Fuzzy candidates are included as suggestions for the preview UI.
    unresolved.push({
      exportedName: req.name,
      authType: req.authType,
      scope: req.scope,
      connector: req.connector,
      referencedBy: req.referencedBy,
      candidates: candidates.slice(0, 5),
      // [R2 Fix] Top candidate with score >= 0.7 is a "suggestion" — shown
      // in the preview UI for user confirmation, but NOT auto-applied.
      suggestedMatch:
        candidates.length > 0 && candidates[0].score >= 0.7 ? candidates[0] : undefined,
    });
  }

  return { resolved, unresolved, nameToIdMap };
}

/**
 * Score target profiles against an exported requirement.
 *
 * Scoring weights:
 * - authType match:  0.4 (required for any match)
 * - scope match:     0.2
 * - connector match: 0.3
 * - category match:  0.1
 */
function scoreCandidates(
  req: ExportedAuthProfileRef,
  targets: TargetAuthProfile[],
): Array<{ id: string; name: string; authType: string; score: number }> {
  const results: Array<{
    id: string;
    name: string;
    authType: string;
    score: number;
  }> = [];

  for (const t of targets) {
    let score = 0;

    // authType is a hard requirement — skip if no match
    if (t.authType !== req.authType) continue;
    score += 0.4;

    if (t.scope === req.scope) score += 0.2;

    if (req.connector && t.connector && t.connector.toLowerCase() === req.connector.toLowerCase()) {
      score += 0.3;
    }

    if (req.category && t.category && t.category.toLowerCase() === req.category.toLowerCase()) {
      score += 0.1;
    }

    results.push({
      id: t._id,
      name: t.name,
      authType: t.authType,
      score,
    });
  }

  return results.sort((a, b) => b.score - a.score);
}
```

#### Connection Rewriting

After resolution, connections are rewritten before staging:

```typescript
/**
 * Rewrite authProfileName references to authProfileId in connection data.
 * Called during the connections layer disassembly before staging.
 */
export function rewriteConnectionAuthProfiles(
  connectionData: Record<string, unknown>,
  nameToIdMap: Record<string, string>,
): { rewritten: Record<string, unknown>; unmapped: string[] } {
  const unmapped: string[] = [];
  const rewritten = { ...connectionData };

  const profileName = rewritten.authProfileName as string | undefined;
  if (profileName) {
    const resolvedId = nameToIdMap[profileName];
    if (resolvedId) {
      rewritten.authProfileId = resolvedId;
      delete rewritten.authProfileName;
    } else {
      unmapped.push(profileName);
    }
  }

  return { rewritten, unmapped };
}
```

---

## 4.3 Imported JSON Schema Validation

### Problem

Each layer's JSON files are currently parsed with `JSON.parse()` but never validated
against expected schemas. Malicious or corrupted files could inject unexpected fields
into the database, bypass business rules, or overwrite internal fields like `tenantId`.

### Design

```
File: packages/project-io/src/import/layer-schemas.ts
```

#### Approach

> **[R1 Fix: VULN-2]** All schemas now use `.strip()` instead of `.passthrough()`. The
> `.passthrough()` + `stripInternal` pattern only removed 7 named internal fields, letting
> arbitrary attacker-injected fields (e.g., `role: "admin"`, `permissions: ["*:*"]`) pass
> into MongoDB. `.strip()` silently removes ALL unknown keys, containing data to the
> explicitly declared schema shape. Where extensibility is genuinely needed (e.g.,
> connector configs), an explicit `additionalProperties: z.record(z.unknown())` field
> is used instead.

> **[R1 Fix: MAJ-2 / MAJ-3]** All schemas have been cross-referenced against the actual
> assembler output (`stripInternalFields` + `.select()` projections) to match real
> exported field names. Previous schemas used incorrect field names (e.g., `config`
> instead of `vectorStore`, `type` instead of `channelType`, `name` instead of
> `displayName`) that would reject valid export data.

- One Zod schema per entity type
- Schemas use `.strip()`: unknown fields are silently removed, not passed through
- Internal fields (`_id`, `tenantId`, `projectId`, `__v`) are always stripped
  regardless of input
- Validation runs during the disassembly phase, before staging

#### Per-Entity Zod Schemas

```typescript
import { z } from 'zod';

// ── Internal field stripping (applied to all entities) ──

const INTERNAL_FIELDS = [
  '_id',
  '__v',
  'tenantId',
  'projectId',
  'createdAt',
  'updatedAt',
  'status',
] as const;

function stripInternal(data: Record<string, unknown>): Record<string, unknown> {
  const result = { ...data };
  for (const field of INTERNAL_FIELDS) {
    delete result[field];
  }
  return result;
}

// ── Connections ──
// Source: ConnectionsAssembler — ConnectorConnection.find().lean(), then stripInternalFields
// with additional keys: encryptedCredentials, encryptionKeyVersion, oauth2RefreshToken, authProfileId
// Exported fields come from the full Mongoose document minus internal/secret fields.

export const ImportedConnectionSchema = z
  .object({
    connectorName: z.string().min(1).max(255),
    displayName: z.string().min(1).max(255),
    scope: z.enum(['tenant', 'user']).optional(),
    authType: z.enum(['oauth2', 'api_key', 'bearer', 'basic', 'custom', 'none']).optional(),
    authProfileName: z.string().max(255).optional(),
    scopes: z.array(z.string().max(500)).max(50).optional(),
    oauth2Provider: z.string().max(255).optional(),
    authProfile: z.record(z.unknown()).optional(),
  })
  .strip()
  .transform(stripInternal);

// ── Connector Configs ──
// Source: ConnectionsAssembler — ConnectorConfig.find().lean(), then stripInternalFields
// with additional keys: oauthTokenId, syncState, errorState
// [R1 Fix: MIN-3] Use z.string() instead of z.enum() to avoid rejecting future connector types.

export const ImportedConnectorConfigSchema = z
  .object({
    connectorType: z.string().min(1).max(100),
    connectionConfig: z.record(z.unknown()).optional(),
    filterConfig: z
      .object({
        standard: z.record(z.unknown()).optional(),
        scope: z.record(z.unknown()).optional(),
        advancedFilters: z.record(z.unknown()).optional(),
        version: z.number().optional(),
      })
      .strip()
      .optional(),
    permissionConfig: z
      .object({
        mode: z.enum(['full', 'simplified', 'disabled']).optional(),
        additionalProperties: z.record(z.unknown()).optional(),
      })
      .strip()
      .optional(),
  })
  .strip()
  .transform(stripInternal);

// ── Guardrails ──
// Source: GuardrailsAssembler — GuardrailPolicy.find().lean(), then stripInternalFields
// Exported as full GuardrailPolicy record minus __v and webhookSecret from settings.
// Actual fields: name, description, scope, type, enabled, settings, priority, etc.

export const ImportedGuardrailSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(2000).optional(),
    type: z.string().min(1).max(100).optional(),
    enabled: z.boolean().optional(),
    scope: z
      .object({
        type: z.enum(['project', 'agent']).optional(),
        projectId: z.string().optional(),
        agentId: z.string().optional(),
      })
      .strip()
      .optional(),
    settings: z.record(z.unknown()).optional(),
    priority: z.number().int().min(0).max(1000).optional(),
  })
  .strip()
  .transform(stripInternal);

// ── Workflows ──
// Source: WorkflowsAssembler — Workflow.find().lean().select(
//   'name type description steps triggers slaMinutes escalationRules notificationRules status')
// then stripInternalFields with additional keys: _v, archivedAt, metadata

export const ImportedWorkflowSchema = z
  .object({
    name: z.string().min(1).max(255),
    type: z.string().max(100).optional(),
    description: z.string().max(2000).optional(),
    steps: z.array(z.record(z.unknown())).max(500).optional(),
    triggers: z.array(z.record(z.unknown())).max(100).optional(),
    slaMinutes: z.number().int().min(0).optional(),
    escalationRules: z.array(z.record(z.unknown())).max(100).optional(),
    notificationRules: z.array(z.record(z.unknown())).max(100).optional(),
  })
  .strip()
  .transform(stripInternal);

// ── Workflow Versions ──
// Source: WorkflowsAssembler — emitted as { version, source_hash, status, changelog,
//   created_by, created_at, definition }

export const ImportedWorkflowVersionSchema = z
  .object({
    version: z.string().max(50),
    source_hash: z.string().max(255).optional(),
    changelog: z.string().max(5000).nullable().optional(),
    created_by: z.string().max(255).optional(),
    created_at: z.string().optional(),
    definition: z.record(z.unknown()).optional(),
  })
  .strip()
  .transform(stripInternal);

// ── Evals ──
// Source: EvalsAssembler — EvalSet.find().lean().select(
//   'name description personaIds scenarioIds evaluatorIds variants maxConcurrency
//    regressionThreshold ciEnabled personaModel personaModelConfig createdBy')
// then stripInternalFields

export const ImportedEvalSetSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(2000).optional(),
    personaIds: z.array(z.string()).max(500).optional(),
    scenarioIds: z.array(z.string()).max(500).optional(),
    evaluatorIds: z.array(z.string()).max(100).optional(),
    variants: z.array(z.record(z.unknown())).max(100).optional(),
    maxConcurrency: z.number().int().min(1).max(100).optional(),
    regressionThreshold: z.number().min(0).max(1).optional(),
    ciEnabled: z.boolean().optional(),
    personaModel: z.string().max(255).optional(),
    personaModelConfig: z.record(z.unknown()).optional(),
    createdBy: z.string().max(255).optional(),
  })
  .strip()
  .transform(stripInternal);

// [R1 Fix: MISS-6] Add missing schemas for eval scenarios, personas, and evaluators.

export const ImportedEvalScenarioSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(5000).optional(),
    category: z.string().max(255).optional(),
    difficulty: z.string().max(50).optional(),
    entryAgent: z.string().max(255).optional(),
    initialMessage: z.string().max(10000).optional(),
    expectedOutcome: z.string().max(5000).optional(),
    maxTurns: z.number().int().min(1).max(1000).optional(),
    tags: z.array(z.string().max(100)).max(50).optional(),
    agentPath: z.array(z.string().max(255)).max(50).optional(),
    expectedMilestones: z.array(z.record(z.unknown())).max(100).optional(),
    maxToolCalls: z.number().int().min(0).max(10000).optional(),
    version: z.string().max(50).optional(),
    createdBy: z.string().max(255).optional(),
  })
  .strip()
  .transform(stripInternal);

export const ImportedEvalPersonaSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(5000).optional(),
    communicationStyle: z.string().max(500).optional(),
    domainKnowledge: z.string().max(2000).optional(),
    behaviorTraits: z.array(z.string().max(500)).max(50).optional(),
    goals: z.array(z.string().max(500)).max(50).optional(),
    constraints: z.array(z.string().max(500)).max(50).optional(),
    systemPrompt: z.string().max(10000).optional(),
    source: z.string().max(255).optional(),
    isAdversarial: z.boolean().optional(),
    adversarialType: z.string().max(100).optional(),
    isBuiltIn: z.boolean().optional(),
    createdBy: z.string().max(255).optional(),
  })
  .strip()
  .transform(stripInternal);

// Source: EvalsAssembler — EvalEvaluator.find().lean().select(
//   'name description type category judgeModel judgePrompt chainOfThought temperature
//    scoringRubric biasSettings scorerName scorerConfig trajectoryMetrics isBuiltIn createdBy')

export const ImportedEvaluatorSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(5000).optional(),
    type: z.string().min(1).max(100),
    category: z.string().max(100).optional(),
    judgeModel: z.string().max(255).optional(),
    judgePrompt: z.string().max(50000).optional(),
    chainOfThought: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    scoringRubric: z.record(z.unknown()).optional(),
    biasSettings: z.record(z.unknown()).optional(),
    scorerName: z.string().max(255).optional(),
    scorerConfig: z.record(z.unknown()).optional(),
    trajectoryMetrics: z.array(z.string().max(255)).max(50).optional(),
    isBuiltIn: z.boolean().optional(),
    createdBy: z.string().max(255).optional(),
  })
  .strip()
  .transform(stripInternal);

// ── Search ──
// Source: SearchAssembler — SearchIndex.find().lean().select(
//   'slug name description embeddingModel embeddingDimensions tokenChunkStrategy
//    vectorStore searchDefaults llmConfig status')
// then stripInternalFields + delete documentCount, chunkCount, sourceCount, lastIndexedAt, indexError

export const ImportedSearchIndexSchema = z
  .object({
    slug: z.string().min(1).max(255).optional(),
    name: z.string().min(1).max(255),
    description: z.string().max(2000).optional(),
    embeddingModel: z.string().max(255).optional(),
    embeddingDimensions: z.number().int().min(1).max(10000).optional(),
    tokenChunkStrategy: z.record(z.unknown()).optional(),
    vectorStore: z.record(z.unknown()).optional(),
    searchDefaults: z.record(z.unknown()).optional(),
    llmConfig: z.record(z.unknown()).optional(),
  })
  .strip()
  .transform(stripInternal);

// Source: SearchAssembler — SearchSource.find().lean().select(
//   'indexId name sourceType extractionConfig enrichmentConfig syncSchedule status')
// then stripInternalFields + delete sourceConfig, documentCount, lastSyncAt, syncError

export const ImportedSearchSourceSchema = z
  .object({
    indexId: z.string().max(255).optional(),
    name: z.string().min(1).max(255),
    sourceType: z.string().max(100).optional(),
    extractionConfig: z.record(z.unknown()).optional(),
    enrichmentConfig: z.record(z.unknown()).optional(),
    syncSchedule: z.record(z.unknown()).optional(),
  })
  .strip()
  .transform(stripInternal);

// Source: SearchAssembler — KnowledgeBase.find().lean().select(
//   'name description searchIndexId connectorCount status isPublic')
// then stripInternalFields + delete documentCount, lastIndexedAt, indexError

export const ImportedKnowledgeBaseSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(2000).optional(),
    searchIndexId: z.string().max(255).optional(),
    connectorCount: z.number().int().min(0).optional(),
    isPublic: z.boolean().optional(),
  })
  .strip()
  .transform(stripInternal);

// [R1 Fix: MISS-8] Add missing schema for crawl patterns.
// Source: SearchAssembler — CrawlPattern.find().lean().select(
//   'domain siteType framework jsRequired linkDensity estimatedSize avgResponseTime
//    rateLimitDetected maxConcurrency confidence metadata')
// then stripInternalFields + delete runtime stats

export const ImportedCrawlPatternSchema = z
  .object({
    domain: z.string().min(1).max(2048),
    siteType: z.string().max(100).optional(),
    framework: z.string().max(100).optional(),
    jsRequired: z.boolean().optional(),
    linkDensity: z.number().min(0).optional(),
    estimatedSize: z.number().int().min(0).optional(),
    avgResponseTime: z.number().min(0).optional(),
    rateLimitDetected: z.boolean().optional(),
    maxConcurrency: z.number().int().min(1).max(100).optional(),
    confidence: z.number().min(0).max(1).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strip()
  .transform(stripInternal);

// ── Channels ──
// Source: ChannelsAssembler — ChannelConnection.find().lean().select(
//   'channelType externalIdentifier displayName agentId deploymentId environment config status')
// then stripInternalFields + delete encryptedCredentials, verifyTokenHash

export const ImportedChannelSchema = z
  .object({
    channelType: z.string().min(1).max(100),
    externalIdentifier: z.string().max(500).optional(),
    displayName: z.string().min(1).max(255),
    agentId: z.string().max(255).optional(),
    deploymentId: z.string().max(255).optional(),
    environment: z.string().max(100).optional(),
    config: z.record(z.unknown()).optional(),
  })
  .strip()
  .transform(stripInternal);

// Source: ChannelsAssembler — WebhookSubscription.find().lean().select(
//   'channelConnectionId callbackUrl events status description')
// then stripInternalFields + delete encryptedSecret, lastDeliveryAt, failureCount

export const ImportedWebhookSchema = z
  .object({
    channelConnectionId: z.string().max(255).optional(),
    callbackUrl: z.string().url().max(2048),
    events: z.array(z.string().max(255)).max(100).optional(),
    description: z.string().max(2000).optional(),
  })
  .strip()
  .transform(stripInternal);

// [R1 Fix: MISS-7] Add missing schema for widget configs.
// Source: ChannelsAssembler — WidgetConfig.findOne(), then stripInternalFields

export const ImportedWidgetConfigSchema = z
  .object({
    theme: z.record(z.unknown()).optional(),
    branding: z.record(z.unknown()).optional(),
    behavior: z.record(z.unknown()).optional(),
    customCss: z.string().max(50000).optional(),
    allowedOrigins: z.array(z.string().max(2048)).max(50).optional(),
  })
  .strip()
  .transform(stripInternal);

// ── Vocabulary ──
// Source: VocabularyAssembler — LookupEntry grouped by tableName
// Exported per-table as arrays: [{ tableName, value, field, metadata }]

export const ImportedLookupEntrySchema = z
  .object({
    tableName: z.string().min(1).max(255),
    value: z.string().max(500),
    field: z.string().max(255).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strip()
  .transform(stripInternal);

export const ImportedLookupTableSchema = z.array(ImportedLookupEntrySchema).max(10000);

// Source: VocabularyAssembler — CanonicalSchema.find().lean().select(
//   'knowledgeBaseId version fields status')

export const ImportedCanonicalSchemaFile = z
  .object({
    knowledgeBaseId: z.string().max(255).optional(),
    version: z.number().int().min(0).optional(),
    fields: z.array(z.record(z.unknown())).max(500).optional(),
  })
  .strip()
  .transform(stripInternal);

// Source: VocabularyAssembler — DomainVocabulary.find().lean().select(
//   'projectKnowledgeBaseId version status entries')
// Exported as an array in vocabulary/domain-vocabulary.json

export const ImportedDomainVocabularySchema = z
  .object({
    projectKnowledgeBaseId: z.string().max(255).optional(),
    version: z.number().int().min(0).optional(),
    entries: z.array(z.record(z.unknown())).max(50000).optional(),
  })
  .strip()
  .transform(stripInternal);

// [R1 Fix: MISS-6] Add missing schema for facts.
// Source: VocabularyAssembler — Fact.find().lean().select(
//   'key value sourceType sourceAgentName expiresAt metadata')
// then stripInternalFields + delete userId, sourceSessionId, sourceTraceId

export const ImportedFactSchema = z
  .object({
    key: z.string().min(1).max(500),
    value: z.string().max(10000),
    sourceType: z.string().max(100).optional(),
    sourceAgentName: z.string().max(255).optional(),
    expiresAt: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strip()
  .transform(stripInternal);
```

#### Validation Runner

```typescript
import type { LayerName } from '../types.js';

export interface SchemaValidationIssue {
  file: string;
  layer: LayerName;
  errors: Array<{ path: string; message: string }>;
}

export interface SchemaValidationResult {
  valid: boolean;
  sanitizedData: Record<string, unknown>;
  issues: SchemaValidationIssue[];
}

/**
 * Validate a parsed JSON entity against its layer schema.
 * Returns sanitized data (internal fields stripped, unknown fields removed)
 * or validation errors.
 */
export function validateEntitySchema(
  filePath: string,
  layer: LayerName,
  data: Record<string, unknown>,
): SchemaValidationResult {
  const schema = getSchemaForFile(filePath, layer);
  if (!schema) {
    // Unknown file type in layer — strip internal fields only
    return {
      valid: true,
      sanitizedData: stripInternal(data),
      issues: [],
    };
  }

  const result = schema.safeParse(data);
  if (result.success) {
    return { valid: true, sanitizedData: result.data, issues: [] };
  }

  const errors = result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));

  return {
    valid: false,
    sanitizedData: stripInternal(data), // fallback: strip but flag invalid
    issues: [{ file: filePath, layer, errors }],
  };
}

/**
 * Select the appropriate Zod schema based on file path and layer.
 *
 * [R1 Fix: MISS-6/7/8] Added schemas for scenarios, personas, crawl patterns,
 * widget configs, domain vocabulary, facts, workflow versions, and canonical schemas.
 */
function getSchemaForFile(filePath: string, layer: LayerName): z.ZodTypeAny | null {
  // Connection layer
  if (filePath.endsWith('.connection.json')) return ImportedConnectionSchema;
  if (filePath.endsWith('.connector-config.json')) return ImportedConnectorConfigSchema;

  // Guardrails
  if (filePath.endsWith('.guardrail.json')) return ImportedGuardrailSchema;

  // Workflows
  if (filePath.endsWith('.workflow.json')) return ImportedWorkflowSchema;
  if (filePath.endsWith('.version.json')) return ImportedWorkflowVersionSchema;

  // Evals
  if (filePath.includes('eval-set.json')) return ImportedEvalSetSchema;
  if (filePath.endsWith('.evaluator.json')) return ImportedEvaluatorSchema;
  if (filePath.endsWith('.scenario.json')) return ImportedEvalScenarioSchema;
  if (filePath.endsWith('.persona.json')) return ImportedEvalPersonaSchema;

  // Search
  if (filePath.endsWith('.index.json')) return ImportedSearchIndexSchema;
  if (filePath.endsWith('.source.json')) return ImportedSearchSourceSchema;
  if (filePath.endsWith('.kb.json')) return ImportedKnowledgeBaseSchema;
  if (filePath === 'search/crawl-patterns.json') return z.array(ImportedCrawlPatternSchema);

  // Channels
  if (filePath.endsWith('.channel.json')) return ImportedChannelSchema;
  if (filePath.endsWith('.webhook.json')) return ImportedWebhookSchema;
  if (filePath === 'channels/widgets/widget-config.json') return ImportedWidgetConfigSchema;

  // Vocabulary
  if (filePath.endsWith('.lookup.json')) return ImportedLookupTableSchema;
  if (filePath.endsWith('.schema.json')) return ImportedCanonicalSchemaFile;
  if (filePath === 'vocabulary/domain-vocabulary.json')
    return z.array(ImportedDomainVocabularySchema);
  if (filePath === 'vocabulary/facts.json') return z.array(ImportedFactSchema);

  return null;
}
```

---

## 4.4 Security Hardening

### 4.4.1 Threat Model

| Threat               | Vector                                            | Impact                          | Existing Defense              | Gap                                                  |
| -------------------- | ------------------------------------------------- | ------------------------------- | ----------------------------- | ---------------------------------------------------- |
| SSRF                 | Imported webhook URLs, connector tenantUrls, tool | Internal network recon, data    | None                          | No URL validation on imported configs                |
|                      | DSL endpoint references                           | exfiltration                    |                               |                                                      |
| NoSQL Injection      | Crafted field names or values containing `$`      | Query manipulation, data leak   | None                          | Imported JSON inserted with `$`-prefixed keys        |
|                      | operators in imported JSON                        |                                 |                               |                                                      |
| Template Injection   | `{{env.X}}` patterns with payload content         | Env var leakage, code exec      | None                          | Imported DSL may contain malicious template patterns |
| Secret Leakage       | Exported file manually edited to include real     | Credential exposure in DB       | Export redacts secrets        | Import never checks for non-redacted secrets         |
|                      | credentials instead of `***REDACTED***`           |                                 |                               |                                                      |
| Path Traversal       | `../../../etc/passwd` in file keys                | File system read/write          | v1 checks `..`, `/`, `\0`     | v2 layer paths may bypass simpler checks             |
| Tenant Escape        | Crafted `tenantId`/`projectId` in imported JSON   | Cross-tenant data access        | Assembler strips `_id` etc.   | No verify on StagedRecords before insert             |
| DoS — Giant Payload  | Very large vocabulary or eval files               | Memory exhaustion, OOM          | 1MB per file, 50MB total (v1) | v2 layers may need different per-layer limits        |
| DoS — Import Flood   | Rapid concurrent import requests                  | Redis/MongoDB resource starving | Single project lock (v1)      | No per-tenant concurrency limit for v2               |
| Privilege Escalation | Import guardrails without `guardrail:write`       | Unauthorized config changes     | `project:import` check only   | No per-layer permission checks                       |
| Zip Bomb             | Compressed payload expands to huge size           | OOM crash                       | Body size limit               | No decompressed size limit if zip support is added   |

### 4.4.2 SSRF Protection

> **[R1 Fix: VULN-1]** Added dual-phase SSRF check. `checkSSRF()` performs static
> validation at parse time. `checkSSRFAtConnect()` re-validates by performing DNS
> resolution and checking the resolved IP against blocked ranges. This prevents DNS
> rebinding attacks where a hostname resolves to a public IP during validation but
> rebinds to `169.254.169.254` at actual request time.

```
File: packages/project-io/src/import/security/ssrf-validator.ts
```

```typescript
import { URL } from 'url';
import { isIP } from 'net';
import { lookup } from 'dns/promises';

// ── Blocked network ranges (RFC 1918, loopback, link-local, metadata) ──

const BLOCKED_IP_RANGES = [
  { start: '10.0.0.0', end: '10.255.255.255' }, // RFC 1918
  { start: '172.16.0.0', end: '172.31.255.255' }, // RFC 1918
  { start: '192.168.0.0', end: '192.168.255.255' }, // RFC 1918
  { start: '127.0.0.0', end: '127.255.255.255' }, // Loopback
  { start: '169.254.0.0', end: '169.254.255.255' }, // Link-local
  { start: '0.0.0.0', end: '0.255.255.255' }, // This network
] as const;

/** Cloud metadata endpoints that must always be blocked */
const BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.google',
  '169.254.169.254', // AWS/GCP/Azure metadata
  '100.100.100.200', // Alibaba Cloud metadata
  'fd00:ec2::254', // AWS IPv6 metadata
]);

/** Allowed URL schemes */
const ALLOWED_SCHEMES = new Set(['https:', 'http:', 'wss:', 'ws:']);

export interface SSRFCheckResult {
  safe: boolean;
  reason?: string;
  /** Resolved IP (populated by checkSSRFAtConnect, pinned for subsequent use) */
  resolvedIp?: string;
}

/**
 * Phase 1: Static URL validation at parse time.
 * Rejects internal IPs, cloud metadata endpoints, and non-HTTP schemes.
 * Does NOT resolve DNS — use checkSSRFAtConnect() for connection-time validation.
 */
export function checkSSRF(urlString: string): SSRFCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { safe: false, reason: 'Invalid URL format' };
  }

  // Scheme check
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return {
      safe: false,
      reason: `Disallowed URL scheme: ${parsed.protocol}`,
    };
  }

  // Hostname blocklist
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return {
      safe: false,
      reason: `Blocked hostname: ${hostname} (cloud metadata endpoint)`,
    };
  }

  // IP range check (if hostname is an IP literal)
  if (isIP(hostname)) {
    if (isBlockedIP(hostname)) {
      return {
        safe: false,
        reason: `Internal/private IP address: ${hostname}`,
      };
    }
  }

  // DNS rebinding defense: flag hostnames that resolve to common internal patterns
  // (actual DNS resolution happens at request time — this is a static heuristic)
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    return {
      safe: false,
      reason: `Hostname "${hostname}" may resolve to internal address`,
    };
  }

  return { safe: true };
}

/**
 * Phase 2: Connection-time SSRF check with DNS resolution.
 * [R1 Fix: VULN-1] Resolves the hostname to an IP and checks the resolved IP
 * against blocked ranges. This defeats DNS rebinding attacks where a hostname
 * initially resolves to a public IP but later rebinds to an internal address.
 *
 * Call this at the point where the URL is actually used for a network request
 * (e.g., webhook delivery, connector health check). The resolved IP should be
 * pinned and used for the actual TCP connection to prevent TOCTOU races.
 */
export async function checkSSRFAtConnect(urlString: string): Promise<SSRFCheckResult> {
  // Run static checks first
  const staticResult = checkSSRF(urlString);
  if (!staticResult.safe) return staticResult;

  const parsed = new URL(urlString);
  const hostname = parsed.hostname.toLowerCase();

  // If hostname is already an IP, the static check covered it
  if (isIP(hostname)) {
    return { safe: true, resolvedIp: hostname };
  }

  // Resolve DNS and check resolved IP
  try {
    const { address } = await lookup(hostname);

    if (isBlockedIP(address)) {
      return {
        safe: false,
        reason: `Hostname "${hostname}" resolved to blocked IP: ${address}`,
        resolvedIp: address,
      };
    }

    if (BLOCKED_HOSTNAMES.has(address)) {
      return {
        safe: false,
        reason: `Hostname "${hostname}" resolved to blocked address: ${address}`,
        resolvedIp: address,
      };
    }

    return { safe: true, resolvedIp: address };
  } catch {
    return {
      safe: false,
      reason: `DNS resolution failed for hostname: ${hostname}`,
    };
  }
}

function ipToLong(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function isBlockedIP(ip: string): boolean {
  const ipLong = ipToLong(ip);
  for (const range of BLOCKED_IP_RANGES) {
    const start = ipToLong(range.start);
    const end = ipToLong(range.end);
    if (ipLong >= start && ipLong <= end) return true;
  }
  return false;
}

/**
 * [R1 Fix: VULN-3] Maximum recursion depth for all scan functions.
 * Objects nested deeper than this are treated as a security finding
 * (potential DoS via stack overflow).
 */
const MAX_SCAN_DEPTH = 20;

/**
 * Scan all URL-bearing fields in imported data for SSRF risks.
 * Returns a list of unsafe URLs found.
 */
export function scanImportedDataForSSRF(
  files: Map<string, string>,
): Array<{ file: string; field: string; url: string; reason: string }> {
  const findings: Array<{
    file: string;
    field: string;
    url: string;
    reason: string;
  }> = [];

  const URL_FIELD_PATTERNS = [
    /url$/i,
    /endpoint$/i,
    /baseUrl$/i,
    /tenantUrl$/i,
    /webhookUrl$/i,
    /callbackUrl$/i,
    /redirectUri$/i,
  ];

  for (const [filePath, content] of files) {
    if (!filePath.endsWith('.json')) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content);
    } catch {
      continue;
    }

    scanObject(parsed, filePath, '', URL_FIELD_PATTERNS, findings, 0);
  }

  return findings;
}

function scanObject(
  obj: unknown,
  filePath: string,
  pathPrefix: string,
  patterns: RegExp[],
  findings: Array<{
    file: string;
    field: string;
    url: string;
    reason: string;
  }>,
  depth: number,
): void {
  if (!obj || typeof obj !== 'object') return;

  // [R1 Fix: VULN-3] Prevent stack overflow from deeply nested objects
  if (depth >= MAX_SCAN_DEPTH) {
    findings.push({
      file: filePath,
      field: pathPrefix,
      url: '',
      reason: `Object nesting exceeds maximum depth (${MAX_SCAN_DEPTH}) — potential DoS payload`,
    });
    return;
  }

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const fieldPath = pathPrefix ? `${pathPrefix}.${key}` : key;

    if (typeof value === 'string' && patterns.some((p) => p.test(key))) {
      const result = checkSSRF(value);
      if (!result.safe) {
        findings.push({
          file: filePath,
          field: fieldPath,
          url: value,
          reason: result.reason ?? 'Unknown',
        });
      }
    }

    if (typeof value === 'object' && value !== null) {
      scanObject(value, filePath, fieldPath, patterns, findings, depth + 1);
    }
  }
}
```

### 4.4.3 Injection Prevention

```
File: packages/project-io/src/import/security/injection-guard.ts
```

```typescript
/**
 * Scan imported JSON for MongoDB operator injection.
 * Rejects keys starting with $ which could manipulate queries.
 *
 * [R1 Fix: VULN-3] Added depth parameter to prevent stack overflow
 * from deeply nested malicious payloads.
 */
export function scanForInjection(
  data: Record<string, unknown>,
  path: string = '',
  depth: number = 0,
): Array<{ path: string; key: string; type: 'mongo_operator' | 'prototype' | 'excessive_depth' }> {
  const findings: Array<{
    path: string;
    key: string;
    type: 'mongo_operator' | 'prototype' | 'excessive_depth';
  }> = [];

  // [R1 Fix: VULN-3] Prevent stack overflow from deeply nested objects
  if (depth >= MAX_SCAN_DEPTH) {
    findings.push({
      path,
      key: '<root>',
      type: 'excessive_depth',
    });
    return findings;
  }

  for (const [key, value] of Object.entries(data)) {
    const currentPath = path ? `${path}.${key}` : key;

    // MongoDB operator injection: $set, $where, $gt, etc.
    if (key.startsWith('$')) {
      findings.push({
        path: currentPath,
        key,
        type: 'mongo_operator',
      });
    }

    // Prototype pollution: __proto__, constructor, prototype
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      findings.push({
        path: currentPath,
        key,
        type: 'prototype',
      });
    }

    // Recurse into nested objects
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      findings.push(...scanForInjection(value as Record<string, unknown>, currentPath, depth + 1));
    }

    // Recurse into arrays
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (value[i] && typeof value[i] === 'object') {
          findings.push(
            ...scanForInjection(
              value[i] as Record<string, unknown>,
              `${currentPath}[${i}]`,
              depth + 1,
            ),
          );
        }
      }
    }
  }

  return findings;
}

/**
 * Remove dangerous keys from an object tree (defense in depth).
 * Used after scanForInjection to sanitize data even if scan was skipped.
 *
 * [R1 Fix: VULN-3] Added depth parameter with MAX_SCAN_DEPTH limit.
 */
export function sanitizeImportedData(
  data: Record<string, unknown>,
  depth: number = 0,
): Record<string, unknown> {
  if (depth >= MAX_SCAN_DEPTH) return {}; // Truncate excessively deep objects

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    // Skip dangerous keys
    if (
      key.startsWith('$') ||
      key === '__proto__' ||
      key === 'constructor' ||
      key === 'prototype'
    ) {
      continue;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = sanitizeImportedData(value as Record<string, unknown>, depth + 1);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? sanitizeImportedData(item as Record<string, unknown>, depth + 1)
          : item,
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}
```

### 4.4.4 Secret Leakage Detection

```
File: packages/project-io/src/import/security/secret-detector.ts
```

```typescript
/**
 * Patterns that indicate a value may be a real credential rather than
 * a redacted placeholder. These catch common secret formats.
 */
const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  // AWS keys
  { name: 'AWS Access Key', pattern: /^AKIA[0-9A-Z]{16}$/ },
  {
    name: 'AWS Secret Key',
    pattern: /^[A-Za-z0-9/+=]{40}$/,
  },
  // JWT tokens
  { name: 'JWT Token', pattern: /^eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
  // GitHub tokens
  { name: 'GitHub Token', pattern: /^gh[ps]_[A-Za-z0-9_]{36,}$/ },
  // Generic API key patterns
  { name: 'API Key (long hex)', pattern: /^[a-f0-9]{32,}$/i },
  // Bearer-style tokens
  {
    name: 'Bearer Token',
    pattern: /^Bearer\s+[A-Za-z0-9._~+/=-]{20,}$/,
  },
  // Private key headers
  { name: 'Private Key', pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE KEY-----/ },
  // Base64-encoded blocks that look like credentials (>40 chars, mostly alphanumeric)
  {
    name: 'Base64 Credential',
    pattern: /^[A-Za-z0-9+/]{40,}={0,2}$/,
  },
];

/** Fields whose values should be checked for secret content */
const SECRET_FIELD_PATTERNS = [
  /secret/i,
  /password/i,
  /token/i,
  /key(?!board|word|stone)/i,
  /credential/i,
  /apiKey/i,
  /authToken/i,
  /accessToken/i,
  /refreshToken/i,
  /clientSecret/i,
  /privateKey/i,
  /encryptedCredentials/i,
];

export interface DetectedSecret {
  file: string;
  field: string;
  patternName: string;
  /** First 8 chars only — never log full secret */
  preview: string;
}

/**
 * Scan imported files for values that appear to be real credentials.
 * Returns findings with truncated previews (never logs full secrets).
 */
export function detectLeakedSecrets(files: Map<string, string>): DetectedSecret[] {
  const findings: DetectedSecret[] = [];

  for (const [filePath, content] of files) {
    if (!filePath.endsWith('.json')) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content);
    } catch {
      continue;
    }

    scanForSecrets(parsed, filePath, '', findings, 0);
  }

  return findings;
}

/**
 * [R1 Fix: VULN-3] Added depth parameter with MAX_SCAN_DEPTH limit to prevent
 * stack overflow from deeply nested malicious payloads.
 */
function scanForSecrets(
  obj: unknown,
  filePath: string,
  pathPrefix: string,
  findings: DetectedSecret[],
  depth: number,
): void {
  if (!obj || typeof obj !== 'object') return;

  // [R1 Fix: VULN-3] Depth limit
  if (depth >= MAX_SCAN_DEPTH) return;

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const fieldPath = pathPrefix ? `${pathPrefix}.${key}` : key;

    if (typeof value === 'string' && value !== '***REDACTED***') {
      // Check if field name suggests it holds a secret
      const isSecretField = SECRET_FIELD_PATTERNS.some((p) => p.test(key));

      if (isSecretField) {
        // Check if value looks like a real credential
        for (const { name, pattern } of SECRET_PATTERNS) {
          if (pattern.test(value)) {
            findings.push({
              file: filePath,
              field: fieldPath,
              patternName: name,
              preview: value.slice(0, 8) + '...',
            });
            break; // One match per field is sufficient
          }
        }
      }
    }

    if (typeof value === 'object' && value !== null) {
      scanForSecrets(value, filePath, fieldPath, findings, depth + 1);
    }
  }
}
```

### 4.4.5 Extended Path Traversal Checks for v2

The existing v1 checks in `validateImportPayload` reject `..`, leading `/`, null bytes,
and backslashes. For v2, extend this with layer-aware path validation:

```typescript
/**
 * V2 path validation — ensures file paths stay within their declared layer.
 *
 * Valid patterns:
 *   agents/supervisor.agent.abl
 *   connections/connectors/sharepoint.connection.json
 *   guardrails/pii-filter.guardrail.json
 *
 * Rejected:
 *   ../../etc/passwd
 *   connections/../agents/evil.agent.abl  (cross-layer escape)
 *   /absolute/path.json
 */
export function validateV2FilePath(
  filePath: string,
  declaredLayers: string[],
): { valid: boolean; error?: string } {
  // Existing v1 checks
  if (
    filePath.includes('..') ||
    filePath.startsWith('/') ||
    filePath.includes('\0') ||
    filePath.includes('\\')
  ) {
    return { valid: false, error: `Path traversal detected: ${filePath}` };
  }

  // Depth limit — no path should need more than 5 segments
  const segments = filePath.split('/');
  if (segments.length > 6) {
    return {
      valid: false,
      error: `Path too deep (${segments.length} segments): ${filePath}`,
    };
  }

  // Character allowlist — only alphanumeric, hyphens, underscores, dots, slashes
  if (!/^[a-zA-Z0-9_.\-/]+$/.test(filePath)) {
    return {
      valid: false,
      error: `Path contains disallowed characters: ${filePath}`,
    };
  }

  // Layer containment — top-level directory must be a known layer folder
  // or a known root file (project.json, abl.lock)
  // [R1 Fix: MIN-1] Added 'environment' and 'locales' folders (recognized by readFolderV2).
  // [R1 Fix: MIN-2] Changed 'lockfile.json' to 'abl.lock' to match actual filename
  // (confirmed in folder-reader.ts line 75).
  const ROOT_FILES = new Set(['project.json', 'abl.lock']);
  const LAYER_FOLDERS = new Set([
    'agents',
    'tools',
    'config',
    'core',
    'connections',
    'guardrails',
    'workflows',
    'evals',
    'search',
    'channels',
    'vocabulary',
    'behavior_profiles',
    'deployments',
    'environment',
    'locales',
  ]);

  const topLevel = segments[0];
  if (!ROOT_FILES.has(filePath) && !LAYER_FOLDERS.has(topLevel)) {
    return {
      valid: false,
      error: `Unknown layer folder: ${topLevel} in path ${filePath}`,
    };
  }

  return { valid: true };
}
```

### 4.4.6 Per-Layer File Size Limits

```typescript
/**
 * Per-layer file size limits. Some layers naturally have larger files
 * (vocabulary with 10K entries) while others should always be small.
 */
export const LAYER_FILE_SIZE_LIMITS: Record<string, number> = {
  // Core DSL files — should be compact
  agents: 512 * 1024, // 512KB
  tools: 512 * 1024,
  behavior_profiles: 256 * 1024,
  config: 256 * 1024,

  // JSON config layers
  connections: 256 * 1024,
  guardrails: 256 * 1024,
  workflows: 1024 * 1024, // 1MB — workflow definitions can be large
  evals: 2 * 1024 * 1024, // 2MB — eval scenarios can be extensive
  search: 512 * 1024,
  channels: 256 * 1024,

  // Vocabulary can be large (lookup tables)
  vocabulary: 5 * 1024 * 1024, // 5MB

  // Root files
  // [R1 Fix: MIN-2] Actual lockfile is named 'abl.lock' not 'lockfile.json'
  'project.json': 64 * 1024,
  'abl.lock': 256 * 1024,
};

/** Overall v2 import limits */
export const V2_IMPORT_LIMITS = {
  /** Maximum total import payload size */
  maxTotalSize: 100 * 1024 * 1024, // 100MB (up from 50MB for v1)
  /** Maximum number of files in v2 import */
  maxFileCount: 2000, // Up from 500 for v1
  /** Maximum per-file size (fallback for unknown layers) */
  maxDefaultFileSize: 1024 * 1024, // 1MB
};
```

### 4.4.7 Tenant Isolation Verification

> **[R1 Fix: VULN-4]** Changed tenant/project checks from truthy-then-compare
> (`if (data.tenantId && data.tenantId !== expected)`) to explicit presence-and-match
> (`if (!data.tenantId || data.tenantId !== expected)`). The original code silently
> passed records that were MISSING `tenantId`/`projectId` entirely, which could result
> in orphaned records visible to cross-tenant queries.

```typescript
/**
 * Verify all staged records have the correct tenantId and projectId
 * before they are written to the database.
 *
 * This is a defense-in-depth check — the records should already have
 * the correct values from the import pipeline, but this catches any
 * bugs that might set them incorrectly.
 */
export function verifyTenantIsolation(
  records: StagedRecord[],
  expectedTenantId: string,
  expectedProjectId: string,
): Array<{ collection: string; index: number; violation: string }> {
  const violations: Array<{
    collection: string;
    index: number;
    violation: string;
  }> = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const data = record.data;

    // [R1 Fix: VULN-4] Check tenantId is PRESENT AND matches.
    // Records without tenantId are violations (not silently passed).
    if (!data.tenantId || data.tenantId !== expectedTenantId) {
      violations.push({
        collection: record.collection,
        index: i,
        violation: data.tenantId
          ? `tenantId mismatch: expected ${expectedTenantId}, got ${String(data.tenantId)}`
          : `tenantId missing: expected ${expectedTenantId}`,
      });
    }

    // [R1 Fix: VULN-4] Check projectId is PRESENT AND matches.
    if (!data.projectId || data.projectId !== expectedProjectId) {
      violations.push({
        collection: record.collection,
        index: i,
        violation: data.projectId
          ? `projectId mismatch: expected ${expectedProjectId}, got ${String(data.projectId)}`
          : `projectId missing: expected ${expectedProjectId}`,
      });
    }

    // Check for smuggled _id (should never be present in import data)
    if (data._id) {
      violations.push({
        collection: record.collection,
        index: i,
        violation: `Smuggled _id detected: ${String(data._id)}`,
      });
    }
  }

  return violations;
}
```

### 4.4.8 Security Validation Pipeline

> **[R1 Fix: MAJ-6]** The security pipeline is split into two phases to resolve the
> contradictory execution order. Phase 1 (file-level scans) runs BEFORE disassembly
> on raw file content. Phase 2 (record-level checks) runs AFTER disassembly but
> BEFORE staging. This ensures malicious data is never written to the database.

All security checks run as a two-phase orchestrated pipeline during import:

```typescript
/**
 * Phase 1: File-level security scan.
 * Runs on raw files BEFORE disassembly. Catches SSRF, injection, secrets,
 * and path traversal issues before any database writes occur.
 */
export interface FileSecurityScanResult {
  safe: boolean;
  ssrfFindings: Array<{
    file: string;
    field: string;
    url: string;
    reason: string;
  }>;
  injectionFindings: Array<{
    path: string;
    key: string;
    type: string;
  }>;
  secretFindings: DetectedSecret[];
  pathViolations: Array<{ file: string; error: string }>;
}

export function runFileSecurityScan(
  files: Map<string, string>,
  declaredLayers: string[],
): FileSecurityScanResult {
  // 1. Path validation
  const pathViolations: Array<{ file: string; error: string }> = [];
  for (const filePath of files.keys()) {
    const result = validateV2FilePath(filePath, declaredLayers);
    if (!result.valid) {
      pathViolations.push({ file: filePath, error: result.error ?? '' });
    }
  }

  // 2. SSRF scan
  const ssrfFindings = scanImportedDataForSSRF(files);

  // 3. Injection scan (per JSON file)
  const injectionFindings: Array<{
    path: string;
    key: string;
    type: string;
  }> = [];
  for (const [filePath, content] of files) {
    if (!filePath.endsWith('.json') || filePath === 'abl.lock') continue;
    try {
      const parsed = JSON.parse(content);
      const findings = scanForInjection(parsed);
      for (const finding of findings) {
        injectionFindings.push({
          ...finding,
          path: `${filePath}:${finding.path}`,
        });
      }
    } catch {
      // Parse errors handled elsewhere
    }
  }

  // 4. Secret leakage detection
  const secretFindings = detectLeakedSecrets(files);

  const safe =
    pathViolations.length === 0 &&
    ssrfFindings.length === 0 &&
    injectionFindings.length === 0 &&
    secretFindings.length === 0;

  return {
    safe,
    ssrfFindings,
    injectionFindings,
    secretFindings,
    pathViolations,
  };
}

/**
 * Phase 2: Record-level security checks.
 * Runs AFTER disassembly but BEFORE staging. Verifies tenant isolation
 * on constructed records that are about to be written to MongoDB.
 */
export interface RecordSecurityScanResult {
  safe: boolean;
  tenantViolations: Array<{
    collection: string;
    index: number;
    violation: string;
  }>;
}

export function runRecordSecurityScan(
  stagedRecords: StagedRecord[],
  tenantId: string,
  projectId: string,
): RecordSecurityScanResult {
  const tenantViolations = verifyTenantIsolation(stagedRecords, tenantId, projectId);

  return {
    safe: tenantViolations.length === 0,
    tenantViolations,
  };
}

/**
 * Combined result type for the full security pipeline (both phases).
 */
export interface SecurityScanResult {
  safe: boolean;
  ssrfFindings: Array<{
    file: string;
    field: string;
    url: string;
    reason: string;
  }>;
  injectionFindings: Array<{
    path: string;
    key: string;
    type: string;
  }>;
  secretFindings: DetectedSecret[];
  pathViolations: Array<{ file: string; error: string }>;
  tenantViolations: Array<{
    collection: string;
    index: number;
    violation: string;
  }>;
}
```

**Execution order in the import pipeline:**

```
1. Parse files (JSON.parse)
2. runFileSecurityScan()          ← Phase 1: blocks if SSRF/injection/secrets/paths found
3. Disassemble (build StagedRecords from parsed data)
4. runRecordSecurityScan()        ← Phase 2: blocks if tenant isolation violations found
5. Stage (write StagedRecords to MongoDB)
6. Activate
```

---

## 4.5 Redacted Value Handling

### Problem

The `ConnectionsAssembler` replaces credential fields with `***REDACTED***` during
export (via the `stripSecrets` function and `CONNECTION_SECRET_KEYS` removal). On
import, these placeholders must be detected and handled — they must never be stored as
actual credential values.

### Design

```
File: packages/project-io/src/import/security/redacted-handler.ts
```

```typescript
const REDACTED_SENTINEL = '***REDACTED***';

export interface RedactedField {
  file: string;
  fieldPath: string;
  /** Whether the field is required for the connection to function */
  critical: boolean;
}

export interface RedactedScanResult {
  hasRedactedValues: boolean;
  fields: RedactedField[];
  /** User-facing summary message */
  summary: string;
}

/**
 * Detect all ***REDACTED*** values in imported connection files.
 * Returns field paths that the user needs to re-enter credentials for.
 */
export function detectRedactedValues(files: Map<string, string>): RedactedScanResult {
  const fields: RedactedField[] = [];

  for (const [filePath, content] of files) {
    if (!filePath.endsWith('.connection.json') && !filePath.endsWith('.connector-config.json')) {
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content);
    } catch {
      continue;
    }

    scanForRedacted(parsed, filePath, '', fields);
  }

  const hasRedactedValues = fields.length > 0;
  const summary = hasRedactedValues
    ? `${fields.length} credential field(s) contain redacted placeholders. ` +
      `After import, navigate to Settings > Connections to re-enter credentials.`
    : 'No redacted values detected.';

  return { hasRedactedValues, fields, summary };
}

/**
 * [R1 Fix: VULN-3] Added depth parameter with MAX_SCAN_DEPTH limit to prevent
 * stack overflow from deeply nested malicious payloads.
 */
function scanForRedacted(
  obj: unknown,
  filePath: string,
  pathPrefix: string,
  fields: RedactedField[],
  depth: number = 0,
): void {
  if (!obj || typeof obj !== 'object') return;

  // [R1 Fix: VULN-3] Depth limit
  if (depth >= MAX_SCAN_DEPTH) return;

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const fieldPath = pathPrefix ? `${pathPrefix}.${key}` : key;

    if (value === REDACTED_SENTINEL) {
      const critical = isCriticalCredentialField(key);
      fields.push({ file: filePath, fieldPath, critical });
    }

    if (typeof value === 'object' && value !== null) {
      scanForRedacted(value, filePath, fieldPath, fields, depth + 1);
    }
  }
}

/** Critical fields that, if redacted, prevent the connection from working */
const CRITICAL_CREDENTIAL_FIELDS = new Set([
  'clientSecret',
  'apiKey',
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'privateKey',
]);

function isCriticalCredentialField(fieldName: string): boolean {
  return CRITICAL_CREDENTIAL_FIELDS.has(fieldName);
}

/**
 * Sanitize redacted values before database insertion.
 * Replaces ***REDACTED*** with empty string and marks the connection
 * as needing credential setup.
 *
 * NEVER stores the literal sentinel in the database.
 */
export function sanitizeRedactedForStorage(data: Record<string, unknown>): {
  sanitized: Record<string, unknown>;
  needsCredentialSetup: boolean;
} {
  let needsCredentialSetup = false;
  const sanitized = deepReplace(data, REDACTED_SENTINEL, (fieldPath) => {
    needsCredentialSetup = true;
    return ''; // Empty string — will fail validation on use, forcing user setup
  });

  return { sanitized, needsCredentialSetup };
}

/**
 * [R3 Fix] R3-DEEPREPLACE-DEPTH: Added depth parameter with MAX_SCAN_DEPTH limit
 * to prevent stack overflow from deeply nested malicious `.connection.json` payloads.
 * Consistent with scanForInjection, scanForSecrets, scanForRedacted, and
 * sanitizeImportedData which all enforce the same depth limit.
 */
function deepReplace(
  obj: Record<string, unknown>,
  sentinel: string,
  replacer: (path: string) => unknown,
  pathPrefix: string = '',
  depth: number = 0,
): Record<string, unknown> {
  if (depth >= MAX_SCAN_DEPTH) return obj; // Return as-is beyond depth limit

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const fieldPath = pathPrefix ? `${pathPrefix}.${key}` : key;

    if (value === sentinel) {
      result[key] = replacer(fieldPath);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = deepReplace(
        value as Record<string, unknown>,
        sentinel,
        replacer,
        fieldPath,
        depth + 1,
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}
```

---

## 4.6 Import Audit Trail

### Design

```
File: packages/project-io/src/import/audit/import-audit.ts
```

#### Audit Event Schema

```typescript
export interface ImportAuditEvent {
  /** Unique event ID */
  eventId: string;
  /** Links to the import operation */
  importOperationId: string;
  /** Tenant scope */
  tenantId: string;
  /** Target project */
  projectId: string;
  /** User who triggered the import */
  userId: string;
  /** Event type */
  eventType: ImportAuditEventType;
  /** ISO timestamp */
  timestamp: string;
  /** Event-specific payload */
  details: Record<string, unknown>;
}

export type ImportAuditEventType =
  | 'import_started'
  | 'import_prerequisite_check'
  | 'import_security_scan'
  | 'import_layer_staged'
  | 'import_layer_activated'
  | 'import_entity_created'
  | 'import_entity_updated'
  | 'import_entity_deleted'
  | 'import_completed'
  | 'import_failed'
  | 'import_rolled_back';
```

#### Event Detail Schemas

```typescript
/** Details for import_started */
export interface ImportStartedDetails {
  /** Manifest format version */
  formatVersion: string;
  /** Layers requested for import */
  layers: string[];
  /** Total file count */
  fileCount: number;
  /** Total payload size in bytes */
  totalSizeBytes: number;
  /** Source manifest name */
  sourceProjectName: string;
  /** Whether this is a preview or full import */
  mode: 'preview' | 'apply';
}

/** Details for import_entity_created/updated/deleted */
export interface ImportEntityDetails {
  /** Entity type: agent, tool, connection, guardrail, etc. */
  entityType: string;
  /** Entity name (human-readable) */
  entityName: string;
  /** Entity ID in the database (after creation) */
  entityId?: string;
  /** Layer this entity belongs to */
  layer: string;
  /** For updates: what changed */
  changeType?: 'content' | 'config' | 'metadata';
}

/** Details for import_completed */
export interface ImportCompletedDetails {
  /** Duration in milliseconds */
  durationMs: number;
  /** Per-layer entity counts */
  entityCounts: Record<string, { created: number; updated: number; deleted: number }>;
  /** Number of prerequisite warnings */
  prerequisiteWarnings: number;
  /** Number of security findings (non-blocking) */
  securityWarnings: number;
  /** Redacted fields that need credential re-entry */
  redactedFieldCount: number;
}

/** Details for import_failed */
export interface ImportFailedDetails {
  /** Phase where failure occurred */
  failedPhase: string;
  /** Layer where failure occurred (if applicable) */
  failedLayer?: string;
  /** Error message */
  errorMessage: string;
  /** Error code */
  errorCode: string;
  /** Whether rollback was successful */
  rollbackSucceeded?: boolean;
}
```

#### Audit Logger

```typescript
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('import-audit');

export class ImportAuditLogger {
  private readonly operationId: string;
  private readonly tenantId: string;
  private readonly projectId: string;
  private readonly userId: string;
  private events: ImportAuditEvent[] = [];

  constructor(params: {
    operationId: string;
    tenantId: string;
    projectId: string;
    userId: string;
  }) {
    this.operationId = params.operationId;
    this.tenantId = params.tenantId;
    this.projectId = params.projectId;
    this.userId = params.userId;
  }

  emit(eventType: ImportAuditEventType, details: Record<string, unknown>): void {
    const event: ImportAuditEvent = {
      eventId: `${this.operationId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      importOperationId: this.operationId,
      tenantId: this.tenantId,
      projectId: this.projectId,
      userId: this.userId,
      eventType,
      timestamp: new Date().toISOString(),
      details,
    };

    this.events.push(event);

    // Structured log for observability pipeline
    log.info('Import audit event', {
      eventType,
      importOperationId: this.operationId,
      tenantId: this.tenantId,
      projectId: this.projectId,
      userId: this.userId,
      details,
    });
  }

  /** Return all collected events (for batch persistence) */
  getEvents(): ImportAuditEvent[] {
    return [...this.events];
  }
}
```

#### Audit Trail Storage

Audit events are persisted to the `import_audit_events` collection via a dedicated
model. Events are also emitted to the structured log (ingested by the observability
pipeline). The collection has a TTL index to auto-expire events after 90 days.

```typescript
// Mongoose schema sketch (to be added to packages/database)
const ImportAuditEventSchema = new Schema(
  {
    _id: { type: String, default: uuidv7 },
    importOperationId: { type: String, required: true, index: true },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    userId: { type: String, required: true },
    eventType: { type: String, required: true },
    details: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, collection: 'import_audit_events' },
);

// TTL index: auto-expire after 90 days
ImportAuditEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 86400 });
// Query by operation
ImportAuditEventSchema.index({ tenantId: 1, importOperationId: 1 });
// Query by project
ImportAuditEventSchema.index({ tenantId: 1, projectId: 1, eventType: 1 });
```

---

## 4.7 Rate Limiting for v2 Import

### Problem

v2 imports are substantially heavier than v1 (multi-layer, larger payloads, more DB
operations). The existing single-project lock prevents concurrent imports within one
project, but does not limit per-tenant concurrency or prevent import flooding across
projects.

### Design

Rate limiting for v2 operates at three levels:

#### Level 1: Per-Project Distributed Lock (existing, extended)

The current `acquireImportLock` in `project-io.ts` already prevents concurrent imports
within a single project using Redis `SET NX PX`. Extend for v2 with a longer TTL:

```typescript
// v2 imports take longer — extend the lock TTL
const V2_IMPORT_LOCK_TTL_SECONDS = 300; // 5 minutes (v1 is 2 minutes)
const V2_IMPORT_LOCK_PREFIX = 'import:v2:lock:';
```

#### Level 2: Per-Tenant Concurrent Import Limit

A tenant should not be able to run many v2 imports simultaneously across different
projects, as each import is a heavy multi-collection database operation.

```typescript
const TENANT_CONCURRENT_IMPORT_LIMIT = 3;
const TENANT_IMPORT_SET_PREFIX = 'import:v2:tenant:';
const TENANT_IMPORT_SET_TTL_SECONDS = 600; // 10 minutes safety

/**
 * Check and claim a tenant-level import slot.
 * Uses Redis SET (same pattern as session counting in rate-limiter.ts).
 *
 * Returns the import slot token if acquired, null if at limit.
 */
async function claimTenantImportSlot(tenantId: string, projectId: string): Promise<string | null> {
  const redis = getRedisClient();
  if (!redis) return `no-redis-${projectId}`; // Allow in dev

  const setKey = `${TENANT_IMPORT_SET_PREFIX}${tenantId}`;
  const slotToken = `${projectId}:${Date.now()}`;

  // Atomic check-and-add using the same Lua pattern as session slots
  const result = await redis.eval(
    LUA_CHECK_AND_ADD,
    1,
    setKey,
    slotToken,
    String(TENANT_CONCURRENT_IMPORT_LIMIT),
    String(TENANT_IMPORT_SET_TTL_SECONDS),
  );

  return result === -1 ? null : slotToken;
}

async function releaseTenantImportSlot(tenantId: string, slotToken: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis || slotToken.startsWith('no-redis-')) return;

  const setKey = `${TENANT_IMPORT_SET_PREFIX}${tenantId}`;
  await redis.eval(LUA_REMOVE_MEMBER, 1, setKey, slotToken);
}
```

#### Level 3: Cool-Down Period

Prevent rapid re-imports that could indicate abuse or scripting errors:

```typescript
const IMPORT_COOLDOWN_SECONDS = 30;
const IMPORT_COOLDOWN_PREFIX = 'import:v2:cooldown:';

/**
 * Check if a project is in the cool-down period after a recent import.
 * Returns remaining seconds if in cooldown, 0 if clear.
 */
async function checkImportCooldown(projectId: string): Promise<number> {
  const redis = getRedisClient();
  if (!redis) return 0;

  const key = `${IMPORT_COOLDOWN_PREFIX}${projectId}`;
  const ttl = await redis.ttl(key);
  return ttl > 0 ? ttl : 0;
}

/**
 * Set cooldown after a successful import completes.
 */
async function setImportCooldown(projectId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  const key = `${IMPORT_COOLDOWN_PREFIX}${projectId}`;
  await redis.set(key, '1', 'EX', IMPORT_COOLDOWN_SECONDS);
}
```

#### Route Integration

```typescript
// In the v2 import route handler — before any processing
const cooldownRemaining = await checkImportCooldown(projectId);
if (cooldownRemaining > 0) {
  res.status(429).json({
    success: false,
    error: {
      code: 'IMPORT_COOLDOWN',
      message: `Please wait ${cooldownRemaining} seconds before importing again`,
    },
    retryAfterSeconds: cooldownRemaining,
  });
  return;
}

const tenantSlot = await claimTenantImportSlot(tenantId, projectId);
if (!tenantSlot) {
  res.status(429).json({
    success: false,
    error: {
      code: 'TENANT_IMPORT_LIMIT',
      message: `Too many concurrent imports for this organization (max ${TENANT_CONCURRENT_IMPORT_LIMIT})`,
    },
  });
  return;
}

const projectLock = await acquireImportLockV2(projectId);
if (!projectLock) {
  await releaseTenantImportSlot(tenantId, tenantSlot);
  res.status(409).json({
    success: false,
    error: {
      code: 'IMPORT_IN_PROGRESS',
      message: 'Another import is in progress for this project',
    },
  });
  return;
}

try {
  // ... import logic ...
  await setImportCooldown(projectId);
} finally {
  await releaseImportLockV2(projectId, projectLock);
  await releaseTenantImportSlot(tenantId, tenantSlot);
}
```

---

## 4.8 Security Checklist

Every v2 import must pass ALL of the following before any data is staged:

| #   | Check                      | Module                          | Blocks Import | Error Code                |
| --- | -------------------------- | ------------------------------- | ------------- | ------------------------- |
| 1   | Authentication             | `authMiddleware`                | Yes           | 401                       |
| 2   | Project scope              | `requireProjectScope`           | Yes           | 403                       |
| 3   | Base permission            | `requireProjectPermission`      | Yes           | 403                       |
| 4   | Content-Length guard       | `rejectOversizedContentLength`  | Yes           | 413                       |
| 5   | JSON parse                 | `importBodyParser`              | Yes           | 400                       |
| 6   | File count limit           | `validateImportPayload`         | Yes           | 400                       |
| 7   | Path traversal (v2)        | `validateV2FilePath`            | Yes           | 400                       |
| 8   | Per-file + per-layer size  | `LAYER_FILE_SIZE_LIMITS`        | Yes           | 400                       |
| 9   | Total size limit           | `V2_IMPORT_LIMITS`              | Yes           | 400                       |
| 10  | Rate limit (tenant)        | `tenantRateLimit`               | Yes           | 429                       |
| 11  | Cool-down period           | `checkImportCooldown`           | Yes           | 429 IMPORT_COOLDOWN       |
| 12  | Tenant concurrent limit    | `claimTenantImportSlot`         | Yes           | 429 TENANT_IMPORT_LIMIT   |
| 13  | Project lock               | `acquireImportLockV2`           | Yes           | 409 IMPORT_IN_PROGRESS    |
| 14  | Manifest schema validation | `validateManifestV2`            | Yes           | 422                       |
| 15  | SHA integrity              | `verifySHAIntegrity`            | Warns         | (warnings in response)    |
| 16  | SSRF scan (Phase 1)        | `runFileSecurityScan`           | Yes           | 422 SSRF_DETECTED         |
| 17  | Injection scan (Phase 1)   | `runFileSecurityScan`           | Yes           | 422 INJECTION_DETECTED    |
| 18  | Secret leakage (Phase 1)   | `runFileSecurityScan`           | Warns         | (warnings in response)    |
| 19  | Entity schema validation   | `validateEntitySchema`          | Yes           | 422 SCHEMA_INVALID        |
| 20  | Prerequisite check         | `validateImportPrerequisites`   | Blocking only | 422 PREREQUISITES_NOT_MET |
| 21  | Per-layer permissions      | (within prerequisite validator) | Yes           | 403                       |
| 22  | Auth profile resolution    | `resolveAuthProfiles`           | Warns         | (unresolved in response)  |
| 23  | Redacted value detection   | `detectRedactedValues`          | Warns         | (warnings in response)    |
| 24  | Tenant isolation (Phase 2) | `runRecordSecurityScan`         | Yes           | 500 ISOLATION_VIOLATION   |
| 25  | Cross-layer deps           | `validateCrossLayerDeps`        | Warns         | (warnings in response)    |

---

## 4.9 Implementation Order

| Phase | Task                                       | Priority | Estimated Effort |
| ----- | ------------------------------------------ | -------- | ---------------- |
| 1     | Per-entity Zod schemas + validation runner | P0       | 2 days           |
| 2     | Security pipeline (SSRF, injection, paths) | P0       | 2 days           |
| 3     | Redacted value handling                    | P0       | 1 day            |
| 4     | Prerequisite validator                     | P0       | 1.5 days         |
| 5     | Auth profile resolver                      | P1       | 2 days           |
| 6     | Tenant isolation verification              | P0       | 0.5 day          |
| 7     | Per-layer permission checks                | P1       | 1 day            |
| 8     | Rate limiting (tenant + cooldown)          | P1       | 1 day            |
| 9     | Audit trail logger + model                 | P2       | 1.5 days         |
| 10    | Secret leakage detection                   | P2       | 1 day            |
| 11    | Integration tests for full pipeline        | P0       | 2 days           |

**Total estimated effort: ~15.5 days**

---

## 4.10 File Layout

```
packages/project-io/src/import/
  prerequisite-validator.ts        # Section 4.1
  auth-profile-resolver.ts         # Section 4.2
  layer-schemas.ts                 # Section 4.3
  security/
    ssrf-validator.ts              # Section 4.4.2
    injection-guard.ts             # Section 4.4.3
    secret-detector.ts             # Section 4.4.4
    path-validator.ts              # Section 4.4.5
    size-limits.ts                 # Section 4.4.6
    tenant-isolation.ts            # Section 4.4.7
    security-pipeline.ts           # Section 4.4.8
    redacted-handler.ts            # Section 4.5
  audit/
    import-audit.ts                # Section 4.6
  rate-limiting/
    import-rate-limiter.ts         # Section 4.7

packages/database/src/models/
  import-audit-event.model.ts      # Section 4.6 storage

apps/runtime/src/routes/
  project-io-v2.ts                 # Route integration
```
