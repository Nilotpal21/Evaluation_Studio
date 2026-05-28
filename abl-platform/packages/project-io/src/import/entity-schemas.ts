/**
 * Entity validation schemas for imported JSON entities.
 *
 * Each schema uses `.strip()` to silently remove unknown fields (never `.passthrough()`).
 * Internal ownership fields are stripped via a transform to prevent injection of
 * tenant/project scoping fields. A few entity-specific schemas (for example guardrails)
 * preserve real exported status/version fields when those are part of the public bundle.
 *
 * Schemas are cross-referenced against actual assembler output (ConnectionsAssembler,
 * GuardrailsAssembler, WorkflowsAssembler, etc.) to match real exported field names.
 */

import { z } from 'zod';
import { AGENT_NAME_MAX_LENGTH, AGENT_NAME_PATTERN } from '@agent-platform/shared';
import {
  normalizeMcpServerConfigForIO,
  projectIOMcpServerConfigSchema,
} from '../mcp-server-config-io.js';
import { isGuardrailArchivePath } from '../guardrail-projection.js';

// ── Known temp fields set by disassemblers for cross-ref resolution ──
// These are the ONLY _-prefixed fields preserved through schema validation.
// Must stay in sync with KNOWN_TEMP_FIELDS in cross-ref-resolver.ts.

const KNOWN_TEMP_FIELDS = new Set([
  '_workflowName',
  '_indexSlug',
  '_channelDisplayName',
  '_channelAgentName',
  '_guardrailAgentName',
  '_searchAiIndexExportedId',
  '_parentSetName',
  '_nestedScenarioNames',
  '_nestedPersonaNames',
  '_nestedEvaluatorNames',
  '_vocabularyKnowledgeBaseId',
  '_schemaKnowledgeBaseId',
  '_connectorConfigSourceId',
  '_exportedId',
  '_workflowVersion',
  '_workflowToolExportedWorkflowId',
  '_workflowToolExportedTriggerId',
]);

// ── Internal field stripping (applied to all entities) ──

const INTERNAL_FIELDS = [
  '_id',
  'id',
  '__v',
  '_v',
  'tenantId',
  'projectId',
  'createdBy',
  'updatedBy',
  'modifiedBy',
  'ownerId',
  'ownerTeamId',
  'lastEditedBy',
  'createdAt',
  'updatedAt',
  'status',
] as const;

function stripFields(
  data: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const result = { ...data };
  for (const field of fields) {
    delete result[field];
  }
  return result;
}

function stripInternal(data: Record<string, unknown>): Record<string, unknown> {
  return stripFields(data, INTERNAL_FIELDS);
}

const GUARDRAIL_INTERNAL_FIELDS = INTERNAL_FIELDS.filter((field) => field !== 'status');

function stripGuardrailInternal(data: Record<string, unknown>): Record<string, unknown> {
  return stripFields(data, GUARDRAIL_INTERNAL_FIELDS);
}

// ── Connections ──
// Source: ConnectionsAssembler — ConnectorConnection.find().lean(), then stripInternalFields
// with additional keys: encryptedCredentials, encryptionKeyVersion, oauth2RefreshToken, authProfileId

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

export const ImportedConnectorConfigSchema = z
  .object({
    sourceId: z.string().max(255).optional(),
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
// Actual exported fields mirror GuardrailPolicy documents plus an import/export-only
// `scope.agentName` anchor used to remap agent-scoped policies across projects.

const guardrailScopeSchema = z
  .object({
    type: z.enum(['project', 'agent']).optional(),
    projectId: z.string().optional(),
    agentDefId: z.string().optional(),
    agentId: z.string().optional(),
    agentName: z.string().min(1).max(255).optional(),
  })
  .strip();

const guardrailProviderOverrideSchema = z
  .object({
    providerName: z.string().min(1).max(255),
    endpoint: z.string().max(2048).optional(),
    apiKeyCredentialId: z.never().optional(),
    authProfileId: z.never().optional(),
    defaultCategory: z.string().max(255).optional(),
    defaultThreshold: z.number().min(0).max(1).optional(),
    circuitBreaker: z.record(z.unknown()).optional(),
    retry: z.record(z.unknown()).optional(),
    costPerEvalUsd: z.number().min(0).optional(),
    isActive: z.boolean().optional(),
  })
  .strip();

const guardrailRuleSchema = z
  .object({
    guardrailName: z.string().min(1).max(255),
    override: z.enum(['disable', 'threshold', 'action', 'severity_actions', 'define']),
    threshold: z.number().min(0).max(1).optional(),
    action: z.record(z.unknown()).optional(),
    severityActions: z.record(z.unknown()).optional(),
    kind: z.enum(['input', 'output', 'tool_input', 'tool_output', 'handoff']).optional(),
    tier: z.enum(['local', 'model', 'llm']).optional(),
    provider: z.string().max(255).optional(),
    category: z.string().max(255).optional(),
    check: z.string().max(255).optional(),
    llmCheck: z.string().max(255).optional(),
    description: z.string().max(5000).optional(),
    priority: z.number().int().optional(),
    message: z.string().max(5000).optional(),
  })
  .strip();

const guardrailConstitutionSchema = z
  .object({
    principle: z.string().min(1).max(5000),
    weight: z.number(),
    examples: z.array(z.string().max(5000)).max(100).optional(),
  })
  .strip();

const guardrailStreamingSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    defaultInterval: z.enum(['token', 'sentence', 'chunk_size']).optional(),
    chunkSize: z.number().int().positive().optional(),
    maxLatencyMs: z.number().int().positive().optional(),
    earlyTermination: z.boolean().optional(),
  })
  .strip();

const guardrailSettingsSchema = z
  .object({
    failMode: z.enum(['open', 'closed']).optional(),
    timeouts: z
      .object({
        local: z.number().int().positive(),
        model: z.number().int().positive(),
        llm: z.number().int().positive(),
      })
      .strip()
      .optional(),
    webhookUrl: z.string().max(2048).optional(),
    webhookSecret: z.string().max(4096).optional(),
    streaming: guardrailStreamingSettingsSchema.optional(),
  })
  .strip();

const guardrailCachingSchema = z
  .object({
    enabled: z.boolean().optional(),
    exactMatch: z.boolean().optional(),
    semanticMatch: z.boolean().optional(),
    semanticThreshold: z.number().optional(),
    defaultTtlSeconds: z.number().int().optional(),
  })
  .strip();

const guardrailBudgetSchema = z
  .object({
    monthlyLimitUsd: z.number().positive().optional(),
    currentSpendUsd: z.number().min(0).optional(),
    overspendAction: z.enum(['downgrade', 'disable_model_checks', 'alert_only']).optional(),
  })
  .strip();

function hasGuardrailOperationalControls(data: Record<string, unknown>): boolean {
  const settings =
    data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings)
      ? (data.settings as Record<string, unknown>)
      : undefined;

  return (
    data.caching !== undefined ||
    data.budget !== undefined ||
    settings?.webhookUrl !== undefined ||
    settings?.webhookSecret !== undefined
  );
}

function validateGuardrailOperationalControlScope(
  data: Record<string, unknown>,
  ctx: z.RefinementCtx,
): void {
  const scope =
    data.scope && typeof data.scope === 'object' && !Array.isArray(data.scope)
      ? (data.scope as Record<string, unknown>)
      : undefined;

  if (hasGuardrailOperationalControls(data) && scope?.type !== 'project') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scope'],
      message: 'caching, budget, and webhook settings require project-scoped guardrail policies',
    });
  }
}

function normalizeGuardrailScope(
  scope: z.input<typeof guardrailScopeSchema> | undefined,
  options: { preserveAgentName: boolean },
): Record<string, unknown> | undefined {
  if (!scope) return undefined;

  const normalized = { ...scope } as Record<string, unknown>;
  const canonicalAgentDefId = normalized['agentDefId'];
  const legacyAgentId = normalized['agentId'];

  if (typeof canonicalAgentDefId !== 'string' && typeof legacyAgentId === 'string') {
    normalized['agentDefId'] = legacyAgentId;
  }

  delete normalized['agentId'];

  if (!options.preserveAgentName) {
    delete normalized['agentName'];
  }

  return normalized;
}

function normalizeGuardrailData(
  data: Record<string, unknown>,
  options: { preserveAgentName: boolean },
): Record<string, unknown> {
  const normalized = { ...data };

  if (typeof normalized['enabled'] === 'boolean' && typeof normalized['isActive'] !== 'boolean') {
    normalized['isActive'] = normalized['enabled'];
  }

  delete normalized['enabled'];

  const scopeInput = normalized['scope'];
  if (scopeInput && typeof scopeInput === 'object' && !Array.isArray(scopeInput)) {
    normalized['scope'] = normalizeGuardrailScope(
      scopeInput as z.input<typeof guardrailScopeSchema>,
      options,
    );
  }

  return normalized;
}

const guardrailImportObjectBaseSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(2000).optional(),
    enabled: z.boolean().optional(),
    scope: guardrailScopeSchema.optional(),
    providerOverrides: z.array(guardrailProviderOverrideSchema).max(500).optional(),
    rules: z.array(guardrailRuleSchema).max(5000).optional(),
    constitution: z.array(guardrailConstitutionSchema).max(500).optional(),
    settings: guardrailSettingsSchema.optional(),
    caching: guardrailCachingSchema.optional(),
    budget: guardrailBudgetSchema.optional(),
    version: z.number().int().optional(),
    previousVersionId: z.string().max(255).optional(),
    changelog: z.string().max(5000).optional(),
    status: z.enum(['draft', 'active', 'archived']).optional(),
    isActive: z.boolean().optional(),
    _v: z.number().int().optional(),
  })
  .strip();

const guardrailImportObjectSchema = guardrailImportObjectBaseSchema.superRefine(
  validateGuardrailOperationalControlScope,
);

export const ImportedGuardrailSchema = guardrailImportObjectSchema.transform((data) =>
  stripGuardrailInternal(normalizeGuardrailData(data, { preserveAgentName: true })),
);

// ── Workflows ──
// Source: WorkflowsAssembler — Workflow.find().lean().select(
//   'name type description steps triggers slaMinutes escalationRules notificationRules status')

export const ImportedWorkflowSchema = z
  .object({
    name: z.string().min(1).max(255),
    type: z.string().max(100).optional(),
    description: z.string().max(2000).nullable().optional(),
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

export const ImportedEvalSetSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(2000).optional(),
    personaIds: z.array(z.string()).max(500).optional(),
    scenarioIds: z.array(z.string()).max(500).optional(),
    evaluatorIds: z.array(z.string()).max(100).optional(),
    variants: z.number().int().min(0).optional(),
    maxConcurrency: z.number().int().min(1).max(100).optional(),
    regressionThreshold: z.number().min(0).max(1).optional(),
    ciEnabled: z.boolean().optional(),
    personaModel: z.string().max(255).nullable().optional(),
    personaModelConfig: z.record(z.unknown()).optional(),
    createdBy: z.string().max(255).optional(),
  })
  .strip()
  .transform(stripInternal);

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
    expectedMilestones: z.array(z.string().max(1000)).max(100).optional(),
    maxToolCalls: z.number().int().min(0).max(10000).optional(),
    version: z.number().int().optional(),
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
    goals: z.string().max(5000).optional(),
    constraints: z.string().max(5000).optional(),
    sessionVariables: z.record(z.unknown()).optional(),
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

// Source: SearchAssembler — KnowledgeBase.find().lean()

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

// Source: SearchAssembler — CrawlPattern.find().lean()

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
    confidence: z.number().min(0).max(100).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strip()
  .transform(stripInternal);

// ── Channels ──
// Source: ChannelsAssembler — ChannelConnection.find().lean().select(
//   'channelType externalIdentifier displayName agentId deploymentId environment config status')

export const ImportedChannelSchema = z
  .object({
    channelType: z.string().min(1).max(100),
    externalIdentifier: z.string().max(500).optional(),
    displayName: z.string().min(1).max(255),
    agentId: z.string().max(255).optional(),
    deploymentId: z.string().max(255).optional(),
    environment: z.string().max(100).nullable().optional(),
    config: z.record(z.unknown()).optional(),
    status: z.string().max(50).optional(),
  })
  .strip()
  .transform(stripInternal);

// Source: ChannelsAssembler — WebhookSubscription.find().lean()

export const ImportedWebhookSchema = z
  .object({
    channelConnectionId: z.string().max(255).optional(),
    callbackUrl: z.string().url().max(2048),
    events: z.array(z.string().max(255)).max(100).optional(),
    description: z.string().max(2000).optional(),
  })
  .strip()
  .transform(stripInternal);

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

// Source: VocabularyAssembler — CanonicalSchema.find().lean()

export const ImportedCanonicalSchemaFile = z
  .object({
    knowledgeBaseId: z.string().max(255).optional(),
    version: z.number().int().min(0).optional(),
    fields: z.array(z.record(z.unknown())).max(500).optional(),
  })
  .strip()
  .transform(stripInternal);

// Source: VocabularyAssembler — DomainVocabulary.find().lean()

export const ImportedDomainVocabularySchema = z
  .object({
    projectKnowledgeBaseId: z.string().max(255).optional(),
    version: z.number().int().min(0).optional(),
    entries: z.array(z.record(z.unknown())).max(50000).optional(),
  })
  .strip()
  .transform(stripInternal);

// Source: VocabularyAssembler — Fact.find().lean()

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

// ── Core Layer Record Schemas ──
// These validate record shape and ownership fields for core layer entities
// (agents, tools) before insertion via StagedImporter.

export const agentRecordSchema = z
  .object({
    name: z.string().min(1).max(AGENT_NAME_MAX_LENGTH).regex(AGENT_NAME_PATTERN),
    description: z.string().max(5000).nullable().optional(),
    dslContent: z.string().min(1).max(500_000),
    dslValidationStatus: z.enum(['valid', 'invalid', 'unknown']).optional(),
    dslDiagnostics: z.array(z.unknown()).optional(),
    systemPromptLibraryRef: z
      .object({
        promptId: z.string().min(1),
        versionId: z.string().min(1),
        resolvedHash: z.string().min(1).optional(),
      })
      .nullable()
      .optional(),
    projectId: z.string(),
    tenantId: z.string(),
    createdBy: z.string(),
  })
  .strip();

export const toolRecordSchema = z
  .object({
    name: z.string().min(1).max(200),
    slug: z.string().min(1).max(200).optional(),
    toolType: z.string().min(1).max(100),
    description: z.string().max(2000).nullable().optional(),
    dslContent: z.string().min(1).max(500_000),
    sourceHash: z.string().min(1).max(255),
    sourceFile: z.string().max(1024).optional(),
    variableNamespaceIds: z.array(z.string().min(1).max(255)).max(100).optional(),
    lastEditedBy: z.string().max(255).optional(),
    projectId: z.string(),
    tenantId: z.string(),
    createdBy: z.string(),
  })
  .strip();

export const connectionRecordSchema = z
  .object({
    connectorName: z.string().min(1).max(255),
    displayName: z.string().min(1).max(255),
    authType: z.string().max(100).optional(),
    scope: z.enum(['tenant', 'user']).optional(),
    authProfileId: z.string().max(255).optional(),
    authProfileName: z.string().max(255).optional(),
    scopes: z.array(z.string().max(500)).max(50).optional(),
    oauth2Provider: z.string().max(255).optional(),
    authProfile: z.record(z.unknown()).optional(),
    projectId: z.string(),
    tenantId: z.string(),
    createdBy: z.string(),
  })
  .strip();

const guardrailRecordObjectSchema = guardrailImportObjectBaseSchema
  .extend({
    projectId: z.string(),
    tenantId: z.string(),
    createdBy: z.string(),
  })
  .superRefine(validateGuardrailOperationalControlScope);

export const guardrailRecordSchema = guardrailRecordObjectSchema.transform((data) =>
  normalizeGuardrailData(data, { preserveAgentName: false }),
);

export const workflowRecordSchema = z
  .object({
    name: z.string().min(1).max(255),
    type: z.string().max(100).optional(),
    description: z.string().max(2000).nullable().optional(),
    steps: z.array(z.record(z.unknown())).max(500).optional(),
    triggers: z.array(z.record(z.unknown())).max(100).optional(),
    slaMinutes: z.number().int().min(0).optional(),
    escalationRules: z.array(z.record(z.unknown())).max(100).optional(),
    notificationRules: z.array(z.record(z.unknown())).max(100).optional(),
    status: z.string().max(50).optional(),
    projectId: z.string(),
    tenantId: z.string(),
    createdBy: z.string(),
  })
  .strip();

export const evalSetRecordSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(2000).optional(),
    scenarioIds: z.array(z.string()).max(500).optional(),
    personaIds: z.array(z.string()).max(500).optional(),
    evaluatorIds: z.array(z.string()).max(100).optional(),
    variants: z.number().int().min(0).optional(),
    maxConcurrency: z.number().int().min(1).max(100).optional(),
    regressionThreshold: z.number().min(0).max(1).optional(),
    ciEnabled: z.boolean().optional(),
    personaModel: z.string().max(255).nullable().optional(),
    personaModelConfig: z.record(z.unknown()).optional(),
    projectId: z.string(),
    tenantId: z.string(),
    createdBy: z.string(),
  })
  .strip();

export const searchIndexRecordSchema = z
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
    projectId: z.string(),
    tenantId: z.string(),
    createdBy: z.string(),
  })
  .strip();

export const channelConnectionRecordSchema = z
  .object({
    channelType: z.string().min(1).max(100),
    displayName: z.string().min(1).max(255),
    externalIdentifier: z.string().max(500).optional(),
    agentId: z.string().max(255).optional(),
    deploymentId: z.string().max(255).optional(),
    environment: z.string().max(100).nullable().optional(),
    config: z.record(z.unknown()).optional(),
    status: z.enum(['active', 'inactive']).optional(),
    projectId: z.string(),
    tenantId: z.string(),
    createdBy: z.string(),
  })
  .strip();

export const vocabularyRecordSchema = z
  .object({
    tableName: z.string().min(1).max(255),
    value: z.string().max(500),
    field: z.string().max(255).optional(),
    metadata: z.record(z.unknown()).optional(),
    projectId: z.string(),
    tenantId: z.string(),
    createdBy: z.string(),
  })
  .strip();

export const factRecordSchema = z
  .object({
    key: z.string().min(1).max(500),
    value: z.string().max(10000),
    sourceType: z.string().max(100).optional(),
    sourceAgentName: z.string().max(255).optional(),
    scope: z.string().max(50).optional(),
    expiresAt: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
    projectId: z.string(),
    tenantId: z.string(),
    createdBy: z.string(),
  })
  .strip();

// ── Record schemas for remaining collections ──
// These use .strip() with ownership fields to prevent injection while
// allowing disassembler-produced data through with minimal field constraints.

const ownershipFields = {
  projectId: z.string(),
  tenantId: z.string(),
  createdBy: z.string(),
};

const environmentNameSchema = z.preprocess(
  (value) => (value === null || value === undefined || value === '' ? 'global' : value),
  z.enum(['global', 'dev', 'staging', 'production']),
);

export const connectorConfigRecordSchema = z
  .object({
    sourceId: z.string().max(255).optional(),
    connectorType: z.string().min(1).max(100),
    connectionConfig: z.record(z.unknown()).optional(),
    filterConfig: z.record(z.unknown()).optional(),
    permissionConfig: z.record(z.unknown()).optional(),
    ...ownershipFields,
  })
  .strip();

export const workflowVersionRecordSchema = z
  .object({
    version: z.string().max(50).optional(),
    sourceHash: z.string().max(255).optional(),
    changelog: z.string().max(5000).nullable().optional(),
    status: z.string().max(50).optional(),
    state: z.enum(['active', 'inactive']).optional(),
    environment: z.string().max(255).nullable().optional(),
    deploymentId: z.string().max(255).nullable().optional(),
    definition: z.record(z.unknown()).optional(),
    workflowId: z.string().optional(),
    triggers: z
      .array(
        z
          .object({
            id: z.string().min(1).max(255),
            type: z.string().min(1).max(100).optional(),
            triggerType: z.string().min(1).max(100).optional(),
            triggerName: z.string().min(1).max(255).optional(),
            status: z.string().max(50).optional(),
            config: z.record(z.unknown()).optional(),
          })
          .passthrough(),
      )
      .max(1000)
      .optional(),
    publishedAt: z.string().nullable().optional(),
    publishedBy: z.string().max(255).nullable().optional(),
    metadata: z.record(z.unknown()).nullable().optional(),
    ...ownershipFields,
  })
  .strip();

export const evalScenarioRecordSchema = z
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
    expectedMilestones: z.array(z.string().max(1000)).max(100).optional(),
    maxToolCalls: z.number().int().min(0).max(10000).optional(),
    version: z.number().int().optional(),
    ...ownershipFields,
  })
  .strip();

export const evalPersonaRecordSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(5000).optional(),
    communicationStyle: z.string().max(500).optional(),
    domainKnowledge: z.string().max(2000).optional(),
    behaviorTraits: z.array(z.string().max(500)).max(50).optional(),
    goals: z.string().max(5000).optional(),
    constraints: z.string().max(5000).optional(),
    systemPrompt: z.string().max(10000).optional(),
    source: z.string().max(255).optional(),
    isAdversarial: z.boolean().optional(),
    adversarialType: z.string().max(100).optional(),
    isBuiltIn: z.boolean().optional(),
    ...ownershipFields,
  })
  .strip();

export const evaluatorRecordSchema = z
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
    ...ownershipFields,
  })
  .strip();

export const searchSourceRecordSchema = z
  .object({
    name: z.string().min(1).max(255),
    sourceType: z.string().max(100).optional(),
    indexId: z.string().max(255).optional(),
    extractionConfig: z.record(z.unknown()).optional(),
    enrichmentConfig: z.record(z.unknown()).optional(),
    syncSchedule: z.record(z.unknown()).optional(),
    ...ownershipFields,
  })
  .strip();

export const knowledgeBaseRecordSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(2000).optional(),
    searchIndexId: z.string().max(255).optional(),
    connectorCount: z.number().int().min(0).optional(),
    isPublic: z.boolean().optional(),
    ...ownershipFields,
  })
  .strip();

export const crawlPatternRecordSchema = z
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
    confidence: z.number().min(0).max(100).optional(),
    metadata: z.record(z.unknown()).optional(),
    ...ownershipFields,
  })
  .strip();

export const webhookRecordSchema = z
  .object({
    channelConnectionId: z.string().max(255).optional(),
    callbackUrl: z.string().max(2048),
    events: z.array(z.string().max(255)).max(100).optional(),
    description: z.string().max(2000).optional(),
    ...ownershipFields,
  })
  .strip();

export const widgetConfigRecordSchema = z
  .object({
    theme: z.record(z.unknown()).optional(),
    branding: z.record(z.unknown()).optional(),
    behavior: z.record(z.unknown()).optional(),
    customCss: z.string().max(50000).optional(),
    allowedOrigins: z.array(z.string().max(2048)).max(50).optional(),
    ...ownershipFields,
  })
  .strip();

export const domainVocabularyRecordSchema = z
  .object({
    projectKnowledgeBaseId: z.string().max(255).optional(),
    version: z.number().int().min(0).optional(),
    entries: z.array(z.record(z.unknown())).max(50000).optional(),
    ...ownershipFields,
  })
  .strip();

export const canonicalSchemaRecordSchema = z
  .object({
    knowledgeBaseId: z.string().max(255).optional(),
    version: z.number().int().min(0).optional(),
    fields: z.array(z.record(z.unknown())).max(500).optional(),
    ...ownershipFields,
  })
  .strip();

export const ImportedMcpServerConfigSchema = projectIOMcpServerConfigSchema.transform(
  normalizeMcpServerConfigForIO,
);

export const mcpServerConfigRecordSchema = projectIOMcpServerConfigSchema
  .extend({
    ...ownershipFields,
  })
  .strip();

export const promptLibraryItemRecordSchema = z
  .object({
    _id: z.string().min(1),
    name: z.string().min(1).max(128),
    description: z.string().max(512).optional(),
    tags: z.array(z.string().max(64)).max(20).optional(),
    status: z.enum(['active', 'archived']).optional(),
    nextVersionNumber: z.number().int().min(0).optional(),
    ...ownershipFields,
  })
  .strip();

export const promptLibraryVersionRecordSchema = z
  .object({
    _id: z.string().min(1),
    promptId: z.string().min(1),
    versionNumber: z.number().int().min(1),
    template: z.string().max(32768),
    variables: z.array(z.string().max(64)).max(20).optional(),
    description: z.string().max(512).optional(),
    status: z.enum(['draft', 'active', 'archived']).optional(),
    sourceHash: z.string().min(1),
    metadata: z.record(z.unknown()).optional(),
    publishedAt: z.date().optional(),
    ...ownershipFields,
  })
  .strip();

export const projectSettingsRecordSchema = z
  .object({
    enableThinking: z.boolean().optional(),
    thinkingBudget: z.number().nullable().optional(),
    thoughtDescription: z.string().nullable().optional(),
    promptOverrides: z.record(z.unknown()).optional(),
    compactionThreshold: z.number().nullable().optional(),
    traceDimensions: z.array(z.string().max(255)).max(100).optional(),
    agentTransfer: z.record(z.unknown()).nullable().optional(),
    sessionLifecycle: z.record(z.unknown()).nullable().optional(),
    memory: z.record(z.unknown()).nullable().optional(),
    publicApiAccess: z.record(z.unknown()).nullable().optional(),
    sdkDefaults: z.record(z.unknown()).nullable().optional(),
    ...ownershipFields,
  })
  .strip();

export const projectLlmConfigRecordSchema = z
  .object({
    operationTierOverrides: z.record(z.string()).optional(),
    ...ownershipFields,
  })
  .strip();

export const modelConfigRecordSchema = z
  .object({
    name: z.string().min(1).max(255),
    modelId: z.string().min(1).max(255),
    provider: z.string().min(1).max(100),
    credentialId: z.string().max(255).nullable().optional(),
    authProfileId: z.string().max(255).nullable().optional(),
    tenantModelId: z.string().max(255).nullable().optional(),
    temperature: z.number(),
    maxTokens: z.number().int().min(1),
    topP: z.number().min(0).max(1),
    frequencyPenalty: z.number().min(-2).max(2),
    presencePenalty: z.number().min(-2).max(2),
    hyperParameters: z.record(z.unknown()).nullable().optional(),
    inputCostPer1k: z.number().nullable().optional(),
    outputCostPer1k: z.number().nullable().optional(),
    supportsTools: z.boolean(),
    supportsVision: z.boolean(),
    supportsStreaming: z.boolean(),
    useResponsesApi: z.boolean().nullable().optional(),
    useStreaming: z.boolean().nullable().optional(),
    contextWindow: z.number().int().min(1),
    tier: z.string().min(1).max(100),
    isDefault: z.boolean(),
    priority: z.number().int(),
    ...ownershipFields,
  })
  .strip();

export const agentModelConfigRecordSchema = z
  .object({
    agentName: z.string().min(1).max(AGENT_NAME_MAX_LENGTH),
    defaultModel: z.string().max(255).nullable().optional(),
    operationModels: z.record(z.unknown()).nullable().optional(),
    temperature: z.number().nullable().optional(),
    maxTokens: z.number().int().min(1).nullable().optional(),
    hyperParameters: z.record(z.unknown()).nullable().optional(),
    useResponsesApi: z.boolean().nullable().optional(),
    useStreaming: z.boolean().nullable().optional(),
    ...ownershipFields,
  })
  .strip();

export const environmentVariableRecordSchema = z
  .object({
    key: z.string().min(1).max(255),
    environment: environmentNameSchema.default('global'),
    isSecret: z.boolean().default(false),
    description: z.string().max(2000).nullable().optional(),
    ...ownershipFields,
  })
  .strip();

export const projectConfigVariableRecordSchema = z
  .object({
    key: z.string().min(1).max(500),
    value: z.string().max(500_000),
    description: z.string().max(2000).nullable().optional(),
    ...ownershipFields,
  })
  .strip();

export const triggerRegistrationRecordSchema = z
  .object({
    workflowId: z.string().max(255).optional(),
    workflowVersionId: z.string().max(255).optional(),
    workflowVersion: z.string().max(50).optional(),
    connectorName: z.string().max(255).optional(),
    triggerName: z.string().min(1).max(255),
    triggerType: z.enum(['webhook', 'cron', 'event']),
    connectionId: z.string().max(255).optional(),
    config: z.record(z.unknown()).optional(),
    status: z.enum(['active', 'paused', 'error', 'deleted', 'inactive']).optional(),
    webhookUrl: z.string().max(2048).optional(),
    webhookMode: z.enum(['sync', 'async']).optional(),
    webhookDelivery: z.enum(['poll', 'push']).optional(),
    callbackUrl: z.string().max(2048).optional(),
    authProfileId: z.string().max(255).nullable().optional(),
    pollingIntervalMs: z.number().int().min(1).optional(),
    cronExpression: z.string().max(255).optional(),
    missedFirePolicy: z.enum(['fire_once', 'fire_all', 'skip']).optional(),
    environment: z.string().max(255).nullable().optional(),
    ...ownershipFields,
  })
  .strip();

// Runtime config is validated by the canonical strict save validator after
// disassembly because it also resolves destination prompt/model references.
const looseRecordSchema = z
  .object({
    ...ownershipFields,
  })
  .passthrough();

// ── Collection → Record Schema mapping for post-disassembly validation ──

const COLLECTION_RECORD_SCHEMAS: Record<string, z.ZodTypeAny> = {
  // Core layer
  project_agents: agentRecordSchema,
  project_tools: toolRecordSchema,
  project_settings: projectSettingsRecordSchema,
  project_runtime_configs: looseRecordSchema,
  project_llm_configs: projectLlmConfigRecordSchema,
  model_configs: modelConfigRecordSchema,
  agent_model_configs: agentModelConfigRecordSchema,
  environment_variables: environmentVariableRecordSchema,
  project_config_variables: projectConfigVariableRecordSchema,
  mcp_server_configs: mcpServerConfigRecordSchema,
  prompt_library_items: promptLibraryItemRecordSchema,
  prompt_library_versions: promptLibraryVersionRecordSchema,
  // Connections layer
  connector_connections: connectionRecordSchema,
  connector_configs: connectorConfigRecordSchema,
  // Guardrails layer
  guardrail_policies: guardrailRecordSchema,
  // Workflows layer
  workflows: workflowRecordSchema,
  workflow_versions: workflowVersionRecordSchema,
  trigger_registrations: triggerRegistrationRecordSchema,
  // Evals layer
  eval_sets: evalSetRecordSchema,
  eval_scenarios: evalScenarioRecordSchema,
  eval_personas: evalPersonaRecordSchema,
  eval_evaluators: evaluatorRecordSchema,
  // Search layer
  search_indexes: searchIndexRecordSchema,
  search_sources: searchSourceRecordSchema,
  knowledge_bases: knowledgeBaseRecordSchema,
  crawl_patterns: crawlPatternRecordSchema,
  // Channels layer
  channel_connections: channelConnectionRecordSchema,
  webhook_subscriptions: webhookRecordSchema,
  widget_configs: widgetConfigRecordSchema,
  // Vocabulary layer
  lookup_entries: vocabularyRecordSchema,
  domain_vocabularies: domainVocabularyRecordSchema,
  canonical_schemas: canonicalSchemaRecordSchema,
  facts: factRecordSchema,
};

/**
 * Get the Zod record schema for a collection name.
 * Returns null for collections without a dedicated schema.
 */
export function getRecordSchemaForCollection(collection: string): z.ZodTypeAny | null {
  return COLLECTION_RECORD_SCHEMAS[collection] ?? null;
}

/**
 * Validate and sanitize a batch of staged records against their collection schemas.
 * Records with matching schemas are validated and sanitized via .strip().
 * Records without schemas pass through unchanged — disassemblers have already
 * processed them (injectOwnership, safeParseJSON, stripRedactedValues).
 *
 * IMPORTANT: The fallback must NOT call stripInternal() because records already
 * contain tenantId/projectId/createdBy injected by injectOwnership(). Stripping
 * those fields would create a resource isolation violation.
 */
export function validateStagedRecordBatch<
  T extends { collection: string; data: Record<string, unknown> },
>(records: T[]): { sanitized: T[]; warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  const sanitized = records.map((record) => {
    const schema = COLLECTION_RECORD_SCHEMAS[record.collection];
    if (!schema) {
      // No schema for this collection — trust the disassembler's output as-is.
      // Do NOT strip ownership fields (tenantId, projectId, createdBy).
      return record;
    }

    // Preserve KNOWN temp fields through schema validation.
    // These are set by disassemblers for cross-ref resolution (Phase 5)
    // and will be cleaned up by the cross-ref resolver after staging.
    // Without this, .strip() removes them before staging and cross-ref fails.
    // Only known fields are preserved to prevent arbitrary _-prefixed injection.
    const tempFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record.data)) {
      if (KNOWN_TEMP_FIELDS.has(key)) {
        tempFields[key] = value;
      }
    }

    const result = schema.safeParse(record.data);
    if (result.success) {
      const sanitized = result.data as Record<string, unknown>;
      // Restore temp fields that .strip() removed
      return {
        ...record,
        data: Object.keys(tempFields).length > 0 ? { ...sanitized, ...tempFields } : sanitized,
      } as T;
    }

    // Validation failed — return the original record so callers can still
    // surface contextual diagnostics, but expose the failure as a blocking
    // error before staging.
    // Do NOT apply stripInternal() which would remove ownership fields.
    const issueMessages = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    const message = `Schema validation failed for "${record.collection}": ${issueMessages.join('; ')}`;
    warnings.push(message);
    errors.push(message);
    return record;
  });

  return { sanitized, warnings, errors };
}

// ── Generic Record Validator ──

export interface ValidateRecordResult<T = Record<string, unknown>> {
  valid: boolean;
  data?: T;
  errors?: Array<{ path: string; message: string }>;
}

/**
 * Validate any data against a Zod schema and return a typed result.
 * Uses `.strip()` semantics from the schema to prevent field injection.
 *
 * @param schema - Zod schema to validate against
 * @param data - Raw data to validate
 * @returns Validation result with sanitized data or error details
 */
export function validateRecord<T>(schema: z.ZodType<T>, data: unknown): ValidateRecordResult<T> {
  const result = schema.safeParse(data);
  if (result.success) {
    return { valid: true, data: result.data };
  }

  const errors = result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));

  return { valid: false, errors };
}

// ── Schema Validation Types ──

export interface SchemaValidationIssue {
  file: string;
  layer: string;
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
  layer: string,
  data: Record<string, unknown>,
): SchemaValidationResult {
  // Preserve known temp fields through schema validation (same as batch path).
  // Without this, .strip() removes _indexSlug, _channelDisplayName, etc.
  const tempFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (KNOWN_TEMP_FIELDS.has(key)) {
      tempFields[key] = value;
    }
  }
  const hasTempFields = Object.keys(tempFields).length > 0;

  const schema = getSchemaForFile(filePath);
  if (!schema) {
    // Unknown file type in layer — strip internal fields only
    return {
      valid: true,
      sanitizedData: hasTempFields
        ? { ...stripInternal(data), ...tempFields }
        : stripInternal(data),
      issues: [],
    };
  }

  const result = schema.safeParse(data);
  if (result.success) {
    const sanitized = result.data as Record<string, unknown>;
    return {
      valid: true,
      sanitizedData: hasTempFields ? { ...sanitized, ...tempFields } : sanitized,
      issues: [],
    };
  }

  const errors = result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));

  const fallback = stripInternal(data);
  return {
    valid: false,
    sanitizedData: hasTempFields ? { ...fallback, ...tempFields } : fallback,
    issues: [{ file: filePath, layer, errors }],
  };
}

/**
 * Select the appropriate Zod schema based on file path.
 * Returns null for unrecognized file types (caller should still strip internal fields).
 */
export function getSchemaForFile(filePath: string): z.ZodTypeAny | null {
  // Connection layer
  if (filePath.endsWith('.connection.json')) return ImportedConnectionSchema;
  if (filePath.endsWith('.connector-config.json')) return ImportedConnectorConfigSchema;

  // Guardrails
  if (isGuardrailArchivePath(filePath)) return ImportedGuardrailSchema;

  // Workflows
  if (filePath.endsWith('.workflow.json')) return ImportedWorkflowSchema;
  if (filePath.endsWith('.version.json')) return ImportedWorkflowVersionSchema;
  if (filePath.endsWith('.mcp-config.json')) return ImportedMcpServerConfigSchema;

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
