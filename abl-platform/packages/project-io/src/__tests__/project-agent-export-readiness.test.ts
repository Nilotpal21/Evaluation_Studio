import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildInvalidProjectExportPayload,
  buildInvalidAgentDraftExportPayload,
  getProjectExportReadinessIssues,
  getProjectAgentExportReadinessIssues,
  hasBlockingProjectAgentDraftReadinessStatus,
} from '../project-agent-export-readiness.js';

const mockValidateProjectRuntimeConfigWrite = vi.fn();
const mockValidateProjectModelPolicyConfigWrite = vi.fn();

function stripImportMetadata(data: Record<string, unknown>): Record<string, unknown> {
  const {
    _id: _id,
    id: id,
    __v: __v,
    _v: _v,
    tenantId: tenantId,
    projectId: projectId,
    createdAt: createdAt,
    updatedAt: updatedAt,
    createdBy: createdBy,
    sourceFile: sourceFile,
    ...portableData
  } = data;
  return portableData;
}

vi.mock('../import/runtime-config-save-validation.js', () => ({
  stripModelPolicyImportMetadata: stripImportMetadata,
  stripRuntimeConfigSaveValidationMetadata: stripImportMetadata,
  validateProjectRuntimeConfigWrite: (...args: unknown[]) =>
    mockValidateProjectRuntimeConfigWrite(...args),
  validateProjectModelPolicyConfigWrite: (...args: unknown[]) =>
    mockValidateProjectModelPolicyConfigWrite(...args),
}));

describe('project agent export readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateProjectRuntimeConfigWrite.mockResolvedValue({ valid: true, data: {} });
    mockValidateProjectModelPolicyConfigWrite.mockReturnValue({ valid: true, data: {} });
  });

  it('reports only non-empty persisted drafts with blocking validation errors', () => {
    const issues = getProjectAgentExportReadinessIssues([
      {
        name: 'valid_agent',
        dslContent: 'AGENT: valid_agent\nGOAL: "Help"',
        dslValidationStatus: 'valid',
      },
      {
        name: 'empty_draft',
        dslContent: '  ',
        dslValidationStatus: 'error',
      },
      {
        name: 'broken_agent',
        dslContent: 'AGENT: broken_agent\nHANDOFF:\n  - TO: missing_agent',
        dslValidationStatus: 'error',
        dslDiagnostics: [{ severity: 'error', message: 'Unknown handoff target' }],
      },
    ]);

    expect(issues).toEqual([
      {
        kind: 'agent_draft',
        agentName: 'broken_agent',
        diagnostics: [{ severity: 'error', message: 'Unknown handoff target' }],
      },
    ]);
  });

  it('fails closed for non-empty drafts without trusted validation metadata', () => {
    const issues = getProjectAgentExportReadinessIssues([
      {
        name: 'legacy_agent',
        dslContent: 'AGENT: legacy_agent\nGOAL: "Help"',
        dslValidationStatus: null,
      },
      {
        name: 'unknown_agent',
        dslContent: 'AGENT: unknown_agent\nGOAL: "Help"',
        dslValidationStatus: 'pending',
      },
    ]);

    expect(issues).toEqual([
      {
        kind: 'agent_draft',
        agentName: 'legacy_agent',
        diagnostics: [
          {
            severity: 'error',
            message:
              'Agent draft has not been validated. Save or revalidate the draft before exporting.',
            source: 'project-agent-export-readiness',
          },
        ],
      },
      {
        kind: 'agent_draft',
        agentName: 'unknown_agent',
        diagnostics: [
          {
            severity: 'error',
            message:
              'Agent draft has not been validated. Save or revalidate the draft before exporting.',
            source: 'project-agent-export-readiness',
          },
        ],
      },
    ]);
  });

  it('exposes the canonical draft readiness predicate for runtime consumers', () => {
    expect(
      hasBlockingProjectAgentDraftReadinessStatus({
        dslContent: 'AGENT: valid_agent\nGOAL: "Help"',
        dslValidationStatus: 'valid',
      }),
    ).toBe(false);
    expect(
      hasBlockingProjectAgentDraftReadinessStatus({
        dslContent: 'AGENT: warning_agent\nGOAL: "Help"',
        dslValidationStatus: 'warning',
      }),
    ).toBe(false);
    expect(
      hasBlockingProjectAgentDraftReadinessStatus({
        dslContent: 'AGENT: empty_agent\nGOAL: "Help"',
        dslValidationStatus: null,
      }),
    ).toBe(true);
    expect(
      hasBlockingProjectAgentDraftReadinessStatus({
        dslContent: '  ',
        dslValidationStatus: 'error',
      }),
    ).toBe(false);
  });

  it('builds the stable invalid-draft export error payload', () => {
    expect(
      buildInvalidAgentDraftExportPayload([
        {
          kind: 'agent_draft',
          agentName: 'broken_agent',
          diagnostics: [{ severity: 'error', message: 'Unknown handoff target' }],
        },
      ]),
    ).toMatchObject({
      success: false,
      error: {
        code: 'INVALID_AGENT_DRAFT',
      },
      issues: [{ kind: 'agent_draft', agentName: 'broken_agent' }],
    });
  });

  it('reports runtime config readiness issues through the project-level helper', async () => {
    mockValidateProjectRuntimeConfigWrite.mockResolvedValue({
      valid: false,
      code: 'RUNTIME_CONFIG_PROMPT_REF_INVALID',
      status: 400,
      message: 'Runtime filler promptRef must reference an active project prompt version',
    });

    const issues = await getProjectExportReadinessIssues({
      agents: [],
      tenantId: 'tenant-1',
      projectId: 'project-1',
      runtimeConfig: {
        filler: {
          enabled: true,
          promptRef: { promptId: 'prompt-1', versionId: 'archived-version' },
        },
        tenantId: 'tenant-1',
        projectId: 'project-1',
      },
    });

    expect(issues).toEqual([
      {
        kind: 'runtime_config',
        diagnostics: [
          {
            severity: 'error',
            message: 'Runtime filler promptRef must reference an active project prompt version',
            source: 'export-runtime-config-readiness',
          },
        ],
      },
    ]);
    expect(mockValidateProjectRuntimeConfigWrite).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      data: {
        filler: {
          enabled: true,
          promptRef: { promptId: 'prompt-1', versionId: 'archived-version' },
        },
      },
    });
  });

  it('reports canonical LLM config readiness issues through the project-level helper', async () => {
    mockValidateProjectModelPolicyConfigWrite.mockReturnValue({
      valid: false,
      code: 'MODEL_POLICY_OPERATION_TIERS_INVALID',
      status: 400,
      message:
        'Invalid operation-tier overrides (incompatible operation/tier pair(s): response_gen=voice).',
    });

    const issues = await getProjectExportReadinessIssues({
      agents: [],
      tenantId: 'tenant-1',
      projectId: 'project-1',
      runtimeConfig: {
        operationTierOverrides: {
          response_gen: 'balanced',
        },
      },
      llmConfig: {
        operationTierOverrides: {
          response_gen: 'voice',
        },
        tenantId: 'tenant-1',
        projectId: 'project-1',
      },
    });

    expect(issues).toEqual([
      {
        kind: 'model_policy',
        diagnostics: [
          {
            severity: 'error',
            message:
              'Invalid operation-tier overrides (incompatible operation/tier pair(s): response_gen=voice).',
            source: 'export-model-policy-readiness',
          },
        ],
      },
    ]);
    expect(mockValidateProjectModelPolicyConfigWrite).toHaveBeenCalledWith({
      data: {
        operationTierOverrides: {
          response_gen: 'voice',
        },
      },
    });
  });

  it('builds the stable invalid-project export error payload', () => {
    expect(
      buildInvalidProjectExportPayload([
        {
          kind: 'runtime_config',
          diagnostics: [
            {
              severity: 'error',
              message: 'Runtime filler promptRef must reference an active project prompt version',
            },
          ],
        },
      ]),
    ).toMatchObject({
      success: false,
      error: {
        code: 'INVALID_AGENT_DRAFT',
      },
      issues: [{ kind: 'runtime_config' }],
    });
  });
});
