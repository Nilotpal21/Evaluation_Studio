/**
 * Pipeline Flows E2E Tests (Playwright)
 *
 * Tests pipeline CRUD, flow routing, default protection, CEL conditions,
 * and provider schemas via the SearchAI API.
 *
 * Runs against live services — no mocks.
 */

import {
  test,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
} from '@playwright/test';

const SEARCHAI_URL = process.env.SEARCHAI_URL || 'http://localhost:3113';
const TENANT_ID = 'tenant-dev-001';
const PROJECT_ID = 'proj-search-ai-strategies';
const KB_ID = '019d9628-daa3-7a2c-abe7-156f86e0cece';

const KB_PATH = `${SEARCHAI_URL}/api/projects/${PROJECT_ID}/knowledge-bases/${KB_ID}`;
const PROVIDERS_PATH = `${SEARCHAI_URL}/api/projects/${PROJECT_ID}/pipelines/providers`;

function headers(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-tenant-id': TENANT_ID };
}

let api: APIRequestContext;
let defaultPipelineId: string;
let customPipelineId: string;

// ─── Setup ──────────────────────────────────────────────────────────────

test.beforeAll(async () => {
  api = await playwrightRequest.newContext();

  // Health check
  const health = await api.get(`${SEARCHAI_URL}/health`);
  expect(health.ok()).toBeTruthy();
});

test.afterAll(async () => {
  await api.dispose();
});

// ─── Basic Pipeline CRUD ───────────────────────────────────────────────

test.describe('Pipeline CRUD', () => {
  test('create default pipeline with 2 flows', async () => {
    const res = await api.post(`${KB_PATH}/pipelines`, { headers: headers() });

    // May be 201 (new) or 409 (already exists)
    if (res.status() === 409) {
      // Pipeline exists — fetch it
      const getRes = await api.get(`${KB_PATH}/pipelines?active=true`, { headers: headers() });
      const data = await getRes.json();
      defaultPipelineId = data.pipeline._id;
      return;
    }

    expect(res.status()).toBe(201);
    const data = await res.json();
    const pipeline = data.pipeline;

    defaultPipelineId = pipeline._id;
    expect(pipeline.isDefault).toBe(true);
    expect(pipeline.status).toBe('active');
    expect(pipeline.flows).toHaveLength(2);

    // Flow 1: Rich Documents (P:10, has selectionRules)
    const richFlow = pipeline.flows.find((f: any) => f.name === 'Rich Documents');
    expect(richFlow).toBeDefined();
    expect(richFlow.priority).toBe(10);
    expect(richFlow.isDefault).toBe(false);
    expect(richFlow.selectionRules.length).toBeGreaterThan(0);

    // Flow 2: Default (P:0, no rules, isDefault:true)
    const defaultFlow = pipeline.flows.find((f: any) => f.isDefault === true);
    expect(defaultFlow).toBeDefined();
    expect(defaultFlow.priority).toBe(0);
    expect(defaultFlow.selectionRules).toHaveLength(0);

    // Both flows have extraction as first stage
    for (const flow of pipeline.flows) {
      expect(flow.stages[0].type).toBe('extraction');
      // Both have content-intelligence
      const ciStage = flow.stages.find((s: any) => s.type === 'content-intelligence');
      expect(ciStage).toBeDefined();
    }

    // Only extraction differs — shared stages are identical
    const richPost = pipeline.flows[0].stages.slice(1).map((s: any) => `${s.type}:${s.provider}`);
    const defaultPost = pipeline.flows[1].stages
      .slice(1)
      .map((s: any) => `${s.type}:${s.provider}`);
    expect(richPost).toEqual(defaultPost);
  });

  test('get all pipelines', async () => {
    const res = await api.get(`${KB_PATH}/pipelines`, { headers: headers() });
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.pipelines.length).toBeGreaterThanOrEqual(1);
  });

  test('get active pipeline', async () => {
    const res = await api.get(`${KB_PATH}/pipelines?active=true`, { headers: headers() });
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.pipeline).toBeDefined();
    expect(data.pipeline.status).toBe('active');
  });

  test('create custom pipeline', async () => {
    const res = await api.post(`${KB_PATH}/pipelines`, {
      headers: headers(),
      data: { name: 'E2E Custom Pipeline', description: 'Created by Playwright' },
    });
    expect(res.status()).toBe(201);
    const data = await res.json();
    customPipelineId = data.pipeline._id;
    expect(data.pipeline.isDefault).toBe(false);
    expect(data.pipeline.status).toBe('draft');
  });

  test('update custom pipeline', async () => {
    const res = await api.patch(`${KB_PATH}/pipelines/${customPipelineId}`, {
      headers: headers(),
      data: { description: 'Updated by Playwright' },
    });
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.pipeline.version).toBeGreaterThan(1);
  });
});

// ─── Default Pipeline Protection ────────────────────────────────────────

test.describe('Default Pipeline Protection', () => {
  test('cannot delete default pipeline', async () => {
    const res = await api.delete(`${KB_PATH}/pipelines/${defaultPipelineId}`, {
      headers: headers(),
    });
    expect(res.status()).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe('CANNOT_DELETE_DEFAULT_PIPELINE');
  });

  test('cannot remove stages from default pipeline', async () => {
    // Get current flows
    const getRes = await api.get(`${KB_PATH}/pipelines?active=true`, { headers: headers() });
    const pipeline = (await getRes.json()).pipeline;
    const flows = JSON.parse(JSON.stringify(pipeline.flows));

    // Remove last stage from first flow
    flows[0].stages = flows[0].stages.slice(0, -1);

    const res = await api.patch(`${KB_PATH}/pipelines/${defaultPipelineId}`, {
      headers: headers(),
      data: { flows },
    });
    expect(res.status()).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe('CANNOT_REMOVE_DEFAULT_STAGE');
  });

  test('cannot change isDefault flag', async () => {
    const res = await api.patch(`${KB_PATH}/pipelines/${defaultPipelineId}`, {
      headers: headers(),
      data: { isDefault: false },
    });
    expect(res.status()).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe('CANNOT_CHANGE_DEFAULT_FLAG');
  });

  test('can customize default pipeline config', async () => {
    const getRes = await api.get(`${KB_PATH}/pipelines?active=true`, { headers: headers() });
    const pipeline = (await getRes.json()).pipeline;
    const flows = JSON.parse(JSON.stringify(pipeline.flows));

    // Change chunk size on first flow's chunking stage
    for (const stage of flows[0].stages) {
      if (stage.type === 'chunking') {
        stage.providerConfig.chunkSize = 800;
        break;
      }
    }

    const res = await api.patch(`${KB_PATH}/pipelines/${defaultPipelineId}`, {
      headers: headers(),
      data: { flows },
    });
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.success).toBe(true);
    const updatedChunking = data.pipeline.flows[0].stages.find((s: any) => s.type === 'chunking');
    expect(updatedChunking.providerConfig.chunkSize).toBe(800);
  });
});

// ─── Flow Selection & Routing ───────────────────────────────────────────

test.describe('Flow Selection', () => {
  test('PDF routes to Rich Documents (P:10)', async () => {
    const res = await api.post(`${KB_PATH}/pipelines/${defaultPipelineId}/test-selection`, {
      headers: headers(),
      data: {
        document: {
          name: 'report.pdf',
          mimeType: 'application/pdf',
          extension: 'pdf',
          size: 1048576,
        },
        source: { connector: 'sharepoint' },
      },
    });
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.selectedFlow.name).toBe('Rich Documents');
    expect(data.selectedFlow.priority).toBe(10);
  });

  test('DOCX routes to Rich Documents', async () => {
    const res = await api.post(`${KB_PATH}/pipelines/${defaultPipelineId}/test-selection`, {
      headers: headers(),
      data: {
        document: {
          name: 'doc.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          extension: 'docx',
          size: 50000,
        },
        source: { connector: 'google-drive' },
      },
    });
    const data = await res.json();
    expect(data.selectedFlow.name).toBe('Rich Documents');
  });

  test('plain text routes to Default (P:0)', async () => {
    const res = await api.post(`${KB_PATH}/pipelines/${defaultPipelineId}/test-selection`, {
      headers: headers(),
      data: {
        document: { name: 'readme.txt', mimeType: 'text/plain', extension: 'txt', size: 5000 },
        source: { connector: 'upload' },
      },
    });
    const data = await res.json();
    expect(data.selectedFlow.name).toBe('Default');
    expect(data.selectedFlow.isDefault).toBe(true);
  });

  test('markdown routes to Default', async () => {
    const res = await api.post(`${KB_PATH}/pipelines/${defaultPipelineId}/test-selection`, {
      headers: headers(),
      data: {
        document: { name: 'docs.md', mimeType: 'text/markdown', extension: 'md', size: 3000 },
        source: { connector: 'confluence' },
      },
    });
    const data = await res.json();
    expect(data.selectedFlow.name).toBe('Default');
  });

  test('unknown MIME type routes to Default', async () => {
    const res = await api.post(`${KB_PATH}/pipelines/${defaultPipelineId}/test-selection`, {
      headers: headers(),
      data: {
        document: {
          name: 'data.xyz',
          mimeType: 'application/unknown',
          extension: 'xyz',
          size: 1000,
        },
        source: { connector: 'upload' },
      },
    });
    const data = await res.json();
    expect(data.selectedFlow.name).toBe('Default');
  });

  test('image routes to Rich Documents', async () => {
    const res = await api.post(`${KB_PATH}/pipelines/${defaultPipelineId}/test-selection`, {
      headers: headers(),
      data: {
        document: { name: 'scan.png', mimeType: 'image/png', extension: 'png', size: 2000000 },
        source: { connector: 'upload' },
      },
    });
    const data = await res.json();
    expect(data.selectedFlow.name).toBe('Rich Documents');
  });

  test('HTML routes to Rich Documents', async () => {
    const res = await api.post(`${KB_PATH}/pipelines/${defaultPipelineId}/test-selection`, {
      headers: headers(),
      data: {
        document: { name: 'page.html', mimeType: 'text/html', extension: 'html', size: 10000 },
        source: { connector: 'web-crawler' },
      },
    });
    const data = await res.json();
    expect(data.selectedFlow.name).toBe('Rich Documents');
  });
});

// ─── Validation ─────────────────────────────────────────────────────────

test.describe('Validation', () => {
  test('default pipeline validates successfully', async () => {
    const getRes = await api.get(`${KB_PATH}/pipelines?active=true`, { headers: headers() });
    const pipeline = (await getRes.json()).pipeline;

    const res = await api.post(`${KB_PATH}/pipelines/validate`, {
      headers: headers(),
      data: pipeline,
    });
    const data = await res.json();
    expect(data.valid).toBe(true);
    expect(data.summary.errorCount).toBe(0);
  });

  test('invalid stage sequence rejected', async () => {
    const res = await api.post(`${KB_PATH}/pipelines/validate`, {
      headers: headers(),
      data: {
        name: 'Bad',
        version: 1,
        status: 'draft',
        isDefault: false,
        flows: [
          {
            id: 'f1',
            name: 'bad',
            enabled: true,
            priority: 0,
            isDefault: true,
            selectionRules: [],
            stages: [
              {
                id: 's1',
                name: 'ch',
                type: 'chunking',
                provider: 'recursive-character',
                providerConfig: { chunkSize: 1000, chunkOverlap: 200 },
                onError: 'fail',
              },
              {
                id: 's2',
                name: 'ex',
                type: 'extraction',
                provider: 'docling',
                providerConfig: { ocrEnabled: true },
                onError: 'fail',
              },
            ],
          },
        ],
        activeEmbeddingConfig: { provider: 'bge-m3', model: 'bge-m3', dimensions: 1024 },
      },
    });
    const data = await res.json();
    expect(data.valid).toBe(false);
    expect(data.errors.some((e: any) => e.code === 'INVALID_STAGE_SEQUENCE')).toBe(true);
  });

  test('invalid CEL expression rejected', async () => {
    const res = await api.post(`${KB_PATH}/pipelines/validate`, {
      headers: headers(),
      data: {
        name: 'Bad CEL',
        version: 1,
        status: 'draft',
        isDefault: false,
        flows: [
          {
            id: 'f1',
            name: 'cel-flow',
            enabled: true,
            priority: 10,
            isDefault: false,
            selectionRules: [{ type: 'cel', celExpression: 'not valid %%% cel' }],
            stages: [
              {
                id: 's1',
                name: 'ex',
                type: 'extraction',
                provider: 'docling',
                providerConfig: { ocrEnabled: true },
                onError: 'fail',
              },
            ],
          },
          {
            id: 'f2',
            name: 'default',
            enabled: true,
            priority: 0,
            isDefault: true,
            selectionRules: [],
            stages: [
              {
                id: 's2',
                name: 'ex',
                type: 'extraction',
                provider: 'docling',
                providerConfig: { ocrEnabled: true },
                onError: 'fail',
              },
            ],
          },
        ],
        activeEmbeddingConfig: { provider: 'bge-m3', model: 'bge-m3', dimensions: 1024 },
      },
    });
    const data = await res.json();
    expect(data.valid).toBe(false);
    expect(data.errors.some((e: any) => e.code === 'INVALID_CEL_EXPRESSION')).toBe(true);
  });

  test('content-intelligence and visual-analysis stages validate', async () => {
    const res = await api.post(`${KB_PATH}/pipelines/validate`, {
      headers: headers(),
      data: {
        name: 'V2 Stages',
        version: 1,
        status: 'draft',
        isDefault: false,
        flows: [
          {
            id: 'f1',
            name: 'flow',
            enabled: true,
            priority: 0,
            isDefault: true,
            selectionRules: [],
            stages: [
              {
                id: 's1',
                name: 'ex',
                type: 'extraction',
                provider: 'docling',
                providerConfig: { ocrEnabled: true },
                onError: 'fail',
              },
              {
                id: 's2',
                name: 'ch',
                type: 'chunking',
                provider: 'recursive-character',
                providerConfig: { chunkSize: 1000, chunkOverlap: 200 },
                onError: 'fail',
              },
              {
                id: 's3',
                name: 'ci',
                type: 'content-intelligence',
                provider: 'content-intelligence',
                providerConfig: { generateSummary: true, modelTier: 'fast' },
                onError: 'continue',
              },
              {
                id: 's4',
                name: 'va',
                type: 'visual-analysis',
                provider: 'visual-analysis',
                providerConfig: { analyzeImages: true, modelTier: 'balanced' },
                onError: 'continue',
              },
            ],
          },
        ],
        activeEmbeddingConfig: { provider: 'bge-m3', model: 'bge-m3', dimensions: 1024 },
      },
    });
    const data = await res.json();
    expect(data.valid).toBe(true);
  });
});

// ─── Provider Schemas ───────────────────────────────────────────────────

test.describe('Provider Schemas', () => {
  test('extraction providers include all expected', async () => {
    const res = await api.get(`${PROVIDERS_PATH}/extraction/schemas`, { headers: headers() });
    const data = await res.json();
    const ids = data.providers.map((p: any) => p.id);
    expect(ids).toContain('docling');
    expect(ids).toContain('llamaindex');
    expect(ids).toContain('http-webhook');
    expect(ids).not.toContain('javascript-sandbox');
  });

  test('content-intelligence provider has correct schema', async () => {
    const res = await api.get(`${PROVIDERS_PATH}/content-intelligence/schemas`, {
      headers: headers(),
    });
    const data = await res.json();
    expect(data.providers).toHaveLength(1);
    expect(data.providers[0].id).toBe('content-intelligence');
    const props = Object.keys(data.schemas['content-intelligence'].properties);
    expect(props).toContain('generateSummary');
    expect(props).toContain('modelTier');
    expect(props).toContain('questionsPerChunk');
  });

  test('visual-analysis provider has correct schema', async () => {
    const res = await api.get(`${PROVIDERS_PATH}/visual-analysis/schemas`, { headers: headers() });
    const data = await res.json();
    expect(data.providers[0].id).toBe('visual-analysis');
    const props = Object.keys(data.schemas['visual-analysis'].properties);
    expect(props).toContain('analyzeImages');
    expect(props).toContain('summarizeTables');
    expect(props).toContain('modelTier');
  });

  test('llm-stage provider has correct schema', async () => {
    const res = await api.get(`${PROVIDERS_PATH}/llm-stage/schemas`, { headers: headers() });
    const data = await res.json();
    expect(data.providers).toHaveLength(1);
    expect(data.providers[0].id).toBe('llm-stage');
    const props = Object.keys(data.schemas['llm-stage'].properties);
    expect(props).toContain('promptTemplate');
    expect(props).toContain('outputMapping');
    expect(props).toContain('temperature');
  });

  test('embedding providers available', async () => {
    const res = await api.get(`${PROVIDERS_PATH}/embedding`, { headers: headers() });
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.data.providers.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Publish & Delete ───────────────────────────────────────────────────

test.describe('Publish & Delete', () => {
  test('publish custom pipeline', async () => {
    if (!customPipelineId) return;

    // Replace all flows with a single valid default flow
    const singleFlow = [
      {
        id: 'flow-e2e-default',
        name: 'Default',
        enabled: true,
        priority: 0,
        isDefault: true,
        selectionRules: [],
        stages: [
          {
            id: 'e2e-ex',
            name: 'Extraction',
            type: 'extraction',
            provider: 'docling',
            providerConfig: { ocrEnabled: true },
            onError: 'fail',
          },
          {
            id: 'e2e-ch',
            name: 'Chunking',
            type: 'chunking',
            provider: 'recursive-character',
            providerConfig: { chunkSize: 1000, chunkOverlap: 200 },
            onError: 'fail',
          },
        ],
      },
    ];

    await api.patch(`${KB_PATH}/pipelines/${customPipelineId}`, {
      headers: headers(),
      data: { flows: singleFlow },
    });

    const res = await api.post(`${KB_PATH}/pipelines/${customPipelineId}/publish`, {
      headers: headers(),
    });
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.pipeline.status).toBe('active');
  });

  test('default pipeline not archived after custom publish', async () => {
    const res = await api.get(`${KB_PATH}/pipelines`, { headers: headers() });
    const data = await res.json();
    const defaultPipeline = data.pipelines.find((p: any) => p.isDefault);
    expect(defaultPipeline).toBeDefined();
    expect(defaultPipeline.status).not.toBe('archived');
  });

  test('delete custom pipeline triggers default fallback', async () => {
    const res = await api.delete(`${KB_PATH}/pipelines/${customPipelineId}`, {
      headers: headers(),
    });
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.success).toBe(true);

    // Verify default is active
    const getRes = await api.get(`${KB_PATH}/pipelines?active=true`, { headers: headers() });
    const pipeline = (await getRes.json()).pipeline;
    expect(pipeline.isDefault).toBe(true);
  });

  test('fallback status reports valid', async () => {
    const res = await api.get(`${KB_PATH}/pipelines/${defaultPipelineId}/fallback-status`, {
      headers: headers(),
    });
    const data = await res.json();
    expect(data.valid).toBe(true);
  });
});
