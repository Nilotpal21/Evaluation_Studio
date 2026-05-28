import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockApiFetch = vi.hoisted(() => vi.fn());

vi.mock('../lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  handleResponse: vi.fn(),
}));

import { applyImport, fetchImportPreview, fetchImportStatus } from '../api/project-io';

describe('project-io import client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves structured preview failures on non-2xx responses', async () => {
    mockApiFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Import preview contains blocking issues',
          },
          warnings: ['Preview stopped early'],
          preview: {
            valid: false,
            formatVersion: '2.0',
            layers: ['core'],
            layerChanges: { core: { added: 0, modified: 0, removed: 0, unchanged: 0 } },
            agentChanges: { added: [], modified: [], removed: [], unchanged: [] },
            toolChanges: { added: [], modified: [], removed: [] },
            shaIntegrity: {
              valid: true,
              integrityMatch: true,
              layerResults: {},
              errors: [],
              warnings: [],
            },
            crossLayerDeps: { valid: true, missingDependencies: [], warnings: [] },
            syntaxErrors: [],
            issues: [],
            hasBlockingIssues: true,
            requiresAcknowledgement: false,
            blockingIssueCount: 1,
            nonBlockingIssueCount: 0,
            entryAgentResolution: {
              requested: null,
              resolved: null,
              matchedBy: 'none',
            },
            warnings: [],
          },
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const result = await fetchImportPreview('proj-1', {
      'agents/main.agent.abl': 'GOAL: Missing header',
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Import preview contains blocking issues',
      },
      warnings: ['Preview stopped early'],
      preview: {
        hasBlockingIssues: true,
        blockingIssueCount: 1,
      },
    });
  });

  it('preserves structured apply failures with stage and sanitized cause', async () => {
    mockApiFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          error: {
            code: 'IMPORT_APPLY_FAILED',
            message: 'Import failed during apply',
            stage: 'apply',
            sanitizedCause: 'Persistence operation failed',
          },
          warnings: ['Snapshot created'],
          operationId: 'import-op-1',
          previewDigest: 'digest-1',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const result = await applyImport(
      'proj-1',
      {
        'agents/main.agent.abl': 'AGENT: Main\nGOAL: Help customers\n',
      },
      {
        previewDigest: 'digest-1',
        acknowledgedIssueIds: [],
      },
    );

    expect(result).toEqual({
      success: false,
      error: {
        code: 'IMPORT_APPLY_FAILED',
        message: 'Import failed during apply',
        stage: 'apply',
        sanitizedCause: 'Persistence operation failed',
      },
      warnings: ['Snapshot created'],
      operationId: 'import-op-1',
      previewDigest: 'digest-1',
    });
  });

  it('normalizes generic error envelopes into an import error payload', async () => {
    mockApiFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          errors: [
            { code: 'VALIDATION_ERROR', msg: 'Invalid JSON body' },
            { code: 'VALIDATION_ERROR', msg: 'files map is required' },
          ],
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const result = await fetchImportPreview('proj-1', {
      'agents/main.agent.abl': 'AGENT: Main\nGOAL: Help customers\n',
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid JSON body | files map is required',
      },
      errors: [
        { code: 'VALIDATION_ERROR', msg: 'Invalid JSON body' },
        { code: 'VALIDATION_ERROR', msg: 'files map is required' },
      ],
    });
  });

  it('fetches import operation status by operation id', async () => {
    mockApiFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            operationId: 'import-op-1',
            status: 'failed',
            layers: {
              core: { status: 'activated' },
              guardrails: { status: 'rolled_back' },
            },
            error: {
              phase: 'apply',
              layer: 'guardrails',
              message: 'Guardrail import failed',
            },
            createdAt: '2026-05-06T10:00:00.000Z',
            updatedAt: '2026-05-06T10:01:00.000Z',
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const result = await fetchImportStatus('proj-1', 'import-op-1');

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/projects/proj-1/import/status?operationId=import-op-1',
      {
        headers: { 'Content-Type': 'application/json' },
      },
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        status: 'failed',
        layers: {
          core: { status: 'activated' },
          guardrails: { status: 'rolled_back' },
        },
      },
    });
  });
});
