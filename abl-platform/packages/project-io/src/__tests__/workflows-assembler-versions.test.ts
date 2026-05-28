import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkflowsAssembler } from '../export/layer-assemblers/workflows-assembler.js';

vi.mock('@agent-platform/database', () => ({
  Workflow: { find: vi.fn(), countDocuments: vi.fn() },
}));

vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: { find: vi.fn() },
  WorkflowVersion: { find: vi.fn() },
  TriggerRegistration: { find: vi.fn() },
  Deployment: { find: vi.fn() },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { Workflow } from '@agent-platform/database';
import {
  AuthProfile,
  WorkflowVersion,
  Deployment,
  TriggerRegistration,
} from '@agent-platform/database/models';

const CTX = { projectId: 'proj-1', tenantId: 'tenant-1' };

function mockLean(data: unknown[]) {
  const leanResult = Object.assign(Promise.resolve(data), {
    select: () => Promise.resolve(data),
  });
  return { lean: () => leanResult };
}

function mockLeanSimple(data: unknown[]) {
  return { lean: () => Promise.resolve(data) };
}

describe('WorkflowsAssembler — version export', () => {
  let assembler: WorkflowsAssembler;

  beforeEach(() => {
    vi.clearAllMocks();
    assembler = new WorkflowsAssembler();
    (TriggerRegistration.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLeanSimple([]));
    (AuthProfile.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
  });

  it('includes pinned version files when includeDeployments is true', async () => {
    (Workflow.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'wf-1',
          name: 'order_processing',
          type: 'cx_automation',
          steps: [{ id: 's1', type: 'http' }],
          status: 'active',
        },
      ]),
    );

    (Deployment.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLeanSimple([
        {
          workflowVersionManifest: { order_processing: '1.0.0' },
        },
      ]),
    );

    (WorkflowVersion.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLeanSimple([
        {
          workflowId: 'wf-1',
          version: '1.0.0',
          sourceHash: 'hash1',
          state: 'active',
          changelog: 'First release',
          createdBy: 'user-1',
          createdAt: new Date('2026-03-09'),
          definition: { steps: [{ id: 's1', type: 'http' }] },
        },
      ]),
    );

    const result = await assembler.assemble({
      ...CTX,
      includeDeployments: true,
    });

    // Working copy file
    expect(result.files.has('workflows/order_processing.workflow.json')).toBe(true);

    // Pinned version file
    const versionPath = 'workflows/versions/order_processing/1.0.0.version.json';
    expect(result.files.has(versionPath)).toBe(true);

    const versionData = JSON.parse(result.files.get(versionPath)!);
    expect(versionData.version).toBe('1.0.0');
    expect(versionData.source_hash).toBe('hash1');
    expect(versionData.state).toBe('active');
    expect(versionData.definition).toBeDefined();
    expect(versionData.definition.steps).toHaveLength(1);
  });

  it('skips deployment-pinned version query when includeDeployments is false', async () => {
    // In the version-first model, canonical versions are always exported via
    // assembleAllVersions(). Only the extra deployment-pinned pass is gated
    // behind includeDeployments. With no WorkflowVersion records and
    // includeDeployments omitted, Deployment.find must not be queried and no
    // version files are produced.
    (Workflow.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'wf-1',
          name: 'order_processing',
          type: 'cx_automation',
          steps: [],
          status: 'active',
        },
      ]),
    );
    (WorkflowVersion.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLeanSimple([]));

    const result = await assembler.assemble(CTX);

    expect(result.files.has('workflows/order_processing.workflow.json')).toBe(true);
    const versionFiles = [...result.files.keys()].filter((k) => k.includes('/versions/'));
    expect(versionFiles).toHaveLength(0);
    expect(Deployment.find).not.toHaveBeenCalled();
  });

  it('handles multiple workflows with multiple pinned versions', async () => {
    (Workflow.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'wf-1',
          name: 'order_processing',
          type: 'cx_automation',
          steps: [],
          status: 'active',
        },
        { _id: 'wf-2', name: 'ticket_routing', type: 'cx_automation', steps: [], status: 'active' },
      ]),
    );

    (Deployment.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLeanSimple([
        { workflowVersionManifest: { order_processing: '1.0.0' } },
        { workflowVersionManifest: { order_processing: '2.0.0', ticket_routing: '0.1.0' } },
      ]),
    );

    (WorkflowVersion.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLeanSimple([
        {
          workflowId: 'wf-1',
          version: '1.0.0',
          sourceHash: 'hash1',
          status: 'active',
          definition: { steps: [] },
          createdBy: 'user-1',
          createdAt: new Date(),
        },
        {
          workflowId: 'wf-1',
          version: '2.0.0',
          sourceHash: 'hash2',
          status: 'active',
          definition: { steps: [{ id: 's1', type: 'delay' }] },
          createdBy: 'user-1',
          createdAt: new Date(),
        },
        {
          workflowId: 'wf-2',
          version: '0.1.0',
          sourceHash: 'hash3',
          status: 'draft',
          definition: { steps: [] },
          createdBy: 'user-1',
          createdAt: new Date(),
        },
      ]),
    );

    const result = await assembler.assemble({
      ...CTX,
      includeDeployments: true,
    });

    expect(result.files.has('workflows/versions/order_processing/1.0.0.version.json')).toBe(true);
    expect(result.files.has('workflows/versions/order_processing/2.0.0.version.json')).toBe(true);
    expect(result.files.has('workflows/versions/ticket_routing/0.1.0.version.json')).toBe(true);
  });

  it('keeps colliding workflow filenames and version directories distinct', async () => {
    (Workflow.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        { _id: 'wf-1', name: 'Sales Flow', type: 'cx_automation', steps: [], status: 'active' },
        { _id: 'wf-2', name: 'Sales/Flow', type: 'cx_automation', steps: [], status: 'active' },
      ]),
    );

    (WorkflowVersion.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLeanSimple([
        {
          workflowId: 'wf-1',
          version: 'draft',
          sourceHash: 'hash1',
          state: 'active',
          definition: { steps: [{ id: 'first' }] },
          createdBy: 'user-1',
          createdAt: new Date(),
        },
        {
          workflowId: 'wf-2',
          version: 'draft',
          sourceHash: 'hash2',
          state: 'active',
          definition: { steps: [{ id: 'second' }] },
          createdBy: 'user-1',
          createdAt: new Date(),
        },
      ]),
    );

    const result = await assembler.assemble(CTX);

    expect(result.files.has('workflows/sales_flow.workflow.json')).toBe(true);
    expect(result.files.has('workflows/sales_flow_2.workflow.json')).toBe(true);
    expect(result.files.has('workflows/versions/sales_flow/draft.version.json')).toBe(true);
    expect(result.files.has('workflows/versions/sales_flow_2/draft.version.json')).toBe(true);
    expect(
      JSON.parse(result.files.get('workflows/versions/sales_flow/draft.version.json')!).definition
        .steps[0].id,
    ).toBe('first');
    expect(
      JSON.parse(result.files.get('workflows/versions/sales_flow_2/draft.version.json')!).definition
        .steps[0].id,
    ).toBe('second');
  });

  it('keeps colliding workflow version filenames distinct', async () => {
    (Workflow.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        { _id: 'wf-1', name: 'Sales Flow', type: 'cx_automation', steps: [], status: 'active' },
      ]),
    );

    (WorkflowVersion.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLeanSimple([
        {
          workflowId: 'wf-1',
          version: 'v 1',
          sourceHash: 'hash1',
          state: 'inactive',
          definition: { steps: [{ id: 'first' }] },
          createdBy: 'user-1',
          createdAt: new Date(),
        },
        {
          workflowId: 'wf-1',
          version: 'v/1',
          sourceHash: 'hash2',
          state: 'active',
          definition: { steps: [{ id: 'second' }] },
          createdBy: 'user-1',
          createdAt: new Date(),
        },
      ]),
    );

    const result = await assembler.assemble(CTX);

    expect(result.files.has('workflows/versions/sales_flow/v_1.version.json')).toBe(true);
    expect(result.files.has('workflows/versions/sales_flow/v_1_2.version.json')).toBe(true);
    expect(
      JSON.parse(result.files.get('workflows/versions/sales_flow/v_1.version.json')!).definition
        .steps[0].id,
    ).toBe('first');
    expect(
      JSON.parse(result.files.get('workflows/versions/sales_flow/v_1_2.version.json')!).definition
        .steps[0].id,
    ).toBe('second');
  });

  it('exports workflow trigger auth bindings by portable profile name', async () => {
    (Workflow.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        { _id: 'wf-1', name: 'Sales Flow', type: 'cx_automation', steps: [], status: 'active' },
      ]),
    );
    (WorkflowVersion.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLeanSimple([
        {
          _id: 'wv-1',
          workflowId: 'wf-1',
          version: 'draft',
          sourceHash: 'hash1',
          state: 'active',
          definition: { steps: [] },
          createdBy: 'user-1',
          createdAt: new Date(),
        },
      ]),
    );
    (TriggerRegistration.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLeanSimple([
        {
          _id: 'tr-1',
          workflowId: 'wf-1',
          workflowVersionId: 'wv-1',
          triggerType: 'webhook',
          triggerName: 'webhook',
          config: {},
          authProfileId: 'source-profile-id',
        },
      ]),
    );
    (AuthProfile.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([{ _id: 'source-profile-id', name: 'production-oauth' }]),
    );

    const result = await assembler.assemble(CTX);
    const versionData = JSON.parse(
      result.files.get('workflows/versions/sales_flow/draft.version.json')!,
    );

    expect(versionData.triggers[0].authProfileName).toBe('production-oauth');
    expect(versionData.triggers[0]).not.toHaveProperty('authProfileId');
  });

  it('warns when a pinned version is not found in database', async () => {
    (Workflow.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'wf-1',
          name: 'order_processing',
          type: 'cx_automation',
          steps: [],
          status: 'active',
        },
      ]),
    );

    (Deployment.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLeanSimple([{ workflowVersionManifest: { order_processing: '2.0.0' } }]),
    );

    // No versions exist in DB
    (WorkflowVersion.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLeanSimple([]));

    const result = await assembler.assemble({
      ...CTX,
      includeDeployments: true,
    });

    expect(result.warnings).toContain(
      'Workflow "order_processing" version "2.0.0" referenced in deployment manifest not found',
    );
  });

  it('sanitizes version string in file path to prevent path traversal', async () => {
    (Workflow.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'wf-1',
          name: 'order_processing',
          type: 'cx_automation',
          steps: [],
          status: 'active',
        },
      ]),
    );

    (Deployment.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLeanSimple([{ workflowVersionManifest: { order_processing: '../../etc/passwd' } }]),
    );

    (WorkflowVersion.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLeanSimple([
        {
          workflowId: 'wf-1',
          version: '../../etc/passwd',
          sourceHash: 'hash1',
          status: 'active',
          definition: { steps: [] },
          createdBy: 'user-1',
          createdAt: new Date(),
        },
      ]),
    );

    const result = await assembler.assemble({
      ...CTX,
      includeDeployments: true,
    });

    // Should sanitize path traversal characters — slashes replaced with underscores
    const versionPaths = [...result.files.keys()].filter((k) => k.includes('/versions/'));
    expect(versionPaths).toHaveLength(1);
    // Path traversal slashes are removed, dots are harmless without slashes
    expect(versionPaths[0]).toBe(
      'workflows/versions/order_processing/.._.._etc_passwd.version.json',
    );
    // Crucially, the path should NOT contain directory traversal sequences
    expect(versionPaths[0]).not.toContain('/../');
  });

  it('includes projectId in WorkflowVersion query', async () => {
    (Workflow.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'wf-1',
          name: 'order_processing',
          type: 'cx_automation',
          steps: [],
          status: 'active',
        },
      ]),
    );

    (Deployment.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLeanSimple([{ workflowVersionManifest: { order_processing: '1.0.0' } }]),
    );

    (WorkflowVersion.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLeanSimple([
        {
          workflowId: 'wf-1',
          version: '1.0.0',
          sourceHash: 'hash1',
          status: 'active',
          definition: { steps: [] },
          createdBy: 'user-1',
          createdAt: new Date(),
        },
      ]),
    );

    await assembler.assemble({
      ...CTX,
      includeDeployments: true,
    });

    // Verify WorkflowVersion.find was called with projectId
    expect(WorkflowVersion.find).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
      }),
    );
  });

  it('handles deployments with empty workflowVersionManifest', async () => {
    (Workflow.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'wf-1',
          name: 'order_processing',
          type: 'cx_automation',
          steps: [],
          status: 'active',
        },
      ]),
    );
    // No canonical versions either, so the always-on assembleAllVersions pass
    // also yields no files.
    (WorkflowVersion.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLeanSimple([]));

    (Deployment.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLeanSimple([{ workflowVersionManifest: {} }]),
    );

    const result = await assembler.assemble({
      ...CTX,
      includeDeployments: true,
    });

    // Only working copy, no version files
    const versionFiles = [...result.files.keys()].filter((k) => k.includes('/versions/'));
    expect(versionFiles).toHaveLength(0);
  });
});

describe('Lockfile v2 — workflow version enrichment', () => {
  it('should include version and status for workflow version files', async () => {
    const { generateLockfileV2 } = await import('../export/lockfile-generator.js');
    type LayerNameType = import('../types.js').LayerName;

    const workflowFiles = new Map<string, string>();
    workflowFiles.set(
      'workflows/order_processing.workflow.json',
      JSON.stringify({ name: 'order_processing', steps: [] }),
    );
    workflowFiles.set(
      'workflows/versions/order_processing/1.0.0.version.json',
      JSON.stringify({
        version: '1.0.0',
        source_hash: 'hash1',
        status: 'active',
        definition: { steps: [] },
      }),
    );

    const layerFiles = new Map<LayerNameType, Map<string, string>>();
    layerFiles.set('workflows' as LayerNameType, workflowFiles);

    const lockfile = generateLockfileV2(layerFiles, []);

    // Working copy should have source_hash only
    const workingCopy = lockfile.workflows['workflows/order_processing.workflow.json'];
    expect(workingCopy).toBeDefined();
    expect(workingCopy.source_hash).toBeDefined();
    expect(workingCopy.version).toBeUndefined();

    // Version file should have enriched version and status
    const versionEntry =
      lockfile.workflows['workflows/versions/order_processing/1.0.0.version.json'];
    expect(versionEntry).toBeDefined();
    expect(versionEntry.source_hash).toBeDefined();
    expect(versionEntry.version).toBe('1.0.0');
    expect(versionEntry.status).toBe('active');
  }, 90_000);
});
