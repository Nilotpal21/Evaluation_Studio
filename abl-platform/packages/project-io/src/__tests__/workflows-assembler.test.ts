import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkflowsAssembler } from '../export/layer-assemblers/workflows-assembler.js';
import { WorkflowsDisassembler } from '../import/layer-disassemblers/workflows-disassembler.js';

vi.mock('@agent-platform/database', () => ({
  Workflow: { find: vi.fn(), countDocuments: vi.fn() },
}));

vi.mock('@agent-platform/database/models', () => ({
  WorkflowVersion: { find: vi.fn() },
  TriggerRegistration: { find: vi.fn() },
  Deployment: { find: vi.fn() },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { Workflow } from '@agent-platform/database';
import { TriggerRegistration, WorkflowVersion } from '@agent-platform/database/models';

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

describe('WorkflowsAssembler', () => {
  let assembler: WorkflowsAssembler;

  beforeEach(() => {
    vi.clearAllMocks();
    assembler = new WorkflowsAssembler();
    (TriggerRegistration.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLeanSimple([]));
  });

  it('should have layer name "workflows"', () => {
    expect(assembler.layer).toBe('workflows');
  });

  it('should export workflow definitions without execution or version-owned fields', async () => {
    // In the version-first model, the workflow container only carries
    // `name`, `type`, `description`, `tags`, `metadata` (enforced by .select()).
    // Step/trigger/nodes/edges definitions live on WorkflowVersion.
    (Workflow.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'wf-1',
          name: 'Ticket Routing',
          type: 'cx_automation',
          description: 'Routes support tickets',
          tags: ['support'],
        },
      ]),
    );
    (WorkflowVersion.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLeanSimple([]));

    const result = await assembler.assemble(CTX);

    expect(result.files.has('workflows/ticket_routing.workflow.json')).toBe(true);
    const workflow = JSON.parse(result.files.get('workflows/ticket_routing.workflow.json')!);

    // Verify container-level fields are present
    expect(workflow.name).toBe('Ticket Routing');
    expect(workflow.type).toBe('cx_automation');
    expect(workflow.description).toBe('Routes support tickets');

    // Must NOT contain internal fields or version-owned fields (stripped by assembler)
    expect(workflow).not.toHaveProperty('_id');
    expect(workflow).not.toHaveProperty('tenantId');
    expect(workflow).not.toHaveProperty('projectId');
    expect(workflow).not.toHaveProperty('_v');
    expect(workflow).not.toHaveProperty('archivedAt');
    expect(workflow).not.toHaveProperty('steps');
    expect(workflow).not.toHaveProperty('triggers');
    expect(workflow).not.toHaveProperty('status');
    expect(workflow).not.toHaveProperty('nodes');
    expect(workflow).not.toHaveProperty('edges');
    expect(workflow).not.toHaveProperty('envVars');
    expect(workflow).not.toHaveProperty('inputSchema');
    expect(workflow).not.toHaveProperty('outputSchema');
    expect(workflow).not.toHaveProperty('deployment');
  });

  it('should query with correct scoping', async () => {
    (Workflow.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));

    await assembler.assemble(CTX);

    expect(Workflow.find).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
  });

  it('should count entities correctly', async () => {
    (Workflow.countDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(7);

    const count = await assembler.countEntities(CTX);
    expect(count).toBe(7);
  });

  it('should return empty result when no workflows exist', async () => {
    (Workflow.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));

    const result = await assembler.assemble(CTX);
    expect(result.files.size).toBe(0);
    expect(result.entityCount).toBe(0);
  });

  it('hydrates exported version triggers from TriggerRegistration records', async () => {
    (Workflow.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'wf-source-1',
          name: 'Loan Processing',
          type: 'workflow',
        },
      ]),
    );
    (WorkflowVersion.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLeanSimple([
        {
          _id: 'wfv-source-1',
          workflowId: 'wf-source-1',
          version: 'draft',
          state: 'active',
          definition: { nodes: [] },
          sourceHash: 'hash-1',
          triggers: [],
          createdBy: 'user-1',
        },
      ]),
    );
    (TriggerRegistration.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLeanSimple([
        {
          _id: 'tr-source-1',
          workflowId: 'wf-source-1',
          workflowVersionId: 'wfv-source-1',
          triggerName: 'webhook',
          triggerType: 'webhook',
          status: 'active',
          config: { inputSchema: { type: 'object' } },
          webhookMode: 'sync',
        },
      ]),
    );

    const result = await assembler.assemble(CTX);
    const version = JSON.parse(
      result.files.get('workflows/versions/loan_processing/draft.version.json')!,
    );

    expect(TriggerRegistration.find).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      workflowId: { $in: ['wf-source-1'] },
      status: { $ne: 'deleted' },
    });
    expect(version.triggers).toEqual([
      {
        id: 'tr-source-1',
        triggerName: 'webhook',
        type: 'webhook',
        status: 'active',
        config: { inputSchema: { type: 'object' } },
        webhookMode: 'sync',
      },
    ]);
  });

  it('hydrates draft version triggers from legacy workflow-level registrations', async () => {
    (Workflow.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'wf-source-1',
          name: 'Loan Processing',
          type: 'workflow',
        },
      ]),
    );
    (WorkflowVersion.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLeanSimple([
        {
          _id: 'wfv-draft-1',
          workflowId: 'wf-source-1',
          version: 'draft',
          state: 'active',
          definition: { nodes: [] },
          sourceHash: 'hash-1',
          triggers: [],
          createdBy: 'user-1',
        },
      ]),
    );
    (TriggerRegistration.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLeanSimple([
        {
          _id: 'tr-legacy-1',
          workflowId: 'wf-source-1',
          triggerName: 'webhook',
          triggerType: 'webhook',
          status: 'active',
          config: {},
          webhookMode: 'sync',
        },
      ]),
    );

    const result = await assembler.assemble(CTX);
    const version = JSON.parse(
      result.files.get('workflows/versions/loan_processing/draft.version.json')!,
    );

    expect(version.triggers).toEqual([
      {
        id: 'tr-legacy-1',
        triggerName: 'webhook',
        type: 'webhook',
        status: 'active',
        config: {},
        webhookMode: 'sync',
      },
    ]);
  });

  it('round-trips a full workflow version graph, not only the start node', async () => {
    const fullDefinition = {
      nodes: [
        {
          id: 'start-1',
          nodeType: 'start',
          config: {
            inputVariables: [
              {
                name: 'customer_id',
                type: 'string',
                required: true,
                description: 'Customer identifier',
              },
            ],
          },
        },
        {
          id: 'decision-1',
          nodeType: 'condition',
          config: {
            expression: 'customer_id != ""',
            branches: ['approved', 'manual_review'],
          },
        },
        {
          id: 'http-1',
          nodeType: 'http',
          config: {
            method: 'POST',
            url: 'https://loan.example.test/process',
            bodyTemplate: { customer_id: '{{customer_id}}' },
          },
        },
        {
          id: 'end-1',
          nodeType: 'end',
          config: {
            resultPath: '$.loanResult',
          },
        },
      ],
      edges: [
        { id: 'edge-start-decision', source: 'start-1', target: 'decision-1' },
        {
          id: 'edge-decision-http',
          source: 'decision-1',
          target: 'http-1',
          condition: 'approved',
        },
        { id: 'edge-http-end', source: 'http-1', target: 'end-1' },
      ],
      envVars: { LOAN_API_BASE_URL: 'https://loan.example.test' },
      inputSchema: {
        type: 'object',
        required: ['customer_id'],
        properties: {
          customer_id: { type: 'string' },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          approval_id: { type: 'string' },
        },
      },
    };

    (Workflow.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'wf-source-1',
          name: 'Loan Processing',
          type: 'workflow',
        },
      ]),
    );
    (WorkflowVersion.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLeanSimple([
        {
          _id: 'wfv-source-1',
          workflowId: 'wf-source-1',
          version: 'draft',
          state: 'active',
          definition: fullDefinition,
          sourceHash: 'hash-full-graph',
          triggers: [],
          createdBy: 'user-1',
        },
      ]),
    );

    const exportResult = await assembler.assemble(CTX);
    const versionPath = 'workflows/versions/loan_processing/draft.version.json';
    const exportedVersion = JSON.parse(exportResult.files.get(versionPath)!);

    expect(exportedVersion.definition).toEqual(fullDefinition);

    const importResult = await new WorkflowsDisassembler().disassemble({
      files: exportResult.files,
      projectId: 'target-project',
      tenantId: 'target-tenant',
      userId: 'target-user',
      conflictStrategy: 'merge',
      existingRecordIds: new Map(),
    });
    const importedVersion = importResult.records.find(
      (record) => record.collection === 'workflow_versions' && record.data.version === 'draft',
    );
    const importedWorkflow = importResult.records.find(
      (record) => record.collection === 'workflows',
    );

    expect(importResult.warnings).toEqual([]);
    expect(importedWorkflow?.data).not.toHaveProperty('nodes');
    expect(importedWorkflow?.data).not.toHaveProperty('edges');
    expect(importedVersion?.data.definition).toEqual(fullDefinition);
    expect((importedVersion?.data.definition as typeof fullDefinition).nodes).toHaveLength(4);
    expect((importedVersion?.data.definition as typeof fullDefinition).edges).toHaveLength(3);
    expect((importedVersion?.data.definition as typeof fullDefinition).nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'decision-1', nodeType: 'condition' }),
        expect.objectContaining({ id: 'http-1', nodeType: 'http' }),
      ]),
    );
  });
});
