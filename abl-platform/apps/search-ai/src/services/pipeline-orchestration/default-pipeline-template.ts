/**
 * Default Pipeline Template
 *
 * Two flows with different extraction providers, shared post-extraction stages.
 *
 * Flow 1 — Docling (P:10): PDF, Office, HTML, images
 *   Matches: document.mimeType in [pdf, docx, pptx, html, image/*]
 *
 * Flow 2 — LlamaIndex (P:0, catch-all): text, markdown, everything else
 *   No rules — catches all unmatched documents
 *
 * Both flows share identical: Chunking → Content Intelligence → Visual Analysis
 *
 * The graph builder detects the shared stages and renders a diamond branch:
 * only extraction fans out, everything else is a single shared path.
 */

import type { ISearchPipelineDefinition } from '@agent-platform/database';

export const SYSTEM_TEMPLATE_VERSION = '2.0.0';

export const DEFAULT_FLOW_ID = 'flow-default';
export const DOCLING_FLOW_ID = 'flow-docling';

/** Shared post-extraction stages — identical config in both flows */
function sharedStages(prefix: string) {
  return [
    {
      id: `${prefix}-chunking`,
      name: 'Chunking',
      type: 'chunking' as const,
      provider: 'page',
      providerConfig: {},
      onError: 'fail' as const,
    },
    {
      id: `${prefix}-ci`,
      name: 'Content Intelligence',
      type: 'content-intelligence' as const,
      provider: 'content-intelligence',
      providerConfig: {
        generateSummary: true,
        summaryMaxTokens: 300,
        documentSummary: true,
        documentSummaryMaxTokens: 500,
        generateQuestions: true,
        questionsPerChunk: 3,
        documentQuestions: true,
        documentQuestionsCount: 5,
        modelTier: 'fast',
      },
      onError: 'continue' as const,
    },
    {
      id: `${prefix}-va`,
      name: 'Visual Analysis',
      type: 'visual-analysis' as const,
      provider: 'visual-analysis',
      providerConfig: {
        analyzeImages: true,
        analyzeScreenshots: true,
        analyzeCharts: true,
        summarizeTables: true,
        enhanceTableContinuations: true,
        modelTier: 'balanced',
        maxTokens: 500,
      },
      onError: 'continue' as const,
      executionCondition:
        'document.mimeType == "application/pdf" || document.mimeType.startsWith("image/")',
    },
  ];
}

export function createDefaultPipeline(
  tenantId: string,
  knowledgeBaseId: string,
  createdBy: string,
): Omit<ISearchPipelineDefinition, '_id' | 'createdAt' | 'updatedAt'> {
  const now = new Date();

  return {
    tenantId,
    knowledgeBaseId,
    name: 'Default Pipeline',
    description:
      'Routes by document type: Docling for rich formats, LlamaIndex for text. Shared chunking, intelligence, and visual analysis.',
    version: 1,
    status: 'active',
    isDefault: true,
    createdBy,

    activeEmbeddingConfig: {
      provider: 'bge-m3',
      model: 'bge-m3',
      dimensions: 1024,
    },

    flows: [
      // ── Docling flow (P:10) — PDF, Office, HTML, images ─────────────
      {
        id: DOCLING_FLOW_ID,
        name: 'Docling',
        description: 'PDF, Office, HTML, images — Docling extraction with OCR and table support.',
        enabled: true,
        priority: 10,
        isDefault: false,
        templateVersion: SYSTEM_TEMPLATE_VERSION,
        selectionRules: [
          {
            type: 'simple' as const,
            field: 'document.mimeType',
            operator: 'in',
            value: [
              'application/pdf',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'application/msword',
              'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              'application/vnd.ms-powerpoint',
              'text/html',
              'image/png',
              'image/jpeg',
              'image/tiff',
              'image/bmp',
              'image/webp',
            ],
          },
        ],
        stages: [
          {
            id: 'stage-docling',
            name: 'Docling',
            type: 'extraction',
            provider: 'docling',
            providerConfig: {
              ocrEnabled: true,
              extractTables: true,
              extractImages: true,
            },
            onError: 'fail',
          },
          ...sharedStages('docling'),
        ],
        createdAt: now,
        updatedAt: now,
      },

      // ── LlamaIndex flow (P:0) — text, markdown, catch-all ──────────
      {
        id: DEFAULT_FLOW_ID,
        name: 'LlamaIndex',
        description: 'Text, markdown, and all other formats — LlamaIndex simple text extraction.',
        enabled: true,
        priority: 0,
        isDefault: true,
        templateVersion: SYSTEM_TEMPLATE_VERSION,
        selectionRules: [],
        stages: [
          {
            id: 'stage-llamaindex',
            name: 'LlamaIndex',
            type: 'extraction',
            provider: 'llamaindex',
            providerConfig: { maxContentLength: 10000000 },
            onError: 'fail',
          },
          ...sharedStages('llama'),
        ],
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}
