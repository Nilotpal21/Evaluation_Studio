/**
 * processMessage — ONBOARDING mode message processor for v4.
 *
 * M1.21: Replaces the stub with real TurnEngine wiring.
 *
 * Source of truth: docs/superpowers/specs/2026-04-18-arch-v4-design.md
 *
 * Wire plan:
 *   1. Build a fully wired TurnEngine via createProductionTurnEngine().
 *   2. Resolve the turn plan (specialist + system prompt + allowed tools)
 *      via resolveTurnPlan() from the coordinator bridge.
 *   3. Build a TurnBuffer for this turn using the ArchSessionModel model.
 *   4. Map session messages → LLMMessage[] history.
 *   5. Drive engine.runTurn() as an AsyncIterable<TurnEvent>.
 *   6. Bridge TurnEvent → route's ArchSSEEvent emitter via cast through
 *      unknown. The hook reducer (apps/studio/src/lib/arch-ai/ui/hook-reducer.ts
 *      — M1.22) understands both legacy ArchSSEEvent shapes and v4 TurnEvent
 *      envelopes. A proper translation layer is deferred to M2 polish.
 */

import { createLogger } from '@abl/compiler/platform';
import { SPEC_TO_SESSION_FIELD_MAP } from '../spec-document/index.js';
import type {
  ArchContentBlock,
  ArchSSEEvent,
  ArchSession,
  MessageRequest,
  TurnEvent,
} from '../types/index.js';
import type {
  ResolveTurnPlanInput,
  RunTurnInput,
  TurnEngine,
  TurnEngineDeps,
} from '../engine/index.js';
import { TurnBuffer, resolveTurnPlan } from '../engine/index.js';
import { ArchSessionModel } from '../models/index.js';
import type { ArchFileStore } from '../session/index.js';
import type {
  JournalService,
  ProjectMemoryService,
  SessionService,
  SpecDocumentService,
} from '../index.js';
import type { ToolRegistry } from '../tools/index.js';
import { uuidv7 } from '@agent-platform/database/mongo';
import { journalAppendAndEmit, specUpdateAndEmit } from '../helpers/stream-helpers.js';
import {
  collectBlobIdsFromContent,
  prepareTurnHistory,
  resolveUserContentForArchLlm,
} from '../helpers/build-llm-messages.js';
import {
  extractSourceArchitectureContractFromFiles,
  getSourceArchitectureContractFromMetadata,
  renderSourceArchitectureContractPrompt,
} from '../blueprint/index.js';
import { appendDeterministicToolAnswerMessage } from '../helpers/persist-tool-answer-history.js';
import {
  asBlueprintTopology,
  buildBlueprintConceptPrompt,
  buildBlueprintConfirmWidget,
  buildTopologyApprovalWidget,
  buildTopologyRevisionPrompt,
  buildTopologyRevisionWidget,
  getBlueprintContextSummary,
  getBlueprintStage,
  getDraftTopology,
  getLockedTopology,
  getEffectiveTopology,
  hasPendingBlueprintWidget,
  normalizeBlueprintConfirmAnswer,
  normalizeTopologyApprovalAnswer,
  normalizeTopologyRevisionAnswer,
  type BlueprintTopology,
} from '../blueprint-flow.js';
import { synthesizeDeterministicBlueprintDraft } from '../blueprint-topology-fallback.js';
import {
  buildPageContextClarificationAppendix,
  shouldClarifyPageContextIntent,
} from '../page-context-ambiguity.js';
import { getProjectNameFromWidgetAnswer } from './widget-answer-capture.js';

const log = createLogger('arch-ai:processors:process-message');

export interface ArchRequestTiming {
  requestId: string;
  requestStartedAt: number;
}

export interface ProcessMessageModelResolution {
  model: unknown | null;
  error?: string | null;
}

export interface ProcessMessageBuildResult {
  agentName: string;
  status: 'compiled' | 'warning' | 'error';
  warnings: string[];
  errors: string[];
  diagnosticCodes?: string[];
  retryable?: boolean;
  retryReason?: string;
  mode: string;
  agentType: string;
  toolCount: number;
  handoffCount: number;
  quality: {
    guardrails: boolean;
    memory: boolean;
    errorHandlers: boolean;
    constraints: boolean;
    catchAllHandoff: boolean;
  };
  elapsed?: number;
  enrichedSections?: string[];
}

export interface ProcessMessageDeps {
  sessionService: SessionService;
  journalService: JournalService;
  specDocumentService: SpecDocumentService;
  projectMemoryService: ProjectMemoryService;
  fileStoreService: ArchFileStore;
  resolveModel: (tenantId: string) => Promise<ProcessMessageModelResolution>;
  createTurnEngine: (
    tenantId: string,
    options: { generateSuggestions: NonNullable<TurnEngineDeps['generateSuggestions']> },
  ) => Promise<{ engine: TurnEngine; toolRegistry: ToolRegistry }>;
  buildServiceBagForTurn: (buffer: TurnBuffer) => Record<string, unknown>;
  buildSuggestionGenerator: (
    session: ArchSession,
  ) => NonNullable<TurnEngineDeps['generateSuggestions']>;
  buildTurnPlanLoaders: (
    ctx: { tenantId: string; userId: string },
    session: ArchSession,
  ) => Pick<
    ResolveTurnPlanInput,
    | 'specDocumentLoader'
    | 'journalDecisionLoader'
    | 'projectMemoryLoader'
    | 'learningMemoryLoader'
    | 'projectStateSummaryLoader'
    | 'activeDraftSnapshotLoader'
  >;
  augmentUserInputWithFileRefs: (
    ctx: { tenantId: string; userId: string },
    sessionId: string,
    userText: string,
    fileRefs?: Array<{ blobId: string }>,
  ) => Promise<string>;
  buildUserContentFromFileRefs: (
    ctx: { tenantId: string; userId: string },
    sessionId: string,
    userText: string,
    fileRefs?: Array<{ blobId: string }>,
  ) => Promise<ArchContentBlock[] | undefined>;
  transitionSessionToIdle: (
    sessionService: SessionService,
    ctx: { tenantId: string; userId: string },
    sessionId: string,
    reason: string,
  ) => Promise<void>;
  closeAndResetIfActive: (
    sessionService: SessionService,
    ctx: { tenantId: string; userId: string },
    sessionId: string,
    close: () => void,
    reason: string,
  ) => Promise<void>;
  projectExistsByName: (projectName: string, tenantId: string) => Promise<boolean>;
  finalizeProject: (
    ctx: { tenantId: string; userId: string },
    session: ArchSession,
    emit: (event: ArchSSEEvent) => void,
    close: () => void,
    deps: {
      sessionService: SessionService;
      journalService: JournalService;
      specDocumentService: SpecDocumentService;
      projectMemoryService: ProjectMemoryService;
    },
    timing?: ArchRequestTiming,
  ) => Promise<void>;
  runParallelGeneration: (
    agentNames: string[],
    ctx: { tenantId: string; userId: string },
    session: ArchSession,
    emit: (event: ArchSSEEvent) => void,
    model: unknown,
    abortSignal: AbortSignal,
    options: { buildRunId: string; trigger: string },
  ) => Promise<ProcessMessageBuildResult[]>;
  buildCompletionSummary: (results: ProcessMessageBuildResult[]) => string;
  buildCompletionWidgetPayload: (
    results: ProcessMessageBuildResult[],
    projectName?: string,
  ) => Record<string, unknown>;
  extractBuildResultsFromPendingWidgetPayload: (
    payload: Record<string, unknown>,
  ) => ProcessMessageBuildResult[];
  handleBuildAction: (
    answer: string,
    ctx: { tenantId: string; userId: string },
    session: ArchSession,
    results: ProcessMessageBuildResult[],
    emit: (event: ArchSSEEvent) => void,
    close: () => void,
    deps: {
      sessionService: SessionService;
      journalFn: (
        summary: string,
        rationale: string,
        specialist: string,
        phase: string,
      ) => Promise<void>;
      timing?: ArchRequestTiming;
      createProject?: (
        ctx: { tenantId: string; userId: string },
        session: ArchSession,
        emit: (event: ArchSSEEvent) => void,
        close: () => void,
      ) => Promise<void>;
      runParallelGeneration?: (
        agentNames: string[],
        ctx: { tenantId: string; userId: string },
        session: ArchSession,
        emit: (event: ArchSSEEvent) => void,
      ) => Promise<ProcessMessageBuildResult[]>;
    },
    projectName?: string,
  ) => Promise<{ continueToLLM: boolean }>;
  executePhaseTransition: (
    ctx: { tenantId: string; userId: string },
    session: ArchSession,
    sessionService: SessionService,
    emit: (event: ArchSSEEvent) => void,
    journalFn: (
      summary: string,
      rationale: string,
      specialist: string,
      phase: string,
    ) => Promise<void>,
    timing?: ArchRequestTiming,
  ) => Promise<{ transitioned: boolean; to?: string; error?: string }>;
}

let configuredProcessMessageDeps: ProcessMessageDeps | null = null;

export function configureProcessMessageDeps(deps: ProcessMessageDeps): void {
  configuredProcessMessageDeps = deps;
}

function resolveProcessMessageDeps(deps?: ProcessMessageDeps): ProcessMessageDeps {
  const resolved = deps ?? configuredProcessMessageDeps;
  if (!resolved) {
    throw new Error('processMessage dependencies have not been configured');
  }
  return resolved;
}

// Temporary relaxation while BLUEPRINT orchestration is reworked against the
// runtime/parser truth. Keep the newer pathways available in code, but default
// to the pre-hardening behavior for draft topology generation.
const BLUEPRINT_FORCE_PROVIDER_TOOL_ROUTING = false;
// Fail open to a deterministic, reviewable draft after the provider ignores the
// dedicated generate_topology turn and the retry. This prevents BLUEPRINT from
// looping on the same confirmation widget while preserving user approval before
// BUILD.
const BLUEPRINT_USE_SYNTHETIC_DRAFT_FALLBACK = true;

type BuildTopology = BlueprintTopology;

const MANUAL_CREATE_DIRECT_PATTERN =
  /\b(?:create|finali[sz]e|provision|launch)\b(?:\s+\w+){0,3}\s+\bproject\b|\bcreate_project\b/;
const MANUAL_CREATE_AFFIRMATIVE_PATTERN =
  /^(?:yes|yep|yeah|ok|okay|sure|continue|proceed|go ahead|looks good|approved?|do it|ship it)(?:[\s.!]*|$)/;
const MANUAL_CREATE_CHANGE_REQUEST_PATTERN =
  /\b(?:add|change|modify|edit|revise|before|instead|wait|stop|not|don't|dont|review|fix|retry|back|tools?|warnings?)\b/;

function getMissingTopologyAgents(session: ArchSession): string[] {
  const topology =
    getLockedTopology(session) ??
    asBlueprintTopology(session.metadata.topology as BuildTopology | undefined);
  const topologyAgentNames =
    topology?.agents
      ?.map((agent) => (typeof agent.name === 'string' ? agent.name : null))
      .filter((name): name is string => name !== null) ?? [];
  if (topologyAgentNames.length === 0) {
    return [];
  }

  const files = (session.metadata.files ?? {}) as Record<string, unknown>;
  const generatedNames = new Set(Object.keys(files));
  return topologyAgentNames.filter((name) => !generatedNames.has(name));
}

async function extractTurnSourceArchitectureContract(params: {
  fileStore: ArchFileStore;
  ctx: { tenantId: string; userId: string };
  sessionId: string;
  metadata: Record<string, unknown>;
}) {
  const existing = getSourceArchitectureContractFromMetadata(params.metadata);
  try {
    const activeFiles = await params.fileStore.getActiveFiles(params.ctx, params.sessionId);
    const extracted = extractSourceArchitectureContractFromFiles(activeFiles);
    return extracted ?? existing;
  } catch (err) {
    log.warn('Failed to extract source architecture contract from active files', {
      sessionId: params.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return existing;
  }
}

function buildCompleteWidgetCanCreate(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }
  const record = payload as { widgetType?: unknown; options?: unknown };
  if (record.widgetType !== 'BuildComplete') {
    return false;
  }
  if (!Array.isArray(record.options)) {
    return true;
  }
  return record.options.some((option) => {
    return (
      typeof option === 'object' &&
      option !== null &&
      (option as { value?: unknown }).value === 'create'
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MAX_COLLECT_FILE_CONTEXT_CHARS = 20_000;
const MAX_COLLECT_FILE_STORED_SUMMARY_CHARS = 2_000;
const TEXT_COLLECT_FILE_EXTENSIONS = new Set([
  '.css',
  '.csv',
  '.env',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.log',
  '.md',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.sql',
  '.ts',
  '.tsx',
  '.tsv',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);
const TEXT_COLLECT_FILE_MIME_TYPES = new Set([
  'application/javascript',
  'application/json',
  'application/typescript',
  'application/xml',
  'application/x-yaml',
]);

interface CollectFileAnswerFile {
  name: string;
  size?: number;
  type?: string;
  content: string;
}

interface CollectFileAnswerContext {
  llmText: string;
  storedAnswer: Array<{
    name: string;
    size?: number;
    type?: string;
    contentStored: true;
    summary?: string;
  }>;
}

function isCollectFileAnswerFile(value: unknown): value is CollectFileAnswerFile {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    value.name.trim().length > 0 &&
    typeof value.content === 'string' &&
    value.content.length > 0 &&
    (value.size === undefined || typeof value.size === 'number') &&
    (value.type === undefined || typeof value.type === 'string')
  );
}

function truncateCollectFileText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n[Uploaded file truncated for model context]`;
}

function isReadableCollectFile(file: CollectFileAnswerFile): boolean {
  const type = file.type?.toLowerCase();
  if (type?.startsWith('text/') || (type != null && TEXT_COLLECT_FILE_MIME_TYPES.has(type))) {
    return true;
  }

  const extensionMatch = /\.([a-z0-9]+)$/i.exec(file.name.trim());
  if (!extensionMatch) {
    return false;
  }

  return TEXT_COLLECT_FILE_EXTENSIONS.has(`.${extensionMatch[1]!.toLowerCase()}`);
}

function decodeCollectFileContent(file: CollectFileAnswerFile): string | null {
  if (!isReadableCollectFile(file)) {
    return null;
  }

  try {
    const decoded = Buffer.from(file.content, 'base64').toString('utf-8');
    return decoded.trim().length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function buildCollectFileAnswerContext(answer: unknown): CollectFileAnswerContext | null {
  if (!Array.isArray(answer) || !answer.every(isCollectFileAnswerFile)) {
    return null;
  }

  const sections: string[] = [];
  const storedAnswer: CollectFileAnswerContext['storedAnswer'] = [];
  let remainingChars = MAX_COLLECT_FILE_CONTEXT_CHARS;

  for (const file of answer) {
    const decoded = decodeCollectFileContent(file);
    const summary =
      decoded != null
        ? truncateCollectFileText(decoded.trim(), MAX_COLLECT_FILE_STORED_SUMMARY_CHARS)
        : undefined;

    storedAnswer.push({
      name: file.name,
      contentStored: true,
      ...(file.size !== undefined ? { size: file.size } : {}),
      ...(file.type !== undefined ? { type: file.type } : {}),
      ...(summary ? { summary } : {}),
    });

    if (remainingChars <= 0) {
      continue;
    }

    const body =
      decoded != null && decoded.trim().length > 0
        ? decoded.trim()
        : `Content for ${file.name} is not available as readable text.`;
    const section = `[Uploaded file: ${file.name}]\n${body}\n[/Uploaded file]`;
    const truncated = truncateCollectFileText(section, remainingChars);
    sections.push(truncated);
    remainingChars -= truncated.length;
  }

  if (sections.length === 0) {
    return null;
  }

  return {
    llmText: `The user uploaded the requested file${answer.length === 1 ? '' : 's'}:\n\n${sections.join('\n\n')}`,
    storedAnswer,
  };
}

function findUnansweredWidgetPayloadInHistory(
  session: ArchSession,
  toolCallId: string,
): Record<string, unknown> | undefined {
  for (let messageIndex = session.metadata.messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = session.metadata.messages[messageIndex];
    if (!message || !Array.isArray(message.toolCalls)) {
      continue;
    }

    for (const toolCall of message.toolCalls) {
      if (
        toolCall.toolCallId === toolCallId &&
        toolCall.toolName === 'ask_user' &&
        (toolCall.result === undefined || toolCall.result === null) &&
        isRecord(toolCall.input)
      ) {
        return toolCall.input;
      }
    }
  }

  return undefined;
}

function isBuildCompleteResumeReady(session: ArchSession): boolean {
  const buildStage = isRecord(session.metadata.buildProgress)
    ? session.metadata.buildProgress.stage
    : undefined;
  return (
    (session.metadata.phase === 'BUILD' || session.metadata.phase === 'CREATE') &&
    (buildStage === 'agents_complete' || buildStage === 'complete')
  );
}

function isManualCreateProjectIntent(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (MANUAL_CREATE_CHANGE_REQUEST_PATTERN.test(normalized)) {
    return false;
  }
  return (
    MANUAL_CREATE_DIRECT_PATTERN.test(normalized) ||
    MANUAL_CREATE_AFFIRMATIVE_PATTERN.test(normalized)
  );
}

function isSessionReadyForManualCreate(session: ArchSession): boolean {
  if (session.metadata.projectId) {
    return false;
  }
  if (session.metadata.phase !== 'BUILD' && session.metadata.phase !== 'CREATE') {
    return false;
  }
  if (getMissingTopologyAgents(session).length > 0) {
    return false;
  }
  return Object.keys((session.metadata.files ?? {}) as Record<string, unknown>).length > 0;
}

function isCreateProjectWidgetAnswer(answer: unknown): boolean {
  if (answer === true) {
    return true;
  }
  if (typeof answer !== 'string') {
    return false;
  }
  const normalized = answer.trim().toLowerCase();
  if (!normalized || MANUAL_CREATE_CHANGE_REQUEST_PATTERN.test(normalized)) {
    return false;
  }
  return (
    normalized === 'true' ||
    normalized === 'create' ||
    normalized === 'create_project' ||
    normalized === 'create project' ||
    normalized === 'create now' ||
    normalized === 'yes' ||
    normalized === 'approved' ||
    normalized === 'proceed'
  );
}

function isInterviewDesignProceedAnswer(
  answer: unknown,
  payload: Record<string, unknown> | undefined,
): boolean {
  if (payload && Array.isArray(payload.options)) {
    const hasProceedOption = payload.options.some((option) => {
      return isRecord(option) && option.value === 'proceed';
    });
    if (!hasProceedOption) {
      return false;
    }
  }

  if (answer === true) {
    return true;
  }
  if (typeof answer !== 'string') {
    return false;
  }

  const normalized = answer.trim().toLowerCase();
  return (
    normalized === 'proceed' ||
    normalized === 'design' ||
    normalized === 'design architecture' ||
    normalized === 'design the architecture' ||
    normalized === 'start designing'
  );
}

async function persistBlueprintMetadata(
  ctx: { tenantId: string; userId: string },
  sessionId: string,
  patch: Record<string, unknown>,
  unset: Record<string, ''> = {},
): Promise<void> {
  await ArchSessionModel.updateOne(
    {
      _id: sessionId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      state: { $ne: 'ARCHIVED' },
    },
    {
      $set: patch,
      ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
    },
  );
}

async function persistHistorySummary(
  ctx: { tenantId: string; userId: string },
  sessionId: string,
  historySummary: ArchSession['metadata']['historySummary'],
): Promise<void> {
  await ArchSessionModel.updateOne(
    {
      _id: sessionId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      state: { $ne: 'ARCHIVED' },
    },
    {
      $set: {
        'metadata.historySummary': historySummary ?? null,
      },
    },
  );
}

async function persistProjectNameWidgetAnswer(
  ctx: { tenantId: string; userId: string },
  sessionId: string,
  projectName: string,
  emit: (event: ArchSSEEvent) => void,
  deps: ProcessMessageDeps,
): Promise<void> {
  try {
    if (await deps.projectExistsByName(projectName, ctx.tenantId)) {
      log.warn('Project-name widget answer already exists as project; leaving LLM to re-ask', {
        sessionId,
      });
      return;
    }

    const specDoc = await deps.specDocumentService.getBySession(ctx, sessionId);
    const sessionField = SPEC_TO_SESSION_FIELD_MAP['business.projectName'];
    if (specDoc && sessionField) {
      await specUpdateAndEmit(
        deps.specDocumentService,
        log,
        ctx,
        String(specDoc._id),
        'business.projectName',
        projectName,
        emit,
        sessionId,
        sessionField,
      );
      return;
    }

    await deps.sessionService.updateSpecification(ctx, sessionId, { projectName });
  } catch (err) {
    log.warn('Failed to persist project-name widget answer before LLM turn', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function persistCoordinatorWidget(
  ctx: { tenantId: string; userId: string },
  sessionId: string,
  phase: ArchSession['metadata']['phase'],
  payload: Record<string, unknown>,
  emit: (event: ArchSSEEvent) => void,
  options?: {
    messageText?: string;
    specialist?: string;
  },
  deps?: Pick<ProcessMessageDeps, 'sessionService'>,
): Promise<string> {
  const toolCallId = `widget_${crypto.randomUUID().slice(0, 8)}`;
  const promptText =
    options?.messageText ??
    (typeof payload.question === 'string' ? payload.question : 'Review the next action.');

  if (options?.specialist) {
    emit({ type: 'specialist', name: options.specialist, icon: 'bot' } as unknown as ArchSSEEvent);
  }
  emit({ type: 'text_delta', delta: promptText } as unknown as ArchSSEEvent);
  emit({ type: 'tool_call', toolCallId, toolName: 'ask_user', input: payload });

  const service = deps?.sessionService;
  if (!service) {
    throw new Error('persistCoordinatorWidget requires sessionService');
  }

  await service.appendMessage(ctx, sessionId, {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: promptText,
    timestamp: new Date().toISOString(),
    specialist: options?.specialist,
    toolCalls: [{ toolCallId, toolName: 'ask_user', input: payload }],
    phase,
  });
  await service.setPendingInteraction(ctx, sessionId, {
    kind: 'widget',
    id: toolCallId,
    payload,
    createdAt: new Date().toISOString(),
  });

  return toolCallId;
}

async function clearRejectedTopologyDraft(
  ctx: { tenantId: string; userId: string },
  sessionId: string,
  deps: ProcessMessageDeps,
): Promise<void> {
  await persistBlueprintMetadata(ctx, sessionId, {
    'metadata.blueprintStage': 'concept_ready',
    'metadata.topology': null,
    'metadata.draftTopology': null,
    'metadata.lockedTopology': null,
    'metadata.blueprintContextSummary': null,
    'metadata.topologyApproved': false,
  });

  try {
    const specDoc = await deps.specDocumentService.getBySession(ctx, sessionId);
    if (!specDoc) {
      return;
    }

    const specId = String(specDoc._id);
    await deps.specDocumentService.updateField(ctx, specId, 'architecture.agents', []);
    await deps.specDocumentService.updateField(ctx, specId, 'architecture.edges', []);
    await deps.specDocumentService.updateField(ctx, specId, 'architecture.entryPoint', null);
    await deps.specDocumentService.updateField(ctx, specId, 'architecture.agentCount', 0);
  } catch (err) {
    log.warn('Failed to clear rejected topology draft (non-fatal)', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Process an ONBOARDING message through the v4 TurnEngine.
 *
 * Supports all MessageRequest types routed here from the v4 message route.
 * For 'message' type: drives the full INTERVIEW/BLUEPRINT/BUILD turn loop.
 * For other types (tool_answer, gate_response, continue, create): currently
 * falls through to the engine (tools handle them via the interactive tool
 * resume path); future phases may add dedicated branches.
 */
export async function processMessage(
  ctx: { tenantId: string; userId: string; permissions?: string[] },
  session: ArchSession,
  msg: MessageRequest,
  emit: (event: ArchSSEEvent) => void,
  close: () => void,
  abortSignal: AbortSignal,
  authToken?: string,
  timing?: ArchRequestTiming,
  fencingToken?: number,
  depsArg?: ProcessMessageDeps,
): Promise<void> {
  const deps = resolveProcessMessageDeps(depsArg);
  const {
    sessionService,
    journalService,
    specDocumentService,
    projectMemoryService,
    fileStoreService,
    transitionSessionToIdle,
    closeAndResetIfActive,
  } = deps;
  log.info('v4 processMessage entry', {
    sessionId: session.id,
    msgType: msg.type,
    phase: session.metadata.phase,
    mode: session.metadata.mode,
    tenantId: ctx.tenantId,
  });

  // ─── CREATE shortcut: type='create' skips TurnEngine entirely ─────────
  // The CREATE flow is a deterministic service call (create project, save
  // agents, archive session) — no LLM streaming needed. Handled before the
  // TurnEngine wiring to avoid constructing an engine we won't use.
  if (msg.type === 'create') {
    log.info('v4 processMessage: CREATE branch', {
      sessionId: session.id,
      phase: session.metadata.phase,
    });
    await deps.finalizeProject(
      ctx,
      session,
      emit,
      close,
      {
        sessionService: deps.sessionService,
        journalService: deps.journalService,
        specDocumentService: deps.specDocumentService,
        projectMemoryService: deps.projectMemoryService,
      },
      timing,
    );
    return;
  }

  // Bridge: emit a v4 TurnEvent down the SSE stream typed as ArchSSEEvent.
  // The hook reducer (M1.22) handles both shapes. Cast via unknown is
  // intentional — a typed translation layer is deferred to M2.
  const emitTurnEvent = (event: TurnEvent): void => {
    try {
      emit(event as unknown as ArchSSEEvent);
    } catch (err) {
      log.warn('emit failed for v4 turn event', {
        error: err instanceof Error ? err.message : String(err),
        eventType: (event as { type?: string }).type,
      });
    }
  };

  try {
    const fileRefs = msg.type === 'message' ? msg.fileRefs : undefined;
    const rawUserText = msg.type === 'message' ? (msg.text ?? '') : '';
    const plannedUserInput =
      msg.type === 'message'
        ? await deps.augmentUserInputWithFileRefs(ctx, session.id, rawUserText, fileRefs)
        : undefined;
    const userContent =
      msg.type === 'message'
        ? await deps.buildUserContentFromFileRefs(ctx, session.id, rawUserText, fileRefs)
        : undefined;
    const collectFileAnswerContext =
      msg.type === 'tool_answer' ? buildCollectFileAnswerContext(msg.answer) : null;
    let freshSession = (await sessionService.getById(ctx, session.id)) ?? session;
    const isInProject = freshSession.metadata.mode === 'IN_PROJECT';
    const pendingWidgetPayload =
      session.metadata.pendingInteraction?.kind === 'widget'
        ? (session.metadata.pendingInteraction.payload as Record<string, unknown> | undefined)
        : undefined;
    const freshPendingWidgetPayload =
      freshSession.metadata.pendingInteraction?.kind === 'widget'
        ? (freshSession.metadata.pendingInteraction.payload as Record<string, unknown> | undefined)
        : undefined;
    const historyPendingWidgetPayload =
      msg.type === 'tool_answer'
        ? (findUnansweredWidgetPayloadInHistory(freshSession, msg.toolCallId) ??
          findUnansweredWidgetPayloadInHistory(session, msg.toolCallId))
        : undefined;
    const activePendingWidgetPayload =
      pendingWidgetPayload ?? freshPendingWidgetPayload ?? historyPendingWidgetPayload;

    if (
      !isInProject &&
      msg.type === 'tool_answer' &&
      isCreateProjectWidgetAnswer(msg.answer) &&
      isSessionReadyForManualCreate(freshSession) &&
      (freshSession.metadata.phase === 'CREATE' ||
        (freshSession.metadata.phase === 'BUILD' &&
          (buildCompleteWidgetCanCreate(activePendingWidgetPayload) ||
            isBuildCompleteResumeReady(freshSession))))
    ) {
      log.info('v4 processMessage: create-project widget answer routed to finalizer', {
        sessionId: session.id,
        phase: freshSession.metadata.phase,
        toolCallId: msg.toolCallId,
        pendingWidgetType: (activePendingWidgetPayload?.widgetType as string | undefined) ?? null,
      });
      await deps.finalizeProject(
        ctx,
        freshSession,
        emit,
        close,
        {
          sessionService,
          journalService,
          specDocumentService,
          projectMemoryService,
        },
        timing,
      );
      return;
    }

    if (
      !isInProject &&
      msg.type === 'message' &&
      isManualCreateProjectIntent(rawUserText) &&
      isSessionReadyForManualCreate(freshSession) &&
      (freshSession.metadata.phase === 'CREATE' ||
        buildCompleteWidgetCanCreate(pendingWidgetPayload) ||
        buildCompleteWidgetCanCreate(freshPendingWidgetPayload) ||
        isBuildCompleteResumeReady(freshSession))
    ) {
      log.info('v4 processMessage: manual create-project intent routed to finalizer', {
        sessionId: session.id,
        phase: freshSession.metadata.phase,
        pendingWidgetType:
          (freshPendingWidgetPayload?.widgetType as string | undefined) ??
          (pendingWidgetPayload?.widgetType as string | undefined) ??
          (historyPendingWidgetPayload?.widgetType as string | undefined) ??
          null,
      });
      await deps.finalizeProject(
        ctx,
        freshSession,
        emit,
        close,
        {
          sessionService,
          journalService,
          specDocumentService,
          projectMemoryService,
        },
        timing,
      );
      return;
    }

    const runDeterministicBuild = async (
      buildSession: ArchSession,
      options: { appendCurrentMessage?: boolean; trigger: string },
    ): Promise<void> => {
      const missingAgents = getMissingTopologyAgents(buildSession);
      if (missingAgents.length === 0) {
        log.info('v4 BUILD deterministic path found no missing topology agents', {
          sessionId: session.id,
          trigger: options.trigger,
        });
        await transitionSessionToIdle(
          sessionService,
          ctx,
          session.id,
          'v4_build_no_missing_agents',
        );
        emit({ type: 'done' });
        return;
      }

      const resolution = await deps.resolveModel(ctx.tenantId);
      if (!resolution.model) {
        emit({
          type: 'error',
          code: 'NO_MODEL_CONFIGURED',
          message: resolution.error ?? 'No LLM model is configured for build generation right now.',
          retryable: false,
        });
        await closeAndResetIfActive(
          sessionService,
          ctx,
          session.id,
          close,
          'build_parallel_missing_model',
        );
        return;
      }

      if (options.appendCurrentMessage && msg.type === 'message') {
        await sessionService.appendMessage(ctx, session.id, {
          id: crypto.randomUUID(),
          role: 'user',
          content: userContent ?? rawUserText,
          timestamp: new Date().toISOString(),
          phase: buildSession.metadata.phase,
        });
      }

      const buildRunId = crypto.randomUUID().slice(0, 12);

      log.info('v4 BUILD parallel generation starting', {
        sessionId: session.id,
        buildRunId,
        trigger: options.trigger,
        topologyAgentCount: (getLockedTopology(buildSession)?.agents ?? []).length,
        existingGeneratedCount: Object.keys(
          (buildSession.metadata.files ?? {}) as Record<string, unknown>,
        ).length,
        missingAgentCount: missingAgents.length,
        missingAgents,
      });

      const results = await deps.runParallelGeneration(
        missingAgents,
        ctx,
        buildSession,
        emit,
        resolution.model,
        abortSignal,
        { buildRunId, trigger: options.trigger },
      );

      log.info('v4 BUILD parallel generation completed', {
        sessionId: session.id,
        buildRunId,
        total: results.length,
        compiled: results.filter((result) => result.status === 'compiled').length,
        warnings: results.filter((result) => result.status === 'warning').length,
        errors: results.filter((result) => result.status === 'error').length,
        results: results.map((result) => ({
          agentName: result.agentName,
          status: result.status,
          warningCount: result.warnings.length,
          errorCount: result.errors.length,
          elapsedMs: result.elapsed ?? 0,
        })),
      });

      const summary = deps.buildCompletionSummary(results);
      emit({ type: 'text_delta', delta: `${summary}\n\n` });

      const widgetPayload = deps.buildCompletionWidgetPayload(
        results,
        (buildSession.metadata.specification?.projectName as string | undefined) ?? undefined,
      );
      const toolCallId = `build-complete-${crypto.randomUUID().slice(0, 8)}`;
      const widgetInput = widgetPayload as unknown as Record<string, unknown>;
      emit({ type: 'tool_call', toolCallId, toolName: 'ask_user', input: widgetInput });

      await sessionService.appendMessage(ctx, session.id, {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: summary,
        timestamp: new Date().toISOString(),
        specialist: 'abl-construct-expert',
        toolCalls: [{ toolCallId, toolName: 'ask_user', input: widgetInput }],
        phase: buildSession.metadata.phase,
      });
      await sessionService.setPendingInteraction(ctx, session.id, {
        kind: 'widget',
        id: toolCallId,
        payload: widgetInput,
        createdAt: new Date().toISOString(),
      });

      await transitionSessionToIdle(sessionService, ctx, session.id, 'v4_build_parallel_complete');
      emit({ type: 'done' });
    };

    const emitBlueprintConfirm = async (
      currentSession: ArchSession,
      description?: string | null,
    ): Promise<void> => {
      const summary = getBlueprintContextSummary(currentSession, description);
      await persistBlueprintMetadata(ctx, session.id, {
        'metadata.blueprintStage': 'concept_ready',
        'metadata.topologyApproved': false,
        'metadata.blueprintContextSummary': summary,
      });
      const widgetPayload = buildBlueprintConfirmWidget(summary);
      await persistCoordinatorWidget(
        ctx,
        session.id,
        'BLUEPRINT',
        widgetPayload as unknown as Record<string, unknown>,
        emit,
        {
          specialist: 'multi-agent-architect',
        },
        { sessionService },
      );
      await transitionSessionToIdle(sessionService, ctx, session.id, 'blueprint_confirm_ready');
      emit({ type: 'done' });
    };

    const emitTopologyApproval = async (
      currentSession: ArchSession,
      topology: BlueprintTopology,
      description?: string | null,
    ): Promise<void> => {
      const summary = getBlueprintContextSummary(currentSession, description);
      await persistBlueprintMetadata(ctx, session.id, {
        'metadata.blueprintStage': 'draft_ready',
        'metadata.draftTopology': topology,
        'metadata.topology': topology,
        'metadata.topologyApproved': false,
        'metadata.blueprintContextSummary': summary,
      });
      const widgetPayload = buildTopologyApprovalWidget(topology, summary);
      await persistCoordinatorWidget(
        ctx,
        session.id,
        'BLUEPRINT',
        widgetPayload as unknown as Record<string, unknown>,
        emit,
        {
          specialist: 'multi-agent-architect',
        },
        { sessionService },
      );
      await transitionSessionToIdle(sessionService, ctx, session.id, 'blueprint_draft_ready');
      emit({ type: 'done' });
    };

    const emitTopologyRevision = async (
      currentSession: ArchSession,
      description?: string | null,
    ): Promise<void> => {
      const widgetPayload = buildTopologyRevisionWidget(getDraftTopology(currentSession));
      await persistBlueprintMetadata(ctx, session.id, {
        'metadata.blueprintStage': 'revising',
        'metadata.topologyApproved': false,
      });
      await persistCoordinatorWidget(
        ctx,
        session.id,
        'BLUEPRINT',
        {
          ...widgetPayload,
          description: description ?? widgetPayload.description,
        },
        emit,
        {
          specialist: 'multi-agent-architect',
        },
        { sessionService },
      );
      await transitionSessionToIdle(sessionService, ctx, session.id, 'blueprint_revision_ready');
      emit({ type: 'done' });
    };

    const lockDraftTopology = async (currentSession: ArchSession): Promise<ArchSession | null> => {
      const draftTopology = getDraftTopology(currentSession);
      if (!draftTopology) {
        return null;
      }

      const summary = getBlueprintContextSummary(currentSession);
      await persistBlueprintMetadata(ctx, session.id, {
        'metadata.blueprintStage': 'topology_locked',
        'metadata.draftTopology': draftTopology,
        'metadata.lockedTopology': draftTopology,
        'metadata.topology': draftTopology,
        'metadata.topologyApproved': true,
        'metadata.blueprintContextSummary': summary,
      });

      return (await sessionService.getById(ctx, session.id)) ?? currentSession;
    };

    const runTurn = async (
      turnSession: ArchSession,
      options?: {
        userInput?: string;
        userContentOverride?: typeof userContent;
        restrictAllowedToolNames?: string[];
        excludeAllowedToolNames?: string[];
        llmOptions?: Record<string, unknown>;
        systemPromptAppendix?: string;
        suppressUserMessage?: boolean;
      },
    ): Promise<{ latestSession: ArchSession; turnId: string }> => {
      const { engine, toolRegistry } = await deps.createTurnEngine(ctx.tenantId, {
        generateSuggestions: deps.buildSuggestionGenerator(turnSession),
      });
      const engineMode: 'onboarding' | 'in-project' = isInProject ? 'in-project' : 'onboarding';

      const effectiveUserInput =
        options?.userInput ??
        (msg.type === 'message'
          ? rawUserText
          : msg.type === 'tool_answer'
            ? (collectFileAnswerContext?.llmText ??
              (typeof msg.answer === 'string' ? msg.answer : JSON.stringify(msg.answer ?? '')))
            : msg.type === 'gate_response'
              ? msg.feedback
                ? `[Gate ${msg.action}] ${msg.feedback}`
                : `[Gate ${msg.action}]`
              : msg.type === 'proposal_response'
                ? msg.feedback
                  ? `[Proposal ${msg.action}] ${msg.feedback}`
                  : `[Proposal ${msg.action}]`
                : '');

      const plan = await resolveTurnPlan({
        session: {
          _id: session.id,
          metadata: {
            phase: turnSession.metadata.phase,
            mode: engineMode,
            specification: turnSession.metadata.specification as Record<string, unknown>,
            projectId: turnSession.metadata.projectId,
          },
        },
        userInput: effectiveUserInput,
        pageContext: msg.type === 'message' ? msg.pageContext : undefined,
        specialistOverride:
          engineMode === 'in-project' &&
          (msg.type !== 'message' ||
            (msg.type === 'message' &&
              rawUserText.trim().length === 0 &&
              Array.isArray(fileRefs) &&
              fileRefs.length > 0))
            ? turnSession.metadata.activeSpecialist
            : undefined,
        registry: toolRegistry,
        ...deps.buildTurnPlanLoaders(ctx, turnSession),
      });

      let allowedToolNames = plan.allowedTools.map((tool) => tool.name);
      if (options?.restrictAllowedToolNames) {
        allowedToolNames = allowedToolNames.filter((toolName) =>
          options.restrictAllowedToolNames?.includes(toolName),
        );
      }
      if (options?.excludeAllowedToolNames?.length) {
        allowedToolNames = allowedToolNames.filter(
          (toolName) => !options.excludeAllowedToolNames?.includes(toolName),
        );
      }
      const allowedRegistry = toolRegistry.subset(allowedToolNames);

      const turnId = `turn_${uuidv7()}`;
      const buffer = new TurnBuffer({
        ArchSessions: ArchSessionModel as unknown as import('mongoose').Model<unknown>,
        sessionId: session.id,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        fencingToken: fencingToken ?? Date.now(),
        turnId,
      });
      if (msg.type === 'message') {
        buffer.patchSession({
          'metadata.lastUserPageContext': msg.pageContext ?? null,
        });
      }

      const currentUserContent = options?.userContentOverride ?? userContent;
      const sourceArchitectureContract = await extractTurnSourceArchitectureContract({
        fileStore: fileStoreService,
        ctx,
        sessionId: session.id,
        metadata: turnSession.metadata as unknown as Record<string, unknown>,
      });
      if (sourceArchitectureContract) {
        buffer.patchSession({
          'metadata.sourceArchitectureContract': sourceArchitectureContract,
        });
      }

      const { history, filePreamble } = await prepareTurnHistory({
        session: turnSession,
        fileStore: fileStoreService,
        ctx,
        sessionId: session.id,
        currentPhase: turnSession.metadata.phase,
        excludedBlobIds: collectBlobIdsFromContent(currentUserContent),
        persistHistorySummary: async (historySummary) =>
          persistHistorySummary(ctx, session.id, historySummary),
      });
      const userInputContent = await resolveUserContentForArchLlm({
        userContent: currentUserContent,
        fileStore: fileStoreService,
        ctx,
        sessionId: session.id,
      });

      const services = deps.buildServiceBagForTurn(buffer);
      services.permissions = ctx.permissions;
      services.authToken = authToken;
      services.pageContext = msg.type === 'message' ? msg.pageContext : undefined;

      const sourceContractPrompt =
        sourceArchitectureContract != null
          ? renderSourceArchitectureContractPrompt(sourceArchitectureContract)
          : '';

      const systemPrompt = [
        plan.systemPrompt,
        filePreamble,
        sourceContractPrompt,
        options?.systemPromptAppendix,
      ]
        .filter((section): section is string => typeof section === 'string' && section.length > 0)
        .join('\n\n');

      for await (const event of engine.runTurn({
        sessionId: session.id,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        turnId,
        phase: turnSession.metadata.phase,
        mode: engineMode,
        projectId: turnSession.metadata.projectId,
        history,
        systemPrompt,
        userInput: effectiveUserInput,
        userInputContent,
        userContent: currentUserContent,
        allowedTools: allowedRegistry,
        buffer,
        signal: abortSignal,
        llmOptions: options?.llmOptions,
        specialist: plan.specialist,
        routing: plan.routing,
        services,
        suppressUserMessage: options?.suppressUserMessage,
        onToolCall: (info) => {
          emit({
            type: 'tool_call',
            toolCallId: info.toolCallId,
            toolName: info.toolName,
            input: info.input ?? {},
          } as unknown as ArchSSEEvent);
          emit({
            type: 'tool_result',
            toolCallId: info.toolCallId,
            toolName: info.toolName,
            result: info.result,
            isError: !info.ok,
          } as unknown as ArchSSEEvent);
        },
      })) {
        emitTurnEvent(event);
      }

      return {
        latestSession: (await sessionService.getById(ctx, session.id)) ?? turnSession,
        turnId,
      };
    };

    if (msg.type === 'tool_answer') {
      try {
        await sessionService.setPendingInteraction(ctx, session.id, null);
      } catch (err) {
        log.warn('Failed to clear pending interaction before widget handling (non-fatal)', {
          sessionId: session.id,
          toolCallId: msg.toolCallId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      try {
        if (collectFileAnswerContext) {
          await sessionService.setLastCollectFileContent(ctx, session.id, msg.answer);
        }
        await sessionService.setToolResult(
          ctx,
          session.id,
          msg.toolCallId,
          collectFileAnswerContext?.storedAnswer ?? msg.answer,
        );
      } catch (err) {
        log.warn('Failed to persist widget answer result (non-fatal)', {
          sessionId: session.id,
          toolCallId: msg.toolCallId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const projectName = getProjectNameFromWidgetAnswer({
        payload: activePendingWidgetPayload,
        answer: msg.answer,
        currentProjectName: freshSession.metadata.specification.projectName,
      });
      if (projectName) {
        await persistProjectNameWidgetAnswer(ctx, session.id, projectName, emit, deps);
      }

      freshSession = (await sessionService.getById(ctx, session.id)) ?? freshSession;
    }

    const buildCompleteWidgetPayload =
      activePendingWidgetPayload?.widgetType === 'BuildComplete'
        ? activePendingWidgetPayload
        : undefined;
    const actionPhase = freshSession.metadata.phase ?? session.metadata.phase;

    if (
      msg.type === 'tool_answer' &&
      buildCompleteWidgetPayload &&
      (actionPhase === 'BUILD' || actionPhase === 'CREATE')
    ) {
      const answer = typeof msg.answer === 'string' ? msg.answer : String(msg.answer);
      log.info('v4 BuildComplete action received', {
        sessionId: session.id,
        phase: actionPhase,
        action: answer,
        toolCallId: msg.toolCallId,
      });

      const buildCompleteResolution = await deps.resolveModel(ctx.tenantId);
      const results = deps.extractBuildResultsFromPendingWidgetPayload(buildCompleteWidgetPayload);
      const projectName =
        typeof freshSession.metadata.specification.projectName === 'string'
          ? freshSession.metadata.specification.projectName
          : undefined;
      const actionSession: ArchSession =
        freshSession.metadata.phase === 'CREATE'
          ? {
              ...freshSession,
              metadata: {
                ...freshSession.metadata,
                phase: 'BUILD',
              },
            }
          : freshSession;

      const journalFn = async (
        summary: string,
        rationale: string,
        specialist: string,
        phase: string,
      ) => {
        await journalAppendAndEmit(
          journalService,
          ctx,
          {
            sessionId: session.id,
            type: 'decision',
            content: {
              type: 'decision',
              summary,
              rationale,
              specialist,
              source: 'specialist_recommendation' as const,
            },
            specialist,
            phase,
          },
          emit,
        );
      };

      const buildResult = await deps.handleBuildAction(
        answer,
        ctx,
        actionSession,
        results,
        emit,
        close,
        {
          sessionService,
          journalFn,
          timing,
          createProject: async (actionCtx, actionSessionForCreate, actionEmit, actionClose) => {
            await deps.finalizeProject(
              actionCtx,
              actionSessionForCreate,
              actionEmit,
              actionClose,
              {
                sessionService,
                journalService,
                specDocumentService,
                projectMemoryService,
              },
              timing,
            );
          },
          runParallelGeneration: buildCompleteResolution.model
            ? async (agentNames, actionCtx, actionSessionForBuild, actionEmit) => {
                const buildRunId = crypto.randomUUID().slice(0, 12);
                return deps.runParallelGeneration(
                  agentNames,
                  actionCtx,
                  actionSessionForBuild,
                  actionEmit,
                  buildCompleteResolution.model!,
                  abortSignal,
                  {
                    buildRunId,
                    trigger: `build_complete_${answer}`,
                  },
                );
              }
            : undefined,
        },
        projectName,
      );

      log.info('v4 BuildComplete action handled', {
        sessionId: session.id,
        phase: actionPhase,
        action: answer,
        continueToLLM: buildResult.continueToLLM,
      });

      if (!buildResult.continueToLLM) {
        await appendDeterministicToolAnswerMessage({
          sessionService,
          ctx,
          session,
          toolCallId: msg.toolCallId,
          answer: msg.answer,
          pendingPayload: buildCompleteWidgetPayload,
        });
        return;
      }
    }

    const currentBlueprintStage = !isInProject ? getBlueprintStage(freshSession) : null;
    const hadPendingBlueprintConfirm = hasPendingBlueprintWidget(session, 'BlueprintConfirm');
    const hadPendingTopologyApproval = hasPendingBlueprintWidget(session, 'TopologyApproval');
    const hadPendingTopologyRevision = hasPendingBlueprintWidget(session, 'TopologyRevision');
    const autoGenerateBlueprintDraftAfterInterview =
      !isInProject &&
      freshSession.metadata.phase === 'INTERVIEW' &&
      msg.type === 'tool_answer' &&
      isInterviewDesignProceedAnswer(msg.answer, activePendingWidgetPayload);

    let blueprintTurnMode: 'concept' | 'generate_draft' | 'revise_draft' | null = null;
    let userInputOverride: string | undefined;
    let userContentOverride: typeof userContent | undefined = userContent;
    let restrictAllowedToolNames: string[] | undefined;
    let excludeAllowedToolNames: string[] | undefined;
    let llmOptions: Record<string, unknown> | undefined;
    let systemPromptAppendix: string | undefined;
    const forcedTopologyToolOptions: Record<string, unknown> = {
      toolChoice: { type: 'tool', toolName: 'generate_topology' },
      activeTools: ['generate_topology'],
    };
    const previousPageContext =
      msg.type === 'message' ? freshSession.metadata.lastUserPageContext : undefined;
    const currentPageContext = msg.type === 'message' ? msg.pageContext : undefined;
    const hasPendingPageContextAction =
      freshSession.metadata.pendingInteraction != null ||
      freshSession.metadata.pendingMutation != null;

    if (!isInProject && freshSession.metadata.phase === 'BLUEPRINT') {
      if (msg.type === 'tool_answer' && hadPendingBlueprintConfirm) {
        const answer = normalizeBlueprintConfirmAnswer(msg.answer);
        if (answer === 'generate_draft_topology') {
          blueprintTurnMode = 'generate_draft';
          userInputOverride =
            'Generate the first draft blueprint now. You must call generate_topology exactly once, then explain the architecture clearly.';
          userContentOverride = undefined;
          restrictAllowedToolNames = ['generate_topology'];
          llmOptions = BLUEPRINT_FORCE_PROVIDER_TOOL_ROUTING
            ? forcedTopologyToolOptions
            : undefined;
          systemPromptAppendix =
            'This is a dedicated draft-blueprint generation turn. You must call generate_topology exactly once and you must not ask the user for approval or transition phases yourself.';
          await persistBlueprintMetadata(ctx, session.id, {
            'metadata.blueprintStage': 'draft_generating',
            'metadata.topologyApproved': false,
          });
        } else if (answer === 'refine_concept') {
          blueprintTurnMode = 'concept';
          userInputOverride = buildBlueprintConceptPrompt(getBlueprintContextSummary(freshSession));
          userContentOverride = undefined;
          restrictAllowedToolNames = [];
          systemPromptAppendix =
            'This is a concept-only BLUEPRINT turn. Explain and refine the architecture direction. Do not call generate_topology, ask_user, or proceed_to_next_phase.';
          await persistBlueprintMetadata(ctx, session.id, {
            'metadata.blueprintStage': 'concept_ready',
            'metadata.topologyApproved': false,
          });
        }
      } else if (msg.type === 'tool_answer' && hadPendingTopologyApproval) {
        const approval = normalizeTopologyApprovalAnswer(msg.answer);
        if (approval) {
          await appendDeterministicToolAnswerMessage({
            sessionService,
            ctx,
            session,
            toolCallId: msg.toolCallId,
            answer: msg.answer,
            pendingPayload: pendingWidgetPayload ?? null,
          });
        }
        if (approval?.action === 'accept') {
          const lockedSession = await lockDraftTopology(freshSession);
          if (!lockedSession) {
            await emitBlueprintConfirm(
              freshSession,
              'The current draft could not be locked because no valid topology was found. Please regenerate the draft.',
            );
            return;
          }

          const transitionResult = await deps.executePhaseTransition(
            ctx,
            lockedSession,
            sessionService,
            emit,
            async (summary, rationale, specialist, phase) => {
              await journalAppendAndEmit(
                journalService,
                ctx,
                {
                  sessionId: session.id,
                  type: 'decision',
                  content: {
                    type: 'decision',
                    summary,
                    rationale,
                    specialist,
                    source: 'specialist_recommendation' as const,
                  },
                  specialist,
                  phase,
                },
                emit,
              );
            },
            timing,
          );

          if (!transitionResult.transitioned || transitionResult.to !== 'BUILD') {
            emit({
              type: 'error',
              code: 'BLUEPRINT_ACCEPT_FAILED',
              message:
                transitionResult.error ??
                'Could not lock the blueprint and start the build. Please try again.',
              retryable: true,
            });
            await transitionSessionToIdle(
              sessionService,
              ctx,
              session.id,
              'blueprint_widget_accept_failed',
            );
            return;
          }

          const buildSession = (await sessionService.getById(ctx, session.id)) ?? lockedSession;
          await runDeterministicBuild(buildSession, { trigger: 'v4_topology_widget_accept' });
          return;
        }

        if (approval?.action === 'request_changes') {
          await emitTopologyRevision(
            freshSession,
            approval.notes ?? 'Describe what should change in the draft blueprint.',
          );
          return;
        }

        if (approval?.action === 'reject') {
          await clearRejectedTopologyDraft(ctx, session.id, deps);
          const resetSession = (await sessionService.getById(ctx, session.id)) ?? freshSession;
          await emitBlueprintConfirm(
            resetSession,
            approval.notes ??
              'The previous draft was discarded. Refine the concept or generate a new draft blueprint.',
          );
          return;
        }
      } else if (msg.type === 'tool_answer' && hadPendingTopologyRevision) {
        const revision = normalizeTopologyRevisionAnswer(msg.answer);
        if (revision) {
          blueprintTurnMode = 'revise_draft';
          userInputOverride = buildTopologyRevisionPrompt(revision);
          userContentOverride = undefined;
          restrictAllowedToolNames = ['generate_topology'];
          llmOptions = BLUEPRINT_FORCE_PROVIDER_TOOL_ROUTING
            ? forcedTopologyToolOptions
            : undefined;
          systemPromptAppendix =
            'This is a dedicated draft-blueprint revision turn. You must call generate_topology exactly once using the requested changes, then explain the revised architecture clearly.';
          await persistBlueprintMetadata(ctx, session.id, {
            'metadata.blueprintStage': 'revising',
            'metadata.topologyApproved': false,
          });
        }
      } else if (
        msg.type === 'gate_response' &&
        session.metadata.pendingInteraction?.kind === 'gate'
      ) {
        if (msg.action === 'accept') {
          const lockedSession = await lockDraftTopology(freshSession);
          if (!lockedSession) {
            await emitBlueprintConfirm(
              freshSession,
              'The blueprint approval could not be completed because the draft blueprint is missing.',
            );
            return;
          }
          const transitionResult = await deps.executePhaseTransition(
            ctx,
            lockedSession,
            sessionService,
            emit,
            async (summary, rationale, specialist, phase) => {
              await journalAppendAndEmit(
                journalService,
                ctx,
                {
                  sessionId: session.id,
                  type: 'decision',
                  content: {
                    type: 'decision',
                    summary,
                    rationale,
                    specialist,
                    source: 'specialist_recommendation' as const,
                  },
                  specialist,
                  phase,
                },
                emit,
              );
            },
            timing,
          );

          if (!transitionResult.transitioned || transitionResult.to !== 'BUILD') {
            emit({
              type: 'error',
              code: 'BLUEPRINT_ACCEPT_FAILED',
              message:
                transitionResult.error ??
                'Could not lock the blueprint and start the build. Please try again.',
              retryable: true,
            });
            await transitionSessionToIdle(
              sessionService,
              ctx,
              session.id,
              'blueprint_legacy_gate_accept_failed',
            );
            return;
          }

          const buildSession = (await sessionService.getById(ctx, session.id)) ?? lockedSession;
          await runDeterministicBuild(buildSession, { trigger: 'v4_legacy_topology_gate_accept' });
          return;
        }

        if (msg.action === 'reject') {
          await clearRejectedTopologyDraft(ctx, session.id, deps);
          const resetSession = (await sessionService.getById(ctx, session.id)) ?? freshSession;
          await emitBlueprintConfirm(
            resetSession,
            msg.feedback ??
              'The previous draft was discarded. Refine the concept or generate a new draft blueprint.',
          );
          return;
        }

        if (msg.feedback?.trim()) {
          blueprintTurnMode = 'revise_draft';
          userInputOverride = buildTopologyRevisionPrompt({
            targets: ['agents', 'responsibilities', 'handoffs', 'pattern'],
            notes: msg.feedback.trim(),
          });
          userContentOverride = undefined;
          restrictAllowedToolNames = ['generate_topology'];
          llmOptions = BLUEPRINT_FORCE_PROVIDER_TOOL_ROUTING
            ? forcedTopologyToolOptions
            : undefined;
          systemPromptAppendix =
            'This is a dedicated draft-blueprint revision turn. You must call generate_topology exactly once using the requested changes, then explain the revised architecture clearly.';
          await persistBlueprintMetadata(ctx, session.id, {
            'metadata.blueprintStage': 'revising',
            'metadata.topologyApproved': false,
          });
        } else {
          await emitTopologyRevision(
            freshSession,
            'The legacy approval flow requested modifications. Describe the blueprint changes and regenerate the draft.',
          );
          return;
        }
      } else if (msg.type === 'message') {
        if (
          hadPendingTopologyApproval ||
          (currentBlueprintStage === 'draft_ready' && getDraftTopology(freshSession))
        ) {
          blueprintTurnMode = 'revise_draft';
          userInputOverride = buildTopologyRevisionPrompt({
            targets: ['agents', 'responsibilities', 'handoffs', 'pattern'],
            notes: plannedUserInput ?? rawUserText,
          });
          userContentOverride = undefined;
          restrictAllowedToolNames = ['generate_topology'];
          llmOptions = BLUEPRINT_FORCE_PROVIDER_TOOL_ROUTING
            ? forcedTopologyToolOptions
            : undefined;
          systemPromptAppendix =
            'This is a dedicated draft-topology revision turn. You must call generate_topology exactly once using the requested changes, then explain the revised architecture clearly.';
          await persistBlueprintMetadata(ctx, session.id, {
            'metadata.blueprintStage': 'revising',
            'metadata.topologyApproved': false,
          });
        } else if (
          hadPendingBlueprintConfirm ||
          currentBlueprintStage === 'concept_ready' ||
          (currentBlueprintStage === 'revising' && !getDraftTopology(freshSession))
        ) {
          blueprintTurnMode = 'concept';
          excludeAllowedToolNames = ['generate_topology', 'ask_user', 'proceed_to_next_phase'];
          systemPromptAppendix =
            'This is a concept-only BLUEPRINT turn. Explain and refine the architecture direction. Do not call generate_topology, ask_user, or proceed_to_next_phase.';
          await persistBlueprintMetadata(ctx, session.id, {
            'metadata.blueprintStage': 'concept_ready',
            'metadata.topologyApproved': false,
          });
        }
      }
    }

    if (
      msg.type === 'message' &&
      shouldClarifyPageContextIntent({
        text: rawUserText,
        previousPageContext,
        currentPageContext,
        hasPendingAction: hasPendingPageContextAction,
      })
    ) {
      restrictAllowedToolNames = ['ask_user'];
      excludeAllowedToolNames = undefined;
      systemPromptAppendix = [
        systemPromptAppendix,
        buildPageContextClarificationAppendix({
          previousPageContext,
          currentPageContext,
          hasPendingAction: hasPendingPageContextAction,
        }),
      ]
        .filter((section): section is string => typeof section === 'string' && section.length > 0)
        .join('\n\n');
    }

    if (
      freshSession.metadata.phase === 'BUILD' &&
      !isInProject &&
      !(restrictAllowedToolNames?.length === 1 && restrictAllowedToolNames[0] === 'ask_user')
    ) {
      if (getMissingTopologyAgents(freshSession).length > 0) {
        await runDeterministicBuild(freshSession, {
          appendCurrentMessage: msg.type === 'message',
          trigger: 'v4_initial_missing_agents',
        });
        return;
      }
    }

    let latestSession: ArchSession;
    let lastTurnId: string | null = null;

    const firstTurn = await runTurn(freshSession, {
      userInput: userInputOverride,
      userContentOverride,
      restrictAllowedToolNames,
      excludeAllowedToolNames,
      llmOptions,
      systemPromptAppendix,
      suppressUserMessage: msg.type === 'tool_answer',
    });
    latestSession = firstTurn.latestSession;
    lastTurnId = firstTurn.turnId;

    if (
      autoGenerateBlueprintDraftAfterInterview &&
      latestSession.metadata.phase === 'BLUEPRINT' &&
      latestSession.metadata.pendingInteraction == null &&
      !getDraftTopology(latestSession)
    ) {
      blueprintTurnMode = 'generate_draft';
      await persistBlueprintMetadata(ctx, session.id, {
        'metadata.blueprintStage': 'draft_generating',
        'metadata.topologyApproved': false,
      });
      const draftTurn = await runTurn(latestSession, {
        userInput:
          'Generate the first draft blueprint now. The user already chose to design the architecture, so do not ask for another confirmation. You must call generate_topology exactly once, then explain the architecture clearly.',
        userContentOverride: undefined,
        restrictAllowedToolNames: ['generate_topology'],
        llmOptions: BLUEPRINT_FORCE_PROVIDER_TOOL_ROUTING ? forcedTopologyToolOptions : undefined,
        systemPromptAppendix:
          'This is an automatic draft-blueprint generation turn after the user selected Design the architecture. You must call generate_topology exactly once and you must not ask the user for another confirmation or transition phases yourself.',
      });
      latestSession = draftTurn.latestSession;
      lastTurnId = draftTurn.turnId;
    }

    if (
      !isInProject &&
      latestSession.metadata.phase === 'BLUEPRINT' &&
      (blueprintTurnMode === 'generate_draft' || blueprintTurnMode === 'revise_draft') &&
      !getDraftTopology(latestSession)
    ) {
      const retryTurn = await runTurn(latestSession, {
        userInput: `${userInputOverride ?? 'Generate the draft blueprint now.'}\n\nIMPORTANT: You did not produce a valid topology on the first attempt. You must call generate_topology exactly once before responding.`,
        userContentOverride: undefined,
        restrictAllowedToolNames: ['generate_topology'],
        llmOptions: BLUEPRINT_FORCE_PROVIDER_TOOL_ROUTING ? forcedTopologyToolOptions : undefined,
        systemPromptAppendix:
          'Retry mode: you must produce a valid topology with generate_topology exactly once before responding. Do not ask for approval or transition phases yourself.',
      });
      latestSession = retryTurn.latestSession;
      lastTurnId = retryTurn.turnId;
    }

    if (
      !isInProject &&
      latestSession.metadata.phase === 'BLUEPRINT' &&
      latestSession.metadata.pendingInteraction == null
    ) {
      const latestDraftTopology =
        getDraftTopology(latestSession) ?? getEffectiveTopology(latestSession);
      if (latestDraftTopology) {
        await emitTopologyApproval(latestSession, latestDraftTopology);
        return;
      }

      if (blueprintTurnMode === 'generate_draft') {
        if (BLUEPRINT_USE_SYNTHETIC_DRAFT_FALLBACK) {
          const fallbackDraft = synthesizeDeterministicBlueprintDraft(
            latestSession.metadata.specification,
            getSourceArchitectureContractFromMetadata(
              latestSession.metadata as unknown as Record<string, unknown>,
            ),
          );
          log.warn(
            'BLUEPRINT draft generation returned no topology; using deterministic fallback',
            {
              sessionId: session.id,
              projectName: latestSession.metadata.specification.projectName,
              pattern: fallbackDraft.patternName,
            },
          );
          await emitTopologyApproval(latestSession, fallbackDraft.topology, fallbackDraft.summary);
          return;
        }

        await emitBlueprintConfirm(
          latestSession,
          'I could not produce a valid draft blueprint on that attempt. Refine the concept or retry draft generation.',
        );
        return;
      }

      if (blueprintTurnMode === 'revise_draft') {
        await emitTopologyRevision(
          latestSession,
          'I could not regenerate a valid blueprint from that revision request. Adjust the revision and try again.',
        );
        return;
      }

      await emitBlueprintConfirm(latestSession);
      return;
    }

    log.info('v4 processMessage complete', {
      sessionId: session.id,
      phase: latestSession.metadata.phase,
      turnId: lastTurnId,
      blueprintStage: !isInProject ? getBlueprintStage(latestSession) : null,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('v4 processMessage failed', {
      sessionId: session.id,
      phase: session.metadata.phase,
      msgType: msg.type,
      error: message,
    });
    // Surface model configuration errors directly — these carry user-facing messages
    // from the resolution pipeline that tell the user what to fix.
    const isModelConfigError = (err as { code?: string } | null)?.code === 'MODEL_CONFIG_ERROR';
    const userMessage = isModelConfigError
      ? message
      : 'An unexpected error occurred. Please try again.';
    emit({
      type: 'error',
      code: isModelConfigError ? 'MODEL_CONFIG_ERROR' : 'STREAM_ERROR',
      message: userMessage,
      retryable: !isModelConfigError,
    });
    await transitionSessionToIdle(sessionService, ctx, session.id, 'v4_process_message_failed');
  } finally {
    // Always close the SSE stream. The route's stream-observer wraps close()
    // with an idempotency guard, so double-close is safe.
    close();
  }
}
