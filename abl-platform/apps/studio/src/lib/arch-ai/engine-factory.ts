/**
 * Engine factory — builds turn-scoped service bags AND production TurnEngine
 * instances for the active turn engine.
 *
 * Source of truth: docs/superpowers/specs/2026-04-17-arch-ai-orchestration-redesign-design.md §7
 * Plan: docs/superpowers/plans/2026-04-18-arch-ai-engine-rewire-impl-plan.md Phase 1.5 + 6.3
 *
 * Provides:
 *   - `buildServiceBagForTurn(buffer)` — per-turn buffered service bag
 *   - `buildV1CoreRefs()` — lazy-import all v1 Core function refs from Studio tool modules
 *   - `buildV2LlmStreamClient(tenantId)` — adapts existing Vercel AI SDK model resolver to v2 interface
 *   - `createProductionTurnEngine(tenantId)` — fully wired TurnEngine ready for runTurn()
 *   - `buildOnboardingToolRegistry()` — v2 ToolRegistry populated with all onboarding-phase tools
 *     (INTERVIEW + BLUEPRINT + BUILD). Phase-scoping is done by coordinator-bridge's `resolveTurnPlan`.
 */

import mongoose from 'mongoose';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { z } from 'zod';
import { ArchSpecDocument } from '@agent-platform/database/models';
import { estimateCost } from '@agent-platform/shared/model-pricing';
import type {
  TurnBuffer,
  MinimalCollection,
  V2LLMStreamClient,
  V2LLMStreamRequest,
  V2LLMStreamChunk,
  TurnEngineDeps,
} from '@agent-platform/arch-ai/engine';
import {
  createBufferedSessionService,
  createBufferedJournalService,
  createBufferedSpecDocumentService,
  createBufferedProjectService,
  createBufferedArchSessionsCollection,
  TurnEngine,
} from '@agent-platform/arch-ai/engine';
import { ToolRegistry } from '@agent-platform/arch-ai/tools';
import {
  publishTurnEvent,
  buildDurablePublisher,
  createRingBuffer,
} from '@agent-platform/arch-ai/session';
import type { RingBufferClient } from '@agent-platform/arch-ai/session';
import type { TurnEvent } from '@agent-platform/arch-ai';
import type { MinimalTurnContext } from '@agent-platform/arch-ai/tools';
import {
  extractSourceArchitectureContractFromFiles,
  searchDocsGrouped,
  SPEC_TO_SESSION_FIELD_MAP,
  validateTopologyAgainstSourceContract,
} from '@agent-platform/arch-ai';
import {
  renderKnownConstructsHint,
  renderMissingMemoryWarning,
  renderSupervisorCatchAllHandoffWarning,
} from '@agent-platform/arch-ai/constructs';
import { renderMissingGuardrailsWarning } from '@agent-platform/arch-ai/guardrails';
import type { ArchFileStore } from '@agent-platform/arch-ai/session';
import type { SourceArchitectureContract } from '@agent-platform/arch-ai';
import {
  sessionService as realSessionService,
  journalService as realJournalService,
  specDocumentService as realSpecDocumentService,
  fileStoreService as realFileStoreService,
} from '@/lib/arch-ai/message-services';
import {
  truncate,
  journalAppendAndEmit,
  specUpdateAndEmit,
} from '@/lib/arch-ai/helpers/stream-helpers';
import { askUserSchema, collectFileSchema, updateSpecSchema } from '@/lib/arch-ai/tool-schemas';
import { TraceDiagnosisInputSchema } from '@/lib/arch-ai/tools/trace-diagnosis';
import { ARCH_AI_LLM_DEFAULTS, ARCH_AI_TIMEOUTS } from '@/lib/arch-ai/constants';
import { buildTemperatureOption } from '@/lib/arch-ai/model-options';
import { buildV1CoreRefs } from '@/lib/arch-ai/compat/v1-core-refs';
import {
  buildInProjectTools,
  type InProjectMutationGuardOptions,
} from '@/lib/arch-ai/tools/in-project-tools';
import {
  CompileWorkerTimeoutError,
  runIsolatedSingleAgentCompile,
} from '@/lib/arch-ai/helpers/isolated-build-compiler';
import { toV2VercelMessages } from '@/lib/arch-ai/vercel-message-adapter';
import * as projectServiceModule from '@/services/project-service';
import { getRedisClient } from '@/lib/redis-client';
import { TOPOLOGY_DECISION_TREE, TOPOLOGY_PATTERNS } from '@/lib/arch-ai/topology-patterns';
import { validateTopologyRuntimeHints } from '@/lib/arch-ai/topology-runtime-validation';

const log = createLogger('arch-ai:engine-factory');
const DURABLE_REPLAY_SEQ_TTL_SECONDS = 3600;

type StreamTextToolChoice =
  | 'auto'
  | 'required'
  | 'none'
  | {
      type: 'tool';
      toolName: string;
    };

function parseToolChoice(
  raw: unknown,
  allowedToolNames: Set<string>,
): StreamTextToolChoice | undefined {
  if (raw === 'auto' || raw === 'required' || raw === 'none') {
    return raw;
  }

  if (
    raw &&
    typeof raw === 'object' &&
    (raw as { type?: unknown }).type === 'tool' &&
    typeof (raw as { toolName?: unknown }).toolName === 'string'
  ) {
    const toolName = (raw as { toolName: string }).toolName;
    return allowedToolNames.has(toolName) ? { type: 'tool', toolName } : undefined;
  }

  return undefined;
}

function parseActiveTools(raw: unknown, allowedToolNames: Set<string>): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const filtered = raw.filter((value): value is string => {
    return typeof value === 'string' && allowedToolNames.has(value);
  });

  return filtered.length > 0 ? filtered : undefined;
}

function getTurnBuffer(ctx: MinimalTurnContext): TurnBuffer | undefined {
  const turnCtx = ctx as MinimalTurnContext & { buffer?: TurnBuffer };
  return turnCtx.buffer;
}

function toToolRegistryInputSchema(schema: unknown): z.ZodSchema<unknown> {
  if (
    schema &&
    typeof schema === 'object' &&
    typeof (schema as { safeParse?: unknown }).safeParse === 'function'
  ) {
    return schema as z.ZodSchema<unknown>;
  }

  return z.record(z.unknown());
}

function patchBufferedSpecificationField(buffer: TurnBuffer, field: string, value: unknown): void {
  buffer.patchSession({
    [`metadata.specification.${field}`]: value,
  });
}

function enqueueBufferedSpecDocumentFieldUpdate(params: {
  buffer: TurnBuffer;
  tenantId: string;
  userId: string;
  sessionId: string;
  path: string;
  value: unknown;
}): void {
  const { buffer, tenantId, userId, sessionId, path, value } = params;

  buffer.enqueueProjectWrite({
    label: `specDocument:updateField:${path}`,
    execute: async (session) => {
      const opts =
        session && typeof session === 'object'
          ? { returnDocument: 'after' as const, session: session as mongoose.ClientSession }
          : { returnDocument: 'after' as const };

      await ArchSpecDocument.findOneAndUpdate(
        {
          tenantId,
          userId,
          sessionId,
        },
        {
          $set: { [path]: value },
          $inc: { version: 1 },
        },
        opts,
      );
    },
  });
}

// ─── Types ──────────────────────────────────────────────────────────────

export interface TurnServiceBag {
  sessionService: typeof realSessionService;
  journalService: typeof realJournalService;
  specDocumentService: typeof realSpecDocumentService;
  projectService: typeof projectServiceModule;
  archSessionsCollection: MinimalCollection;
  fileStoreService: ArchFileStore;
}

export interface CreateProductionTurnEngineOptions {
  generateSuggestions?: TurnEngineDeps['generateSuggestions'];
}

const SearchFilterOperatorSchema = z.enum([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'not_in',
  'contains',
  'not_contains',
  'exists',
  'not_exists',
]);

const SearchFilterInputSchema = z.union([
  z.record(z.unknown()),
  z.array(
    z.object({
      field: z.string(),
      operator: SearchFilterOperatorSchema,
      value: z.unknown().optional(),
    }),
  ),
]);

const collectSecretInputSchema = z.object({
  flowId: z
    .string()
    .min(1)
    .describe('Flow ID from the auth_ops or mcp_server_ops needsSecrets response'),
  field: z.string().min(1).describe('Secret field name, such as clientSecret, apiKey, or token'),
  label: z.string().min(1).describe('Human-readable label shown to the user'),
});

const configureModelInputSchema = z.object({
  action: z.enum(['inspect', 'diff', 'apply']).describe('Model configuration action to perform'),
  agentName: z.string().min(1).describe('Agent name, or "all" for topology-wide operations'),
  source: z.enum(['recommendation', 'manual']).optional().describe('Source for apply actions'),
  modelId: z.string().optional().describe('Model ID for manual model assignment'),
  provider: z.string().optional().describe('Provider for manual model assignment'),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).optional(),
  operationModels: z.record(z.string(), z.string()).optional(),
  confirmed: z.boolean().optional(),
});

const sessionOpsInputSchema = z.object({
  action: z.enum(['list', 'get', 'get_analysis']).describe('Session operation to perform'),
  sessionId: z.string().optional().describe('Session ID for get or get_analysis'),
  limit: z.number().int().min(1).max(50).optional().describe('Max sessions to return'),
  status: z.string().optional().describe('Optional session status filter for list'),
});

const traceQueryInputSchema = z.object({
  agentName: z.string().optional().describe('Filter by agent name'),
  sessionId: z.string().optional().describe('Filter by session ID'),
  eventType: z.string().optional().describe('Filter by a single trace event type'),
  eventTypes: z.array(z.string()).optional().describe('Filter by multiple trace event types'),
  severity: z.enum(['debug', 'info', 'warn', 'error']).optional().describe('Filter by severity'),
  since: z.string().optional().describe('ISO timestamp lower bound'),
  until: z.string().optional().describe('ISO timestamp upper bound'),
  limit: z.number().int().min(1).max(200).optional().describe('Max traces to return'),
  includeData: z.boolean().optional().describe('Include full event payloads'),
});

const readInsightsInputSchema = z.object({
  action: z
    .enum(['overview', 'quality', 'outcomes', 'agent_performance', 'sentiment', 'tool_performance'])
    .describe('Type of insight to read'),
  agentName: z.string().optional().describe('Filter by agent name'),
  timeRange: z
    .enum(['1h', '24h', '7d', '30d'])
    .optional()
    .describe('Time range for the insight query'),
});

const projectConfigInputSchema = z.object({
  action: z.enum(['get_config', 'update_config', 'get_settings', 'update_settings']),
  name: z.string().min(1).max(100).optional(),
  description: z.string().nullable().optional(),
  entryAgentName: z.string().nullable().optional(),
  messageRetentionDays: z.number().int().positive().nullable().optional(),
  language: z.string().optional(),
  enableThinking: z.boolean().optional(),
  thinkingBudget: z.number().int().positive().nullable().optional(),
  thoughtDescription: z.string().nullable().optional(),
  confirmed: z.boolean().optional(),
});

const kbManageInputSchema = z.object({
  action: z.enum(['list', 'create', 'get', 'update', 'delete']),
  kbId: z.string().optional().describe('Knowledge base ID'),
  kbName: z.string().optional().describe('Knowledge base name'),
  description: z.string().optional().describe('Knowledge base description'),
  confirmed: z.boolean().optional().describe('Required true for delete'),
});

const kbSearchInputSchema = z.object({
  action: z.enum(['query', 'structured_query', 'discover', 'resolve_vocab']),
  kbId: z.string().optional().describe('Knowledge base ID'),
  kbName: z.string().optional().describe('Knowledge base name'),
  query: z.string().optional().describe('Search query text'),
  filters: SearchFilterInputSchema.optional().describe(
    'Search filters as a field/value record or [{ field, operator, value }]',
  ),
  limit: z.number().optional().describe('Maximum results'),
  mode: z.enum(['exact', 'alias', 'fuzzy']).optional().describe('Vocabulary resolution mode'),
});

const kbHealthInputSchema = z.object({
  action: z.enum(['summary', 'errors', 'retry_failed', 'sync_counters', 'check_operation']),
  kbId: z.string().optional().describe('Knowledge base ID'),
  kbName: z.string().optional().describe('Knowledge base name'),
  connectorId: z.string().optional().describe('Connector ID for operation checks'),
  jobId: z.string().optional().describe('Job ID for operation checks'),
  documentIds: z.array(z.string()).optional().describe('Document IDs for retry/reprocess'),
});

const kbIngestInputSchema = z.object({
  action: z.enum(['upload_file', 'add_url', 'add_text', 'list_sources']),
  kbId: z.string().optional().describe('Knowledge base ID'),
  kbName: z.string().optional().describe('Knowledge base name'),
  sourceId: z.string().optional().describe('Existing source ID'),
  blobId: z.string().optional().describe('Blob ID from collect_file (fallback)'),
  fileContent: z
    .string()
    .optional()
    .describe('Base64-encoded file content for direct upload to SearchAI'),
  fileMimeType: z.string().optional().describe('MIME type of the file'),
  fileName: z.string().optional().describe('File name override'),
  url: z.string().optional().describe('URL to crawl'),
  urls: z.array(z.string()).optional().describe('URLs to crawl'),
  text: z.string().optional().describe('Inline text to ingest'),
  title: z.string().optional().describe('Title for inline text or uploaded content'),
  metadata: z.record(z.unknown()).optional().describe('Document metadata'),
});

const kbConnectorInputSchema = z.object({
  action: z.enum(['list', 'create', 'auth', 'sync_start', 'sync_status', 'sync_pause']),
  kbId: z.string().optional().describe('Knowledge base ID'),
  kbName: z.string().optional().describe('Knowledge base name'),
  connectorId: z.string().optional().describe('Connector ID'),
  connectorType: z.string().optional().describe('Connector type, such as sharepoint'),
  connectorName: z.string().optional().describe('Display name for connector'),
  config: z.record(z.unknown()).optional().describe('Connector configuration'),
  resume: z.boolean().optional().describe('True to resume instead of pause'),
});

const mcpServerOpsInputSchema = z.object({
  action: z.enum([
    'list',
    'read',
    'create',
    'update',
    'delete',
    'test_connection',
    'discover_preview',
    'import_tools',
    'list_tools',
    'test_tool',
  ]),
  serverId: z.string().optional().describe('MCP server ID'),
  name: z.string().optional().describe('MCP server display name'),
  description: z.string().optional(),
  transport: z.enum(['sse', 'http']).optional(),
  url: z.string().optional().describe('MCP server URL; env placeholders are allowed'),
  env: z.record(z.string()).optional().describe('Server environment variables'),
  authType: z
    .enum(['none', 'bearer', 'api_key', 'custom_headers', 'oauth2_client_credentials'])
    .optional(),
  authConfig: z
    .record(z.unknown())
    .optional()
    .describe('Non-secret MCP auth config such as headerName, tokenEndpoint, scopes'),
  headers: z.record(z.string()).optional().describe('Non-secret custom request headers'),
  priority: z.number().optional(),
  tags: z.array(z.string()).optional(),
  connectionTimeoutMs: z.number().optional(),
  requestTimeoutMs: z.number().optional(),
  autoReconnect: z.boolean().optional(),
  maxReconnectAttempts: z.number().optional(),
  flowId: z.string().optional().describe('Flow ID after collect_secret captures MCP auth secrets'),
  toolNames: z.array(z.string()).optional().describe('Specific MCP tool names to import'),
  toolName: z.string().optional().describe('MCP tool name for test_tool'),
  testInput: z.record(z.unknown()).optional().describe('Input payload for test_tool'),
  confirmed: z.boolean().optional().describe('Required true for delete'),
});

const kbDocumentsInputSchema = z.object({
  action: z.enum(['list', 'status_summary', 'reprocess', 'delete']),
  kbId: z.string().optional().describe('Knowledge base ID'),
  kbName: z.string().optional().describe('Knowledge base name'),
  documentId: z.string().optional().describe('Document ID for delete'),
  documentIds: z.array(z.string()).optional().describe('Document IDs for reprocess'),
  status: z.string().optional().describe('Document status filter'),
  limit: z.number().optional().describe('Page size'),
  offset: z.number().optional().describe('Page offset'),
  confirmed: z.boolean().optional().describe('Required true for delete'),
});

const topologyPatternsInputSchema = z.object({
  filter: z
    .enum(['all', 'simple', 'complex'])
    .optional()
    .describe(
      'Filter topology patterns by complexity. simple = single_agent + triage; complex = pipeline + hub_spoke + mesh.',
    ),
  currentPattern: z
    .string()
    .optional()
    .describe('Current topology pattern to exclude when asking for alternatives'),
});

const searchDocsInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('Search query — use specific terms, API paths, or feature names for best results'),
  limit: z.number().int().min(1).max(20).optional().describe('Max sections to return'),
});

function getServiceAuthToken(ctx: MinimalTurnContext): string | undefined {
  const raw = ctx.services?.authToken;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function getServicePermissions(ctx: MinimalTurnContext): string[] {
  const raw = ctx.services?.permissions;
  return Array.isArray(raw)
    ? raw.filter((permission): permission is string => typeof permission === 'string')
    : [];
}

function getServiceMutationGuard(
  ctx: MinimalTurnContext,
): InProjectMutationGuardOptions | undefined {
  const raw = ctx.services?.archMutationGuard;
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  const guard = raw as Record<string, unknown>;
  const rawApprovedPlan = guard.approvedPlan as Record<string, unknown> | undefined;
  const plannedMutations = Array.isArray(rawApprovedPlan?.plannedMutations)
    ? rawApprovedPlan.plannedMutations
        .filter((mutation): mutation is Record<string, unknown> => {
          return (
            mutation !== null &&
            typeof mutation === 'object' &&
            typeof mutation.sourceTool === 'string' &&
            typeof mutation.sourceAction === 'string' &&
            typeof mutation.targetKind === 'string' &&
            typeof mutation.operation === 'string'
          );
        })
        .map((mutation) => ({
          sourceTool: String(mutation.sourceTool),
          sourceAction: String(mutation.sourceAction),
          targetKind: mutation.targetKind as never,
          operation: mutation.operation as never,
          agentName: typeof mutation.agentName === 'string' ? mutation.agentName : undefined,
          affectedConstructs: Array.isArray(mutation.affectedConstructs)
            ? mutation.affectedConstructs.filter(
                (construct): construct is string => typeof construct === 'string',
              )
            : undefined,
        }))
    : undefined;
  const approvedPlan =
    rawApprovedPlan &&
    typeof rawApprovedPlan.id === 'string' &&
    rawApprovedPlan.status === 'approved'
      ? {
          id: rawApprovedPlan.id,
          status: 'approved' as const,
          ...(typeof rawApprovedPlan.projectId === 'string'
            ? { projectId: rawApprovedPlan.projectId }
            : {}),
          plannedMutations,
        }
      : undefined;

  return {
    requireApprovedPlanForMutation: guard.requireApprovedPlanForMutation === true,
    approvedPlan,
  };
}

// ─── Service Bag Builder ────────────────────────────────────────────────

/**
 * Build a turn-scoped service bag. Each service is a proxy around the real
 * singleton that enqueues mutator calls into the provided TurnBuffer.
 * Reads pass through directly.
 *
 * Called once per turn at the route-handler boundary (handleArchMessage). The bag is
 * injected into TurnContext.services.
 *
 * Throws if Mongoose is not connected — production code must ensure the
 * connection is established before accepting traffic.
 */
export function buildServiceBagForTurn(buffer: TurnBuffer): TurnServiceBag {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error(
      'buildServiceBagForTurn: Mongoose connection not available — cannot build arch_sessions collection proxy',
    );
  }

  return {
    sessionService: createBufferedSessionService(realSessionService, buffer),
    journalService: createBufferedJournalService(realJournalService, buffer),
    specDocumentService: createBufferedSpecDocumentService(realSpecDocumentService, buffer),
    projectService: createBufferedProjectService(projectServiceModule, buffer),
    fileStoreService: realFileStoreService,
    archSessionsCollection: createBufferedArchSessionsCollection(
      db.collection('arch_sessions') as unknown as MinimalCollection,
      buffer,
    ),
  };
}

// ─── V2 LLM Stream Client (Vercel AI SDK adapter) ──────────────────────

/**
 * Build a v2 LLMStreamClient by resolving the Arch model for the given tenant
 * and wrapping Vercel AI SDK's streamText behind the v2 interface.
 *
 * The v2 interface uses `stream(request)` with a `system` field, `tools`
 * as Zod-schema descriptors, and yields `text_delta` / `tool_call` / `finish`
 * chunks. This is deliberately different from the v1 VercelLLMStreamClient
 * which takes `streamChat({ systemPrompt, messages, tools })`.
 */
export async function buildV2LlmStreamClient(tenantId: string): Promise<V2LLMStreamClient> {
  const { resolveArchVercelModel } = await import('@/lib/arch-llm');
  const resolution = await resolveArchVercelModel(tenantId);

  if (!resolution.model) {
    const userMessage =
      resolution.error ??
      'Arch model configuration is incomplete. Go to Admin > Arch settings to select a model.';
    log.error('LLM model resolution failed', {
      provider: resolution.provider ?? 'none',
      source: resolution.source ?? 'none',
      resolutionPath: resolution.resolutionPath ?? 'none',
      error: resolution.error ?? 'no model available',
    });
    const err = new Error(userMessage);
    (err as Error & { status: number }).status = 0;
    (err as Error & { code: string }).code = 'MODEL_CONFIG_ERROR';
    throw err;
  }

  const vercelModel = resolution.model;
  const { streamText, tool: vercelTool } = await import('ai');
  return {
    stream(request: V2LLMStreamRequest): AsyncIterable<V2LLMStreamChunk> {
      // Build Vercel-compatible tool objects. Must use the `tool()` helper so
      // Vercel AI SDK generates proper JSON Schema for providers like Anthropic
      // (which rejects raw Zod with "input_schema.type: Field required").
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vercelTools: Record<string, any> = {};
      for (const t of request.tools) {
        vercelTools[t.name] = vercelTool({
          description: t.description,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          inputSchema: t.inputSchema as any,
        });
      }
      const allowedToolNames = new Set(Object.keys(vercelTools));
      const toolChoice = parseToolChoice(request.options?.toolChoice, allowedToolNames);
      const activeTools = parseActiveTools(request.options?.activeTools, allowedToolNames);

      // Cast after conversion because our helper returns a structurally valid
      // Vercel ModelMessage[] shape, but the SDK's narrow unions are difficult
      // to satisfy directly across package boundaries.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vercelMessages: any[] = toV2VercelMessages(request.messages);

      const result = streamText({
        model: vercelModel,
        system: request.system,
        messages: vercelMessages,
        tools: vercelTools,
        toolChoice,
        activeTools,
        // The turn engine already owns retries and loop boundaries.
        // Disable SDK retries so a single turn maps to a single provider attempt.
        maxRetries: ARCH_AI_LLM_DEFAULTS.MAX_RETRIES,
        timeout: {
          totalMs: ARCH_AI_TIMEOUTS.LLM_CALL_MS,
          stepMs: ARCH_AI_TIMEOUTS.LLM_CALL_MS,
          chunkMs: ARCH_AI_TIMEOUTS.LLM_STREAM_CHUNK_MS,
        },
        maxOutputTokens: ARCH_AI_LLM_DEFAULTS.MAX_OUTPUT_TOKENS,
        ...buildTemperatureOption(resolution.modelId, ARCH_AI_LLM_DEFAULTS.TEMPERATURE),
        abortSignal: request.signal,
      });
      const streamStartedAt = Date.now();

      // Return an async iterable adapter over the Vercel fullStream.
      return {
        [Symbol.asyncIterator]() {
          const fullStream = result.fullStream;
          const iter = fullStream[Symbol.asyncIterator]();
          let finished = false;

          return {
            async next(): Promise<IteratorResult<V2LLMStreamChunk>> {
              if (finished) return { done: true, value: undefined };

              // eslint-disable-next-line no-constant-condition
              while (true) {
                const { done, value: part } = await iter.next();
                if (done) {
                  finished = true;
                  return { done: true, value: undefined };
                }
                switch (part.type) {
                  case 'text-delta':
                    return { done: false, value: { type: 'text_delta', text: part.text } };
                  case 'tool-call':
                    return {
                      done: false,
                      value: {
                        type: 'tool_call',
                        toolCallId: part.toolCallId,
                        toolName: part.toolName,
                        args: (part.input ?? {}) as unknown,
                      },
                    };
                  case 'finish': {
                    const inputTokens = part.totalUsage?.inputTokens ?? 0;
                    const outputTokens = part.totalUsage?.outputTokens ?? 0;
                    const modelId = resolution.modelId ?? 'unknown';
                    const response = part as {
                      response?: { id?: string; modelId?: string };
                    };
                    const responseModel =
                      typeof response.response?.modelId === 'string'
                        ? response.response.modelId
                        : modelId;
                    const responseId =
                      typeof response.response?.id === 'string' ? response.response.id : undefined;
                    const estimatedUsd = estimateCost(modelId, inputTokens, outputTokens);

                    return {
                      done: false,
                      value: {
                        type: 'finish',
                        finishReason: part.finishReason ?? 'stop',
                        usage: {
                          inputTokens,
                          outputTokens,
                          totalTokens: part.totalUsage?.totalTokens ?? 0,
                        },
                        model: responseModel,
                        provider: resolution.provider ?? undefined,
                        requestedModel: modelId,
                        responseId,
                        estimatedUsd,
                        latencyMs: Date.now() - streamStartedAt,
                      },
                    };
                  }
                  case 'error': {
                    const partError = part.error;
                    const errMsg =
                      partError instanceof Error
                        ? partError.message
                        : typeof partError === 'object' && partError !== null
                          ? JSON.stringify(partError)
                          : String(partError);
                    log.error('Vercel stream error in v2 adapter', {
                      error: errMsg,
                      errorType:
                        partError instanceof Error ? partError.constructor.name : typeof partError,
                    });
                    throw partError instanceof Error ? partError : new Error(errMsg);
                  }
                  default:
                    continue; // skip other chunk types (step-start, etc.)
                }
              }
            },
          };
        },
      };
    },
  };
}

// ─── Onboarding Tool Registry ───────────────────────────────────────────

/**
 * Build a v2 ToolRegistry populated with all onboarding-phase tools.
 *
 * Contains tools for:
 *   - INTERVIEW: ask_user, collect_file, update_specification, proceed_to_next_phase, platform_context
 *   - BLUEPRINT: generate_topology (+ shared tools above)
 *   - BUILD: generate_agent, compile_abl, propose_modification (+ shared tools above)
 *
 * Phase-scoping is done by coordinator-bridge's resolveTurnPlan which filters
 * by PHASE_TOOL_MAP before passing the tool subset to runTurn.
 *
 * Adapts the existing Vercel AI SDK tool definitions into the v2 ToolDefinition
 * contract:
 *   - interactive tools (ask_user, collect_file) have no `execute`
 *   - internal tools have an `execute(args, ctx)` that uses
 *     ctx.tenantId / ctx.userId / ctx.sessionId to call the real service layer
 *
 * Called once per turn (acceptable for M1). M2 will cache the registry per pod.
 */
export function buildOnboardingToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const inProjectToolTemplates = buildInProjectTools(
    { tenantId: 'template-tenant', userId: 'template-user', permissions: [] },
    'template-session',
    'template-project',
  );

  // ── ask_user (interactive — pauses turn for widget input) ──────────────
  registry.register({
    name: 'ask_user',
    kind: 'interactive',
    description:
      'Ask the user a structured question with an interactive widget. Use for ALL questions.',
    inputSchema: askUserSchema,
  });

  // ── collect_file (interactive — pauses turn for file upload) ───────────
  registry.register({
    name: 'collect_file',
    kind: 'interactive',
    description: 'Request file upload from the user.',
    inputSchema: collectFileSchema,
  });

  // ── update_specification (internal — updates spec fields + journal) ────
  registry.register({
    name: 'update_specification',
    kind: 'internal',
    statusLabel: 'Updating specification…',
    description:
      'Update the project specification. Use field+value for form fields, note for conversation notes, or both.',
    inputSchema: updateSpecSchema,
    execute: async (
      input: z.infer<typeof updateSpecSchema>,
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      const authCtx = { tenantId: ctx.tenantId, userId: ctx.userId };
      const sessionId = ctx.sessionId;
      const turnBuffer = getTurnBuffer(ctx);
      const bag = ctx.services as TurnServiceBag | undefined;
      const sessionSvc = bag?.sessionService ?? realSessionService;

      const field = input.field as string | undefined;
      const value = input.value as unknown;
      const note = input.note;
      const results: string[] = [];

      if (field && value !== undefined) {
        if (field === 'projectName') {
          const name = typeof value === 'string' ? value.trim() : '';
          if (!name || name.length < 2) {
            return { updated: false, error: 'Project name must be at least 2 characters.' };
          }
          if (name.length > 100) {
            return { updated: false, error: 'Project name must be 100 characters or fewer.' };
          }
          const { projectExistsByName } = await import('@/services/project-service');
          if (await projectExistsByName(name, ctx.tenantId)) {
            return {
              updated: false,
              error: `A project named "${name}" already exists. Please choose a different name.`,
            };
          }
        }

        let normalizedValue = value;
        if (field === 'channels') {
          const { normalizeChannels } = await import('@/lib/arch-ai/helpers/normalize-channels');
          normalizedValue = normalizeChannels(value);
        }

        if (turnBuffer) {
          patchBufferedSpecificationField(turnBuffer, field, normalizedValue);
        } else {
          await sessionSvc.updateSpecification(authCtx, sessionId, {
            [field]: normalizedValue,
          });
        }
        results.push(`Updated ${field}`);

        await journalAppendAndEmit(
          realJournalService,
          authCtx,
          {
            sessionId,
            type: 'mutation',
            content: {
              type: 'mutation',
              what:
                field === 'projectName'
                  ? `Named project: ${String(value)}`
                  : `Set ${field}: "${truncate(String(value), 80)}"`,
              field,
              to: value,
              reason: `${field} captured during interview`,
              specialist: 'onboarding',
              requestedBy: 'user' as const,
            },
            specialist: 'onboarding',
            phase: 'INTERVIEW',
          },
          undefined, // no SSE emit available at this layer — artifacts go via outbox
        );

        const fieldToSpecPath: Record<string, string> = {
          projectName: 'business.projectName',
          description: 'business.objective',
          channels: 'business.channels',
          language: 'business.language',
        };
        const specPath = fieldToSpecPath[field];
        if (specPath) {
          if (turnBuffer) {
            enqueueBufferedSpecDocumentFieldUpdate({
              buffer: turnBuffer,
              tenantId: ctx.tenantId,
              userId: ctx.userId,
              sessionId,
              path: specPath,
              value: normalizedValue,
            });
          } else {
            // Spec document parallel write (non-blocking) for legacy non-turn-buffer callers.
            try {
              const specDocForField = await realSpecDocumentService.getBySession(
                authCtx,
                sessionId,
              );
              if (specDocForField) {
                const sessionField = SPEC_TO_SESSION_FIELD_MAP[specPath];
                await specUpdateAndEmit(
                  realSpecDocumentService,
                  log,
                  authCtx,
                  String(specDocForField._id),
                  specPath,
                  normalizedValue,
                  undefined, // no SSE emit at this layer
                  sessionId,
                  sessionField,
                );
              }
            } catch (specErr) {
              log.warn('update_specification: spec doc write failed (non-fatal)', {
                error: specErr instanceof Error ? specErr.message : String(specErr),
                field,
                sessionId,
              });
            }
          }
        }
      }

      if (note) {
        const pendingNotes =
          turnBuffer?.sessionPatchSnapshot['metadata.specification.conversationNotes'];
        const currentNotes = Array.isArray(pendingNotes)
          ? pendingNotes
          : ((
              (await sessionSvc.getById(authCtx, sessionId))?.metadata?.specification as
                | { conversationNotes?: unknown[] }
                | undefined
            )?.conversationNotes ?? []);
        const notes = [...currentNotes, note];

        if (turnBuffer) {
          patchBufferedSpecificationField(turnBuffer, 'conversationNotes', notes);
        } else {
          await sessionSvc.updateSpecification(authCtx, sessionId, {
            conversationNotes: notes,
          } as Record<string, unknown>);
        }
        results.push(`Added note: ${note.label}`);

        await journalAppendAndEmit(
          realJournalService,
          authCtx,
          {
            sessionId,
            type: 'mutation',
            content: {
              type: 'mutation',
              what: `Requirement: ${note.label}`,
              to: note.detail ? truncate(note.detail, 120) : undefined,
              reason: `${note.category ?? 'general'} requirement from interview`,
              specialist: 'onboarding',
              requestedBy: 'specialist' as const,
            },
            specialist: 'onboarding',
            phase: 'INTERVIEW',
          },
          undefined,
        );

        if (turnBuffer) {
          enqueueBufferedSpecDocumentFieldUpdate({
            buffer: turnBuffer,
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            sessionId,
            path: 'business.notes',
            value: notes,
          });
        } else {
          // Spec doc write for conversation note (non-blocking)
          try {
            const specDocForNote = await realSpecDocumentService.getBySession(authCtx, sessionId);
            if (specDocForNote) {
              await specUpdateAndEmit(
                realSpecDocumentService,
                log,
                authCtx,
                String(specDocForNote._id),
                'business.notes',
                notes,
                undefined,
              );
            }
          } catch (specErr) {
            log.warn('update_specification: spec doc note write failed (non-fatal)', {
              error: specErr instanceof Error ? specErr.message : String(specErr),
              sessionId,
            });
          }
        }
      }

      return results.length > 0 ? results.join(', ') : 'No field or note provided';
    },
  });

  // ── proceed_to_next_phase (internal — drives phase transition) ──────────
  registry.register({
    name: 'proceed_to_next_phase',
    kind: 'internal',
    statusLabel: 'Advancing to next phase…',
    description:
      'Advance to the next onboarding phase when the user explicitly confirms readiness. ' +
      'Only call this when the user clearly wants to proceed. Do NOT call this if the user is requesting changes.',
    inputSchema: z.object({
      reason: z.string().describe('Brief explanation of why the user is ready to proceed'),
    }),
    execute: async (_input: { reason: string }, ctx: MinimalTurnContext): Promise<unknown> => {
      const authCtx = { tenantId: ctx.tenantId, userId: ctx.userId };
      const sessionId = ctx.sessionId;
      const bag = ctx.services as TurnServiceBag | undefined;
      const sessionSvc = bag?.sessionService ?? realSessionService;

      const { executePhaseTransition } = await import('@/lib/arch-ai/phase-transition');

      const freshSession = await sessionSvc.getById(authCtx, sessionId);
      if (!freshSession) return { error: 'Session not found' };

      // Phase-aware pre-checks: each phase has different requirements.
      const currentPhase = freshSession.metadata.phase;
      if (currentPhase === 'INTERVIEW') {
        const { canExitInterview } = await import('@agent-platform/arch-ai');
        if (!canExitInterview(freshSession.metadata.specification)) {
          return {
            error:
              'Cannot proceed yet — project name is required. Ask the user to provide a project name first.',
          };
        }
      } else if (currentPhase === 'BLUEPRINT') {
        const meta = freshSession.metadata as unknown as Record<string, unknown>;
        if (!meta.lockedTopology && !(meta.topologyApproved === true && meta.topology)) {
          return {
            error:
              'No locked topology exists yet. Wait for the topology approval widget, then accept the approved topology before proceeding to Build.',
          };
        }
      } else if (currentPhase === 'BUILD') {
        // BUILD → CREATE: all topology agents must be compiled or warning.
        // Provide a specific error message before falling through to executePhaseTransition.
        const meta = freshSession.metadata as unknown as Record<string, unknown>;
        const topology = (meta.lockedTopology ?? meta.topology) as
          | { agents?: Array<{ name: string }> }
          | undefined;
        const bp = meta.buildProgress as { agentStatuses?: Record<string, string> } | undefined;
        const topologyAgents = topology?.agents ?? [];
        const notReady = topologyAgents.filter((a) => {
          const status = bp?.agentStatuses?.[a.name];
          return status !== 'compiled' && status !== 'warning';
        });
        if (notReady.length > 0) {
          return {
            error:
              `Cannot proceed — ${notReady.length} agent(s) not yet compiled: ${notReady.map((a) => a.name).join(', ')}. ` +
              `Generate and compile them first.`,
          };
        }
      }
      // CREATE exit criteria are checked by executePhaseTransition.

      const journalFn = async (summary: string, rationale: string, spec: string, ph: string) => {
        await journalAppendAndEmit(
          realJournalService,
          authCtx,
          {
            sessionId,
            type: 'decision',
            content: {
              type: 'decision',
              summary,
              rationale,
              specialist: spec,
              source: 'specialist_recommendation' as const,
            },
            specialist: spec,
            phase: ph,
          },
          undefined,
        );
      };

      return executePhaseTransition(
        authCtx,
        freshSession,
        sessionSvc,
        () => {}, // no direct SSE emit — events go via engine outbox
        journalFn,
        undefined,
        {
          archSessionsCollection: bag?.archSessionsCollection,
        },
      );
    },
  });

  // ── platform_context (internal — reads platform capabilities) ──────────
  registry.register({
    name: 'platform_context',
    kind: 'internal',
    readOnly: true,
    statusLabel: 'Querying platform…',
    description:
      'Query platform and project capabilities. During onboarding, use list_models. ' +
      'During in-project work, use project-scoped actions such as list_agents, list_tools, ' +
      'list_channels, list_auth_profiles, and get_summary.',
    inputSchema: z.object({
      action: z
        .enum([
          'get_summary',
          'list_agents',
          'list_models',
          'list_tools',
          'list_channels',
          'list_auth_profiles',
        ])
        .describe('Platform context action to perform'),
      agentName: z.string().optional().describe('Filter by agent name'),
      toolType: z.string().optional().describe('Filter by tool type'),
    }),
    execute: async (
      input: { action: string; agentName?: string; toolType?: string },
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      if (ctx.mode === 'in-project' || ctx.projectId) {
        const refs = await buildV1CoreRefs();
        return refs.platformContext(ctx, ctx.projectId ?? '', input);
      }

      const projectScopedActions = [
        'get_summary',
        'list_agents',
        'list_tools',
        'list_channels',
        'list_auth_profiles',
      ];
      if (projectScopedActions.includes(input.action)) {
        return {
          success: false,
          error: {
            code: 'PROJECT_REQUIRED',
            message:
              'This action requires a project. It will be available after the project is created. ' +
              'During onboarding, use list_models to query available LLM models.',
          },
        };
      }
      const { executePlatformContext } = await import('@/lib/arch-ai/tools/platform-context');
      return executePlatformContext(input, {
        projectId: '',
        user: {
          permissions: (ctx.services?.permissions as string[] | undefined) ?? [],
          tenantId: ctx.tenantId,
          userId: ctx.userId,
        },
        authToken: getServiceAuthToken(ctx),
      });
    },
  });

  // ── generate_topology (internal — BLUEPRINT phase) ─────────────────────
  // The LLM designs a multi-agent topology and this tool validates it,
  // stores it in session metadata, journals the mutation, and emits an
  // artifact_updated event via ctx.emit().
  registry.register({
    name: 'generate_topology',
    kind: 'internal',
    statusLabel: 'Generating topology…',
    description:
      'Generate or revise a complete multi-agent topology from the specification + blueprint context. ' +
      'Only call this when the coordinator has entered a draft-generation or draft-revision turn. ' +
      'Make confident design choices with sensible defaults and return a complete topology.',
    inputSchema: z.object({
      agents: z.array(
        z.object({
          name: z.string(),
          role: z.string(),
          executionMode: z.enum(['reasoning', 'scripted', 'hybrid']),
          description: z.string(),
          tools: z
            .array(z.string())
            .optional()
            .describe(
              'Snake_case callable tool names this agent needs, for example lookup_policy or book_appointment. Omit only when the agent truly needs no external lookup, action, or calculation.',
            ),
          gatherFields: z
            .array(z.string())
            .optional()
            .describe(
              'Snake_case fields this agent must ask the end user for directly before completion, for example policy_number or requested_date. Do not include values the supervisor, conversation context, tools, or memory can provide.',
            ),
          flowStepSeeds: z
            .array(z.string())
            .optional()
            .describe(
              'Ordered snake_case step names for scripted/hybrid agents, for example collect_context, run_eligibility_check, confirm_next_step.',
            ),
          suggestedConstructs: z
            .array(z.string())
            .optional()
            .describe(
              'ABL constructs the BUILD phase should consider, for example GATHER, TOOLS, FLOW, HANDOFF, ESCALATE, COMPLETE.',
            ),
        }),
      ),
      edges: z.array(
        z.object({
          from: z.string(),
          to: z.string(),
          type: z.enum(['delegate', 'escalate', 'transfer']),
          experienceMode: z
            .enum([
              'shared_voice_handoff',
              'visible_handoff',
              'silent_delegate',
              'human_escalation',
            ])
            .optional()
            .describe(
              'What the customer should perceive when this edge runs. Set on every edge: shared_voice_handoff for customer-facing support specialists, human_escalation for human/escalation targets, visible_handoff for announced transfers, silent_delegate only when DELEGATE agent-as-tool support is available.',
            ),
          condition: z.string(),
          allowCycle: z
            .boolean()
            .optional()
            .describe('Set to true on an edge to allow it to participate in a cycle.'),
          expectReturn: z
            .boolean()
            .optional()
            .describe(
              'true = source resumes after target completes (delegate). false = terminal transfer.',
            ),
        }),
      ),
      entryPoint: z.string(),
    }),
    execute: async (
      input: {
        agents: Array<{
          name: string;
          role: string;
          executionMode: string;
          description: string;
          tools?: string[];
          gatherFields?: string[];
          flowStepSeeds?: string[];
          suggestedConstructs?: string[];
        }>;
        edges: Array<{
          from: string;
          to: string;
          type: string;
          experienceMode?:
            | 'shared_voice_handoff'
            | 'visible_handoff'
            | 'silent_delegate'
            | 'human_escalation';
          condition: string;
          allowCycle?: boolean;
          expectReturn?: boolean;
        }>;
        entryPoint: string;
      },
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      const authCtx = { tenantId: ctx.tenantId, userId: ctx.userId };
      const sessionId = ctx.sessionId;
      const bag = ctx.services as TurnServiceBag | undefined;

      // Validate: entryPoint must be in agents list
      const agentNames = input.agents.map((a) => a.name);
      if (!agentNames.includes(input.entryPoint)) {
        return `Error: entryPoint '${input.entryPoint}' is not in agents list [${agentNames.join(', ')}]`;
      }

      let sourceContract: SourceArchitectureContract | null = null;
      try {
        const activeFiles = await (bag?.fileStoreService ?? realFileStoreService).getActiveFiles(
          authCtx,
          sessionId,
        );
        sourceContract = extractSourceArchitectureContractFromFiles(activeFiles);
      } catch (err) {
        log.warn('generate_topology: source contract extraction failed (non-fatal)', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const topologyForValidation = {
        agents: input.agents.map((a) => ({
          name: a.name,
          role: a.role,
          executionMode: a.executionMode as 'reasoning' | 'scripted' | 'hybrid',
          description: a.description,
          tools: a.tools,
          gatherFields: a.gatherFields,
          flowStepSeeds: a.flowStepSeeds,
          suggestedConstructs: a.suggestedConstructs,
        })),
        edges: input.edges.map((e) => ({
          from: e.from,
          to: e.to,
          type: e.type as 'delegate' | 'escalate' | 'transfer',
          experienceMode: e.experienceMode,
          condition: e.condition,
          allowCycle: e.allowCycle,
          expectReturn: e.expectReturn,
        })),
        entryPoint: input.entryPoint,
      };
      const sourceContractError = validateTopologyAgainstSourceContract(
        topologyForValidation,
        sourceContract,
      );
      if (sourceContractError) {
        return sourceContractError;
      }

      const runtimeHintError = validateTopologyRuntimeHints(input);
      if (runtimeHintError) {
        return runtimeHintError;
      }

      // Validate: edges reference valid agents
      for (const edge of input.edges) {
        if (!agentNames.includes(edge.from)) {
          return `Error: edge from '${edge.from}' references unknown agent`;
        }
        if (!agentNames.includes(edge.to)) {
          return `Error: edge to '${edge.to}' references unknown agent`;
        }
      }

      // Validate: no cycles (unless explicitly allowed via allowCycle on edges).
      // Reuses computeBuildOrder which runs Kahn's topological sort and throws
      // on cycles. This catches designs that would deadlock the builder later.
      try {
        const { computeBuildOrder } = await import('@agent-platform/arch-ai');
        type TopologyForSort = Parameters<typeof computeBuildOrder>[0];
        const topologyForSort: TopologyForSort = {
          agents: input.agents.map((a) => ({
            name: a.name,
            role: a.role,
            executionMode: a.executionMode as 'reasoning' | 'scripted' | 'hybrid',
            description: a.description,
          })),
          edges: input.edges
            .filter((e) => !e.allowCycle)
            .map((e) => ({
              from: e.from,
              to: e.to,
              type: e.type as 'delegate' | 'escalate' | 'transfer',
              experienceMode: e.experienceMode,
              condition: e.condition,
            })),
          entryPoint: input.entryPoint,
        };
        computeBuildOrder(topologyForSort);
      } catch (cycleErr) {
        const msg = cycleErr instanceof Error ? cycleErr.message : String(cycleErr);
        return `Error: ${msg}. Break the cycle by changing edge direction, removing an edge, or setting allowCycle:true on one edge if the loop is intentional.`;
      }

      // Store topology via buffered arch_sessions collection
      if (!bag?.archSessionsCollection?.updateOne) {
        return 'Error: service bag not available — cannot store topology';
      }
      const result = await bag.archSessionsCollection.updateOne(
        { _id: sessionId, tenantId: authCtx.tenantId, userId: authCtx.userId },
        {
          $set: {
            'metadata.blueprintStage': 'draft_ready',
            'metadata.topology': input,
            'metadata.draftTopology': input,
            ...(sourceContract ? { 'metadata.sourceArchitectureContract': sourceContract } : {}),
            'metadata.topologyApproved': false,
          },
        },
      );
      if (result.matchedCount === 0) {
        return 'Error: session not found';
      }

      const topoSummary = `Topology generated: ${input.agents.length} agents, ${input.edges.length} edges, entry: ${input.entryPoint}`;

      // Journal the topology creation
      await journalAppendAndEmit(
        realJournalService,
        authCtx,
        {
          sessionId,
          type: 'mutation',
          content: {
            type: 'mutation',
            what: `Designed system: ${input.agents.length} agents`,
            to: agentNames.join(', '),
            reason: `${input.edges.length} connections, entry: ${input.entryPoint}`,
            specialist: 'multi-agent-architect',
            requestedBy: 'specialist' as const,
          },
          specialist: 'multi-agent-architect',
          phase: 'BLUEPRINT',
        },
        undefined, // no direct SSE emit — artifacts go via outbox
      );

      // Emit topology artifact update via turn context (drained to outbox at commit)
      ctx.emit({
        artifact: 'topology' as const,
        payload: input,
      });

      // Spec document parallel writes (non-blocking)
      try {
        const specDocForTopo = await realSpecDocumentService.getBySession(authCtx, sessionId);
        if (specDocForTopo) {
          const specId = String(specDocForTopo._id);
          const agents = input.agents.map((a) => ({
            name: a.name,
            role: a.role || '',
            executionMode: a.executionMode || 'reasoning',
            model: null,
            description: a.description || '',
            compileStatus: null,
          }));
          await specUpdateAndEmit(
            realSpecDocumentService,
            log,
            authCtx,
            specId,
            'architecture.agents',
            agents,
            undefined,
          );
          await specUpdateAndEmit(
            realSpecDocumentService,
            log,
            authCtx,
            specId,
            'architecture.edges',
            input.edges || [],
            undefined,
          );
          await specUpdateAndEmit(
            realSpecDocumentService,
            log,
            authCtx,
            specId,
            'architecture.entryPoint',
            input.entryPoint,
            undefined,
          );
          await specUpdateAndEmit(
            realSpecDocumentService,
            log,
            authCtx,
            specId,
            'architecture.agentCount',
            input.agents.length,
            undefined,
          );
        }
      } catch (specErr) {
        log.warn('generate_topology: spec doc write failed (non-fatal)', {
          error: specErr instanceof Error ? specErr.message : String(specErr),
          sessionId,
        });
      }

      return topoSummary;
    },
  });

  // ── BUILD phase tools ────────────────────────────────────────────────────
  // Phase-scoping is handled by coordinator-bridge's resolveTurnPlan which
  // filters by PHASE_TOOL_MAP. BUILD = [ask_user, collect_file, generate_agent,
  // compile_abl, propose_modification, proceed_to_next_phase].

  /** Allowed agent-name shape: identifier-style. Matches ABL DSL parser expectations. */
  const AGENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

  // ── generate_agent (internal — writes agent ABL code to session files) ───
  registry.register({
    name: 'generate_agent',
    kind: 'internal',
    statusLabel: 'Generating agent…',
    description:
      'Generate a complete ABL YAML agent definition. Call with agentName and full YAML code.',
    inputSchema: z.object({
      agentName: z.string().describe('Name of the agent'),
      code: z.string().describe('Complete ABL YAML code'),
    }),
    execute: async (
      input: { agentName: string; code: string },
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      const authCtx = { tenantId: ctx.tenantId, userId: ctx.userId };
      const sessionId = ctx.sessionId;

      // Validate agent name to prevent NoSQL field-path injection in $set keys
      if (!AGENT_NAME_PATTERN.test(input.agentName)) {
        return `Error: invalid agent name "${input.agentName}". Must match [A-Za-z_][A-Za-z0-9_]*.`;
      }

      const bag = ctx.services as TurnServiceBag | undefined;
      const currentSession =
        typeof bag?.sessionService?.getById === 'function'
          ? await bag.sessionService.getById(authCtx, sessionId)
          : null;
      const currentTopology = (currentSession?.metadata?.lockedTopology ??
        currentSession?.metadata?.topology ??
        null) as {
        agents?: Array<{ name?: string }>;
      } | null;
      const topologyAgentNames =
        currentTopology?.agents
          ?.map((agent) => (typeof agent.name === 'string' ? agent.name : null))
          .filter((name): name is string => name !== null) ?? [];
      if (topologyAgentNames.length > 0 && !topologyAgentNames.includes(input.agentName)) {
        return `Error: agent "${input.agentName}" is not in the approved topology. Generate only these agents: ${topologyAgentNames.join(', ')}.`;
      }

      const filePath = `agents/${input.agentName}.abl.yaml`;

      // Write to session's virtual filesystem via buffered collection
      if (!bag?.archSessionsCollection?.updateOne) {
        return 'Error: service bag not available — cannot store agent file';
      }

      // First ensure metadata.files exists as an object (may be null)
      await bag.archSessionsCollection.updateOne(
        {
          _id: sessionId,
          tenantId: authCtx.tenantId,
          userId: authCtx.userId,
          'metadata.files': null,
        },
        { $set: { 'metadata.files': {} } },
      );

      // Then set the specific agent file + buildProgress status
      await bag.archSessionsCollection.updateOne(
        { _id: sessionId, tenantId: authCtx.tenantId, userId: authCtx.userId },
        {
          $set: {
            [`metadata.files.${input.agentName}`]: { path: filePath, content: input.code },
            [`metadata.buildProgress.agentStatuses.${input.agentName}`]: 'generated',
          },
        },
      );

      const genSummary = `Agent ${input.agentName} generated: ${input.code.split('\n').length} lines written to ${filePath}`;

      // Journal the generation
      await journalAppendAndEmit(
        realJournalService,
        authCtx,
        {
          sessionId,
          type: 'mutation',
          content: {
            type: 'mutation',
            what: `Generated agent: ${input.agentName}`,
            to: `${input.code.split('\n').length} lines → ${filePath}`,
            reason: 'Agent code generated from blueprint',
            specialist: 'abl-construct-expert',
            requestedBy: 'specialist' as const,
          },
          specialist: 'abl-construct-expert',
          phase: 'BUILD',
        },
        undefined, // no SSE emit — artifacts go via engine outbox
      );

      // Emit build progress artifact update via turn context
      ctx.emit({
        artifact: 'file' as const,
        agent: input.agentName,
        action: 'end' as const,
        fileKind: 'agent' as const,
        path: filePath,
        content: input.code,
      });
      ctx.emit({
        artifact: 'build' as const,
        scope: 'agent' as const,
        agent: input.agentName,
        state: {
          status: 'generating' as const,
          stages: {
            gen: 'done' as const,
            comp: 'pending' as const,
            enrich: 'pending' as const,
            done: 'pending' as const,
          },
          warnings: [],
          errors: [],
        },
      });

      return genSummary;
    },
  });

  // ── compile_abl (internal — validates ABL code via the real compiler) ─────
  registry.register({
    name: 'compile_abl',
    kind: 'internal',
    statusLabel: 'Compiling ABL…',
    description:
      'Validate ABL YAML code against the real ABL compiler. Call after generate_agent. Returns errors if syntax is invalid.',
    inputSchema: z.object({
      code: z.string().describe('ABL YAML code to validate'),
      agentName: z.string().describe('Agent name for error context'),
    }),
    execute: async (
      input: { code: string; agentName: string },
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      const authCtx = { tenantId: ctx.tenantId, userId: ctx.userId };
      const sessionId = ctx.sessionId;

      try {
        const compilePreview = await runIsolatedSingleAgentCompile(
          {
            code: input.code,
            compileOptions: {
              mode: 'preview',
              skipCrossAgentValidation: true,
            },
          },
          { timeoutMs: ARCH_AI_TIMEOUTS.COMPILE_TOOL_MS },
        );
        const errors = compilePreview.parseErrors.map(
          (entry) => `Line ${entry.line ?? '?'}: ${entry.message}`,
        );
        const warnings = compilePreview.parseWarnings.map(
          (entry) => `Line ${entry.line ?? '?'}: ${entry.message}`,
        );

        if (errors.length > 0) {
          // Update buildProgress — compilation failed
          const bag = ctx.services as TurnServiceBag | undefined;
          if (bag?.archSessionsCollection?.updateOne && AGENT_NAME_PATTERN.test(input.agentName)) {
            await bag.archSessionsCollection.updateOne(
              { _id: sessionId, tenantId: authCtx.tenantId, userId: authCtx.userId },
              {
                $set: {
                  [`metadata.buildProgress.agentStatuses.${input.agentName}`]: 'error',
                },
              },
            );
          }

          // Emit build error artifact
          ctx.emit({
            artifact: 'build' as const,
            scope: 'agent' as const,
            agent: input.agentName,
            state: {
              status: 'error' as const,
              stages: {
                gen: 'done' as const,
                comp: 'error' as const,
                enrich: 'pending' as const,
                done: 'error' as const,
              },
              warnings,
              errors,
            },
          });

          return {
            status: 'fail',
            errors,
            warnings,
            hint: `${renderKnownConstructsHint()} Check your syntax.`,
          };
        }

        // Additional check: ensure the document was parsed successfully
        if (!compilePreview.documentFound) {
          return {
            status: 'fail',
            errors: [
              'No AGENT: or SUPERVISOR: declaration found. ABL requires UPPERCASE construct keywords.',
            ],
            warnings,
            hint: 'Use AGENT: AgentName (not agent: name: AgentName)',
          };
        }

        const CROSS_AGENT_PATTERNS = [
          /routing\.default_agent references .* which is not a known agent/,
          /not a known agent\. Available agents/,
        ];
        const compileErrors = compilePreview.compileErrors
          .filter((entry) => {
            if (entry.severity !== 'error' && entry.severity !== undefined) {
              return false;
            }

            return !CROSS_AGENT_PATTERNS.some((pattern) => pattern.test(entry.message));
          })
          .map((entry) => `Line ${entry.line ?? '?'}: ${entry.message}`);
        const compileWarnings = compilePreview.compileWarnings.map(
          (entry) => `Line ${entry.line ?? '?'}: ${entry.message}`,
        );
        const compileSoftWarnings = compilePreview.compileErrors
          .filter((entry) => entry.severity !== undefined && entry.severity !== 'error')
          .map((entry) => `Line ${entry.line ?? '?'}: ${entry.message}`);
        const compilerWarnings = [...warnings, ...compileWarnings, ...compileSoftWarnings];

        if (compileErrors.length > 0) {
          const bag = ctx.services as TurnServiceBag | undefined;
          if (bag?.archSessionsCollection?.updateOne && AGENT_NAME_PATTERN.test(input.agentName)) {
            await bag.archSessionsCollection.updateOne(
              { _id: sessionId, tenantId: authCtx.tenantId, userId: authCtx.userId },
              {
                $set: {
                  [`metadata.buildProgress.agentStatuses.${input.agentName}`]: 'error',
                },
              },
            );
          }

          ctx.emit({
            artifact: 'build' as const,
            scope: 'agent' as const,
            agent: input.agentName,
            state: {
              status: 'error' as const,
              stages: {
                gen: 'done' as const,
                comp: 'error' as const,
                enrich: 'pending' as const,
                done: 'error' as const,
              },
              warnings: compilerWarnings,
              errors: compileErrors,
            },
          });

          return {
            status: 'fail',
            errors: compileErrors,
            warnings: compilerWarnings,
            failureCode: 'compile_error',
            phaseDurationsMs: compilePreview.phaseDurationsMs,
            hint: 'ABL compilation failed. Check HANDOFF targets, TOOLS signatures, FLOW steps, and construct syntax.',
          };
        }

        // Quality floor checks — returned to LLM for self-correction
        const qualityWarnings: string[] = [];
        const isSupervisorAgent = /^\s*SUPERVISOR\s*:/m.test(input.code);

        if (!/GUARDRAILS:/m.test(input.code)) {
          qualityWarnings.push(renderMissingGuardrailsWarning());
        }
        if (!/MEMORY:/m.test(input.code)) {
          qualityWarnings.push(renderMissingMemoryWarning());
        }
        if (isSupervisorAgent && !/WHEN:\s*["']true["']/m.test(input.code)) {
          qualityWarnings.push(renderSupervisorCatchAllHandoffWarning());
        }

        const allWarnings = [...qualityWarnings];

        // Journal the validation result
        await journalAppendAndEmit(
          realJournalService,
          authCtx,
          {
            sessionId,
            type: 'validation',
            content: {
              type: 'validation',
              target: input.agentName,
              result: 'pass' as const,
              warnings: [...compilerWarnings, ...allWarnings],
              triggeredBy: 'abl-construct-expert',
            },
            specialist: 'abl-construct-expert',
            phase: 'BUILD',
          },
          undefined,
        );

        // Update buildProgress — compilation passed
        const bag = ctx.services as TurnServiceBag | undefined;
        if (bag?.archSessionsCollection?.updateOne && AGENT_NAME_PATTERN.test(input.agentName)) {
          const compileStatus = allWarnings.length > 0 ? 'warning' : 'compiled';
          await bag.archSessionsCollection.updateOne(
            { _id: sessionId, tenantId: authCtx.tenantId, userId: authCtx.userId },
            {
              $set: {
                [`metadata.buildProgress.agentStatuses.${input.agentName}`]: compileStatus,
              },
            },
          );
        }

        // Emit build progress artifact
        ctx.emit({
          artifact: 'build' as const,
          scope: 'agent' as const,
          agent: input.agentName,
          state: {
            status: (allWarnings.length > 0 ? 'warning' : 'compiled') as 'warning' | 'compiled',
            stages: {
              gen: 'done' as const,
              comp: 'done' as const,
              enrich: 'pending' as const,
              done: 'done' as const,
            },
            warnings: [...compilerWarnings, ...allWarnings],
            errors: [],
          },
        });

        return {
          status: 'pass',
          errors: [],
          warnings: compilerWarnings,
          qualityWarnings: allWarnings,
          phaseDurationsMs: compilePreview.phaseDurationsMs,
          ...(allWarnings.length > 0 && {
            hint: `Quality: ${allWarnings.length} issue(s) found. Fix these and recompile.`,
          }),
        };
      } catch (err: unknown) {
        const message =
          err instanceof CompileWorkerTimeoutError
            ? `ABL validation timed out during ${err.phase} after ${err.timeoutMs}ms.`
            : err instanceof Error
              ? err.message
              : String(err);

        await journalAppendAndEmit(
          realJournalService,
          authCtx,
          {
            sessionId,
            type: 'validation',
            content: {
              type: 'validation',
              target: input.agentName,
              result: 'fail' as const,
              errors: [message],
              triggeredBy: 'abl-construct-expert',
            },
            specialist: 'abl-construct-expert',
            phase: 'BUILD',
          },
          undefined,
        );

        return {
          status: 'fail',
          errors: [message],
          warnings: [],
          ...(err instanceof CompileWorkerTimeoutError
            ? {
                failureCode: 'timeout',
                timedOutPhase: err.phase,
                hint: 'Compilation infrastructure timed out before validation completed. Retry the build; if it repeats, inspect compiler and diagnostic worker spans.',
              }
            : {}),
        };
      }
    },
  });

  // ── propose_modification (internal — modifies existing agent code) ────────
  registry.register({
    name: 'propose_modification',
    kind: 'internal',
    statusLabel: 'Modifying agent…',
    description:
      'Propose changes to an agent. Provide "sections" for targeted edits (preferred) or ' +
      '"updatedCode" for full rewrites. Returns a reviewable proposal only — do not apply ' +
      'changes until the user confirms and apply_modification runs.',
    inputSchema: z.object({
      agentName: z.string().min(1).describe('Name of the agent to modify or create'),
      change: z.string().min(1).describe('Description of the change'),
      updatedCode: z
        .string()
        .min(1)
        .optional()
        .describe('Full updated ABL YAML — for major restructuring across 3+ sections'),
      sections: z
        .array(
          z.object({
            construct: z
              .string()
              .min(1)
              .describe(
                'ABL section name: PERSONA, GOAL, TOOLS, GATHER, CONSTRAINTS, GUARDRAILS, FLOW, HANDOFF, etc.',
              ),
            content: z
              .string()
              .nullable()
              .describe(
                'New section content including header (e.g. "PERSONA:\\n  You are..."), or null to remove',
              ),
          }),
        )
        .optional()
        .describe('Section-level edits — preferred for targeted changes'),
      isNew: z
        .boolean()
        .optional()
        .describe('True when creating a brand-new agent (no existing agent)'),
    }),
    execute: async (
      input: {
        agentName: string;
        change: string;
        updatedCode?: string;
        sections?: Array<{ construct: string; content: string | null }>;
        isNew?: boolean;
      },
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.proposeModification(ctx, ctx.projectId ?? '', input);
    },
  });

  // ── IN_PROJECT tools ─────────────────────────────────────────────────────
  // These are registered alongside onboarding tools. The coordinator bridge
  // filters by IN_PROJECT_TOOLS when mode='in-project', so onboarding sessions
  // never see them. Conversely, PHASE_TOOL_MAP filters onboarding-only tools
  // out for IN_PROJECT sessions.

  // collect_secret (interactive — pauses turn for secret input)
  registry.register({
    name: 'collect_secret',
    kind: 'interactive',
    description:
      'Collect a sensitive credential from the user via a secure masked input. ' +
      'Use the flowId returned by auth_ops or mcp_server_ops needsSecrets; never include secret values in chat.',
    inputSchema: collectSecretInputSchema,
  });

  // apply_modification (internal — applies a proposed agent modification to the project)
  registry.register({
    name: 'apply_modification',
    kind: 'internal',
    statusLabel: 'Applying modification…',
    description:
      'Apply a previously proposed modification to an agent in the project. Call after propose_modification.',
    inputSchema: z.object({
      agentName: z.string().describe('Name of the agent to apply modification to'),
      isNew: z.boolean().optional().describe('True if creating a new agent'),
    }),
    execute: async (
      input: { agentName: string; isNew?: boolean },
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.applyModification(ctx, ctx.projectId ?? '', input.agentName, input.isNew);
    },
  });

  // dismiss_proposal (internal — clears a pending proposal without applying)
  registry.register({
    name: 'dismiss_proposal',
    kind: 'internal',
    statusLabel: 'Dismissing proposal…',
    description: 'Dismiss the current pending modification proposal without applying it.',
    inputSchema: z.object({
      reason: z.string().optional().describe('Reason for dismissal'),
    }),
    execute: async (_input: { reason?: string }, ctx: MinimalTurnContext): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.dismissProposal(ctx, ctx.sessionId);
    },
  });

  // read_agent (internal — reads an agent definition from the project)
  registry.register({
    name: 'read_agent',
    kind: 'internal',
    readOnly: true,
    statusLabel: 'Reading agent…',
    description: 'Read the ABL definition and metadata of an agent in the project.',
    inputSchema: z.object({
      agentName: z.string().describe('Name of the agent to read'),
    }),
    execute: async (input: { agentName: string }, ctx: MinimalTurnContext): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.readAgent(ctx, ctx.projectId ?? '', input.agentName);
    },
  });

  // read_journal (internal — reads session journal entries)
  registry.register({
    name: 'read_journal',
    kind: 'internal',
    readOnly: true,
    statusLabel: 'Reading journal…',
    description: 'Read the session journal — decisions, mutations, and validations.',
    inputSchema: z.object({
      limit: z.number().optional().describe('Max entries to return'),
      type: z.string().optional().describe('Filter by entry type'),
    }),
    execute: async (
      input: { limit?: number; type?: string },
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.readJournal(ctx, ctx.sessionId, input);
    },
  });

  // read_topology (internal — reads the current topology from session or project)
  registry.register({
    name: 'read_topology',
    kind: 'internal',
    readOnly: true,
    statusLabel: 'Reading topology…',
    description: 'Read the current agent topology — agents, edges, and entry point.',
    inputSchema: z.object({}),
    execute: async (_input: Record<string, never>, ctx: MinimalTurnContext): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.readTopology(ctx, ctx.projectId ?? '');
    },
  });

  // get_topology_patterns (internal — reads the topology pattern catalog)
  registry.register({
    name: 'get_topology_patterns',
    kind: 'internal',
    readOnly: true,
    statusLabel: 'Reading topology patterns…',
    description:
      'Query the topology pattern catalog, selection criteria, ABL implications, and anti-patterns.',
    inputSchema: topologyPatternsInputSchema,
    execute: async (input: z.infer<typeof topologyPatternsInputSchema>): Promise<unknown> => {
      let patterns = TOPOLOGY_PATTERNS;

      if (input.filter === 'simple') {
        patterns = patterns.filter((pattern) =>
          ['single_agent', 'triage_specialists'].includes(pattern.id),
        );
      } else if (input.filter === 'complex') {
        patterns = patterns.filter((pattern) =>
          ['pipeline', 'hub_spoke', 'mesh'].includes(pattern.id),
        );
      }

      if (input.currentPattern) {
        patterns = patterns.filter((pattern) => pattern.id !== input.currentPattern);
      }

      return {
        patterns: patterns.map((pattern) => ({
          id: pattern.id,
          name: pattern.name,
          whenToUse: pattern.whenToUse,
          structure: pattern.structure,
          ablImplications: pattern.ablImplications,
          edgeTypes: pattern.edgeTypes,
          antiPatterns: pattern.antiPatterns,
        })),
        decisionTree: TOPOLOGY_DECISION_TREE,
        currentPattern: input.currentPattern ?? null,
      };
    },
  });

  // read_insights (internal — reads analytics/insights for the project)
  registry.register({
    name: 'read_insights',
    kind: 'internal',
    readOnly: true,
    statusLabel: 'Reading insights…',
    description: 'Read analytics insights and performance data for the project.',
    inputSchema: readInsightsInputSchema,
    execute: async (
      input: z.infer<typeof readInsightsInputSchema>,
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.readInsights(ctx, ctx.projectId ?? '', input);
    },
  });

  // trace_diagnosis (internal — natural-language diagnosis across sessions, traces, and analytics)
  registry.register({
    name: 'trace_diagnosis',
    kind: 'internal',
    readOnly: true,
    statusLabel: 'Diagnosing traces…',
    description:
      'Diagnose runtime behavior using sessions, traces, diagnostics, and analytics. ' +
      'Use this for requests like "my last session", "recent traces", "last 24 hours", ' +
      '"last 3 months", "production health for Billing_Agent", "compare today vs yesterday", ' +
      'or "compare staging vs prod".',
    inputSchema: TraceDiagnosisInputSchema,
    execute: async (
      input: z.infer<typeof TraceDiagnosisInputSchema>,
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.traceDiagnosis(ctx, ctx.projectId ?? '', input);
    },
  });

  // session_ops (internal — exact project-scoped session listing and session summaries)
  registry.register({
    name: 'session_ops',
    kind: 'internal',
    readOnly: true,
    statusLabel: 'Reading sessions…',
    description:
      'List project sessions or read a specific session summary. Use trace_diagnosis for natural-language time windows, "my last session", comparisons, and deep trace analysis.',
    inputSchema: sessionOpsInputSchema,
    execute: async (
      input: z.infer<typeof sessionOpsInputSchema>,
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.sessionOps(ctx, ctx.projectId ?? '', input);
    },
  });

  // validate_agent (internal — validates an agent's ABL code in project context)
  registry.register({
    name: 'validate_agent',
    kind: 'internal',
    statusLabel: 'Validating agent…',
    description:
      'Validate an agent ABL definition with full project context (cross-agent references).',
    inputSchema: z.object({
      agentName: z.string().describe('Name of the agent to validate'),
      code: z.string().optional().describe('Code to validate (uses stored code if omitted)'),
      depth: z.enum(['quick', 'deep']).optional().describe('Validation depth for stored code'),
    }),
    execute: async (
      input: { agentName: string; code?: string; depth?: 'quick' | 'deep' },
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.validateAgent(ctx, ctx.projectId ?? '', input.agentName, input.code, input.depth);
    },
  });

  // diagnose_project (internal — runs diagnostics across the entire project)
  registry.register({
    name: 'diagnose_project',
    kind: 'internal',
    readOnly: true,
    statusLabel: 'Diagnosing project…',
    description: 'Run comprehensive diagnostics across all agents in the project.',
    inputSchema: z.object({
      depth: z.enum(['quick', 'deep']).optional().describe('Analysis depth'),
    }),
    execute: async (input: { depth?: string }, ctx: MinimalTurnContext): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.diagnoseProject(ctx, ctx.projectId ?? '', input);
    },
  });

  // explain_diagnostic (internal — explains a specific diagnostic finding)
  registry.register({
    name: 'explain_diagnostic',
    kind: 'internal',
    readOnly: true,
    statusLabel: 'Explaining diagnostic…',
    description: 'Explain a specific diagnostic finding with remediation guidance.',
    inputSchema: z.object({
      code: z.string().describe('Diagnostic code to explain'),
      context: z.string().optional().describe('Additional context'),
    }),
    execute: async (
      input: { code: string; context?: string },
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.explainDiagnostic(ctx, input.code, input.context);
    },
  });

  // configure_model (internal — configures the LLM model for an agent)
  registry.register({
    name: 'configure_model',
    kind: 'internal',
    statusLabel: 'Configuring model…',
    description:
      'Inspect, compare, or apply LLM model configurations for agents. ' +
      'Use inspect or diff before apply; confirmed=true is required for write actions.',
    inputSchema: configureModelInputSchema,
    execute: async (
      input: z.infer<typeof configureModelInputSchema>,
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.configureModel(ctx, ctx.projectId ?? '', input);
    },
  });

  // recommend_model (internal — recommends a model for an agent)
  registry.register({
    name: 'recommend_model',
    kind: 'internal',
    readOnly: true,
    statusLabel: 'Recommending model…',
    description: 'Recommend the best LLM model for an agent based on its requirements.',
    inputSchema: z.object({
      agentName: z.string().describe('Agent to recommend for'),
    }),
    execute: async (input: { agentName: string }, ctx: MinimalTurnContext): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.recommendModel(ctx, ctx.projectId ?? '', input.agentName);
    },
  });

  // analyze_constraints (internal — analyzes agent constraints)
  registry.register({
    name: 'analyze_constraints',
    kind: 'internal',
    readOnly: true,
    statusLabel: 'Analyzing constraints…',
    description: 'Analyze the CONSTRAINTS section of an agent for correctness and completeness.',
    inputSchema: z.object({
      agentName: z.string().describe('Agent to analyze'),
    }),
    execute: async (input: { agentName: string }, ctx: MinimalTurnContext): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.analyzeConstraints(ctx, ctx.projectId ?? '', input.agentName);
    },
  });

  // query_traces (internal — queries execution traces)
  registry.register({
    name: 'query_traces',
    kind: 'internal',
    readOnly: true,
    statusLabel: 'Querying traces…',
    description: 'Query execution traces for an agent or project.',
    inputSchema: traceQueryInputSchema,
    execute: async (
      input: z.infer<typeof traceQueryInputSchema>,
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.queryTraces(ctx, ctx.projectId ?? '', input);
    },
  });

  // run_test (internal — runs a test against an agent)
  registry.register({
    name: 'run_test',
    kind: 'internal',
    statusLabel: 'Running test…',
    description: 'Run a test message against an agent to verify behavior.',
    inputSchema: z.object({
      agentName: z.string().describe('Agent to test'),
      message: z.string().describe('Test message to send'),
    }),
    execute: async (
      input: { agentName: string; message: string },
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.runTest(ctx, ctx.projectId ?? '', input);
    },
  });

  // health_check (internal — checks project health)
  registry.register({
    name: 'health_check',
    kind: 'internal',
    readOnly: true,
    statusLabel: 'Checking health…',
    description: 'Check the health status of the project and its agents.',
    inputSchema: z.object({}),
    execute: async (_input: Record<string, never>, ctx: MinimalTurnContext): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.healthCheck(ctx, ctx.projectId ?? '');
    },
  });

  // auth_ops (internal — manages auth profiles)
  registry.register({
    name: 'auth_ops',
    kind: 'internal',
    statusLabel: 'Managing auth…',
    description: 'Manage authentication profiles for the project.',
    inputSchema: z.object({
      action: z.enum(['create', 'read', 'update', 'delete', 'list', 'validate']),
      profileId: z.string().optional().describe('Auth profile ID'),
      profileName: z.string().optional().describe('Auth profile name'),
      authType: z.string().optional().describe('Auth type'),
      config: z.record(z.unknown()).optional().describe('Non-secret auth config'),
      flowId: z.string().optional().describe('Secret-collection flow ID'),
      confirmed: z.boolean().optional().describe('Required true for delete'),
    }),
    execute: async (
      input: {
        action: string;
        profileId?: string;
        profileName?: string;
        authType?: string;
        config?: Record<string, unknown>;
        flowId?: string;
        confirmed?: boolean;
      },
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.authOps(ctx, ctx.projectId ?? '', input);
    },
  });

  // tools_ops (internal — manages tool definitions)
  registry.register({
    name: 'tools_ops',
    kind: 'internal',
    statusLabel: 'Managing tools…',
    description:
      'Manage tool definitions for the project, including HTTP/MCP/Sandbox tools and ' +
      'SearchAI knowledge-base runtime tools. Create/read/update returns an agentToolBlock ' +
      'that contains only the callable signature/description for an agent TOOLS section. ' +
      'Do not copy ProjectTool implementation fields such as endpoint, auth, headers, code, ' +
      'server, index_id, or tenant_id into agent definitions.',
    inputSchema: z.object({
      action: z.enum(['read', 'list', 'create', 'update', 'test', 'delete']),
      toolId: z.string().optional().describe('Tool ID'),
      toolName: z.string().optional().describe('Tool name'),
      config: z.record(z.unknown()).optional().describe('Tool config'),
      testInput: z.record(z.unknown()).optional().describe('Sample test input'),
      confirmed: z.boolean().optional().describe('Required true for delete'),
    }),
    execute: async (
      input: {
        action: string;
        toolId?: string;
        toolName?: string;
        config?: Record<string, unknown>;
        testInput?: Record<string, unknown>;
        confirmed?: boolean;
      },
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.toolsOps(ctx, ctx.projectId ?? '', input);
    },
  });

  // mcp_server_ops (internal — manages project MCP server configs)
  registry.register({
    name: 'mcp_server_ops',
    kind: 'internal',
    statusLabel: 'Managing MCP server…',
    description:
      'Manage project MCP server configs using existing Studio MCP APIs. Supports list/read/create/update/delete, ' +
      'connection tests, tool discovery/import, and per-tool tests. For auth-backed MCP servers, call create/update ' +
      'without flowId first to get requiredSecrets, collect them via collect_secret, then retry with flowId. ' +
      'After importing MCP tools, use tools_ops read/list to get agentToolBlock and link only signatures into agents.',
    inputSchema: mcpServerOpsInputSchema,
    execute: async (
      input: z.infer<typeof mcpServerOpsInputSchema>,
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.mcpServerOps(ctx, ctx.projectId ?? '', input);
    },
  });

  // project_config (internal — reads/updates project metadata and settings)
  registry.register({
    name: 'project_config',
    kind: 'internal',
    statusLabel: 'Updating project configuration…',
    description:
      'Read or modify project configuration. Use get_config/update_config for metadata ' +
      'and get_settings/update_settings for thinking settings.',
    inputSchema: projectConfigInputSchema,
    execute: async (
      input: z.infer<typeof projectConfigInputSchema>,
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.projectConfig(ctx, ctx.projectId ?? '', input);
    },
  });

  // variable_ops (internal — manages env/config variables for integrations)
  registry.register({
    name: 'variable_ops',
    kind: 'internal',
    statusLabel: 'Managing variables…',
    description: 'Manage environment variables, config variables, and namespace links.',
    inputSchema: z.object({
      action: z.enum(['list', 'list_namespaces', 'create', 'update', 'delete', 'link_namespace']),
      variableType: z.enum(['env', 'config']).optional().describe('Variable type'),
      variableId: z.string().optional().describe('Variable ID'),
      key: z.string().optional().describe('Variable key'),
      value: z.string().optional().describe('Variable value'),
      description: z.string().nullable().optional().describe('Variable description'),
      isSecret: z.boolean().optional().describe('Whether an env var is secret'),
      environment: z
        .enum(['global', 'dev', 'staging', 'production'])
        .nullable()
        .optional()
        .describe('Env-var environment'),
      namespaceId: z.string().optional().describe('Namespace filter'),
      variableNamespaceIds: z.array(z.string()).optional().describe('Namespace IDs'),
      confirmed: z.boolean().optional().describe('Required true for delete'),
    }),
    execute: async (
      input: {
        action: string;
        variableType?: string;
        variableId?: string;
        key?: string;
        value?: string;
        description?: string | null;
        isSecret?: boolean;
        environment?: string | null;
        namespaceId?: string;
        variableNamespaceIds?: string[];
        confirmed?: boolean;
      },
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.variableOps(ctx, ctx.projectId ?? '', input);
    },
  });

  // integration_ops (internal — manages durable integration drafts)
  registry.register({
    name: 'integration_ops',
    kind: 'internal',
    statusLabel: 'Updating integration draft…',
    description: 'Create, update, test, complete, or archive durable integration drafts.',
    inputSchema: z.object({
      action: z.enum([
        'start',
        'get_active',
        'list',
        'update',
        'run_tool_test',
        'complete',
        'archive',
      ]),
      draftId: z.string().optional().describe('Draft ID'),
      title: z.string().optional().describe('Draft title'),
      providerKey: z.string().nullable().optional().describe('Integration/provider key'),
      source: z.enum(['onboarding', 'in_project']).optional().describe('Draft source'),
      targetAgentNames: z.array(z.string()).optional().describe('Target agents'),
      pendingSteps: z.array(z.string()).optional().describe('Pending step list'),
      addPendingSteps: z.array(z.string()).optional().describe('Pending steps to add'),
      removePendingSteps: z.array(z.string()).optional().describe('Pending steps to remove'),
      lastIntentSummary: z.string().nullable().optional().describe('Intent summary'),
      status: z
        .enum([
          'draft',
          'needs_input',
          'ready_to_test',
          'ready_to_apply',
          'complete',
          'archived',
          'failed',
        ])
        .optional()
        .describe('Draft status'),
      includeCompleted: z.boolean().optional().describe('Include completed drafts'),
      toolId: z.string().optional().describe('Tool ID for test runs'),
      testInput: z.record(z.unknown()).optional().describe('Tool test input'),
      toolIds: z.array(z.string()).optional().describe('Tool IDs'),
      authProfileIds: z.array(z.string()).optional().describe('Auth profile IDs'),
      envVarKeys: z.array(z.string()).optional().describe('Env-var keys'),
      configVarKeys: z.array(z.string()).optional().describe('Config-var keys'),
      variableNamespaceIds: z.array(z.string()).optional().describe('Namespace IDs'),
    }),
    execute: async (
      input: {
        action: string;
        draftId?: string;
        title?: string;
        providerKey?: string | null;
        source?: 'onboarding' | 'in_project';
        targetAgentNames?: string[];
        pendingSteps?: string[];
        addPendingSteps?: string[];
        removePendingSteps?: string[];
        lastIntentSummary?: string | null;
        status?: string;
        includeCompleted?: boolean;
        toolId?: string;
        testInput?: Record<string, unknown>;
        toolIds?: string[];
        authProfileIds?: string[];
        envVarKeys?: string[];
        configVarKeys?: string[];
        variableNamespaceIds?: string[];
      },
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.integrationOps(ctx, ctx.projectId ?? '', input);
    },
  });

  // kb_manage (internal — knowledge base lifecycle)
  registry.register({
    name: 'kb_manage',
    kind: 'internal',
    statusLabel: 'Managing knowledge base…',
    description:
      'Manage knowledge bases: list, create, get details, update, or delete. ' +
      'Use list before asking the user to choose a knowledge base.',
    inputSchema: kbManageInputSchema,
    execute: async (
      input: z.infer<typeof kbManageInputSchema>,
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.kbManage(ctx, ctx.projectId ?? '', input);
    },
  });

  // kb_search (internal — semantic and structured KB search)
  registry.register({
    name: 'kb_search',
    kind: 'internal',
    readOnly: true,
    statusLabel: 'Searching knowledge base…',
    description:
      'Search a knowledge base. Actions: query, structured_query, discover, and resolve_vocab.',
    inputSchema: kbSearchInputSchema,
    execute: async (
      input: z.infer<typeof kbSearchInputSchema>,
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.kbSearch(ctx, ctx.projectId ?? '', input);
    },
  });

  // kb_health (internal — KB health, retry, operation status)
  registry.register({
    name: 'kb_health',
    kind: 'internal',
    statusLabel: 'Checking knowledge base health…',
    description:
      'Check knowledge base health, list errors, retry failed documents, sync counters, or check operation status.',
    inputSchema: kbHealthInputSchema,
    execute: async (
      input: z.infer<typeof kbHealthInputSchema>,
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.kbHealth(ctx, ctx.projectId ?? '', input);
    },
  });

  // kb_ingest (internal — uploads/files/urls/text into a KB)
  registry.register({
    name: 'kb_ingest',
    kind: 'internal',
    statusLabel: 'Ingesting knowledge base content…',
    description:
      'Ingest content into a knowledge base: upload files from collect_file, add URLs, add text, or list sources.',
    inputSchema: kbIngestInputSchema,
    execute: async (
      input: z.infer<typeof kbIngestInputSchema>,
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.kbIngest(ctx, ctx.projectId ?? '', input);
    },
  });

  // kb_connector (internal — enterprise KB connector lifecycle)
  registry.register({
    name: 'kb_connector',
    kind: 'internal',
    statusLabel: 'Managing knowledge base connector…',
    description:
      'Manage enterprise knowledge base connectors: list, create, initiate auth, start sync, check status, pause, or resume.',
    inputSchema: kbConnectorInputSchema,
    execute: async (
      input: z.infer<typeof kbConnectorInputSchema>,
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.kbConnector(ctx, ctx.projectId ?? '', input);
    },
  });

  // kb_documents (internal — KB document list/status/reprocess/delete)
  registry.register({
    name: 'kb_documents',
    kind: 'internal',
    statusLabel: 'Managing knowledge base documents…',
    description:
      'Manage KB documents: list, summarize status, reprocess failed documents, or delete a document.',
    inputSchema: kbDocumentsInputSchema,
    execute: async (
      input: z.infer<typeof kbDocumentsInputSchema>,
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.kbDocuments(ctx, ctx.projectId ?? '', input);
    },
  });

  // search_docs (internal — searches platform documentation)
  registry.register({
    name: 'search_docs',
    kind: 'internal',
    readOnly: true,
    statusLabel: 'Searching documentation…',
    description:
      'Search platform documentation for authoritative information about APIs, SDKs, features, configuration, channels, admin, deployment, and platform topics.',
    inputSchema: searchDocsInputSchema,
    execute: async (input: z.infer<typeof searchDocsInputSchema>): Promise<unknown> => {
      try {
        const results = searchDocsGrouped(input.query, input.limit ?? 5);

        if (results.length === 0) {
          return {
            success: true,
            results: [],
            message:
              'No documentation found matching that query. Try different search terms or a more specific query.',
          };
        }

        return {
          success: true,
          results: results.map((result) => ({
            file: result.file,
            relevanceScore: Math.round(result.bestScore * 100) / 100,
            sections: result.sections.map((section) => ({
              heading: section.heading,
              content: section.text,
            })),
          })),
          resultCount: results.length,
        };
      } catch (err: unknown) {
        return {
          success: false,
          error: {
            code: 'SEARCH_DOCS_ERROR',
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },
  });

  // manage_memory (internal — manages project memory)
  registry.register({
    name: 'manage_memory',
    kind: 'internal',
    statusLabel: 'Managing memory…',
    description: 'Manage cross-session project memories.',
    inputSchema: z.object({
      action: z.enum(['list', 'add', 'delete', 'remove']).describe('Memory operation'),
      content: z.string().optional().describe('Memory content for add or search text for delete'),
      memoryId: z.string().optional().describe('Memory ID for delete'),
    }),
    execute: async (
      input: { action: string; content?: string; memoryId?: string },
      ctx: MinimalTurnContext,
    ): Promise<unknown> => {
      const refs = await buildV1CoreRefs();
      return refs.manageMemory(ctx, ctx.projectId ?? '', input);
    },
  });

  for (const [name, toolDefinition] of Object.entries(inProjectToolTemplates)) {
    if (registry.get(name)) {
      continue;
    }

    const hasExecute = typeof toolDefinition.execute === 'function';
    registry.register({
      name,
      kind: hasExecute ? 'internal' : 'interactive',
      description: toolDefinition.description ?? `Run ${name}`,
      inputSchema: toToolRegistryInputSchema(toolDefinition.inputSchema),
      ...(hasExecute
        ? {
            execute: async (input: unknown, ctx: MinimalTurnContext): Promise<unknown> => {
              const tools = buildInProjectTools(
                {
                  tenantId: ctx.tenantId,
                  userId: ctx.userId,
                  permissions: getServicePermissions(ctx),
                },
                ctx.sessionId,
                ctx.projectId ?? '',
                getServiceAuthToken(ctx),
                (event) => ctx.emit(event),
                {
                  pageContext: (ctx.services?.pageContext as never) ?? null,
                  mutationGuard: getServiceMutationGuard(ctx),
                },
              );
              const runtimeTool = (
                tools as Record<string, { execute?: (input: unknown) => Promise<unknown> }>
              )[name];
              if (typeof runtimeTool?.execute !== 'function') {
                throw new Error(`IN_PROJECT tool '${name}' is not executable`);
              }
              return runtimeTool.execute(input);
            },
          }
        : {}),
    });
  }

  return registry;
}

/** @deprecated Use buildOnboardingToolRegistry(). Kept for backward compat. */
export const buildInterviewToolRegistry = buildOnboardingToolRegistry;

// ─── Production TurnEngine ──────────────────────────────────────────────

/**
 * Build a fully wired production TurnEngine for the given tenant.
 * Returns both the engine and the populated tool registry (needed by the
 * caller for `resolveTurnPlan` filtering).
 */
export async function createProductionTurnEngine(
  tenantId: string,
  options: CreateProductionTurnEngineOptions = {},
): Promise<{
  engine: TurnEngine;
  toolRegistry: ToolRegistry;
}> {
  const redis = getRedisClient();
  if (!redis) {
    throw new Error('createProductionTurnEngine: Redis not initialized');
  }

  // Live fan-out — every event (durable + ephemeral) hits Redis pub/sub for
  // cross-tab delivery. Unchanged from prior behavior.
  const publishLive = async (event: TurnEvent): Promise<void> => {
    await publishTurnEvent(redis, event.sessionId, event);
  };

  // Ring buffer persists durable events for SSE reconnect replay (V4 design §9.3).
  const ringBuffer = createRingBuffer({
    redis: redis as unknown as RingBufferClient,
    sizeLimit: 1000,
    ttlSeconds: 3600,
  });

  const publishDurable = buildDurablePublisher({
    live: publishLive,
    ringBuffer,
    nextDurableSeq: async (sessionId) => {
      const key = `arch:v4:durable-seq:${sessionId}`;
      const next = await redis.incr(key);
      await redis.expire(key, DURABLE_REPLAY_SEQ_TTL_SECONDS);
      return next;
    },
  });

  // Out-of-band cancel flag accessors via native Mongo driver (avoids model import cycle).
  const cancelRequestedRead = async (sessionId: string): Promise<boolean> => {
    const db = mongoose.connection.db;
    if (!db) return false;
    const doc = await db
      .collection('arch_sessions')
      .findOne(
        { _id: sessionId } as Record<string, unknown>,
        { projection: { cancelRequested: 1 } } as Record<string, unknown>,
      );
    return Boolean((doc as { cancelRequested?: boolean } | null)?.cancelRequested);
  };

  const cancelRequestedClear = async (sessionId: string): Promise<void> => {
    const db = mongoose.connection.db;
    if (!db) return;
    await db
      .collection('arch_sessions')
      .updateOne(
        { _id: sessionId } as Record<string, unknown>,
        { $set: { cancelRequested: false } } as Record<string, unknown>,
      );
  };

  // Build LLM client and onboarding tool registry.
  // The registry contains all onboarding-phase tools (INTERVIEW + BLUEPRINT + BUILD).
  // Phase-scoping is done by resolveTurnPlan which filters by PHASE_TOOL_MAP.
  const [llmClient] = await Promise.all([buildV2LlmStreamClient(tenantId)]);

  const toolRegistry = buildOnboardingToolRegistry();

  const engine = new TurnEngine({
    llmClient,
    toolRegistry,
    publishDurable,
    publishLive,
    cancelRequestedRead,
    cancelRequestedClear,
    generateSuggestions: options.generateSuggestions,
    redis,
  });

  return { engine, toolRegistry };
}
