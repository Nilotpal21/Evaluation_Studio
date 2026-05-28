import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';
import { Workflow } from '../models/workflow.model.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

afterEach(async () => {
  if (isMongoReady()) await clearCollections();
});

// This suite exercises schema construction, validateSync paths, and unique
// index enforcement when MongoMemoryServer is available.

const validWorkflow = () => ({
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  name: 'Order Processing',
  createdBy: 'user-1',
});

describe('Workflow (node/edge canvas model)', () => {
  describe('instantiation defaults', () => {
    it('sets default fields on instantiation', () => {
      const wf = new Workflow(validWorkflow());
      expect(wf._id).toBeDefined();
      expect(wf.tenantId).toBe('tenant-1');
      expect(wf.projectId).toBe('proj-1');
      expect(wf.name).toBe('Order Processing');
      expect(wf.status).toBe('draft');
      expect(wf.nodes).toEqual([]);
      expect(wf.edges).toEqual([]);
      expect(wf.envVars).toEqual({});
      expect(wf.inputSchema).toBeNull();
      expect(wf.outputSchema).toBeNull();
      expect(wf.description).toBeNull();
      expect(wf.metadata).toBeNull();
      expect(wf._v).toBe(1);
    });
  });

  describe('required field validation', () => {
    it('requires tenantId', () => {
      const data = validWorkflow();
      delete (data as any).tenantId;
      const err = new Workflow(data).validateSync();
      expect(err).toBeDefined();
      expect(err!.errors.tenantId).toBeDefined();
    });

    it('requires projectId', () => {
      const data = validWorkflow();
      delete (data as any).projectId;
      const err = new Workflow(data).validateSync();
      expect(err).toBeDefined();
      expect(err!.errors.projectId).toBeDefined();
    });

    it('requires name', () => {
      const data = validWorkflow();
      delete (data as any).name;
      const err = new Workflow(data).validateSync();
      expect(err).toBeDefined();
      expect(err!.errors.name).toBeDefined();
    });
  });

  describe('status enum validation', () => {
    it('validates status enum', () => {
      const err = new Workflow({
        ...validWorkflow(),
        status: 'invalid',
      }).validateSync();
      expect(err).toBeDefined();
      expect(err!.errors.status).toBeDefined();
    });

    it('accepts valid status values', () => {
      for (const status of ['draft', 'active', 'archived']) {
        const err = new Workflow({ ...validWorkflow(), status }).validateSync();
        expect(err).toBeUndefined();
      }
    });
  });

  describe('nodes sub-schema', () => {
    it('stores typed nodes with all node types', () => {
      const types = [
        'start',
        'end',
        'condition',
        'loop',
        'delay',
        'text_to_text',
        'text_to_image',
        'audio_to_text',
        'image_to_text',
        'api',
        'function',
        'integration',
        'browser',
        'doc_search',
        'doc_intelligence',
        'human',
        'agentic_app',
      ];
      const nodes = types.map((t) => ({
        id: `node-${t}`,
        nodeType: t,
        name: `Node ${t}`,
        position: { x: 0, y: 0 },
        config: {},
      }));
      const wf = new Workflow({ ...validWorkflow(), nodes });
      expect(wf.nodes).toHaveLength(types.length);
      for (let i = 0; i < types.length; i++) {
        expect(wf.nodes[i].nodeType).toBe(types[i]);
      }
    });

    it('validates nodeType enum', () => {
      const err = new Workflow({
        ...validWorkflow(),
        nodes: [
          {
            id: 'n1',
            nodeType: 'invalid_type',
            name: 'Bad',
            position: { x: 0, y: 0 },
          },
        ],
      }).validateSync();
      expect(err).toBeDefined();
    });

    it('requires node id, nodeType, name, and position', () => {
      const err = new Workflow({
        ...validWorkflow(),
        nodes: [{ nodeType: 'start' }],
      }).validateSync();
      expect(err).toBeDefined();
    });

    it('stores node config as Mixed', () => {
      const wf = new Workflow({
        ...validWorkflow(),
        nodes: [
          {
            id: 'n1',
            nodeType: 'text_to_text',
            name: 'LLM Node',
            position: { x: 100, y: 200 },
            config: { model: 'gpt-4', temperature: 0.7 },
          },
        ],
      });
      expect(wf.nodes[0].config).toEqual({ model: 'gpt-4', temperature: 0.7 });
      expect(wf.nodes[0].position.x).toBe(100);
      expect(wf.nodes[0].position.y).toBe(200);
    });
  });

  describe('edges sub-schema', () => {
    it('stores edges with source and target', () => {
      const wf = new Workflow({
        ...validWorkflow(),
        edges: [
          { id: 'e1', source: 'node-start', target: 'node-llm' },
          {
            id: 'e2',
            source: 'node-llm',
            sourceHandle: 'output-1',
            target: 'node-end',
            label: 'success',
          },
        ],
      });
      expect(wf.edges).toHaveLength(2);
      expect(wf.edges[0].source).toBe('node-start');
      expect(wf.edges[0].target).toBe('node-llm');
      expect(wf.edges[1].sourceHandle).toBe('output-1');
      expect(wf.edges[1].label).toBe('success');
    });

    it('requires edge id, source, and target', () => {
      const err = new Workflow({
        ...validWorkflow(),
        edges: [{ id: 'e1' }],
      }).validateSync();
      expect(err).toBeDefined();
    });
  });

  describe('deployment sub-schema', () => {
    it('stores deployment config', () => {
      const now = new Date();
      const wf = new Workflow({
        ...validWorkflow(),
        deployment: {
          endpointSlug: 'order-processing',
          mode: 'sync',
          timeout: 30000,
          deployedAt: now,
          deployedBy: 'user-1',
          deployedVersion: 3,
        },
      });
      expect(wf.deployment?.endpointSlug).toBe('order-processing');
      expect(wf.deployment?.mode).toBe('sync');
      expect(wf.deployment?.timeout).toBe(30000);
      expect(wf.deployment?.deployedVersion).toBe(3);
    });

    it('validates deployment mode enum', () => {
      const err = new Workflow({
        ...validWorkflow(),
        deployment: {
          endpointSlug: 'test',
          mode: 'invalid',
          timeout: 5000,
          deployedAt: new Date(),
          deployedBy: 'user-1',
          deployedVersion: 1,
        },
      }).validateSync();
      expect(err).toBeDefined();
    });

    it('stores async push config webhook URL (bearer token lives on the execution, not the deployment)', () => {
      const wf = new Workflow({
        ...validWorkflow(),
        deployment: {
          endpointSlug: 'async-flow',
          mode: 'async_push',
          asyncPushConfig: {
            webhookUrl: 'https://hooks.example.com/callback',
          },
          timeout: 60000,
          deployedAt: new Date(),
          deployedBy: 'user-1',
          deployedVersion: 1,
        },
      });
      expect(wf.deployment?.asyncPushConfig?.webhookUrl).toBe('https://hooks.example.com/callback');
      // Regression guard: the prior plaintext-at-rest `accessToken` field
      // on asyncPushConfig has been removed — the bearer token rides the
      // per-execution `triggerMetadata.encryptedAccessToken` path instead.
      expect(
        (wf.deployment?.asyncPushConfig as Record<string, unknown>)?.accessToken,
      ).toBeUndefined();
    });
  });

  describe('triggers sub-schema', () => {
    it('defaults triggers to empty array', () => {
      const wf = new Workflow(validWorkflow());
      expect(wf.triggers).toEqual([]);
    });

    it('stores triggers with id, type, config, and status', () => {
      const wf = new Workflow({
        ...validWorkflow(),
        triggers: [
          {
            id: 'trigger-1',
            type: 'webhook',
            config: { path: '/hook' },
            status: 'active',
          },
          {
            id: 'trigger-2',
            type: 'cron',
            config: { schedule: '0 * * * *' },
            status: 'paused',
          },
        ],
      });
      expect(wf.triggers).toHaveLength(2);
      expect(wf.triggers![0].id).toBe('trigger-1');
      expect(wf.triggers![0].type).toBe('webhook');
      expect(wf.triggers![0].config).toEqual({ path: '/hook' });
      expect(wf.triggers![0].status).toBe('active');
      expect(wf.triggers![1].type).toBe('cron');
    });
  });

  describe('edge sourceHandle default', () => {
    it('defaults sourceHandle to "default" when not provided', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();
      const doc = await Workflow.create({
        ...validWorkflow(),
        edges: [{ id: 'e1', source: 'node-a', target: 'node-b' }],
      });
      expect(doc.edges[0].sourceHandle).toBe('default');
    });

    it('preserves explicit sourceHandle value', () => {
      const wf = new Workflow({
        ...validWorkflow(),
        edges: [{ id: 'e1', source: 'node-a', sourceHandle: 'loop_body', target: 'node-b' }],
      });
      expect(wf.edges[0].sourceHandle).toBe('loop_body');
    });
  });

  describe('optional fields', () => {
    it('stores envVars, inputSchema, outputSchema, metadata', () => {
      const wf = new Workflow({
        ...validWorkflow(),
        envVars: { API_KEY: 'secret' },
        inputSchema: { type: 'object', properties: { orderId: { type: 'string' } } },
        outputSchema: { type: 'object', properties: { result: { type: 'string' } } },
        metadata: { category: 'order-management' },
      });
      expect(wf.envVars).toEqual({ API_KEY: 'secret' });
      expect(wf.inputSchema).toEqual({
        type: 'object',
        properties: { orderId: { type: 'string' } },
      });
      expect(wf.outputSchema).toEqual({
        type: 'object',
        properties: { result: { type: 'string' } },
      });
      expect(wf.metadata).toEqual({ category: 'order-management' });
    });
  });

  describe('unique indexes', () => {
    it('enforces unique name per tenant+project', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();
      await Workflow.create(validWorkflow());
      await expect(Workflow.create(validWorkflow())).rejects.toThrow(/duplicate key/i);
    });

    it('allows same name for different projects', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();
      await Workflow.create(validWorkflow());
      const doc = await Workflow.create({ ...validWorkflow(), projectId: 'proj-2' });
      expect(doc.projectId).toBe('proj-2');
    });

    it('enforces unique deployment endpointSlug', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();
      const deployment = {
        endpointSlug: 'unique-slug',
        mode: 'sync',
        timeout: 5000,
        deployedAt: new Date(),
        deployedBy: 'user-1',
        deployedVersion: 1,
      };
      await Workflow.create({ ...validWorkflow(), deployment });
      await expect(
        Workflow.create({
          ...validWorkflow(),
          name: 'Different Name',
          deployment,
        }),
      ).rejects.toThrow(/duplicate key/i);
    });
  });
});
