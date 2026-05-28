import { describe, it, expect, vi } from 'vitest';
import { readFolderV2 } from '../import/folder-reader.js';
import { StagedImporter } from '../import/staged-importer.js';
import type { ImportDbAdapter } from '../import/staged-importer.js';

describe('Import — workflow version files', () => {
  it('folder reader detects workflow version files separately from working copies', () => {
    const files = new Map<string, string>();
    files.set('agents/main_agent.agent.abl', 'AGENT: main_agent\nGOAL: test');
    files.set(
      'workflows/order_processing.workflow.json',
      JSON.stringify({ name: 'order_processing', steps: [] }),
    );
    files.set(
      'workflows/versions/order_processing/1.0.0.version.json',
      JSON.stringify({
        version: '1.0.0',
        source_hash: 'hash1',
        status: 'active',
        definition: { steps: [] },
        created_by: 'user-1',
      }),
    );
    files.set(
      'workflows/versions/order_processing/2.0.0.version.json',
      JSON.stringify({
        version: '2.0.0',
        source_hash: 'hash2',
        status: 'active',
        definition: { steps: [{ id: 's1', type: 'delay' }] },
        created_by: 'user-1',
      }),
    );

    const result = readFolderV2(files);

    // Working copy files should NOT include version files
    expect(result.workflowFiles.size).toBe(1);
    expect(result.workflowFiles.has('workflows/order_processing.workflow.json')).toBe(true);

    // Version files should be in separate map
    expect(result.workflowVersionFiles.size).toBe(2);
    expect(
      result.workflowVersionFiles.has('workflows/versions/order_processing/1.0.0.version.json'),
    ).toBe(true);
    expect(
      result.workflowVersionFiles.has('workflows/versions/order_processing/2.0.0.version.json'),
    ).toBe(true);
  });

  it('version files are merged into layerFiles.workflows for lockfile hash consistency', () => {
    const files = new Map<string, string>();
    files.set('agents/main_agent.agent.abl', 'AGENT: main_agent\nGOAL: test');
    files.set(
      'workflows/order_processing.workflow.json',
      JSON.stringify({ name: 'order_processing', steps: [] }),
    );
    files.set(
      'workflows/versions/order_processing/1.0.0.version.json',
      JSON.stringify({
        version: '1.0.0',
        source_hash: 'hash1',
        status: 'active',
        definition: { steps: [] },
      }),
    );

    const result = readFolderV2(files);

    // layerFiles.workflows should include both working copy and version files
    const workflowLayerPaths = [...result.layerFiles.workflows.keys()];
    expect(workflowLayerPaths).toHaveLength(2);
    expect(workflowLayerPaths).toContain('workflows/order_processing.workflow.json');
    expect(workflowLayerPaths).toContain('workflows/versions/order_processing/1.0.0.version.json');
  });

  it('imported version status is always reset to draft via buildWorkflowVersionRecords', () => {
    const mockDb: ImportDbAdapter = {
      createImportOperation: vi.fn(),
      updateImportOperation: vi.fn(),
      insertStagedRecords: vi.fn(),
      deleteRecordsByIds: vi.fn(),
      activateLayer: vi.fn(),
      rollbackLayer: vi.fn(),
      findActiveRecordIds: vi.fn(),
    };
    const importer = new StagedImporter(mockDb);

    const versionFiles = new Map<string, string>();
    versionFiles.set(
      'workflows/versions/order_processing/1.0.0.version.json',
      JSON.stringify({
        version: '1.0.0',
        source_hash: 'hash1',
        status: 'active',
        changelog: 'Production release',
        created_by: 'user-1',
        definition: { steps: [{ id: 's1', type: 'http' }] },
      }),
    );
    versionFiles.set(
      'workflows/versions/order_processing/2.0.0.version.json',
      JSON.stringify({
        version: '2.0.0',
        source_hash: 'hash2',
        status: 'active',
        definition: { steps: [] },
      }),
    );

    const { records, warnings } = importer.buildWorkflowVersionRecords(
      versionFiles,
      'proj-1',
      'tenant-1',
      'import-user',
    );

    expect(warnings).toHaveLength(0);
    expect(records).toHaveLength(2);

    // All records should have status reset to draft
    for (const record of records) {
      expect(record.data.status).toBe('draft');
      expect(record.layer).toBe('workflows');
      expect(record.collection).toBe('workflowversions');
      expect(record.data.tenantId).toBe('tenant-1');
      expect(record.data.projectId).toBe('proj-1');
    }

    // Check specific record data
    const v1 = records.find((r) => r.data.version === '1.0.0');
    expect(v1).toBeDefined();
    expect(v1!.data.workflowName).toBe('order_processing');
    expect(v1!.data.sourceHash).toBe('hash1');
    expect(v1!.data.changelog).toBe('Production release');
    expect(v1!.data.createdBy).toBe('user-1');
    expect(v1!.data.definition).toEqual({ steps: [{ id: 's1', type: 'http' }] });
  });

  it('buildWorkflowVersionRecords warns on invalid version files', () => {
    const mockDb: ImportDbAdapter = {
      createImportOperation: vi.fn(),
      updateImportOperation: vi.fn(),
      insertStagedRecords: vi.fn(),
      deleteRecordsByIds: vi.fn(),
      activateLayer: vi.fn(),
      rollbackLayer: vi.fn(),
      findActiveRecordIds: vi.fn(),
    };
    const importer = new StagedImporter(mockDb);

    const versionFiles = new Map<string, string>();
    // Invalid JSON
    versionFiles.set('workflows/versions/broken/1.0.0.version.json', 'not valid json');
    // Missing required fields
    versionFiles.set(
      'workflows/versions/incomplete/1.0.0.version.json',
      JSON.stringify({ version: '1.0.0' }),
    );

    const { records, warnings } = importer.buildWorkflowVersionRecords(
      versionFiles,
      'proj-1',
      'tenant-1',
    );

    expect(records).toHaveLength(0);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('Failed to parse');
    expect(warnings[1]).toContain('missing required fields');
  });

  it('handles export bundle with no workflow versions gracefully', () => {
    const files = new Map<string, string>();
    files.set('agents/main_agent.agent.abl', 'AGENT: main_agent\nGOAL: test');
    files.set(
      'workflows/order_processing.workflow.json',
      JSON.stringify({ name: 'order_processing', steps: [] }),
    );

    const result = readFolderV2(files);

    expect(result.workflowVersionFiles.size).toBe(0);
    expect(result.workflowFiles.size).toBe(1);
  });
});
