/**
 * INT-5: Load Project Tools as IR — Workflow Case
 *
 * Tests that loadProjectToolsAsIR correctly derives parameter schemas
 * from a workflow's start node inputVariables.
 *
 * Uses MongoMemoryServer for a real MongoDB connection — no platform mocks.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, model } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// ─── Simplified models (same collection names as real models) ──────────────
// We create test-specific models to avoid conflicts with globally registered
// Mongoose models. These write to the same collections that
// loadProjectToolsAsIR reads from.

const ProjectToolSchema = new Schema(
  {
    _id: { type: String },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    name: { type: String, required: true },
    slug: { type: String, required: true },
    description: { type: String, default: '' },
    toolType: { type: String, required: true },
    dslContent: { type: String, required: true },
    sourceHash: { type: String, default: 'test-hash' },
    variableNamespaceIds: { type: [String], default: [] },
    createdBy: { type: String, default: 'test' },
  },
  { timestamps: true, collection: 'project_tools' },
);

const WorkflowNodeSchema = new Schema(
  {
    id: { type: String, required: true },
    nodeType: { type: String, required: true },
    name: { type: String, required: true },
    position: { type: Schema.Types.Mixed, default: { x: 0, y: 0 } },
    config: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

const WorkflowSchema = new Schema(
  {
    _id: { type: String },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: null },
    nodes: { type: [WorkflowNodeSchema], default: [] },
    edges: { type: [Schema.Types.Mixed], default: [] },
    envVars: { type: Schema.Types.Mixed, default: {} },
    inputSchema: { type: Schema.Types.Mixed, default: null },
    outputSchema: { type: Schema.Types.Mixed, default: null },
    status: { type: String, default: 'active' },
    deployment: { type: Schema.Types.Mixed },
    metadata: { type: Schema.Types.Mixed, default: null },
    triggers: { type: [Schema.Types.Mixed], default: [] },
    createdBy: { type: String, default: 'test' },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'workflows' },
);

const TriggerRegistrationSchema = new Schema(
  {
    _id: { type: String },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    workflowId: { type: String, required: true },
    workflowVersionId: { type: String },
    triggerName: { type: String, required: true },
    triggerType: { type: String, required: true },
    config: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, default: 'active' },
    authProfileId: { type: String, default: null },
    consecutiveErrors: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'trigger_registrations' },
);

// ─── Test Constants ────────────────────────────────────────────────────────

const TENANT_ID = 'test-tenant-int5';
const PROJECT_ID = 'test-project-int5';
const WORKFLOW_ID = 'wf-int5-001';

// ─── MongoDB Lifecycle ─────────────────────────────────────────────────────

let mongod: MongoMemoryServer;
let TestProjectTool: mongoose.Model<Record<string, unknown>>;
let TestWorkflow: mongoose.Model<Record<string, unknown>>;
let TestTriggerRegistration: mongoose.Model<Record<string, unknown>>;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({
    binary: { version: process.env.MONGOMS_VERSION || '7.0.20' },
    instance: { launchTimeout: 30_000 },
  });
  await mongoose.connect(mongod.getUri());

  TestProjectTool =
    (mongoose.models.TestProjectToolIR as mongoose.Model<Record<string, unknown>>) ||
    model<Record<string, unknown>>('TestProjectToolIR', ProjectToolSchema, 'project_tools');
  TestWorkflow =
    (mongoose.models.TestWorkflowIR as mongoose.Model<Record<string, unknown>>) ||
    model<Record<string, unknown>>('TestWorkflowIR', WorkflowSchema, 'workflows');
  TestTriggerRegistration =
    (mongoose.models.TestTriggerRegistrationIR as mongoose.Model<Record<string, unknown>>) ||
    model<Record<string, unknown>>(
      'TestTriggerRegistrationIR',
      TriggerRegistrationSchema,
      'trigger_registrations',
    );
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await TestProjectTool.deleteMany({});
  await TestWorkflow.deleteMany({});
  await TestTriggerRegistration.deleteMany({});
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('loadProjectToolsAsIR — workflow case (INT-5)', () => {
  it('derives parameter schema from workflow start node inputVariables', async () => {
    // Seed workflow with inputVariables on start node
    await TestWorkflow.create({
      _id: WORKFLOW_ID,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      name: 'Test Workflow',
      status: 'active',
      nodes: [
        {
          id: 'start_node',
          nodeType: 'start',
          name: 'Start',
          position: { x: 0, y: 0 },
          config: {
            inputVariables: [
              {
                name: 'topic',
                type: 'string',
                required: true,
                description: 'Topic',
              },
              {
                name: 'count',
                type: 'number',
                required: false,
                description: 'Number of items',
              },
              {
                name: 'verbose',
                type: 'boolean',
                required: false,
              },
              {
                name: 'payload',
                type: 'json',
                required: false,
                description: 'Arbitrary JSON',
              },
            ],
          },
        },
        {
          id: 'end_node',
          nodeType: 'end',
          name: 'End',
          position: { x: 200, y: 0 },
          config: {},
        },
      ],
      triggers: [{ id: 'tr_001', type: 'webhook', config: {}, status: 'active' }],
    });

    // Seed project tool referencing the workflow
    const dslContent = [
      'run_test(payload: object) -> object',
      '  type: workflow',
      '  description: Run test workflow',
      `  workflow_id: ${WORKFLOW_ID}`,
      '  trigger_id: tr_001',
      '  mode: sync',
      '  timeout_ms: 15000',
    ].join('\n');

    await TestProjectTool.create({
      _id: 'tool-int5-001',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      name: 'run_test',
      slug: 'run_test',
      description: 'Run test workflow',
      toolType: 'workflow',
      dslContent,
      sourceHash: 'test-hash',
    });

    await TestTriggerRegistration.create({
      _id: 'tr_001',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      workflowId: WORKFLOW_ID,
      triggerName: 'Webhook',
      triggerType: 'webhook',
      status: 'active',
      config: {},
      authProfileId: null,
      consecutiveErrors: 0,
    });

    // Import loadProjectToolsAsIR — deferred import so mongoose connection is established first
    const { loadProjectToolsAsIR } = await import('../load-project-tools-as-ir.js');

    const result = await loadProjectToolsAsIR(TENANT_ID, PROJECT_ID, new Set(['run_test']));

    expect(result.tools).toHaveLength(1);
    const tool = result.tools[0];

    // Verify tool_type
    expect(tool.tool_type).toBe('workflow');

    // Verify workflow_binding
    expect(tool.workflow_binding).toBeDefined();
    expect(tool.workflow_binding?.workflowId).toBe(WORKFLOW_ID);
    expect(tool.workflow_binding?.triggerId).toBe('tr_001');
    expect(tool.workflow_binding?.mode).toBe('sync');

    // Verify derived parameters from inputVariables
    expect(tool.parameters).toHaveLength(4);

    const topicParam = tool.parameters.find((p) => typeof p !== 'string' && p.name === 'topic');
    expect(topicParam).toBeDefined();
    if (topicParam && typeof topicParam !== 'string') {
      expect(topicParam.type).toBe('string');
      expect(topicParam.required).toBe(true);
      expect(topicParam.description).toBe('Topic');
    }

    const countParam = tool.parameters.find((p) => typeof p !== 'string' && p.name === 'count');
    expect(countParam).toBeDefined();
    if (countParam && typeof countParam !== 'string') {
      expect(countParam.type).toBe('number');
      expect(countParam.required).toBe(false);
      expect(countParam.description).toBe('Number of items');
    }

    const verboseParam = tool.parameters.find((p) => typeof p !== 'string' && p.name === 'verbose');
    expect(verboseParam).toBeDefined();
    if (verboseParam && typeof verboseParam !== 'string') {
      expect(verboseParam.type).toBe('boolean');
      expect(verboseParam.required).toBe(false);
    }

    const payloadParam = tool.parameters.find((p) => typeof p !== 'string' && p.name === 'payload');
    expect(payloadParam).toBeDefined();
    if (payloadParam && typeof payloadParam !== 'string') {
      // json type maps to 'object' in IR
      expect(payloadParam.type).toBe('object');
      expect(payloadParam.required).toBe(false);
      expect(payloadParam.description).toBe('Arbitrary JSON');
    }

    // Verify the derivedParameterSchema (JSON Schema format)
    const derivedSchema = (tool as unknown as Record<string, unknown>)
      .derivedParameterSchema as Record<string, unknown>;
    expect(derivedSchema).toBeDefined();
    expect(derivedSchema.type).toBe('object');
    const props = derivedSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.topic).toEqual({ type: 'string', description: 'Topic' });
    expect(props.count).toEqual({ type: 'number', description: 'Number of items' });
    expect(props.verbose).toEqual({ type: 'boolean' });
    expect(props.payload).toEqual({ description: 'Arbitrary JSON' }); // json → empty schema
    expect(derivedSchema.required).toEqual(['topic']);
  });

  it('fails closed when workflow tool references a workflow that is not found', async () => {
    const dslContent = [
      'run_missing(payload: object) -> object',
      '  type: workflow',
      '  description: Missing workflow',
      '  workflow_id: wf-nonexistent',
      '  trigger_id: tr_001',
      '  mode: sync',
    ].join('\n');

    await TestProjectTool.create({
      _id: 'tool-int5-002',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      name: 'run_missing',
      slug: 'run_missing',
      description: 'Missing workflow',
      toolType: 'workflow',
      dslContent,
      sourceHash: 'test-hash',
    });

    const { loadProjectToolsAsIR } = await import('../load-project-tools-as-ir.js');

    await expect(
      loadProjectToolsAsIR(TENANT_ID, PROJECT_ID, new Set(['run_missing'])),
    ).rejects.toThrow('Workflow not found');
  });
});
