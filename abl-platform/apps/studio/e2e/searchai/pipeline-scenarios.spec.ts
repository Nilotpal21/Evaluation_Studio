import {
  test,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
} from '@playwright/test';

const SEARCHAI = 'http://localhost:3113';
const TENANT = 'tenant-dev-001';
const PROJECT = 'proj-search-ai-strategies';
const KB = '019d9628-daa3-7a2c-abe7-156f86e0cece';
const KB_PATH = `${SEARCHAI}/api/projects/${PROJECT}/knowledge-bases/${KB}`;
const H = { 'Content-Type': 'application/json', 'x-tenant-id': TENANT };

let api: APIRequestContext;
let customId: string;

test.setTimeout(60_000);

test.beforeAll(async () => {
  api = await playwrightRequest.newContext();
  // Create a custom pipeline for testing scenarios
  const res = await api.post(`${KB_PATH}/pipelines`, {
    headers: H,
    data: { name: 'Scenario Tests' },
  });
  if (res.status() === 201) {
    customId = (await res.json()).pipeline._id;
  } else if (res.status() === 409) {
    // Already exists — find it
    const g = await api.get(`${KB_PATH}/pipelines`, { headers: H });
    const ps = (await g.json()).pipelines;
    const c = ps.find((p: any) => p.name === 'Scenario Tests');
    if (c) customId = c._id;
    else {
      // Create with different name
      const r2 = await api.post(`${KB_PATH}/pipelines`, {
        headers: H,
        data: { name: 'Scenario Tests ' + Date.now() },
      });
      customId = (await r2.json()).pipeline._id;
    }
  }
});

test.afterAll(async () => {
  if (customId)
    await api.delete(`${KB_PATH}/pipelines/${customId}`, { headers: H }).catch(() => {});
  await api.dispose();
});

// Helper: update pipeline with specific flows and validate
async function setFlowsAndValidate(flows: any[], expectValid: boolean, scenarioName: string) {
  // Update
  const upd = await api.patch(`${KB_PATH}/pipelines/${customId}`, { headers: H, data: { flows } });
  const updData = await upd.json();
  if (!updData.success) {
    console.log(
      `  ${scenarioName} — UPDATE FAILED: ${JSON.stringify(updData.error || updData).slice(0, 200)}`,
    );
    return false;
  }

  // Validate
  const pipeline = updData.pipeline;
  const val = await api.post(`${KB_PATH}/pipelines/validate`, { headers: H, data: pipeline });
  const valData = await val.json();
  const errors = valData.errors?.filter((e: any) => e.severity === 'error') || [];

  if (expectValid && !valData.valid) {
    console.log(`  ${scenarioName} — VALIDATION FAILED:`);
    errors.forEach((e: any) => console.log(`    ${e.code}: ${e.message?.slice(0, 80)}`));
    return false;
  }
  if (!expectValid && valData.valid) {
    console.log(`  ${scenarioName} — Expected invalid but got valid`);
    return false;
  }

  console.log(
    `  ✓ ${scenarioName} — ${valData.valid ? 'valid' : 'correctly invalid'} (${errors.length} errors)`,
  );
  return true;
}

// ─── SCENARIO 1: Standard Upload ─────────────────────────────────────────
test('Scenario 1: Standard Upload (Docling + LlamaIndex)', async () => {
  const flows = [
    {
      id: 'f-s1',
      name: 'Default',
      enabled: true,
      priority: 0,
      isDefault: true,
      selectionRules: [],
      stages: [
        {
          id: 's1-ex',
          name: 'Extraction',
          type: 'extraction',
          provider: 'docling',
          providerConfig: { ocrEnabled: true, extractTables: true, extractImages: true },
          onError: 'fail',
          fallbackProvider: 'llamaindex',
          fallbackConfig: { maxContentLength: 10000000 },
        },
        {
          id: 's1-ch',
          name: 'Chunking',
          type: 'chunking',
          provider: 'recursive-character',
          providerConfig: { chunkSize: 1000, chunkOverlap: 200 },
          onError: 'fail',
        },
        {
          id: 's1-ci',
          name: 'Content Intelligence',
          type: 'content-intelligence',
          provider: 'content-intelligence',
          providerConfig: { generateSummary: true, modelTier: 'fast' },
          onError: 'continue',
        },
        {
          id: 's1-va',
          name: 'Visual Analysis',
          type: 'visual-analysis',
          provider: 'visual-analysis',
          providerConfig: { analyzeImages: true, modelTier: 'balanced' },
          onError: 'continue',
        },
      ],
    },
  ];
  expect(await setFlowsAndValidate(flows, true, 'Standard Upload')).toBe(true);
});

// ─── SCENARIO 2: Custom API → Raw Document (Source mode) ─────────────────
test('Scenario 2: Custom API → Raw Document (Source mode)', async () => {
  const flows = [
    {
      id: 'f-s2',
      name: 'Default',
      enabled: true,
      priority: 0,
      isDefault: true,
      selectionRules: [],
      stages: [
        {
          id: 's2-api',
          name: 'Fetch from CRM',
          type: 'api-webhook',
          provider: 'http-webhook',
          providerConfig: {
            url: 'https://api.example.com/documents',
            method: 'POST',
            mode: 'source',
            outputType: 'document',
            entryPoint: 'before-extraction',
          },
          onError: 'continue',
        },
        {
          id: 's2-ex',
          name: 'Extraction',
          type: 'extraction',
          provider: 'docling',
          providerConfig: { ocrEnabled: true },
          onError: 'fail',
        },
        {
          id: 's2-ch',
          name: 'Chunking',
          type: 'chunking',
          provider: 'recursive-character',
          providerConfig: { chunkSize: 1000, chunkOverlap: 200 },
          onError: 'fail',
        },
        {
          id: 's2-ci',
          name: 'Content Intelligence',
          type: 'content-intelligence',
          provider: 'content-intelligence',
          providerConfig: { generateSummary: true, modelTier: 'fast' },
          onError: 'continue',
        },
      ],
    },
  ];
  expect(await setFlowsAndValidate(flows, true, 'Custom API → Raw Document')).toBe(true);
});

// ─── SCENARIO 3: Custom API → Extracted Text (Replacement, skip extraction) ─
test('Scenario 3: Custom API → Extracted Text (skip extraction)', async () => {
  const flows = [
    {
      id: 'f-s3',
      name: 'Default',
      enabled: true,
      priority: 0,
      isDefault: true,
      selectionRules: [],
      stages: [
        {
          id: 's3-api',
          name: 'Transcription API',
          type: 'extraction',
          provider: 'http-webhook',
          providerConfig: {
            url: 'https://api.example.com/transcribe',
            method: 'POST',
            mode: 'replacement',
            outputType: 'text',
            entryPoint: 'after-extraction',
          },
          onError: 'continue',
        },
        {
          id: 's3-ch',
          name: 'Chunking',
          type: 'chunking',
          provider: 'recursive-character',
          providerConfig: { chunkSize: 1000, chunkOverlap: 200 },
          onError: 'fail',
        },
        {
          id: 's3-ci',
          name: 'Content Intelligence',
          type: 'content-intelligence',
          provider: 'content-intelligence',
          providerConfig: { generateSummary: true, modelTier: 'fast' },
          onError: 'continue',
        },
      ],
    },
  ];
  expect(await setFlowsAndValidate(flows, true, 'Custom API → Text (replacement)')).toBe(true);
});

// ─── SCENARIO 4: Custom API → Text BUT Still Extract (Source mode) ───────
test('Scenario 4: Custom API → Text, still run extraction (Source mode)', async () => {
  const flows = [
    {
      id: 'f-s4',
      name: 'Default',
      enabled: true,
      priority: 0,
      isDefault: true,
      selectionRules: [],
      stages: [
        {
          id: 's4-api',
          name: 'Legacy OCR',
          type: 'api-webhook',
          provider: 'http-webhook',
          providerConfig: {
            url: 'https://api.example.com/ocr',
            method: 'POST',
            mode: 'source',
            outputType: 'text',
            entryPoint: 'before-extraction',
          },
          onError: 'continue',
        },
        {
          id: 's4-ex',
          name: 'Docling Re-Extract',
          type: 'extraction',
          provider: 'docling',
          providerConfig: { ocrEnabled: true },
          onError: 'fail',
        },
        {
          id: 's4-ch',
          name: 'Chunking',
          type: 'chunking',
          provider: 'recursive-character',
          providerConfig: { chunkSize: 1000, chunkOverlap: 200 },
          onError: 'fail',
        },
        {
          id: 's4-ci',
          name: 'Content Intelligence',
          type: 'content-intelligence',
          provider: 'content-intelligence',
          providerConfig: { generateSummary: true, modelTier: 'fast' },
          onError: 'continue',
        },
      ],
    },
  ];
  expect(await setFlowsAndValidate(flows, true, 'Custom API → Text + Re-Extract')).toBe(true);
});

// ─── SCENARIO 5: Custom API → Pre-Chunked Data (skip extraction + chunking)
test('Scenario 5: Custom API → Chunks (skip extraction + chunking)', async () => {
  const flows = [
    {
      id: 'f-s5',
      name: 'Default',
      enabled: true,
      priority: 0,
      isDefault: true,
      selectionRules: [],
      stages: [
        {
          id: 's5-api',
          name: 'Zendesk Articles',
          type: 'api-webhook',
          provider: 'http-webhook',
          providerConfig: {
            url: 'https://api.example.com/articles',
            method: 'GET',
            mode: 'replacement',
            outputType: 'chunks',
            entryPoint: 'after-chunking',
          },
          onError: 'continue',
        },
        {
          id: 's5-ci',
          name: 'Content Intelligence',
          type: 'content-intelligence',
          provider: 'content-intelligence',
          providerConfig: { generateSummary: true, modelTier: 'fast' },
          onError: 'continue',
        },
      ],
    },
  ];
  expect(await setFlowsAndValidate(flows, true, 'Custom API → Chunks')).toBe(true);
});

// ─── SCENARIO 6: Custom API → Chunks BUT Re-Extract ─────────────────────
test('Scenario 6: Custom API → Chunks, merge and re-extract (Source mode)', async () => {
  const flows = [
    {
      id: 'f-s6',
      name: 'Default',
      enabled: true,
      priority: 0,
      isDefault: true,
      selectionRules: [],
      stages: [
        {
          id: 's6-api',
          name: 'Legacy Export',
          type: 'api-webhook',
          provider: 'http-webhook',
          providerConfig: {
            url: 'https://api.example.com/export',
            method: 'GET',
            mode: 'source',
            outputType: 'chunks',
            entryPoint: 'before-extraction',
          },
          onError: 'continue',
        },
        {
          id: 's6-ex',
          name: 'Re-Extract',
          type: 'extraction',
          provider: 'docling',
          providerConfig: { ocrEnabled: true },
          onError: 'fail',
        },
        {
          id: 's6-ch',
          name: 'Re-Chunk',
          type: 'chunking',
          provider: 'recursive-character',
          providerConfig: { chunkSize: 500, chunkOverlap: 100 },
          onError: 'fail',
        },
        {
          id: 's6-ci',
          name: 'Content Intelligence',
          type: 'content-intelligence',
          provider: 'content-intelligence',
          providerConfig: { generateSummary: true, modelTier: 'fast' },
          onError: 'continue',
        },
      ],
    },
  ];
  expect(await setFlowsAndValidate(flows, true, 'Custom API → Chunks + Re-Extract')).toBe(true);
});

// ─── SCENARIO 7: Transformer after extraction (PII redaction) ───────────
test('Scenario 7: Custom Script transformer after extraction (PII redaction)', async () => {
  const flows = [
    {
      id: 'f-s7',
      name: 'Default',
      enabled: true,
      priority: 0,
      isDefault: true,
      selectionRules: [],
      stages: [
        {
          id: 's7-ex',
          name: 'Extraction',
          type: 'extraction',
          provider: 'docling',
          providerConfig: { ocrEnabled: true },
          onError: 'fail',
        },
        {
          id: 's7-ch',
          name: 'Chunking',
          type: 'chunking',
          provider: 'recursive-character',
          providerConfig: { chunkSize: 1000, chunkOverlap: 200 },
          onError: 'fail',
        },
        {
          id: 's7-ci',
          name: 'Content Intelligence',
          type: 'content-intelligence',
          provider: 'content-intelligence',
          providerConfig: { generateSummary: true, modelTier: 'fast' },
          onError: 'continue',
        },
      ],
    },
  ];
  expect(await setFlowsAndValidate(flows, true, 'Transformer after extraction')).toBe(true);
});

// ─── SCENARIO 8: Transformer after chunking (translation) ───────────────
test('Scenario 8: Custom API transformer after chunking (translate chunks)', async () => {
  const flows = [
    {
      id: 'f-s8',
      name: 'Default',
      enabled: true,
      priority: 0,
      isDefault: true,
      selectionRules: [],
      stages: [
        {
          id: 's8-ex',
          name: 'Extraction',
          type: 'extraction',
          provider: 'docling',
          providerConfig: { ocrEnabled: true },
          onError: 'fail',
        },
        {
          id: 's8-ch',
          name: 'Chunking',
          type: 'chunking',
          provider: 'recursive-character',
          providerConfig: { chunkSize: 1000, chunkOverlap: 200 },
          onError: 'fail',
        },
        {
          id: 's8-tr',
          name: 'Translate',
          type: 'api-webhook',
          provider: 'http-webhook',
          providerConfig: {
            url: 'https://api.example.com/translate',
            method: 'POST',
            mode: 'transformer',
            outputType: 'text',
            entryPoint: 'after-chunking',
          },
          onError: 'continue',
        },
        {
          id: 's8-ci',
          name: 'Content Intelligence',
          type: 'content-intelligence',
          provider: 'content-intelligence',
          providerConfig: { generateSummary: true, modelTier: 'fast' },
          onError: 'continue',
        },
      ],
    },
  ];
  expect(await setFlowsAndValidate(flows, true, 'Transformer after chunking')).toBe(true);
});

// ─── SCENARIO 9: Custom API → Enriched Chunks (skip to embedding) ───────
test('Scenario 9: Custom API → Enriched Chunks (skip to embedding)', async () => {
  const flows = [
    {
      id: 'f-s9',
      name: 'Default',
      enabled: true,
      priority: 0,
      isDefault: true,
      selectionRules: [],
      stages: [
        {
          id: 's9-api',
          name: 'NLP Service',
          type: 'api-webhook',
          provider: 'http-webhook',
          providerConfig: {
            url: 'https://api.example.com/nlp',
            method: 'POST',
            mode: 'replacement',
            outputType: 'enriched-chunks',
            entryPoint: 'after-enrichment',
          },
          onError: 'fail',
        },
      ],
    },
  ];
  expect(await setFlowsAndValidate(flows, true, 'Custom API → Enriched Chunks')).toBe(true);
});

// ─── SCENARIO 10: Re-Chunk (change chunk size on existing pipeline) ──────
test('Scenario 10: Re-Chunk with different chunk size', async () => {
  const flows = [
    {
      id: 'f-s10',
      name: 'Default',
      enabled: true,
      priority: 0,
      isDefault: true,
      selectionRules: [],
      stages: [
        {
          id: 's10-ex',
          name: 'Extraction',
          type: 'extraction',
          provider: 'docling',
          providerConfig: { ocrEnabled: true },
          onError: 'fail',
        },
        {
          id: 's10-ch',
          name: 'Chunking',
          type: 'chunking',
          provider: 'recursive-character',
          providerConfig: { chunkSize: 500, chunkOverlap: 100 },
          onError: 'fail',
        },
        {
          id: 's10-ci',
          name: 'Content Intelligence',
          type: 'content-intelligence',
          provider: 'content-intelligence',
          providerConfig: { generateSummary: true, modelTier: 'fast' },
          onError: 'continue',
        },
      ],
    },
  ];
  expect(await setFlowsAndValidate(flows, true, 'Re-Chunk with chunkSize=500')).toBe(true);
});

// ─── BONUS: Custom LLM stage ────────────────────────────────────────────
test('Bonus: Custom LLM stage for classification', async () => {
  const flows = [
    {
      id: 'f-llm',
      name: 'Default',
      enabled: true,
      priority: 0,
      isDefault: true,
      selectionRules: [],
      stages: [
        {
          id: 'sl-ex',
          name: 'Extraction',
          type: 'extraction',
          provider: 'docling',
          providerConfig: { ocrEnabled: true },
          onError: 'fail',
        },
        {
          id: 'sl-ch',
          name: 'Chunking',
          type: 'chunking',
          provider: 'recursive-character',
          providerConfig: { chunkSize: 1000, chunkOverlap: 200 },
          onError: 'fail',
        },
        {
          id: 'sl-llm',
          name: 'Classify',
          type: 'llm-stage',
          provider: 'llm-stage',
          providerConfig: {
            promptTemplate: 'Classify: {{content}}',
            outputMapping: 'append-metadata',
            metadataKey: 'category',
            modelTier: 'fast',
            temperature: 0,
          },
          onError: 'continue',
        },
        {
          id: 'sl-ci',
          name: 'Content Intelligence',
          type: 'content-intelligence',
          provider: 'content-intelligence',
          providerConfig: { generateSummary: true, modelTier: 'fast' },
          onError: 'continue',
        },
      ],
    },
  ];
  expect(await setFlowsAndValidate(flows, true, 'Custom LLM classification stage')).toBe(true);
});

// ─── BONUS: CEL execution condition on stage ─────────────────────────────
test('Bonus: Stage with CEL execution condition', async () => {
  const flows = [
    {
      id: 'f-cel',
      name: 'Default',
      enabled: true,
      priority: 0,
      isDefault: true,
      selectionRules: [],
      stages: [
        {
          id: 'sc-ex',
          name: 'Extraction',
          type: 'extraction',
          provider: 'docling',
          providerConfig: { ocrEnabled: true },
          onError: 'fail',
        },
        {
          id: 'sc-ch',
          name: 'Chunking',
          type: 'chunking',
          provider: 'recursive-character',
          providerConfig: { chunkSize: 1000, chunkOverlap: 200 },
          onError: 'fail',
        },
        {
          id: 'sc-ci',
          name: 'Content Intelligence',
          type: 'content-intelligence',
          provider: 'content-intelligence',
          providerConfig: { generateSummary: true, modelTier: 'fast' },
          onError: 'continue',
          executionCondition: 'document.size > 1024',
        },
        {
          id: 'sc-va',
          name: 'Visual Analysis',
          type: 'visual-analysis',
          provider: 'visual-analysis',
          providerConfig: { analyzeImages: true, modelTier: 'balanced' },
          onError: 'continue',
          executionCondition: 'document.mimeType == "application/pdf"',
        },
      ],
    },
  ];
  expect(await setFlowsAndValidate(flows, true, 'Stages with CEL conditions')).toBe(true);
});
