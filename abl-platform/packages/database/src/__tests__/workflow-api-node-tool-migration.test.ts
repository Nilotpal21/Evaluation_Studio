import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import mongoose from 'mongoose';
import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';
import { migration } from '../migrations/scripts/20260514_034_migrate_workflow_api_nodes_to_http_tools.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
  if (!isMongoReady()) return;

  const db = mongoose.connection.db!;
  for (const collectionName of ['workflows', 'workflow_versions', 'project_tools']) {
    const collections = await db.listCollections({ name: collectionName }).toArray();
    if (collections.length > 0) {
      await db.collection(collectionName).deleteMany({});
    }
  }
});

describe('20260514_034 migrate workflow API nodes to HTTP tools', () => {
  test('has the correct version matching its filename', () => {
    expect(migration.version).toBe('20260514_034');
  });

  test('creates an HTTP tool and rewrites draft and workflow working-copy API nodes', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    await db.collection('workflows').insertOne({
      _id: 'wf-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      name: 'Order Flow',
      createdBy: 'user-1',
      deleted: false,
      nodes: [
        {
          id: 'start-1',
          nodeType: 'start',
          name: 'Start',
          position: { x: 0, y: 0 },
          config: {},
        },
        {
          id: 'api-1',
          nodeType: 'api',
          name: 'Send Update',
          position: { x: 200, y: 0 },
          config: {
            method: 'POST',
            url: 'https://api.example.com/accounts/{{trigger.payload.accountId}}/orders',
            headers: [{ key: 'X-Trace', value: '{{workflow.executionId}}' }],
            body: {
              type: 'json',
              content: JSON.stringify({
                orderId: '{{trigger.payload.orderId}}',
                amount: 99.5,
                expedited: true,
                note: 'approved',
              }),
            },
            auth: { type: 'pre_authorized', profileId: 'crm_auth' },
            mode: 'async',
            timeout: 45,
          },
        },
      ],
    });
    await db.collection('workflow_versions').insertOne({
      _id: 'wfv-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      workflowId: 'wf-1',
      version: 'draft',
      sourceHash: 'oldhash',
      deleted: false,
      createdBy: 'user-1',
      definition: {
        nodes: [
          {
            id: 'api-1',
            nodeType: 'api',
            name: 'Send Update',
            position: { x: 200, y: 0 },
            config: {
              method: 'POST',
              url: 'https://api.example.com/accounts/{{trigger.payload.accountId}}/orders',
              headers: [{ key: 'X-Trace', value: '{{workflow.executionId}}' }],
              body: {
                type: 'json',
                content: JSON.stringify({
                  orderId: '{{trigger.payload.orderId}}',
                  amount: 99.5,
                  expedited: true,
                  note: 'approved',
                }),
              },
              auth: { type: 'pre_authorized', profileId: 'crm_auth' },
              mode: 'async',
              timeout: 45,
            },
          },
        ],
      },
    });

    await migration.up(db);

    const tool = await db.collection('project_tools').findOne({ name: 'order_flow_send_update' });
    expect(tool).toMatchObject({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      toolType: 'http',
      slug: 'order_flow_send_update',
      createdBy: 'user-1',
    });
    expect(tool?.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(tool?.dslContent).toContain(
      'order_flow_send_update(trigger_payload_account_id: string, x_trace: string, order_id: string) -> object',
    );
    expect(tool?.dslContent).toContain(
      'endpoint: "https://api.example.com/accounts/{{input.trigger_payload_account_id}}/orders"',
    );
    expect(tool?.dslContent).toContain('auth_profile: crm_auth');
    expect(tool?.dslContent).toContain('"orderId": {{input.order_id}}');
    expect(tool?.dslContent).toContain('"amount": 99.5');
    expect(tool?.dslContent).toContain('"expedited": true');
    expect(tool?.dslContent).toContain('"note": "approved"');

    const workflow = await db.collection('workflows').findOne({ _id: 'wf-1' });
    const workflowNode = workflow?.nodes.find((node: { id: string }) => node.id === 'api-1');
    expect(workflowNode?.nodeType).toBe('tool');
    expect(workflowNode?.config.toolId).toBe(tool?._id);
    expect(workflowNode?.config.params).toMatchObject({
      trigger_payload_account_id: '{{trigger.payload.accountId}}',
      x_trace: '{{workflow.executionId}}',
      order_id: '{{trigger.payload.orderId}}',
    });

    const version = await db.collection('workflow_versions').findOne({ _id: 'wfv-1' });
    const migratedNode = version?.definition.nodes.find(
      (node: { id: string }) => node.id === 'api-1',
    );
    expect(migratedNode).toMatchObject({
      id: 'api-1',
      nodeType: 'tool',
      name: 'Send Update',
      config: {
        toolId: tool?._id,
        toolName: 'order_flow_send_update',
        timeout: 45,
        executionMode: 'async_wait',
        callbackConfig: {
          enabled: true,
          location: 'body',
          callbackUrlKey: 'callbackUrl',
          callbackSecretKey: 'callbackSecret',
        },
      },
    });
    expect(migratedNode?.config.params).toMatchObject({
      trigger_payload_account_id: '{{trigger.payload.accountId}}',
      x_trace: '{{workflow.executionId}}',
      order_id: '{{trigger.payload.orderId}}',
    });

    expect(version?.sourceHash).toMatch(/^[a-f0-9]{16}$/);
    expect(version?.sourceHash).not.toBe('oldhash');

    await expect(migration.validate?.(db)).resolves.toMatchObject({ ok: true });
  });

  test('keeps static JSON body values literal and maps dynamic body expressions by key name', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const apiNode = {
      id: 'api-1',
      nodeType: 'api',
      name: 'Patch Customer',
      position: { x: 200, y: 0 },
      config: {
        method: 'POST',
        url: 'https://api.example.com/customer',
        body: {
          type: 'json',
          content:
            '{"outer":{"id":"{{context.steps.API0001.output.id}}"},"inner":{"id":"{{context.steps.API0002.output.id}}"}, status: true, "name":"sriram"}',
        },
        mode: 'sync',
      },
    };
    await db.collection('workflows').insertOne({
      _id: 'wf-json',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      name: 'Customer Flow',
      createdBy: 'user-1',
      deleted: false,
      nodes: [apiNode],
    });
    await db.collection('workflow_versions').insertOne({
      _id: 'wfv-json',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      workflowId: 'wf-json',
      version: 'draft',
      sourceHash: 'oldhash',
      deleted: false,
      createdBy: 'user-1',
      definition: { nodes: [apiNode] },
    });

    await migration.up(db);

    const tool = await db
      .collection('project_tools')
      .findOne({ name: 'customer_flow_patch_customer' });
    expect(tool?.dslContent).toContain(
      'customer_flow_patch_customer(id: string, id_2: string) -> object',
    );
    expect(tool?.dslContent).toContain('"id": {{input.id}}');
    expect(tool?.dslContent).toContain('"id": {{input.id_2}}');
    expect(tool?.dslContent).toContain('"status": true');
    expect(tool?.dslContent).toContain('"name": "sriram"');

    const version = await db.collection('workflow_versions').findOne({ _id: 'wfv-json' });
    const migratedNode = version?.definition.nodes[0];
    expect(migratedNode.nodeType).toBe('tool');
    expect(migratedNode.config.toolId).toBe(tool?._id);
    expect(migratedNode.config.params).toMatchObject({
      id: '{{context.steps.API0001.output.id}}',
      id_2: '{{context.steps.API0002.output.id}}',
    });
    expect(Object.keys(migratedNode.config.params)).toEqual(['id', 'id_2']);
  });

  test('maps header expressions and unquoted JSON body expressions to keyed tool params', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const apiNode = {
      id: 'api-4',
      nodeType: 'api',
      name: 'API0004',
      position: { x: 200, y: 0 },
      config: {
        method: 'GET',
        url: 'https://dev-process.kore.ai/api/v1/gale-env',
        headers: [{ key: 'headerfromapi4', value: '{{context.steps.input.output.token}}' }],
        body: {
          type: 'json',
          content: '{\n"name":"sriram", "rollno":\n{{context.steps.start.input.arr}}\n}',
        },
        mode: 'sync',
        timeout: 60,
      },
    };
    await db.collection('workflows').insertOne({
      _id: 'wf-api4',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      name: 'Workflow As Tool Test',
      createdBy: 'user-1',
      deleted: false,
      nodes: [apiNode],
    });
    await db.collection('workflow_versions').insertOne({
      _id: 'wfv-api4',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      workflowId: 'wf-api4',
      version: 'draft',
      sourceHash: 'oldhash',
      deleted: false,
      createdBy: 'user-1',
      definition: { nodes: [apiNode] },
    });

    await migration.up(db);

    const tool = await db
      .collection('project_tools')
      .findOne({ name: 'workflow_as_tool_test_api0004' });
    expect(tool?.dslContent).toContain(
      'workflow_as_tool_test_api0004(headerfromapi4: string, rollno: string) -> object',
    );
    expect(tool?.dslContent).toContain('"name": "sriram"');
    expect(tool?.dslContent).toContain('"rollno": {{input.rollno}}');
    expect(tool?.dslContent).toContain('headerfromapi4: "{{input.headerfromapi4}}"');

    const workflow = await db.collection('workflows').findOne({ _id: 'wf-api4' });
    expect(workflow?.nodes[0]).toMatchObject({
      nodeType: 'tool',
      config: {
        toolId: tool?._id,
        toolName: 'workflow_as_tool_test_api0004',
        params: {
          headerfromapi4: '{{context.steps.input.output.token}}',
          rollno: '{{context.steps.start.input.arr}}',
        },
      },
    });
  });

  test('fails before writing when generated tool name conflicts with different config', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    await db.collection('workflows').insertMany([
      {
        _id: 'wf-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        name: 'Order Flow',
        createdBy: 'user-1',
        deleted: false,
        nodes: [
          {
            id: 'api-1',
            nodeType: 'api',
            name: 'Send Update',
            position: { x: 0, y: 0 },
            config: { method: 'GET', url: 'https://api.example.com/one' },
          },
        ],
      },
      {
        _id: 'wf-2',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        name: 'Order Flow',
        createdBy: 'user-1',
        deleted: true,
        nodes: [],
      },
    ]);
    await db.collection('workflow_versions').insertOne({
      _id: 'wfv-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      workflowId: 'wf-1',
      version: 'draft',
      sourceHash: 'oldhash',
      deleted: false,
      definition: {
        nodes: [
          {
            id: 'api-1',
            nodeType: 'api',
            name: 'Send Update',
            position: { x: 0, y: 0 },
            config: { method: 'GET', url: 'https://api.example.com/one' },
          },
        ],
      },
    });
    await db.collection('project_tools').insertOne({
      _id: 'tool-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      name: 'order_flow_send_update',
      slug: 'order_flow_send_update',
      toolType: 'http',
      dslContent:
        'order_flow_send_update() -> object\n  type: http\n  endpoint: https://other.example.com\n  method: GET',
      sourceHash: 'a'.repeat(64),
    });

    await expect(migration.up(db)).rejects.toThrow(
      'Project project-1 already has non-matching tool "order_flow_send_update"',
    );

    const version = await db.collection('workflow_versions').findOne({ _id: 'wfv-1' });
    expect(version?.definition.nodes[0].nodeType).toBe('api');
    expect(version?.sourceHash).toBe('oldhash');
    const workflow = await db.collection('workflows').findOne({ _id: 'wf-1' });
    expect(workflow?.nodes[0].nodeType).toBe('api');
  });

  test('ignores API nodes in non-draft workflow versions', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    await db.collection('workflows').insertOne({
      _id: 'wf-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      name: 'Order Flow',
      createdBy: 'user-1',
      deleted: false,
      nodes: [
        {
          id: 'start-1',
          nodeType: 'start',
          name: 'Start',
          position: { x: 0, y: 0 },
          config: {},
        },
      ],
    });
    await db.collection('workflow_versions').insertOne({
      _id: 'wfv-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      workflowId: 'wf-1',
      version: 'v1.0.0',
      sourceHash: 'oldhash',
      deleted: false,
      definition: {
        nodes: [
          {
            id: 'api-1',
            nodeType: 'api',
            name: 'Send Update',
            position: { x: 200, y: 0 },
            config: { method: 'GET', url: 'https://api.example.com/version-only' },
          },
        ],
      },
    });

    await migration.up(db);

    await expect(migration.validate?.(db)).resolves.toMatchObject({ ok: true });
    await expect(db.collection('project_tools').countDocuments()).resolves.toBe(0);

    const version = await db.collection('workflow_versions').findOne({ _id: 'wfv-1' });
    expect(version?.definition.nodes[0].nodeType).toBe('api');
    expect(version?.sourceHash).toBe('oldhash');
  });
});
