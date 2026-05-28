import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GuardrailsAssembler } from '../export/layer-assemblers/guardrails-assembler.js';
import { parseGuardrailArchive } from '../guardrail-projection.js';

vi.mock('@agent-platform/database', () => ({
  GuardrailPolicy: { find: vi.fn(), countDocuments: vi.fn() },
  ProjectAgent: { find: vi.fn() },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { GuardrailPolicy, ProjectAgent } from '@agent-platform/database';

const CTX = { projectId: 'proj-1', tenantId: 'tenant-1' };

function mockLean(data: unknown[]) {
  const leanResult = Object.assign(Promise.resolve(data), {
    select: () => Promise.resolve(data),
  });
  return { lean: () => leanResult };
}

describe('GuardrailsAssembler', () => {
  let assembler: GuardrailsAssembler;

  beforeEach(() => {
    vi.clearAllMocks();
    assembler = new GuardrailsAssembler();
  });

  it('should have layer name "guardrails"', () => {
    expect(assembler.layer).toBe('guardrails');
  });

  it('should query policies scoped to project and agent', async () => {
    (GuardrailPolicy.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'gp-1',
          tenantId: 'tenant-1',
          name: 'Content Safety',
          scope: { type: 'project', projectId: 'proj-1' },
          providerOverrides: [],
          rules: [{ guardrailName: 'toxicity', override: 'threshold', threshold: 0.8 }],
          constitution: [],
          settings: {
            failMode: 'closed',
            timeouts: { local: 100, model: 5000, llm: 10000 },
            webhookSecret: 'secret-webhook-key',
            streaming: {
              enabled: true,
              defaultInterval: 'sentence',
              chunkSize: 100,
              maxLatencyMs: 500,
              earlyTermination: true,
            },
          },
          caching: {
            enabled: true,
            exactMatch: true,
            semanticMatch: false,
            semanticThreshold: 0.9,
            defaultTtlSeconds: 300,
          },
          budget: {
            monthlyLimitUsd: 100,
            currentSpendUsd: 25,
            overspendAction: 'alert_only',
          },
          version: 1,
          status: 'active',
          isActive: true,
          __v: 1,
        },
        {
          _id: 'gp-2',
          tenantId: 'tenant-1',
          name: 'Agent Safety',
          scope: { type: 'agent', projectId: 'proj-1', agentDefId: 'agent-1' },
          providerOverrides: [],
          rules: [],
          constitution: [],
          settings: {
            failMode: 'closed',
            timeouts: { local: 100, model: 5000, llm: 10000 },
            streaming: {
              enabled: false,
              defaultInterval: 'sentence',
              chunkSize: 128,
              maxLatencyMs: 250,
              earlyTermination: true,
            },
          },
          caching: {
            enabled: false,
            exactMatch: true,
            semanticMatch: false,
            semanticThreshold: 0.95,
            defaultTtlSeconds: 3600,
          },
          budget: {
            monthlyLimitUsd: 50,
            currentSpendUsd: 5,
            overspendAction: 'alert_only',
          },
          version: 2,
          status: 'draft',
          isActive: false,
          __v: 1,
        },
      ]),
    );
    (ProjectAgent.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([{ _id: 'agent-1', name: 'TransferAgent' }]),
    );

    const result = await assembler.assemble(CTX);

    expect(result.files.has('guardrails/content_safety.guardrail.json')).toBe(true);
    expect(result.files.has('guardrails/agent_safety.guardrail.json')).toBe(true);
    const policy = JSON.parse(result.files.get('guardrails/content_safety.guardrail.json')!);
    const agentPolicy = JSON.parse(result.files.get('guardrails/agent_safety.guardrail.json')!);

    // Verify structure
    expect(policy.name).toBe('Content Safety');
    expect(policy.rules[0].guardrailName).toBe('toxicity');

    // Must NOT contain internal fields
    expect(policy).not.toHaveProperty('_id');
    expect(policy).not.toHaveProperty('__v');
    expect(policy).not.toHaveProperty('tenantId');

    // Must strip webhook secret
    expect(policy.settings).not.toHaveProperty('webhookSecret');

    // Agent-scoped exports include a stable agentName anchor for remapping on import
    expect(agentPolicy.scope).toMatchObject({
      type: 'agent',
      projectId: 'proj-1',
      agentDefId: 'agent-1',
      agentName: 'TransferAgent',
    });
  });

  it('should use correct query with $or for project and agent scopes', async () => {
    (GuardrailPolicy.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (ProjectAgent.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));

    await assembler.assemble(CTX);

    expect(GuardrailPolicy.find).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      $or: [
        { 'scope.type': 'project', 'scope.projectId': 'proj-1' },
        { 'scope.type': 'agent', 'scope.projectId': 'proj-1' },
      ],
    });
  });

  it('should count entities correctly', async () => {
    (GuardrailPolicy.countDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(4);

    const count = await assembler.countEntities(CTX);
    expect(count).toBe(4);
  });

  it('should return empty result when no policies exist', async () => {
    (GuardrailPolicy.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (ProjectAgent.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));

    const result = await assembler.assemble(CTX);
    expect(result.files.size).toBe(0);
    expect(result.entityCount).toBe(0);
  });

  it('exports YAML guardrail archives when requested', async () => {
    (GuardrailPolicy.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'gp-4',
          tenantId: 'tenant-1',
          name: 'Portable Policy',
          scope: { type: 'project', projectId: 'proj-1' },
          rules: [{ guardrailName: 'pii', override: 'action' }],
          settings: {
            failMode: 'closed',
            timeouts: { local: 100, model: 5000, llm: 10000 },
          },
          isActive: true,
          __v: 2,
        },
      ]),
    );
    (ProjectAgent.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));

    const result = await assembler.assemble({ ...CTX, guardrailFormat: 'yaml' });

    expect(result.files.has('guardrails/portable_policy.guardrail.yaml')).toBe(true);
    const warnings: string[] = [];
    const policy = parseGuardrailArchive(
      'guardrails/portable_policy.guardrail.yaml',
      result.files.get('guardrails/portable_policy.guardrail.yaml')!,
      warnings,
    );
    expect(warnings).toHaveLength(0);
    expect(policy).toMatchObject({
      name: 'Portable Policy',
      isActive: true,
    });
  });

  it('strips unsupported provider credential overrides from exported guardrail archives', async () => {
    (GuardrailPolicy.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'gp-5',
          tenantId: 'tenant-1',
          name: 'Legacy Credential Policy',
          scope: { type: 'project', projectId: 'proj-1' },
          providerOverrides: [
            {
              providerName: 'openai',
              authProfileId: 'auth-profile-1',
              apiKeyCredentialId: 'credential-1',
              defaultCategory: 'self_harm',
              defaultThreshold: 0.8,
              costPerEvalUsd: 0.01,
              isActive: true,
            },
          ],
          rules: [{ guardrailName: 'pii', override: 'threshold', threshold: 0.75 }],
          settings: {
            failMode: 'closed',
            timeouts: { local: 100, model: 5000, llm: 10000 },
          },
          isActive: true,
          __v: 3,
        },
      ]),
    );
    (ProjectAgent.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));

    const result = await assembler.assemble(CTX);
    const policy = JSON.parse(
      result.files.get('guardrails/legacy_credential_policy.guardrail.json')!,
    );

    expect(policy.providerOverrides).toEqual([
      {
        providerName: 'openai',
        defaultCategory: 'self_harm',
        defaultThreshold: 0.8,
        costPerEvalUsd: 0.01,
        isActive: true,
      },
    ]);
  });

  it('adds a warning when an agent-scoped guardrail cannot be mapped to an agent name', async () => {
    (GuardrailPolicy.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'gp-3',
          tenantId: 'tenant-1',
          name: 'Missing Agent Guard',
          scope: { type: 'agent', projectId: 'proj-1', agentDefId: 'missing-agent' },
          providerOverrides: [],
          rules: [],
          constitution: [],
          settings: {
            failMode: 'closed',
            timeouts: { local: 100, model: 5000, llm: 10000 },
            streaming: {
              enabled: false,
              defaultInterval: 'sentence',
              chunkSize: 128,
              maxLatencyMs: 250,
              earlyTermination: true,
            },
          },
          caching: {
            enabled: false,
            exactMatch: true,
            semanticMatch: false,
            semanticThreshold: 0.95,
            defaultTtlSeconds: 3600,
          },
          budget: {
            monthlyLimitUsd: 50,
            currentSpendUsd: 5,
            overspendAction: 'alert_only',
          },
          version: 1,
          status: 'active',
          isActive: true,
          __v: 1,
        },
      ]),
    );
    (ProjectAgent.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));

    const result = await assembler.assemble(CTX);

    expect(result.warnings).toContain(
      'Guardrail "Missing Agent Guard" references agentDefId "missing-agent" with no matching project agent name',
    );
  });
});
