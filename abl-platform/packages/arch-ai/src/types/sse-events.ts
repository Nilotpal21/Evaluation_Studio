/**
 * SSE event types — Contract: sse-protocol.md
 * 22 event types: 13 existing + 3 B03 multimodal file events + 6 BUILD agent progress events.
 */

import { z } from 'zod';

export const TextDeltaEventSchema = z.object({
  type: z.literal('text_delta'),
  delta: z.string(),
});

export const ToolCallEventSchema = z.object({
  type: z.literal('tool_call'),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.record(z.unknown()),
});

export const ToolResultEventSchema = z.object({
  type: z.literal('tool_result'),
  toolCallId: z.string(),
  toolName: z.string().optional(),
  result: z.unknown(),
  isError: z.boolean().optional(),
});

export const SpecialistEventSchema = z.object({
  type: z.literal('specialist'),
  name: z.string(),
  icon: z.string(),
});

export const PhaseTransitionEventSchema = z.object({
  type: z.literal('phase_transition'),
  from: z.string(),
  to: z.string(),
});

export const JournalEntryEventSchema = z.object({
  type: z.literal('journal_entry'),
  entryType: z.enum(['decision', 'consultation', 'mutation', 'validation', 'analysis']),
  summary: z.string(),
  description: z.string().optional(),
});

export const FileChangedEventSchema = z.object({
  type: z.literal('file_changed'),
  path: z.string(),
  action: z.enum(['create', 'update', 'delete']),
  content: z.string().optional(),
});

export const CompileResultEventSchema = z.object({
  type: z.literal('compile_result'),
  agent: z.string(),
  status: z.enum(['pass', 'fail']),
  errors: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
});

export const GateRequestEventSchema = z.object({
  type: z.literal('gate_request'),
  gateType: z.string(),
  data: z.record(z.unknown()),
});

export const ProgressEventSchema = z.object({
  type: z.literal('progress'),
  step: z.number(),
  total: z.number(),
  label: z.string(),
});

export const SuggestionCategorySchema = z.enum([
  'error-handling',
  'escalation',
  'testing',
  'optimization',
  'feature',
  'security',
  'modify',
  'health',
  'topology',
  'trace',
]);

export const SuggestionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  category: SuggestionCategorySchema,
  prompt: z.string(),
  icon: z.string(),
});

export const CompletionMetaSchema = z.object({
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    totalTokens: z.number(),
  }),
  finishReason: z.string(),
  stepCount: z.number(),
  latencyMs: z.number(),
  model: z.string(),
});

export type CompletionMeta = z.infer<typeof CompletionMetaSchema>;

export const DoneEventSchema = z.object({
  type: z.literal('done'),
  suggestions: z.array(SuggestionSchema).optional(),
  completion: CompletionMetaSchema.optional(),
});

export const ErrorEventSchema = z.object({
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});

export const ActivityEventSchema = z.object({
  type: z.literal('activity'),
  id: z.string(),
  status: z.enum(['active', 'done', 'error', 'warning', 'info']),
  label: z.string(),
  group: z.string().optional(),
  groupLabel: z.string().optional(),
  detail: z.string().optional(),
  timestamp: z.string(),
});

// --- B03: Multimodal file events ---

export const FileProcessedEventSchema = z.object({
  type: z.literal('file_processed'),
  blobId: z.string(),
  name: z.string(),
  mediaType: z.string(),
  size: z.number(),
  tokenCost: z.number(),
  metadata: z.record(z.unknown()),
  smartAction: z
    .object({
      type: z.string(),
      prompt: z.string(),
      actions: z.array(z.object({ label: z.string(), action: z.string() })),
    })
    .optional(),
});

export const FileErrorEventSchema = z.object({
  type: z.literal('file_error'),
  fileName: z.string(),
  error: z.object({
    code: z.enum([
      'corrupt',
      'parse_failed',
      'type_mismatch',
      'too_large',
      'decode_failed',
      'invalid_spec',
      'timeout',
      'session_full',
    ]),
    message: z.string(),
  }),
  recovery: z.array(z.string()),
});

export const FileContextChangeEventSchema = z.object({
  type: z.literal('file_context_change'),
  blobId: z.string(),
  change: z.enum(['evicted', 'included', 'excluded', 'deleted', 'failed']),
  contextBudget: z
    .object({
      used: z.number(),
      total: z.number(),
    })
    .optional(),
});

// --- BUILD agent progress events ---

export const BuildAgentStartEventSchema = z.object({
  type: z.literal('build_agent_start'),
  agent: z.string(),
  mode: z.string(),
  role: z.string(),
});

export const BuildAgentStageEventSchema = z.object({
  type: z.literal('build_agent_stage'),
  agent: z.string(),
  stage: z.enum([
    'compiling',
    'enriching',
    'fixing',
    'recompiling',
    'done',
    // Scaffold+fill stages (FEATURE_SCAFFOLD_GENERATION). Shown in the build
    // tile so users see what the worker is doing in real time.
    'scaffolding',
    'filling',
    'validating',
    'retrying_slot',
    'assembling',
  ]),
  detail: z.string().optional(),
});

export const QualityFloorSchema = z.object({
  guardrails: z.boolean(),
  memory: z.boolean(),
  errorHandlers: z.boolean(),
  constraints: z.boolean(),
  catchAllHandoff: z.boolean(),
});

export const BuildAgentCompiledEventSchema = z.object({
  type: z.literal('build_agent_compiled'),
  agent: z.string(),
  elapsed: z.number(),
  mode: z.string(),
  agentType: z.string(),
  toolCount: z.number(),
  handoffCount: z.number(),
  quality: QualityFloorSchema,
  warnings: z.array(z.string()),
  usage: z
    .object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      totalTokens: z.number(),
    })
    .optional(),
  finishReason: z.string().optional(),
  stepCount: z.number().optional(),
});

export const BuildAgentEnrichedEventSchema = z.object({
  type: z.literal('build_agent_enriched'),
  agent: z.string(),
  injected: z.array(z.string()),
  reason: z.string(),
});

export const BuildAgentErrorEventSchema = z.object({
  type: z.literal('build_agent_error'),
  agent: z.string(),
  error: z.string(),
  stage: z.string(),
});

export const BuildAgentValidatedEventSchema = z.object({
  type: z.literal('build_agent_validated'),
  agent: z.string(),
  warnings: z.array(z.string()),
  toolCount: z.number(),
  handoffCount: z.number(),
  fixRounds: z.number().optional(),
});

export const BuildReconciledEventSchema = z.object({
  type: z.literal('build_reconciled'),
  agents: z.record(
    z.string(),
    z.object({
      status: z.enum(['compiled', 'warning', 'error']),
      errors: z.array(z.string()),
      warnings: z.array(z.string()),
    }),
  ),
  summary: z.object({
    total: z.number(),
    compiled: z.number(),
    warnings: z.number(),
    errors: z.number(),
  }),
});

export const BuildRetryStartEventSchema = z.object({
  type: z.literal('build_retry_start'),
  agents: z.array(z.string()),
});

export const BuildAgentDiagnosticsEventSchema = z.object({
  type: z.literal('build_agent_diagnostics'),
  agent: z.string(),
  overallSeverity: z.enum(['error', 'warning', 'info']),
  summary: z.object({
    errors: z.number(),
    warnings: z.number(),
    infos: z.number(),
    total: z.number(),
  }),
  /** Top findings (limited to 10 most impactful). */
  findings: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      severity: z.enum(['error', 'warning', 'info']),
      category: z.string(),
      fix: z
        .object({
          description: z.string(),
          effort: z.enum(['S', 'M', 'L']),
        })
        .optional(),
    }),
  ),
  architecturePattern: z.string().optional(),
  antiPatterns: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        agents: z.array(z.string()),
        severity: z.enum(['error', 'warning', 'info']),
      }),
    )
    .optional(),
});

// --- Streaming file content deltas (BUILD phase live preview) ---

export const FileContentDeltaEventSchema = z.object({
  type: z.literal('file_content_delta'),
  agentName: z.string(),
  delta: z.string(),
});

// --- Spec document live updates ---

export const SpecDocumentUpdateEventSchema = z.object({
  type: z.literal('spec_document_update'),
  path: z.string(),
  value: z.unknown(),
  version: z.number(),
});

// --- KB card events (Arch KB Assistant) ---

const KBCardActionSchema = z.object({
  label: z.string(),
  action: z.string(),
  variant: z.enum(['primary', 'secondary']),
  deepLink: z.string().optional(),
});

export const KBStatusCardEventSchema = z.object({
  type: z.literal('kb_status_card'),
  kbId: z.string(),
  kbName: z.string(),
  indexId: z.string().optional(),
  status: z.string(),
  stats: z.object({
    documentCount: z.number(),
    chunkCount: z.number(),
    sourceCount: z.number(),
    connectorCount: z.number(),
  }),
  actions: z.array(KBCardActionSchema),
});

export const UploadProgressCardEventSchema = z.object({
  type: z.literal('upload_progress_card'),
  kbId: z.string(),
  kbName: z.string(),
  files: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      stage: z.string().optional(),
      progress: z.number().optional(),
    }),
  ),
  actions: z.array(KBCardActionSchema),
});

export const SearchResultsCardEventSchema = z.object({
  type: z.literal('search_results_card'),
  kbId: z.string(),
  kbName: z.string(),
  query: z.string(),
  resultCount: z.number(),
  latencyMs: z.number(),
  results: z.array(
    z.object({
      title: z.string(),
      score: z.number(),
      content: z.string().optional(),
      source: z.string().optional(),
      sourceType: z.string().optional(),
    }),
  ),
  actions: z.array(KBCardActionSchema),
});

export const KBHealthCardEventSchema = z.object({
  type: z.literal('kb_health_card'),
  kbId: z.string(),
  kbName: z.string(),
  overallStatus: z.enum(['healthy', 'warning', 'error']),
  sections: z.object({
    sources: z.object({ total: z.number(), healthy: z.number(), syncing: z.number() }),
    documents: z.object({ total: z.number(), errored: z.number(), processing: z.number() }),
    pipeline: z.object({ status: z.string() }),
    llm: z.object({ configured: z.boolean() }),
  }),
  errorSummary: z.string().optional(),
  actions: z.array(KBCardActionSchema),
});

export const ConnectorStatusCardEventSchema = z.object({
  type: z.literal('connector_status_card'),
  kbId: z.string(),
  kbName: z.string(),
  connectorId: z.string(),
  connectorType: z.string(),
  authStatus: z.string(),
  syncStatus: z.string(),
  syncProgress: z
    .object({
      processed: z.number(),
      total: z.number(),
      failed: z.number(),
    })
    .optional(),
  lastSyncAt: z.string().optional(),
  actions: z.array(KBCardActionSchema),
});

export const DocProcessingCardEventSchema = z.object({
  type: z.literal('doc_processing_card'),
  kbId: z.string(),
  kbName: z.string(),
  statusBreakdown: z.object({
    ready: z.number(),
    processing: z.number(),
    extracting: z.number(),
    errored: z.number(),
    pending: z.number(),
  }),
  actions: z.array(KBCardActionSchema),
});

// ─── External Agent card (A2A Spec 1) ─────────────────────────────────────
//
// R6 MED-1: strongly-typed payload (NOT `data: z.unknown()`). Mirrors the
// `ExternalAgentConfigView` wire-shape exposed by the runtime route and the
// Studio executor's emitCard() invocation. Re-exported via
// `packages/arch-ai/src/types/index.ts` and `packages/arch-ai/src/index.ts`.
export const ExternalAgentCardEventSchema = z.object({
  type: z.literal('external_agent_card'),
  id: z.string(),
  name: z.string(),
  displayName: z.string().nullable().optional(),
  endpoint: z.string(),
  protocol: z.string(),
  authType: z.string(),
  authConfigured: z.boolean(),
  lastDiscoveredCard: z.record(z.unknown()).nullable().optional(),
  lastConnectionStatus: z.string().nullable().optional(),
  lastConnectionAt: z.string().nullable().optional(),
  lastConnectionLatencyMs: z.number().nullable().optional(),
  lastConnectionError: z.string().nullable().optional(),
});

export const ArchSSEEventSchema = z.discriminatedUnion('type', [
  TextDeltaEventSchema,
  ToolCallEventSchema,
  ToolResultEventSchema,
  SpecialistEventSchema,
  PhaseTransitionEventSchema,
  JournalEntryEventSchema,
  FileChangedEventSchema,
  CompileResultEventSchema,
  GateRequestEventSchema,
  ProgressEventSchema,
  DoneEventSchema,
  ErrorEventSchema,
  ActivityEventSchema,
  FileProcessedEventSchema,
  FileErrorEventSchema,
  FileContextChangeEventSchema,
  BuildAgentStartEventSchema,
  BuildAgentStageEventSchema,
  BuildAgentCompiledEventSchema,
  BuildAgentEnrichedEventSchema,
  BuildAgentErrorEventSchema,
  BuildAgentValidatedEventSchema,
  BuildReconciledEventSchema,
  BuildRetryStartEventSchema,
  BuildAgentDiagnosticsEventSchema,
  FileContentDeltaEventSchema,
  SpecDocumentUpdateEventSchema,
  KBStatusCardEventSchema,
  UploadProgressCardEventSchema,
  SearchResultsCardEventSchema,
  KBHealthCardEventSchema,
  ConnectorStatusCardEventSchema,
  DocProcessingCardEventSchema,
  ExternalAgentCardEventSchema,
]);

export type ArchSSEEvent = z.infer<typeof ArchSSEEventSchema>;

export type BuildAgentValidatedEvent = z.infer<typeof BuildAgentValidatedEventSchema>;
export type BuildAgentDiagnosticsEvent = z.infer<typeof BuildAgentDiagnosticsEventSchema>;
export type BuildReconciledEvent = z.infer<typeof BuildReconciledEventSchema>;
export type BuildRetryStartEvent = z.infer<typeof BuildRetryStartEventSchema>;
export type FileContentDeltaEvent = z.infer<typeof FileContentDeltaEventSchema>;
export type SpecDocumentUpdateEvent = z.infer<typeof SpecDocumentUpdateEventSchema>;
export type KBStatusCardEvent = z.infer<typeof KBStatusCardEventSchema>;
export type UploadProgressCardEvent = z.infer<typeof UploadProgressCardEventSchema>;
export type SearchResultsCardEvent = z.infer<typeof SearchResultsCardEventSchema>;
export type KBHealthCardEvent = z.infer<typeof KBHealthCardEventSchema>;
export type ConnectorStatusCardEvent = z.infer<typeof ConnectorStatusCardEventSchema>;
export type DocProcessingCardEvent = z.infer<typeof DocProcessingCardEventSchema>;
export type ExternalAgentCardEvent = z.infer<typeof ExternalAgentCardEventSchema>;
