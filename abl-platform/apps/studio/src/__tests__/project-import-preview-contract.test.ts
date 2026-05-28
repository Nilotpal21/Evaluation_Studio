import { describe, expect, it, vi } from 'vitest';
import type { ImportPreviewV2 } from '@agent-platform/project-io';

const { mockValidateABL } = vi.hoisted(() => ({
  mockValidateABL: vi.fn(),
}));

vi.mock('@abl/compiler', () => ({
  validateABL: mockValidateABL,
}));

import {
  enrichImportPreview,
  explainImportCompileDiagnostic,
  validatePreviewAcknowledgement,
} from '@agent-platform/project-io/import';

function makePreview(overrides: Partial<ImportPreviewV2> = {}): ImportPreviewV2 {
  return {
    valid: true,
    formatVersion: '2.0',
    layers: ['core'],
    layerChanges: {},
    agentChanges: { added: [], modified: [], removed: [], unchanged: [] },
    toolChanges: { added: [], modified: [], removed: [] },
    shaIntegrity: {
      valid: true,
      integrityMatch: true,
      layerResults: {},
      errors: [],
      warnings: [],
    },
    crossLayerDeps: {
      valid: true,
      missingDependencies: [],
      warnings: [],
    },
    syntaxErrors: [],
    issues: [],
    hasBlockingIssues: false,
    requiresAcknowledgement: false,
    blockingIssueCount: 0,
    nonBlockingIssueCount: 0,
    entryAgentResolution: {
      requested: 'afg_supervisor',
      resolved: 'AFG_Supervisor',
      matchedBy: 'alias',
    },
    warnings: [],
    ...overrides,
  };
}

describe('project import preview contract', () => {
  it('explains common compiler diagnostics with remediation guidance', () => {
    expect(
      explainImportCompileDiagnostic(
        'Tool "process_loan" [workflow_binding]: Workflow tool must have workflow_binding',
      ),
    ).toContain('import the workflows layer');
    expect(
      explainImportCompileDiagnostic(
        'Required parameter "customer_id" of tool "get_checking_accounts" has no description.',
      ),
    ).toContain('add a short parameter description');
    expect(
      explainImportCompileDiagnostic(
        'Banking: W801: Session variable "customer_id" has no population source.',
      ),
    ).toContain('parent agent/runtime context');
  });

  it('adds compiler diagnostics as non-blocking issues and computes a preview digest', () => {
    mockValidateABL.mockReturnValue({
      errors: [
        {
          agent: 'AFG_Supervisor',
          message: 'Compilation failed for FLOW',
          type: 'compilation',
        },
      ],
      warnings: [],
    });

    const preview = enrichImportPreview(
      makePreview(),
      new Map([
        ['agents/afg_supervisor.agent.yaml', 'SUPERVISOR: AFG_Supervisor\nGOAL: Route requests'],
      ]),
    );

    expect(preview.issues).toHaveLength(1);
    expect(preview.issues[0]).toMatchObject({
      category: 'compile',
      severity: 'error',
      blocking: false,
      file: 'agents/afg_supervisor.agent.yaml',
      agent: 'AFG_Supervisor',
    });
    expect(preview.requiresAcknowledgement).toBe(true);
    expect(preview.previewDigest).toBeTruthy();
  });

  it('requires acknowledgement ids and a matching digest before apply', () => {
    mockValidateABL.mockReturnValue({
      errors: [
        {
          agent: 'AFG_Supervisor',
          message: 'Compilation failed for FLOW',
          type: 'compilation',
        },
      ],
      warnings: [],
    });

    const preview = enrichImportPreview(
      makePreview(),
      new Map([
        ['agents/afg_supervisor.agent.yaml', 'SUPERVISOR: AFG_Supervisor\nGOAL: Route requests'],
      ]),
    );

    expect(validatePreviewAcknowledgement(preview, null, [])).toMatchObject({
      ok: false,
      code: 'PREVIEW_ACK_REQUIRED',
    });

    expect(validatePreviewAcknowledgement(preview, 'stale-digest', [])).toMatchObject({
      ok: false,
      code: 'PREVIEW_STALE',
    });

    expect(
      validatePreviewAcknowledgement(
        preview,
        preview.previewDigest,
        preview.issues.filter((issue) => !issue.blocking).map((issue) => issue.id),
      ),
    ).toEqual({ ok: true });
  });

  it('changes the preview digest when the applied change set changes', () => {
    mockValidateABL.mockReturnValue({
      errors: [],
      warnings: [],
    });

    const basePreview = enrichImportPreview(
      makePreview({
        agentChanges: {
          added: ['AFG_Supervisor'],
          modified: [],
          removed: [],
          unchanged: [],
        },
      }),
      new Map([
        ['agents/afg_supervisor.agent.yaml', 'SUPERVISOR: AFG_Supervisor\nGOAL: Route requests'],
      ]),
    );

    const changedPreview = enrichImportPreview(
      makePreview({
        agentChanges: {
          added: ['AFG_Supervisor', 'Helper'],
          modified: [],
          removed: [],
          unchanged: [],
        },
      }),
      new Map([
        ['agents/afg_supervisor.agent.yaml', 'SUPERVISOR: AFG_Supervisor\nGOAL: Route requests'],
      ]),
    );

    expect(basePreview.previewDigest).toBeTruthy();
    expect(changedPreview.previewDigest).toBeTruthy();
    expect(basePreview.previewDigest).not.toEqual(changedPreview.previewDigest);
  });

  it('changes the preview digest when acknowledgement-relevant metadata changes', () => {
    mockValidateABL.mockReturnValue({
      errors: [],
      warnings: [],
    });

    const basePreview = enrichImportPreview(
      makePreview({
        warnings: ['Legacy tool file was normalized'],
      }),
      new Map([
        ['agents/afg_supervisor.agent.yaml', 'SUPERVISOR: AFG_Supervisor\nGOAL: Route requests'],
      ]),
    );

    const changedPreview = enrichImportPreview(
      makePreview({
        warnings: ['Entry agent alias could not be resolved'],
      }),
      new Map([
        ['agents/afg_supervisor.agent.yaml', 'SUPERVISOR: AFG_Supervisor\nGOAL: Route requests'],
      ]),
    );

    expect(basePreview.previewDigest).toBeTruthy();
    expect(changedPreview.previewDigest).toBeTruthy();
    expect(basePreview.issues).toEqual(changedPreview.issues);
    expect(basePreview.previewDigest).not.toEqual(changedPreview.previewDigest);
  });
});
