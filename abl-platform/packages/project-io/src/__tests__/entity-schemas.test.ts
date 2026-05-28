/**
 * Tests for entity-schemas.ts — Zod schemas for imported JSON entities
 * and the validateStagedRecordBatch() batch validator.
 */

import { describe, it, expect } from 'vitest';
import {
  agentRecordSchema,
  toolRecordSchema,
  connectionRecordSchema,
  guardrailRecordSchema,
  workflowRecordSchema,
  evalSetRecordSchema,
  searchIndexRecordSchema,
  channelConnectionRecordSchema,
  vocabularyRecordSchema,
  factRecordSchema,
  ImportedConnectionSchema,
  ImportedConnectorConfigSchema,
  ImportedGuardrailSchema,
  ImportedWorkflowSchema,
  ImportedWorkflowVersionSchema,
  ImportedEvalSetSchema,
  ImportedEvalScenarioSchema,
  ImportedEvalPersonaSchema,
  ImportedEvaluatorSchema,
  ImportedSearchIndexSchema,
  ImportedSearchSourceSchema,
  ImportedKnowledgeBaseSchema,
  ImportedCrawlPatternSchema,
  ImportedChannelSchema,
  ImportedWebhookSchema,
  ImportedWidgetConfigSchema,
  ImportedLookupEntrySchema,
  ImportedCanonicalSchemaFile,
  ImportedDomainVocabularySchema,
  ImportedFactSchema,
  getRecordSchemaForCollection,
  validateStagedRecordBatch,
  validateRecord,
  validateEntitySchema,
  getSchemaForFile,
} from '../import/entity-schemas.js';

// ── Shared ownership fields for record schemas ──

const OWNERSHIP = {
  projectId: 'proj-1',
  tenantId: 'tenant-1',
  createdBy: 'user-1',
};

// ── agentRecordSchema ─────────────────────────────────────────────────────

describe('agentRecordSchema', () => {
  it('accepts valid agent record with all required fields', () => {
    const data = {
      name: 'Supervisor',
      dslContent: 'AGENT: Supervisor\nGOAL: "Route requests"',
      ...OWNERSHIP,
    };
    const result = agentRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ name: 'Supervisor' });
  });

  it('strips legacy status and version fields because project agents do not own them', () => {
    const data = {
      name: 'A',
      dslContent: 'AGENT: A',
      status: 'active',
      version: '0.0.0',
      ...OWNERSHIP,
    };
    const result = agentRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('status');
    expect(result.data).not.toHaveProperty('version');
  });

  it('rejects missing name', () => {
    const data = { dslContent: 'AGENT: A', ...OWNERSHIP };
    const result = agentRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects empty name', () => {
    const data = { name: '', dslContent: 'AGENT: A', ...OWNERSHIP };
    const result = agentRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects names that cannot be used as canonical agent identity', () => {
    const data = { name: 'support-agent', dslContent: 'AGENT: support-agent', ...OWNERSHIP };
    const result = agentRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects missing dslContent', () => {
    const data = { name: 'A', ...OWNERSHIP };
    const result = agentRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects empty dslContent', () => {
    const data = { name: 'A', dslContent: '', ...OWNERSHIP };
    const result = agentRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects missing projectId', () => {
    const data = { name: 'A', dslContent: 'X', tenantId: 't', createdBy: 'u' };
    const result = agentRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects missing tenantId', () => {
    const data = { name: 'A', dslContent: 'X', projectId: 'p', createdBy: 'u' };
    const result = agentRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects missing createdBy', () => {
    const data = { name: 'A', dslContent: 'X', projectId: 'p', tenantId: 't' };
    const result = agentRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('strips unknown fields', () => {
    const data = { name: 'A', dslContent: 'X', ...OWNERSHIP, extraField: 'nope' };
    const result = agentRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>)['extraField']).toBeUndefined();
  });
});

// ── toolRecordSchema ──────────────────────────────────────────────────────

describe('toolRecordSchema', () => {
  it('accepts valid tool record with dslContent (not content)', () => {
    const data = {
      name: 'HotelAPI',
      toolType: 'http',
      dslContent: 'TOOL: HotelAPI\nDESCRIPTION: "Search hotels"',
      sourceHash: 'hash-1',
      ...OWNERSHIP,
    };
    const result = toolRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ name: 'HotelAPI' });
  });

  it('accepts optional slug', () => {
    const data = {
      name: 'HotelAPI',
      slug: 'hotel-api',
      toolType: 'http',
      dslContent: 'TOOL: HotelAPI',
      sourceHash: 'hash-1',
      ...OWNERSHIP,
    };
    const result = toolRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
    expect(result.data!.slug).toBe('hotel-api');
  });

  it('rejects record with content instead of dslContent', () => {
    const data = { name: 'HotelAPI', content: 'TOOL: HotelAPI', ...OWNERSHIP };
    const result = toolRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects missing name', () => {
    const data = { dslContent: 'X', ...OWNERSHIP };
    const result = toolRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects missing dslContent', () => {
    const data = { name: 'T', ...OWNERSHIP };
    const result = toolRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('strips unknown fields', () => {
    const data = {
      name: 'T',
      toolType: 'http',
      dslContent: 'X',
      sourceHash: 'hash-1',
      ...OWNERSHIP,
      randomProp: true,
    };
    const result = toolRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>)['randomProp']).toBeUndefined();
  });
});

// ── connectionRecordSchema ────────────────────────────────────────────────

describe('connectionRecordSchema', () => {
  it('accepts valid connection with all optional auth fields', () => {
    const data = {
      connectorName: 'salesforce',
      displayName: 'Salesforce Production',
      authType: 'oauth2',
      scope: 'tenant',
      authProfileId: 'profile-1',
      authProfileName: 'My Profile',
      scopes: ['read', 'write'],
      oauth2Provider: 'salesforce',
      authProfile: { clientId: 'abc' },
      ...OWNERSHIP,
    };
    const result = connectionRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      connectorName: 'salesforce',
      authProfileId: 'profile-1',
      authProfileName: 'My Profile',
      scopes: ['read', 'write'],
      oauth2Provider: 'salesforce',
      authProfile: { clientId: 'abc' },
    });
  });

  it('accepts minimal connection with only required fields', () => {
    const data = {
      connectorName: 'github',
      displayName: 'GitHub',
      ...OWNERSHIP,
    };
    const result = connectionRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('rejects missing connectorName', () => {
    const data = { displayName: 'Test', ...OWNERSHIP };
    const result = connectionRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects missing displayName', () => {
    const data = { connectorName: 'test', ...OWNERSHIP };
    const result = connectionRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects invalid scope enum value', () => {
    const data = { connectorName: 'x', displayName: 'X', scope: 'global', ...OWNERSHIP };
    const result = connectionRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('strips unknown fields', () => {
    const data = {
      connectorName: 'x',
      displayName: 'X',
      ...OWNERSHIP,
      encryptedCredentials: 'secret',
    };
    const result = connectionRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>)['encryptedCredentials']).toBeUndefined();
  });
});

// ── guardrailRecordSchema ─────────────────────────────────────────────────

describe('guardrailRecordSchema', () => {
  it('accepts a full guardrail policy record and preserves exported policy fields', () => {
    const data = {
      name: 'Content Filter',
      description: 'Protect the transfer flow',
      scope: {
        type: 'project',
        projectId: 'proj-1',
      },
      providerOverrides: [
        {
          providerName: 'openai',
          defaultCategory: 'self_harm',
          defaultThreshold: 0.85,
          isActive: true,
        },
      ],
      rules: [
        {
          guardrailName: 'pii',
          override: 'threshold',
          threshold: 0.75,
          kind: 'input',
          tier: 'llm',
        },
      ],
      constitution: [{ principle: 'Do no harm', weight: 1 }],
      settings: {
        failMode: 'closed',
        timeouts: { local: 25, model: 1000, llm: 4000 },
        streaming: {
          enabled: true,
          defaultInterval: 'sentence',
          chunkSize: 128,
          maxLatencyMs: 250,
          earlyTermination: true,
        },
      },
      caching: {
        enabled: true,
        exactMatch: true,
        semanticMatch: false,
        semanticThreshold: 0.95,
        defaultTtlSeconds: 300,
      },
      budget: {
        monthlyLimitUsd: 20,
        currentSpendUsd: 2,
        overspendAction: 'alert_only',
      },
      version: 3,
      previousVersionId: 'guard-prev-1',
      changelog: 'Raised input threshold',
      status: 'active',
      isActive: true,
      _v: 2,
      ...OWNERSHIP,
    };
    const result = guardrailRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      name: 'Content Filter',
      version: 3,
      status: 'active',
      isActive: true,
      previousVersionId: 'guard-prev-1',
      _v: 2,
    });
    expect(result.data!.scope).toEqual({
      type: 'project',
      projectId: 'proj-1',
    });
    expect(result.data!.providerOverrides).toEqual([
      {
        providerName: 'openai',
        defaultCategory: 'self_harm',
        defaultThreshold: 0.85,
        isActive: true,
      },
    ]);
  });

  it('rejects provider credential overrides until runtime supports them end-to-end', () => {
    const data = {
      name: 'Credential Override Guard',
      providerOverrides: [
        {
          providerName: 'openai',
          apiKeyCredentialId: 'credential-1',
          authProfileId: 'auth-profile-1',
        },
      ],
      ...OWNERSHIP,
    };

    const result = guardrailRecordSchema.safeParse(data);

    expect(result.success).toBe(false);
  });

  it('rejects out-of-range provider override numeric controls', () => {
    const threshold = guardrailRecordSchema.safeParse({
      name: 'Bad Threshold Guard',
      providerOverrides: [{ providerName: 'openai', defaultThreshold: 2 }],
      ...OWNERSHIP,
    });
    const cost = guardrailRecordSchema.safeParse({
      name: 'Bad Cost Guard',
      providerOverrides: [{ providerName: 'openai', costPerEvalUsd: -0.01 }],
      ...OWNERSHIP,
    });

    expect(threshold.success).toBe(false);
    expect(cost.success).toBe(false);
  });

  it('rejects out-of-range rule thresholds', () => {
    const result = guardrailRecordSchema.safeParse({
      name: 'Bad Rule Threshold Guard',
      rules: [{ guardrailName: 'pii', override: 'threshold', threshold: 1.1 }],
      ...OWNERSHIP,
    });

    expect(result.success).toBe(false);
  });

  it('rejects non-positive timing and budget controls', () => {
    const timeout = guardrailRecordSchema.safeParse({
      name: 'Bad Timeout Guard',
      settings: { timeouts: { local: 0, model: 1000, llm: 4000 } },
      ...OWNERSHIP,
    });
    const budget = guardrailRecordSchema.safeParse({
      name: 'Bad Budget Guard',
      budget: { monthlyLimitUsd: 0, overspendAction: 'disable_model_checks' },
      ...OWNERSHIP,
    });

    expect(timeout.success).toBe(false);
    expect(budget.success).toBe(false);
  });

  it('rejects project-only operational controls on agent-scoped staged records', () => {
    const result = guardrailRecordSchema.safeParse({
      name: 'Agent Operational Guard',
      scope: { type: 'agent', projectId: 'proj-1', agentDefId: 'agent-1' },
      caching: { enabled: true },
      budget: { monthlyLimitUsd: 20 },
      settings: {
        webhookUrl: 'https://hooks.example.com/guardrails',
        webhookSecret: 'whsec_test',
      },
      ...OWNERSHIP,
    });

    expect(result.success).toBe(false);
  });

  it('normalizes legacy enabled and agentId fields onto the canonical record shape', () => {
    const data = {
      name: 'Legacy Guard',
      enabled: true,
      scope: { type: 'agent', projectId: 'proj-1', agentId: 'legacy-agent' },
      ...OWNERSHIP,
    };
    const result = guardrailRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
    expect(result.data!.isActive).toBe(true);
    expect(result.data!.scope).toEqual({
      type: 'agent',
      projectId: 'proj-1',
      agentDefId: 'legacy-agent',
    });
  });

  it('accepts guardrail with project scope type', () => {
    const data = {
      name: 'Rate Limit',
      scope: { type: 'project', projectId: 'proj-1' },
      ...OWNERSHIP,
    };
    const result = guardrailRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
    expect((result.data!.scope as Record<string, unknown>)['type']).toBe('project');
  });

  it('accepts minimal guardrail with only required name', () => {
    const data = { name: 'Simple Guard', ...OWNERSHIP };
    const result = guardrailRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('rejects missing name', () => {
    const data = { type: 'filter', ...OWNERSHIP };
    const result = guardrailRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects invalid scope type enum', () => {
    const data = {
      name: 'Guard',
      scope: { type: 'global' },
      ...OWNERSHIP,
    };
    const result = guardrailRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('strips unknown fields in scope object', () => {
    const data = {
      name: 'Guard',
      scope: {
        type: 'project',
        projectId: 'p1',
        agentName: 'should-drop',
        unknownScopeField: true,
      },
      ...OWNERSHIP,
    };
    const result = guardrailRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
    expect((result.data!.scope as Record<string, unknown>)['unknownScopeField']).toBeUndefined();
    expect((result.data!.scope as Record<string, unknown>)['agentName']).toBeUndefined();
  });
});

// ── workflowRecordSchema ──────────────────────────────────────────────────

describe('workflowRecordSchema', () => {
  it('accepts valid workflow with all optional fields', () => {
    const data = {
      name: 'Escalation Workflow',
      type: 'escalation',
      description: 'Handle escalations',
      steps: [{ name: 'step1', action: 'notify' }],
      triggers: [{ event: 'ticket.created' }],
      slaMinutes: 60,
      escalationRules: [{ level: 1 }],
      notificationRules: [{ channel: 'email' }],
      status: 'active',
      ...OWNERSHIP,
    };
    const result = workflowRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ name: 'Escalation Workflow', type: 'escalation' });
  });

  it('accepts minimal workflow with only required fields', () => {
    const data = { name: 'Simple', ...OWNERSHIP };
    const result = workflowRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('accepts workflow exports with null descriptions', () => {
    const data = { name: 'Simple', description: null, ...OWNERSHIP };
    const result = workflowRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('rejects missing name', () => {
    const data = { type: 'flow', ...OWNERSHIP };
    const result = workflowRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects negative slaMinutes', () => {
    const data = { name: 'W', slaMinutes: -1, ...OWNERSHIP };
    const result = workflowRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('strips unknown fields', () => {
    const data = { name: 'W', ...OWNERSHIP, secretField: 'hidden' };
    const result = workflowRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>)['secretField']).toBeUndefined();
  });
});

// ── evalSetRecordSchema ───────────────────────────────────────────────────

describe('evalSetRecordSchema', () => {
  it('accepts variants as number (not array)', () => {
    const data = {
      name: 'Quality Eval',
      variants: 5,
      maxConcurrency: 10,
      regressionThreshold: 0.8,
      ciEnabled: true,
      ...OWNERSHIP,
    };
    const result = evalSetRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
    expect(result.data!.variants).toBe(5);
  });

  it('rejects variants as array', () => {
    const data = {
      name: 'Eval',
      variants: ['v1', 'v2'],
      ...OWNERSHIP,
    };
    const result = evalSetRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('accepts all optional eval set fields', () => {
    const data = {
      name: 'Full Eval',
      description: 'A thorough eval',
      scenarioIds: ['s1', 's2'],
      personaIds: ['p1'],
      evaluatorIds: ['e1'],
      variants: 3,
      maxConcurrency: 5,
      regressionThreshold: 0.5,
      ciEnabled: false,
      personaModel: 'gpt-4',
      personaModelConfig: { temperature: 0.7 },
      ...OWNERSHIP,
    };
    const result = evalSetRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('rejects missing name', () => {
    const data = { variants: 1, ...OWNERSHIP };
    const result = evalSetRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects regressionThreshold above 1', () => {
    const data = { name: 'E', regressionThreshold: 1.5, ...OWNERSHIP };
    const result = evalSetRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects maxConcurrency above 100', () => {
    const data = { name: 'E', maxConcurrency: 101, ...OWNERSHIP };
    const result = evalSetRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});

// ── searchIndexRecordSchema ───────────────────────────────────────────────

describe('searchIndexRecordSchema', () => {
  it('accepts valid search index record', () => {
    const data = {
      name: 'Products Index',
      slug: 'products',
      embeddingModel: 'text-embedding-3-small',
      embeddingDimensions: 1536,
      ...OWNERSHIP,
    };
    const result = searchIndexRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('accepts minimal search index', () => {
    const data = { name: 'Idx', ...OWNERSHIP };
    const result = searchIndexRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('rejects missing name', () => {
    const data = { slug: 'idx', ...OWNERSHIP };
    const result = searchIndexRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects embeddingDimensions below 1', () => {
    const data = { name: 'Idx', embeddingDimensions: 0, ...OWNERSHIP };
    const result = searchIndexRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects embeddingDimensions above 10000', () => {
    const data = { name: 'Idx', embeddingDimensions: 10001, ...OWNERSHIP };
    const result = searchIndexRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});

// ── channelConnectionRecordSchema ─────────────────────────────────────────

describe('channelConnectionRecordSchema', () => {
  it('accepts valid channel connection', () => {
    const data = {
      channelType: 'slack',
      displayName: 'Slack Bot',
      agentId: 'agent-1',
      environment: 'production',
      config: { webhookUrl: 'https://hooks.slack.com/x' },
      ...OWNERSHIP,
    };
    const result = channelConnectionRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('accepts channel connections without a pinned environment', () => {
    const data = {
      channelType: 'slack',
      displayName: 'Slack Bot',
      environment: null,
      ...OWNERSHIP,
    };
    const result = channelConnectionRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('rejects missing channelType', () => {
    const data = { displayName: 'Bot', ...OWNERSHIP };
    const result = channelConnectionRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects missing displayName', () => {
    const data = { channelType: 'slack', ...OWNERSHIP };
    const result = channelConnectionRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('strips unknown fields', () => {
    const data = { channelType: 'web', displayName: 'W', ...OWNERSHIP, secret: 'x' };
    const result = channelConnectionRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>)['secret']).toBeUndefined();
  });
});

// ── vocabularyRecordSchema ────────────────────────────────────────────────

describe('vocabularyRecordSchema', () => {
  it('accepts valid vocabulary record', () => {
    const data = {
      tableName: 'industry_codes',
      value: 'SIC-1234',
      field: 'code',
      metadata: { source: 'manual' },
      ...OWNERSHIP,
    };
    const result = vocabularyRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('rejects missing tableName', () => {
    const data = { value: 'v', ...OWNERSHIP };
    const result = vocabularyRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});

// ── factRecordSchema ──────────────────────────────────────────────────────

describe('factRecordSchema', () => {
  it('accepts valid fact record', () => {
    const data = {
      key: 'company_name',
      value: 'Acme Corp',
      sourceType: 'manual',
      sourceAgentName: 'DataBot',
      scope: 'project',
      expiresAt: '2025-12-31T00:00:00Z',
      metadata: { confidence: 0.95 },
      ...OWNERSHIP,
    };
    const result = factRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('rejects missing key', () => {
    const data = { value: 'v', ...OWNERSHIP };
    const result = factRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects missing value', () => {
    const data = { key: 'k', ...OWNERSHIP };
    const result = factRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});

// ── getRecordSchemaForCollection ──────────────────────────────────────────

describe('getRecordSchemaForCollection', () => {
  it('returns agentRecordSchema for project_agents', () => {
    expect(getRecordSchemaForCollection('project_agents')).toBe(agentRecordSchema);
  });

  it('returns toolRecordSchema for project_tools', () => {
    expect(getRecordSchemaForCollection('project_tools')).toBe(toolRecordSchema);
  });

  it('returns connectionRecordSchema for connector_connections', () => {
    expect(getRecordSchemaForCollection('connector_connections')).toBe(connectionRecordSchema);
  });

  it('returns guardrailRecordSchema for guardrail_policies', () => {
    expect(getRecordSchemaForCollection('guardrail_policies')).toBe(guardrailRecordSchema);
  });

  it('returns workflowRecordSchema for workflows', () => {
    expect(getRecordSchemaForCollection('workflows')).toBe(workflowRecordSchema);
  });

  it('returns evalSetRecordSchema for eval_sets', () => {
    expect(getRecordSchemaForCollection('eval_sets')).toBe(evalSetRecordSchema);
  });

  it('returns searchIndexRecordSchema for search_indexes', () => {
    expect(getRecordSchemaForCollection('search_indexes')).toBe(searchIndexRecordSchema);
  });

  it('returns channelConnectionRecordSchema for channel_connections', () => {
    expect(getRecordSchemaForCollection('channel_connections')).toBe(channelConnectionRecordSchema);
  });

  it('returns vocabularyRecordSchema for lookup_entries', () => {
    expect(getRecordSchemaForCollection('lookup_entries')).toBe(vocabularyRecordSchema);
  });

  it('returns factRecordSchema for facts', () => {
    expect(getRecordSchemaForCollection('facts')).toBe(factRecordSchema);
  });

  it('returns null for unknown collection', () => {
    expect(getRecordSchemaForCollection('unknown_collection')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(getRecordSchemaForCollection('')).toBeNull();
  });
});

// ── validateStagedRecordBatch ─────────────────────────────────────────────

describe('validateStagedRecordBatch', () => {
  it('validates and returns sanitized records for known collections', () => {
    const records = [
      {
        collection: 'project_agents',
        data: {
          name: 'Bot',
          dslContent: 'AGENT: Bot',
          ...OWNERSHIP,
        },
      },
    ];

    const { sanitized, warnings } = validateStagedRecordBatch(records);

    expect(warnings).toHaveLength(0);
    expect(sanitized).toHaveLength(1);
    expect(sanitized[0].data).toMatchObject({ name: 'Bot', dslContent: 'AGENT: Bot' });
  });

  it('accepts channel connection records with null environment during preview validation', () => {
    const records = [
      {
        collection: 'channel_connections',
        data: {
          channelType: 'slack',
          displayName: 'Slack Bot',
          environment: null,
          ...OWNERSHIP,
        },
      },
    ];

    const { sanitized, warnings, errors } = validateStagedRecordBatch(records);

    expect(warnings).toHaveLength(0);
    expect(errors).toHaveLength(0);
    expect(sanitized[0].data.environment).toBeNull();
  });

  it('returns warnings for invalid records and preserves original data', () => {
    const records = [
      {
        collection: 'project_agents',
        data: {
          // missing name and dslContent — should fail validation
          ...OWNERSHIP,
        },
      },
    ];

    const { sanitized, warnings, errors } = validateStagedRecordBatch(records);

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('project_agents');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('project_agents');
    // Original record is preserved on failure
    expect(sanitized[0].data).toMatchObject(OWNERSHIP);
  });

  it('passes through records with unknown collections unchanged', () => {
    const records = [
      {
        collection: 'custom_widgets',
        data: {
          widgetType: 'chart',
          _id: 'should-stay',
          extraField: 'preserved',
          ...OWNERSHIP,
        },
      },
    ];

    const { sanitized, warnings } = validateStagedRecordBatch(records);

    expect(warnings).toHaveLength(0);
    // Unknown collections pass through unchanged — no stripping of _id or ownership
    expect(sanitized[0].data).toMatchObject({
      widgetType: 'chart',
      _id: 'should-stay',
      extraField: 'preserved',
      projectId: OWNERSHIP.projectId,
      tenantId: OWNERSHIP.tenantId,
    });
  });

  it('preserves KNOWN_TEMP_FIELDS through .strip() validation', () => {
    const records = [
      {
        collection: 'project_agents',
        data: {
          name: 'Bot',
          dslContent: 'AGENT: Bot',
          _workflowName: 'MyWorkflow',
          _indexSlug: 'my-index',
          _guardrailAgentName: 'TransferAgent',
          _unknownTemp: 'should-be-stripped',
          ...OWNERSHIP,
        },
      },
    ];

    const { sanitized, warnings } = validateStagedRecordBatch(records);

    expect(warnings).toHaveLength(0);
    expect(sanitized[0].data).toMatchObject({
      name: 'Bot',
      dslContent: 'AGENT: Bot',
      _workflowName: 'MyWorkflow',
      _indexSlug: 'my-index',
      _guardrailAgentName: 'TransferAgent',
    });
    // Non-whitelisted _-prefixed fields are stripped
    expect((sanitized[0].data as Record<string, unknown>)['_unknownTemp']).toBeUndefined();
  });

  it('strips non-whitelisted fields while preserving KNOWN_TEMP_FIELDS', () => {
    const records = [
      {
        collection: 'project_tools',
        data: {
          name: 'API',
          toolType: 'http',
          dslContent: 'TOOL: API',
          sourceHash: 'source-hash-1',
          _exportedId: 'old-id-123',
          randomExtra: 'gone',
          ...OWNERSHIP,
        },
      },
    ];

    const { sanitized, warnings } = validateStagedRecordBatch(records);

    expect(warnings).toHaveLength(0);
    expect(sanitized[0].data._exportedId).toBe('old-id-123');
    expect((sanitized[0].data as Record<string, unknown>)['randomExtra']).toBeUndefined();
  });

  it('strips DB-shaped metadata from model policy records during schema validation', () => {
    const records = [
      {
        collection: 'model_configs',
        data: {
          name: 'Balanced',
          modelId: 'gpt-4o-mini',
          provider: 'openai',
          temperature: 0.2,
          maxTokens: 4096,
          topP: 1,
          frequencyPenalty: 0,
          presencePenalty: 0,
          hyperParameters: { enableThinking: true, thinkingBudget: 4096 },
          supportsTools: true,
          supportsVision: true,
          supportsStreaming: true,
          contextWindow: 128000,
          tier: 'balanced',
          isDefault: true,
          priority: 10,
          _id: 'source-model-config',
          _v: 3,
          createdBy: 'source-user',
          updatedBy: 'source-updater',
          ownerId: 'source-owner',
          sourceFile: 'config/project-model-configs/balanced.model-config.json',
          unexpected: 'gone',
          ...OWNERSHIP,
        },
      },
    ];

    const { sanitized, warnings, errors } = validateStagedRecordBatch(records);

    expect(warnings).toHaveLength(0);
    expect(errors).toHaveLength(0);
    expect(sanitized[0].data).toMatchObject({
      name: 'Balanced',
      modelId: 'gpt-4o-mini',
      provider: 'openai',
      tier: 'balanced',
      projectId: OWNERSHIP.projectId,
      tenantId: OWNERSHIP.tenantId,
      hyperParameters: { enableThinking: true, thinkingBudget: 4096 },
    });
    expect(sanitized[0].data).not.toHaveProperty('_id');
    expect(sanitized[0].data).not.toHaveProperty('_v');
    expect(sanitized[0].data).not.toHaveProperty('updatedBy');
    expect(sanitized[0].data).not.toHaveProperty('ownerId');
    expect(sanitized[0].data).not.toHaveProperty('sourceFile');
    expect(sanitized[0].data).not.toHaveProperty('unexpected');
  });

  it('blocks project model configs that cannot satisfy raw layered staging requirements', () => {
    const records = [
      {
        collection: 'model_configs',
        data: {
          name: 'Incomplete',
          modelId: 'gpt-4o-mini',
          provider: 'openai',
          tier: 'balanced',
          ...OWNERSHIP,
        },
      },
    ];

    const { errors, warnings } = validateStagedRecordBatch(records);

    expect(errors).toEqual([
      expect.stringContaining('Schema validation failed for "model_configs"'),
    ]);
    expect(warnings).toEqual(errors);
  });

  it('normalizes missing or null environment variable environments to global', () => {
    const records = [
      {
        collection: 'environment_variables',
        data: {
          key: 'REGION',
          environment: null,
          ...OWNERSHIP,
        },
      },
    ];

    const { sanitized, warnings, errors } = validateStagedRecordBatch(records);

    expect(warnings).toHaveLength(0);
    expect(errors).toHaveLength(0);
    expect(sanitized[0].data).toMatchObject({
      key: 'REGION',
      environment: 'global',
      isSecret: false,
    });
  });

  it('preserves workflow version execution fields through schema validation', () => {
    const records = [
      {
        collection: 'workflow_versions',
        data: {
          version: 'draft',
          state: 'active',
          environment: null,
          sourceHash: 'source-hash',
          changelog: null,
          definition: { nodes: [], edges: [] },
          triggers: [
            { id: 'trigger-1', type: 'webhook', config: { path: '/hook' } },
            { id: 'trigger-2', triggerType: 'manual', triggerName: 'review' },
          ],
          publishedAt: null,
          metadata: { imported: true },
          randomExtra: 'gone',
          ...OWNERSHIP,
        },
      },
    ];

    const { sanitized, warnings } = validateStagedRecordBatch(records);

    expect(warnings).toHaveLength(0);
    expect(sanitized[0].data).toMatchObject({
      version: 'draft',
      state: 'active',
      environment: null,
      sourceHash: 'source-hash',
      triggers: [
        { id: 'trigger-1', type: 'webhook', config: { path: '/hook' } },
        { id: 'trigger-2', triggerType: 'manual', triggerName: 'review' },
      ],
      publishedAt: null,
      metadata: { imported: true },
    });
    expect((sanitized[0].data as Record<string, unknown>)['randomExtra']).toBeUndefined();
  });

  it('handles empty record array', () => {
    const { sanitized, warnings } = validateStagedRecordBatch([]);
    expect(sanitized).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('handles mixed valid and invalid records in same batch', () => {
    const records = [
      {
        collection: 'project_agents',
        data: { name: 'Good', dslContent: 'AGENT: Good', ...OWNERSHIP },
      },
      {
        collection: 'project_agents',
        data: { ...OWNERSHIP }, // missing required fields
      },
      {
        collection: 'facts',
        data: { key: 'k', value: 'v', ...OWNERSHIP },
      },
    ];

    const { sanitized, warnings } = validateStagedRecordBatch(records);

    expect(sanitized).toHaveLength(3);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('project_agents');
  });

  it('handles multiple different known collections', () => {
    const records = [
      {
        collection: 'project_agents',
        data: { name: 'A', dslContent: 'AGENT: A', ...OWNERSHIP },
      },
      {
        collection: 'connector_connections',
        data: { connectorName: 'sf', displayName: 'SF', ...OWNERSHIP },
      },
      {
        collection: 'facts',
        data: { key: 'k', value: 'v', ...OWNERSHIP },
      },
    ];

    const { sanitized, warnings } = validateStagedRecordBatch(records);

    expect(warnings).toHaveLength(0);
    expect(sanitized).toHaveLength(3);
  });

  it('warning message includes field-level error details', () => {
    const records = [
      {
        collection: 'guardrail_policies',
        data: {
          // name is required but missing
          isActive: true,
          ...OWNERSHIP,
        },
      },
    ];

    const { warnings } = validateStagedRecordBatch(records);

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('guardrail_policies');
  });
});

// ── Import-level schemas ──────────────────────────────────────────────────

describe('ImportedConnectionSchema', () => {
  it('accepts valid connection and strips internal fields', () => {
    const data = {
      connectorName: 'github',
      displayName: 'GitHub',
      scope: 'tenant',
      authType: 'oauth2',
      authProfileName: 'Default',
      scopes: ['repo'],
      oauth2Provider: 'github',
      authProfile: { clientId: 'abc' },
      _id: 'should-be-stripped',
      tenantId: 'should-be-stripped',
      projectId: 'should-be-stripped',
      createdAt: 'should-be-stripped',
      updatedAt: 'should-be-stripped',
    };
    const result = ImportedConnectionSchema.safeParse(data);
    expect(result.success).toBe(true);
    const parsed = result.data as Record<string, unknown>;
    expect(parsed['_id']).toBeUndefined();
    expect(parsed['tenantId']).toBeUndefined();
    expect(parsed['projectId']).toBeUndefined();
    expect(parsed['createdAt']).toBeUndefined();
    expect(parsed.connectorName).toBe('github');
  });

  it('rejects missing connectorName', () => {
    const data = { displayName: 'X' };
    expect(ImportedConnectionSchema.safeParse(data).success).toBe(false);
  });
});

describe('ImportedGuardrailSchema', () => {
  it('accepts the exported guardrail policy shape and preserves portable scope metadata', () => {
    const data = {
      name: 'Filter',
      scope: { type: 'agent', projectId: 'proj-1', agentDefId: 'a1', agentName: 'AuthAgent' },
      rules: [{ guardrailName: 'pii', override: 'threshold', threshold: 0.8 }],
      settings: {
        failMode: 'closed',
        timeouts: { local: 10, model: 100, llm: 500 },
        streaming: { enabled: true, defaultInterval: 'sentence', chunkSize: 64, maxLatencyMs: 200 },
      },
      status: 'active',
      isActive: true,
    };
    const result = ImportedGuardrailSchema.safeParse(data);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      status: 'active',
      isActive: true,
      scope: {
        type: 'agent',
        projectId: 'proj-1',
        agentDefId: 'a1',
        agentName: 'AuthAgent',
      },
    });
  });

  it('normalizes legacy enabled and agentId fields while stripping internal ownership metadata', () => {
    const data = {
      name: 'Legacy Filter',
      enabled: true,
      scope: { type: 'agent', agentId: 'legacy-agent' },
      _id: 'strip-me',
      tenantId: 'strip-me',
      projectId: 'strip-me',
    };
    const result = ImportedGuardrailSchema.safeParse(data);
    expect(result.success).toBe(true);
    const parsed = result.data as Record<string, unknown>;
    expect(parsed['_id']).toBeUndefined();
    expect(parsed['tenantId']).toBeUndefined();
    expect(parsed['projectId']).toBeUndefined();
    expect(parsed['isActive']).toBe(true);
    expect((parsed['scope'] as Record<string, unknown>)['agentDefId']).toBe('legacy-agent');
    expect((parsed['scope'] as Record<string, unknown>)['agentId']).toBeUndefined();
  });

  it('rejects project-only operational controls on non-project imports', () => {
    const result = ImportedGuardrailSchema.safeParse({
      name: 'Imported Agent Operational Guard',
      scope: { type: 'agent', agentName: 'TransferAgent' },
      caching: { enabled: true },
      budget: { monthlyLimitUsd: 20 },
      settings: {
        webhookUrl: 'https://hooks.example.com/guardrails',
        webhookSecret: 'whsec_test',
      },
    });

    expect(result.success).toBe(false);
  });
});

describe('ImportedWorkflowSchema', () => {
  it('accepts valid workflow', () => {
    const data = {
      name: 'Onboarding',
      type: 'onboarding',
      steps: [{ action: 'greet' }],
    };
    const result = ImportedWorkflowSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('accepts workflow exports with null descriptions', () => {
    const result = ImportedWorkflowSchema.safeParse({
      name: 'Onboarding',
      description: null,
    });

    expect(result.success).toBe(true);
  });

  it('rejects missing name', () => {
    expect(ImportedWorkflowSchema.safeParse({ type: 'x' }).success).toBe(false);
  });
});

describe('ImportedWorkflowVersionSchema', () => {
  it('accepts valid workflow version', () => {
    const data = {
      version: '1.0.0',
      source_hash: 'abc123',
      changelog: 'Initial version',
      definition: { steps: [] },
    };
    const result = ImportedWorkflowVersionSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('accepts nullable changelog', () => {
    const data = { version: '1.0', changelog: null };
    const result = ImportedWorkflowVersionSchema.safeParse(data);
    expect(result.success).toBe(true);
  });
});

describe('ImportedEvalSetSchema', () => {
  it('accepts variants as number', () => {
    const data = { name: 'Eval', variants: 3 };
    const result = ImportedEvalSetSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('strips internal fields', () => {
    const data = { name: 'Eval', _id: 'x', __v: 1, tenantId: 't' };
    const result = ImportedEvalSetSchema.safeParse(data);
    expect(result.success).toBe(true);
    const parsed = result.data as Record<string, unknown>;
    expect(parsed['_id']).toBeUndefined();
    expect(parsed['__v']).toBeUndefined();
    expect(parsed['tenantId']).toBeUndefined();
  });
});

describe('ImportedEvalScenarioSchema', () => {
  it('accepts valid scenario', () => {
    const data = {
      name: 'Happy Path',
      description: 'User books a hotel',
      category: 'booking',
      initialMessage: 'I want to book a hotel',
      maxTurns: 10,
      tags: ['booking', 'hotel'],
    };
    const result = ImportedEvalScenarioSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('rejects missing name', () => {
    expect(ImportedEvalScenarioSchema.safeParse({ category: 'x' }).success).toBe(false);
  });
});

describe('ImportedEvalPersonaSchema', () => {
  it('accepts valid persona', () => {
    const data = {
      name: 'Impatient User',
      communicationStyle: 'terse',
      isAdversarial: true,
      adversarialType: 'impatient',
      sessionVariables: { consumer_id: 'consumer-123', contract_id: 'contract-456' },
    };
    const result = ImportedEvalPersonaSchema.safeParse(data);
    expect(result.success).toBe(true);
    expect(result.data?.sessionVariables).toEqual({
      consumer_id: 'consumer-123',
      contract_id: 'contract-456',
    });
  });
});

describe('ImportedEvaluatorSchema', () => {
  it('accepts valid evaluator', () => {
    const data = {
      name: 'Quality Judge',
      type: 'llm_judge',
      judgeModel: 'gpt-4',
      temperature: 0.3,
    };
    const result = ImportedEvaluatorSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('rejects missing type', () => {
    expect(ImportedEvaluatorSchema.safeParse({ name: 'J' }).success).toBe(false);
  });
});

describe('ImportedSearchIndexSchema', () => {
  it('accepts valid search index', () => {
    const data = {
      name: 'Products',
      slug: 'products',
      embeddingModel: 'bge-m3',
      embeddingDimensions: 1024,
    };
    const result = ImportedSearchIndexSchema.safeParse(data);
    expect(result.success).toBe(true);
  });
});

describe('ImportedSearchSourceSchema', () => {
  it('accepts valid search source', () => {
    const data = { name: 'Docs', sourceType: 'web', indexId: 'idx-1' };
    const result = ImportedSearchSourceSchema.safeParse(data);
    expect(result.success).toBe(true);
  });
});

describe('ImportedKnowledgeBaseSchema', () => {
  it('accepts valid knowledge base', () => {
    const data = { name: 'KB', description: 'Knowledge', isPublic: true };
    const result = ImportedKnowledgeBaseSchema.safeParse(data);
    expect(result.success).toBe(true);
  });
});

describe('ImportedCrawlPatternSchema', () => {
  it('accepts valid crawl pattern', () => {
    const data = {
      domain: 'example.com',
      siteType: 'docs',
      jsRequired: false,
      maxConcurrency: 5,
      confidence: 90,
    };
    const result = ImportedCrawlPatternSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('rejects missing domain', () => {
    expect(ImportedCrawlPatternSchema.safeParse({ siteType: 'docs' }).success).toBe(false);
  });
});

describe('ImportedChannelSchema', () => {
  it('accepts valid channel', () => {
    const data = {
      channelType: 'slack',
      displayName: 'Slack Bot',
      agentId: 'a1',
      config: { token: 'xoxb' },
    };
    const result = ImportedChannelSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('accepts exported channels without a pinned environment', () => {
    const data = {
      channelType: 'slack',
      displayName: 'Slack Bot',
      environment: null,
    };
    const result = ImportedChannelSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('strips internal fields', () => {
    const data = {
      channelType: 'web',
      displayName: 'Widget',
      _id: 'strip',
      status: 'strip',
    };
    const result = ImportedChannelSchema.safeParse(data);
    expect(result.success).toBe(true);
    const parsed = result.data as Record<string, unknown>;
    expect(parsed['_id']).toBeUndefined();
    expect(parsed['status']).toBeUndefined();
  });
});

describe('ImportedWebhookSchema', () => {
  it('accepts valid webhook', () => {
    const data = {
      callbackUrl: 'https://example.com/hook',
      events: ['message.created'],
      description: 'Notify on message',
    };
    const result = ImportedWebhookSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('rejects invalid callback URL', () => {
    const data = { callbackUrl: 'not-a-url' };
    expect(ImportedWebhookSchema.safeParse(data).success).toBe(false);
  });
});

describe('ImportedWidgetConfigSchema', () => {
  it('accepts valid widget config', () => {
    const data = {
      theme: { primary: '#000' },
      branding: { logo: 'url' },
      behavior: { autoOpen: true },
      customCss: '.widget { color: red; }',
      allowedOrigins: ['https://example.com'],
    };
    const result = ImportedWidgetConfigSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('accepts empty widget config', () => {
    const result = ImportedWidgetConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe('ImportedConnectorConfigSchema', () => {
  it('accepts valid connector config', () => {
    const data = {
      connectorType: 'salesforce',
      connectionConfig: { instanceUrl: 'https://sf.com' },
      filterConfig: { version: 2 },
      permissionConfig: { mode: 'full' },
    };
    const result = ImportedConnectorConfigSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('rejects missing connectorType', () => {
    expect(ImportedConnectorConfigSchema.safeParse({}).success).toBe(false);
  });
});

describe('ImportedLookupEntrySchema', () => {
  it('accepts valid lookup entry', () => {
    const data = { tableName: 'codes', value: 'ABC' };
    const result = ImportedLookupEntrySchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('rejects missing tableName', () => {
    expect(ImportedLookupEntrySchema.safeParse({ value: 'v' }).success).toBe(false);
  });
});

describe('ImportedCanonicalSchemaFile', () => {
  it('accepts valid canonical schema', () => {
    const data = { version: 1, fields: [{ name: 'title', type: 'string' }] };
    const result = ImportedCanonicalSchemaFile.safeParse(data);
    expect(result.success).toBe(true);
  });
});

describe('ImportedDomainVocabularySchema', () => {
  it('accepts valid domain vocabulary', () => {
    const data = { version: 1, entries: [{ term: 'API', definition: 'interface' }] };
    const result = ImportedDomainVocabularySchema.safeParse(data);
    expect(result.success).toBe(true);
  });
});

describe('ImportedFactSchema', () => {
  it('accepts valid fact', () => {
    const data = { key: 'company', value: 'Acme' };
    const result = ImportedFactSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('strips internal fields', () => {
    const data = { key: 'k', value: 'v', _id: 'strip', tenantId: 'strip' };
    const result = ImportedFactSchema.safeParse(data);
    expect(result.success).toBe(true);
    const parsed = result.data as Record<string, unknown>;
    expect(parsed['_id']).toBeUndefined();
    expect(parsed['tenantId']).toBeUndefined();
  });
});

// ── validateRecord ────────────────────────────────────────────────────────

describe('validateRecord', () => {
  it('returns valid:true with parsed data for valid input', () => {
    const result = validateRecord(agentRecordSchema, {
      name: 'Bot',
      dslContent: 'AGENT: Bot',
      ...OWNERSHIP,
    });
    expect(result.valid).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.errors).toBeUndefined();
  });

  it('returns valid:false with error details for invalid input', () => {
    const result = validateRecord(agentRecordSchema, { name: '' });
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
    expect(result.errors![0]).toHaveProperty('path');
    expect(result.errors![0]).toHaveProperty('message');
  });
});

// ── validateEntitySchema ──────────────────────────────────────────────────

describe('validateEntitySchema', () => {
  it('validates and sanitizes data for a known file type', () => {
    const data = {
      connectorName: 'sf',
      displayName: 'Salesforce',
      _id: 'strip-me',
      tenantId: 'strip-me',
    };
    const result = validateEntitySchema('connections/sf.connection.json', 'connections', data);
    expect(result.valid).toBe(true);
    expect(result.sanitizedData['connectorName']).toBe('sf');
    expect(result.sanitizedData['_id']).toBeUndefined();
    expect(result.issues).toHaveLength(0);
  });

  it('returns issues for invalid data against a known schema', () => {
    const data = { displayName: '' }; // missing connectorName
    const result = validateEntitySchema('connections/x.connection.json', 'connections', data);
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0].file).toBe('connections/x.connection.json');
    expect(result.issues[0].layer).toBe('connections');
  });

  it('preserves exported guardrail status and portable agent scope metadata', () => {
    const data = {
      name: 'Portable Guard',
      status: 'draft',
      scope: {
        type: 'agent',
        projectId: 'proj-1',
        agentId: 'legacy-agent',
        agentName: 'TransferAgent',
      },
      enabled: false,
    };
    const result = validateEntitySchema('guardrails/portable.guardrail.json', 'guardrails', data);
    expect(result.valid).toBe(true);
    expect(result.sanitizedData['status']).toBe('draft');
    expect(result.sanitizedData['isActive']).toBe(false);
    expect(result.sanitizedData['enabled']).toBeUndefined();
    expect(result.sanitizedData['scope']).toEqual({
      type: 'agent',
      projectId: 'proj-1',
      agentDefId: 'legacy-agent',
      agentName: 'TransferAgent',
    });
  });

  it('strips internal fields for unknown file types', () => {
    const data = {
      customField: 'keep',
      _id: 'strip',
      tenantId: 'strip',
      projectId: 'strip',
    };
    const result = validateEntitySchema('unknown/custom.json', 'custom', data);
    expect(result.valid).toBe(true);
    expect(result.sanitizedData['customField']).toBe('keep');
    expect(result.sanitizedData['_id']).toBeUndefined();
    expect(result.sanitizedData['tenantId']).toBeUndefined();
  });
});

// ── getSchemaForFile ──────────────────────────────────────────────────────

describe('getSchemaForFile', () => {
  it('returns ImportedConnectionSchema for .connection.json', () => {
    expect(getSchemaForFile('connections/sf.connection.json')).toBe(ImportedConnectionSchema);
  });

  it('returns ImportedConnectorConfigSchema for .connector-config.json', () => {
    expect(getSchemaForFile('connections/sf.connector-config.json')).toBe(
      ImportedConnectorConfigSchema,
    );
  });

  it('returns ImportedGuardrailSchema for .guardrail.json', () => {
    expect(getSchemaForFile('guardrails/filter.guardrail.json')).toBe(ImportedGuardrailSchema);
  });

  it('returns ImportedGuardrailSchema for .guardrail.yaml', () => {
    expect(getSchemaForFile('guardrails/filter.guardrail.yaml')).toBe(ImportedGuardrailSchema);
  });

  it('returns ImportedWorkflowSchema for .workflow.json', () => {
    expect(getSchemaForFile('workflows/onboard.workflow.json')).toBe(ImportedWorkflowSchema);
  });

  it('returns ImportedWorkflowVersionSchema for .version.json', () => {
    expect(getSchemaForFile('workflows/v1.version.json')).toBe(ImportedWorkflowVersionSchema);
  });

  it('returns ImportedEvalSetSchema for eval-set.json', () => {
    expect(getSchemaForFile('evals/eval-set.json')).toBe(ImportedEvalSetSchema);
  });

  it('returns ImportedEvaluatorSchema for .evaluator.json', () => {
    expect(getSchemaForFile('evals/judge.evaluator.json')).toBe(ImportedEvaluatorSchema);
  });

  it('returns ImportedEvalScenarioSchema for .scenario.json', () => {
    expect(getSchemaForFile('evals/happy.scenario.json')).toBe(ImportedEvalScenarioSchema);
  });

  it('returns ImportedEvalPersonaSchema for .persona.json', () => {
    expect(getSchemaForFile('evals/angry.persona.json')).toBe(ImportedEvalPersonaSchema);
  });

  it('returns ImportedSearchIndexSchema for .index.json', () => {
    expect(getSchemaForFile('search/products.index.json')).toBe(ImportedSearchIndexSchema);
  });

  it('returns ImportedSearchSourceSchema for .source.json', () => {
    expect(getSchemaForFile('search/docs.source.json')).toBe(ImportedSearchSourceSchema);
  });

  it('returns ImportedKnowledgeBaseSchema for .kb.json', () => {
    expect(getSchemaForFile('search/main.kb.json')).toBe(ImportedKnowledgeBaseSchema);
  });

  it('returns ImportedChannelSchema for .channel.json', () => {
    expect(getSchemaForFile('channels/slack.channel.json')).toBe(ImportedChannelSchema);
  });

  it('returns ImportedWebhookSchema for .webhook.json', () => {
    expect(getSchemaForFile('channels/notify.webhook.json')).toBe(ImportedWebhookSchema);
  });

  it('returns ImportedWidgetConfigSchema for widget-config.json', () => {
    expect(getSchemaForFile('channels/widgets/widget-config.json')).toBe(
      ImportedWidgetConfigSchema,
    );
  });

  it('returns ImportedCanonicalSchemaFile for .schema.json', () => {
    expect(getSchemaForFile('vocabulary/product.schema.json')).toBe(ImportedCanonicalSchemaFile);
  });

  it('returns null for unrecognized file paths', () => {
    expect(getSchemaForFile('random/file.json')).toBeNull();
  });

  it('returns null for empty file path', () => {
    expect(getSchemaForFile('')).toBeNull();
  });
});
