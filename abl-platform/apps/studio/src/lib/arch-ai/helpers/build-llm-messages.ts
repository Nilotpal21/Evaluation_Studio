import { createLogger } from '@abl/compiler/platform/logger.js';
import {
  extractContentBlocks,
  isArchContentBlockArray,
  isClientSideTool,
  normalizeContent,
  type ArchContentBlock,
  type ArchSession,
  type HistorySummary,
  type HistorySummaryCapturedAnswer,
  type HistorySummaryDecision,
  type HistorySummaryOpenThread,
  type HistorySummarySpecSnapshot,
  type HistorySummaryToolOutcome,
  type PendingMutation,
  type PendingPlan,
  type ProviderContentBlock,
  type StoredMessage,
  type StoredToolCall,
} from '@agent-platform/arch-ai';
import {
  buildFilePreamble,
  resolveContentBlocks,
  type ContextCapabilities,
} from '@agent-platform/arch-ai/executor';
import type { ArchFileStore, SessionContext } from '@agent-platform/arch-ai/session';
import type { LLMMessage } from '@agent-platform/arch-ai/engine';

export interface ArchLLMMessage {
  role: LLMMessage['role'];
  content: string | ProviderContentBlock[];
  toolCallId?: string;
  toolName?: string;
}

const DEFAULT_CONTEXT_CAPABILITIES: ContextCapabilities = {
  contextWindow: 128_000,
  supportsVision: false,
};

const log = createLogger('lib:arch-ai:helpers:build-llm-messages');

const RAW_HISTORY_MESSAGE_LIMIT = 12;
const RAW_HISTORY_REFRESH_MESSAGE_THRESHOLD = 24;
const RAW_HISTORY_UNSUMMARIZED_TAIL_LIMIT = 12;
const RAW_HISTORY_CHAR_REFRESH_THRESHOLD = 24_000;
const RAW_TOOL_OUTCOME_LIMIT = 3;
const HISTORY_SUMMARY_VERSION = 1;
const MAX_HISTORY_SUMMARY_ANSWERS = 12;
const MAX_HISTORY_SUMMARY_DECISIONS = 8;
const MAX_HISTORY_SUMMARY_TOOL_OUTCOMES = 12;
const MAX_HISTORY_SUMMARY_OPEN_THREADS = 8;
const MAX_TOOL_CONTEXT_CHARS = 320;
const MAX_DECISION_CHARS = 260;
const MAX_OPEN_THREAD_CHARS = 220;
const MAX_PENDING_MUTATION_SUMMARY_CHARS = 240;
const MAX_PENDING_PLAN_SUMMARY_CHARS = 360;

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 1)}…`;
}

function summarizeUnknownValue(value: unknown, maxChars: number): string {
  if (value == null) {
    return 'null';
  }

  if (typeof value === 'string') {
    return truncateText(value, maxChars);
  }

  try {
    const serialized = JSON.stringify(value);
    return truncateText(typeof serialized === 'string' ? serialized : String(value), maxChars);
  } catch {
    return truncateText(String(value), maxChars);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectBlobIdsFromBlocks(blocks?: ArchContentBlock[]): Set<string> {
  const blobIds = new Set<string>();

  if (!Array.isArray(blocks)) {
    return blobIds;
  }

  for (const block of blocks) {
    if (
      (block.type === 'file_ref' || block.type === 'image_ref') &&
      typeof block.blobId === 'string' &&
      block.blobId.length > 0
    ) {
      blobIds.add(block.blobId);
    }
  }

  return blobIds;
}

function extractToolPrompt(input: Record<string, unknown>): string | null {
  const candidates = [input.question, input.prompt, input.message, input.label, input.field].filter(
    (candidate): candidate is string =>
      typeof candidate === 'string' && candidate.trim().length > 0,
  );

  if (candidates.length > 0) {
    return candidates[0]!.trim();
  }

  if (typeof input.widgetType === 'string' && input.widgetType.length > 0) {
    return `${input.widgetType} response`;
  }

  return null;
}

function buildAssistantToolSections(toolCalls?: StoredToolCall[]): string[] {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return [];
  }

  const clientPrompts: string[] = [];
  const clientAnswers: string[] = [];
  const toolOutcomes: string[] = [];

  for (const toolCall of toolCalls) {
    const prompt = extractToolPrompt(toolCall.input);
    if (isClientSideTool(toolCall.toolName)) {
      if (prompt) {
        clientPrompts.push(`- ${prompt}`);
      }
      if (typeof toolCall.result !== 'undefined') {
        clientAnswers.push(
          `- ${prompt ?? toolCall.toolName}: ${summarizeUnknownValue(
            toolCall.result,
            MAX_TOOL_CONTEXT_CHARS,
          )}`,
        );
      }
      continue;
    }

    if (typeof toolCall.result !== 'undefined') {
      toolOutcomes.push(
        `- ${toolCall.toolName}: ${summarizeToolOutcomeValue(
          toolCall.result,
          MAX_TOOL_CONTEXT_CHARS,
        )}`,
      );
    }
  }

  const sections: string[] = [];
  if (clientPrompts.length > 0) {
    sections.push(`Interactive prompts:\n${clientPrompts.join('\n')}`);
  }
  if (clientAnswers.length > 0) {
    sections.push(`Recorded answers:\n${clientAnswers.join('\n')}`);
  }
  if (toolOutcomes.length > 0) {
    sections.push(`Tool outcomes:\n${toolOutcomes.join('\n')}`);
  }

  return sections;
}

export async function buildArchLLMMessages(params: {
  storedMessages: StoredMessage[];
  fileStore: ArchFileStore;
  ctx: SessionContext;
  sessionId: string;
  capabilities: ContextCapabilities;
}): Promise<ArchLLMMessage[]> {
  const { storedMessages, fileStore, ctx, sessionId, capabilities } = params;
  const result: ArchLLMMessage[] = [];

  for (const message of storedMessages) {
    if (message.role === 'user') {
      if (isArchContentBlockArray(message.content)) {
        const resolved = await resolveContentBlocks(
          message.content,
          fileStore,
          ctx,
          sessionId,
          capabilities,
        );
        result.push({
          role: 'user',
          content: resolved.length > 0 ? resolved : normalizeContent(message.content),
        });
      } else {
        result.push({
          role: 'user',
          content: normalizeContent(message.content),
        });
      }
      continue;
    }

    const assistantSections = [
      normalizeContent(message.content),
      ...buildAssistantToolSections(message.toolCalls),
    ].filter((section): section is string => section.trim().length > 0);

    if (assistantSections.length > 0) {
      result.push({
        role: 'assistant',
        content: assistantSections.join('\n\n'),
      });
    }
  }

  return result;
}

export function collectReferencedBlobIds(storedMessages: StoredMessage[]): Set<string> {
  const blobIds = new Set<string>();

  for (const message of storedMessages) {
    if (!isArchContentBlockArray(message.content)) {
      continue;
    }

    for (const block of message.content) {
      if (
        (block.type === 'file_ref' || block.type === 'image_ref') &&
        typeof block.blobId === 'string' &&
        block.blobId.length > 0
      ) {
        blobIds.add(block.blobId);
      }
    }
  }

  return blobIds;
}

export async function buildArchTurnContext(params: {
  storedMessages: StoredMessage[];
  fileStore: ArchFileStore;
  ctx: SessionContext;
  sessionId: string;
  capabilities?: ContextCapabilities;
  excludedBlobIds?: Iterable<string>;
}): Promise<{ history: LLMMessage[]; filePreamble: string; carriedBlobIds: string[] }> {
  const {
    storedMessages,
    fileStore,
    ctx,
    sessionId,
    capabilities = DEFAULT_CONTEXT_CAPABILITIES,
    excludedBlobIds,
  } = params;

  const history = (await buildArchLLMMessages({
    storedMessages,
    fileStore,
    ctx,
    sessionId,
    capabilities,
  })) as LLMMessage[];

  const referencedBlobIds = collectReferencedBlobIds(storedMessages);
  for (const blobId of excludedBlobIds ?? []) {
    referencedBlobIds.add(blobId);
  }

  try {
    const activeFiles = await fileStore.getActiveFiles(ctx, sessionId);
    const carryForwardFiles = activeFiles.filter((file) => !referencedBlobIds.has(file._id));
    const { preamble } = buildFilePreamble(carryForwardFiles, capabilities);

    return {
      history,
      filePreamble: preamble,
      carriedBlobIds: carryForwardFiles.map((file) => file._id),
    };
  } catch (err) {
    log.warn('failed to load active files for carry-forward preamble', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });

    return {
      history,
      filePreamble: '',
      carriedBlobIds: [],
    };
  }
}

function takeNewestUnique<T>(items: T[], keyFor: (item: T) => string, limit: number): T[] {
  const selected: T[] = [];
  const seen = new Set<string>();

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    const key = keyFor(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    selected.push(item);
    if (selected.length >= limit) {
      break;
    }
  }

  return selected.reverse();
}

function estimateStoredMessageSize(message: StoredMessage): number {
  let size = normalizeContent(message.content).length;

  if (Array.isArray(message.toolCalls)) {
    for (const toolCall of message.toolCalls) {
      size += toolCall.toolName.length;
      size += summarizeUnknownValue(toolCall.input, 400).length;
      if (typeof toolCall.result !== 'undefined') {
        size += (
          isClientSideTool(toolCall.toolName)
            ? summarizeUnknownValue(toolCall.result, 400)
            : summarizeToolOutcomeValue(toolCall.result, 400)
        ).length;
      }
    }
  }

  return size;
}

function getUnsummarizedMessages(
  storedMessages: StoredMessage[],
  compactedThroughMessageId: string | null | undefined,
): StoredMessage[] {
  if (!compactedThroughMessageId) {
    return storedMessages;
  }

  const compactedIndex = storedMessages.findIndex(
    (message) => message.id === compactedThroughMessageId,
  );
  if (compactedIndex < 0) {
    return storedMessages;
  }

  return storedMessages.slice(compactedIndex + 1);
}

function collectNewestToolOutcomeMessageIds(storedMessages: StoredMessage[]): Set<string> {
  const selectedMessageIds = new Set<string>();
  let collectedOutcomeCount = 0;

  for (let messageIndex = storedMessages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = storedMessages[messageIndex]!;
    const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];

    for (let toolIndex = toolCalls.length - 1; toolIndex >= 0; toolIndex -= 1) {
      const toolCall = toolCalls[toolIndex]!;
      if (isClientSideTool(toolCall.toolName) || typeof toolCall.result === 'undefined') {
        continue;
      }

      selectedMessageIds.add(message.id);
      collectedOutcomeCount += 1;
      if (collectedOutcomeCount >= RAW_TOOL_OUTCOME_LIMIT) {
        return selectedMessageIds;
      }
    }
  }

  return selectedMessageIds;
}

function pinMessageWithLeadingUser(
  selectedMessageIds: Set<string>,
  storedMessages: StoredMessage[],
  messageIndex: number,
): void {
  const message = storedMessages[messageIndex];
  if (!message) {
    return;
  }

  selectedMessageIds.add(message.id);

  for (let index = messageIndex - 1; index >= 0; index -= 1) {
    const previousMessage = storedMessages[index];
    if (!previousMessage) {
      continue;
    }

    if (previousMessage.role === 'user') {
      selectedMessageIds.add(previousMessage.id);
      break;
    }

    if (normalizeContent(previousMessage.content).trim().length > 0) {
      break;
    }
  }
}

function collectPendingMutationMessageIds(
  session: ArchSession,
  storedMessages: StoredMessage[],
): Set<string> {
  const selectedMessageIds = new Set<string>();
  if (!session.metadata.pendingMutation) {
    return selectedMessageIds;
  }

  for (let messageIndex = storedMessages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = storedMessages[messageIndex];
    if (!message || !Array.isArray(message.toolCalls)) {
      continue;
    }

    const hasConfirmationPrompt = message.toolCalls.some(
      (toolCall) =>
        toolCall.toolName === 'ask_user' &&
        isRecord(toolCall.input) &&
        toolCall.input.widgetType === 'Confirmation',
    );

    if (!hasConfirmationPrompt) {
      continue;
    }

    pinMessageWithLeadingUser(selectedMessageIds, storedMessages, messageIndex);
    break;
  }

  return selectedMessageIds;
}

function selectRawMessagesForContext(session: ArchSession): StoredMessage[] {
  const storedMessages = Array.isArray(session.metadata.messages) ? session.metadata.messages : [];
  const rawIds = new Set(
    storedMessages.slice(-RAW_HISTORY_MESSAGE_LIMIT).map((message) => message.id),
  );

  for (const messageId of collectNewestToolOutcomeMessageIds(storedMessages)) {
    rawIds.add(messageId);
  }

  for (const messageId of collectPendingMutationMessageIds(session, storedMessages)) {
    rawIds.add(messageId);
  }

  const pendingToolCallId = session.metadata.pendingInteraction?.id;
  if (typeof pendingToolCallId === 'string' && pendingToolCallId.length > 0) {
    const pendingMessage = storedMessages.find((message) =>
      Array.isArray(message.toolCalls)
        ? message.toolCalls.some((toolCall) => toolCall.toolCallId === pendingToolCallId)
        : false,
    );
    if (pendingMessage) {
      rawIds.add(pendingMessage.id);
    }
  }

  return storedMessages.filter((message) => rawIds.has(message.id));
}

function buildSpecSnapshot(session: ArchSession): HistorySummarySpecSnapshot {
  const specification = session.metadata.specification;
  return {
    projectName:
      typeof specification.projectName === 'string' && specification.projectName.trim().length > 0
        ? specification.projectName.trim()
        : undefined,
    description:
      typeof specification.description === 'string' && specification.description.trim().length > 0
        ? truncateText(specification.description.trim(), 240)
        : undefined,
    channels: Array.isArray(specification.channels)
      ? specification.channels.filter(
          (channel): channel is string => typeof channel === 'string' && channel.length > 0,
        )
      : undefined,
    language:
      typeof specification.language === 'string' && specification.language.trim().length > 0
        ? specification.language.trim()
        : undefined,
  };
}

function isLikelyShortAnswer(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized.length <= 20 &&
    ['yes', 'no', 'true', 'false', 'accept', 'reject', 'modify', 'retry', 'continue'].includes(
      normalized,
    )
  );
}

function buildHistorySummary(
  session: ArchSession,
  compactedMessages: StoredMessage[],
  currentPhase: ArchSession['metadata']['phase'],
): HistorySummary | null {
  if (compactedMessages.length === 0) {
    return null;
  }

  const phase = currentPhase;
  const capturedAnswers: HistorySummaryCapturedAnswer[] = [];
  const decisions: HistorySummaryDecision[] = [];
  const toolOutcomes: HistorySummaryToolOutcome[] = [];
  const openThreads: HistorySummaryOpenThread[] = [];

  for (const message of compactedMessages) {
    const messagePhase = message.phase as ArchSession['metadata']['phase'];
    const messageText = normalizeContent(message.content).trim();

    if (Array.isArray(message.toolCalls)) {
      for (const toolCall of message.toolCalls) {
        const prompt = extractToolPrompt(toolCall.input) ?? toolCall.toolName;
        if (isClientSideTool(toolCall.toolName)) {
          if (typeof toolCall.result !== 'undefined') {
            capturedAnswers.push({
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              prompt,
              answer: summarizeUnknownValue(toolCall.result, MAX_TOOL_CONTEXT_CHARS),
              phase: messagePhase,
              timestamp: message.timestamp,
            });
          }
          continue;
        }

        if (typeof toolCall.result !== 'undefined') {
          toolOutcomes.push({
            messageId: message.id,
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            summary: summarizeToolOutcomeValue(toolCall.result, MAX_TOOL_CONTEXT_CHARS),
            phase: messagePhase,
            timestamp: message.timestamp,
          });
        }
      }
    }

    if (message.role === 'assistant' && messageText.length > 0) {
      decisions.push({
        messageId: message.id,
        summary: truncateText(messageText, MAX_DECISION_CHARS),
        phase: messagePhase,
        timestamp: message.timestamp,
      });
      continue;
    }

    if (
      message.role === 'user' &&
      messageText.length > 0 &&
      !isLikelyShortAnswer(messageText) &&
      message.messageMetadata?.source !== 'deterministic_tool_answer'
    ) {
      openThreads.push({
        messageId: message.id,
        summary: truncateText(messageText, MAX_OPEN_THREAD_CHARS),
        phase: messagePhase,
        timestamp: message.timestamp,
      });
    }
  }

  return {
    version: HISTORY_SUMMARY_VERSION,
    compactedThroughMessageId: compactedMessages[compactedMessages.length - 1]?.id ?? null,
    phase,
    updatedAt: new Date().toISOString(),
    specSnapshot: buildSpecSnapshot(session),
    capturedAnswers: takeNewestUnique(
      capturedAnswers,
      (item) => `${item.toolName}:${item.prompt}`,
      MAX_HISTORY_SUMMARY_ANSWERS,
    ),
    decisions: takeNewestUnique(decisions, (item) => item.messageId, MAX_HISTORY_SUMMARY_DECISIONS),
    toolOutcomes: takeNewestUnique(
      toolOutcomes,
      (item) => item.toolCallId,
      MAX_HISTORY_SUMMARY_TOOL_OUTCOMES,
    ),
    openThreads: takeNewestUnique(
      openThreads,
      (item) => item.messageId,
      MAX_HISTORY_SUMMARY_OPEN_THREADS,
    ),
  };
}

function renderHistorySummary(summary: HistorySummary | null | undefined): string | null {
  if (!summary) {
    return null;
  }

  const sections: string[] = ['Earlier conversation summary (older turns):'];
  const specLines: string[] = [];

  if (summary.specSnapshot.projectName) {
    specLines.push(`- Project name: ${summary.specSnapshot.projectName}`);
  }
  if (summary.specSnapshot.description) {
    specLines.push(`- Description: ${summary.specSnapshot.description}`);
  }
  if (Array.isArray(summary.specSnapshot.channels) && summary.specSnapshot.channels.length > 0) {
    specLines.push(`- Channels: ${summary.specSnapshot.channels.join(', ')}`);
  }
  if (summary.specSnapshot.language) {
    specLines.push(`- Language: ${summary.specSnapshot.language}`);
  }
  if (specLines.length > 0) {
    sections.push(`Specification snapshot:\n${specLines.join('\n')}`);
  }

  if (summary.capturedAnswers.length > 0) {
    sections.push(
      `Captured answers:\n${summary.capturedAnswers
        .map((answer) => `- ${answer.prompt}: ${answer.answer}`)
        .join('\n')}`,
    );
  }

  if (summary.decisions.length > 0) {
    sections.push(
      `Prior assistant context:\n${summary.decisions
        .map((decision) => `- ${decision.summary}`)
        .join('\n')}`,
    );
  }

  if (summary.toolOutcomes.length > 0) {
    sections.push(
      `Completed tool outcomes:\n${summary.toolOutcomes
        .map((outcome) => `- ${outcome.toolName}: ${outcome.summary}`)
        .join('\n')}`,
    );
  }

  if (summary.openThreads.length > 0) {
    sections.push(
      `Older user requests to remember:\n${summary.openThreads
        .map((thread) => `- ${thread.summary}`)
        .join('\n')}`,
    );
  }

  return sections.join('\n\n');
}

function summarizeToolOutcomeValue(value: unknown, maxChars: number): string {
  if (isRecord(value) && typeof value.summary === 'string' && value.summary.trim().length > 0) {
    return truncateText(value.summary.trim(), maxChars);
  }

  return summarizeUnknownValue(value, maxChars);
}

function renderPendingMutationContext(
  pendingMutation: PendingMutation | null | undefined,
): string | null {
  if (!pendingMutation) {
    return null;
  }

  const lines = ['Pending mutation awaiting review:'];
  const target =
    typeof pendingMutation.target === 'string' && pendingMutation.target.trim().length > 0
      ? pendingMutation.target.trim()
      : 'unknown target';
  const reviewStatus = pendingMutation.reviewStatus ?? 'pending';
  const scope =
    typeof pendingMutation.scope === 'string' && pendingMutation.scope.trim().length > 0
      ? pendingMutation.scope.trim()
      : null;
  const changeSummary =
    typeof pendingMutation.changeSummary === 'string' &&
    pendingMutation.changeSummary.trim().length > 0
      ? truncateText(pendingMutation.changeSummary.trim(), MAX_PENDING_MUTATION_SUMMARY_CHARS)
      : null;
  const proposedResult =
    !changeSummary &&
    typeof pendingMutation.after === 'string' &&
    pendingMutation.after.trim().length > 0
      ? truncateText(pendingMutation.after.trim(), MAX_PENDING_MUTATION_SUMMARY_CHARS)
      : null;

  lines.push(
    `- Proposal: ${pendingMutation.isNew === true ? 'create' : 'update'} ${target}`,
    `- Review status: ${reviewStatus}`,
  );

  if (scope) {
    lines.push(`- Scope: ${scope}`);
  }

  if (changeSummary) {
    lines.push(`- Requested change: ${changeSummary}`);
  } else if (proposedResult) {
    lines.push(`- Proposed result: ${proposedResult}`);
  }

  return lines.join('\n');
}

function renderPendingPlanContext(pendingPlan: PendingPlan | null | undefined): string | null {
  if (!pendingPlan) {
    return null;
  }

  const lines = ['Current in-project plan review state:'];
  lines.push(`- Plan: ${pendingPlan.title}`);
  lines.push(`- Status: ${pendingPlan.status}`);

  if (pendingPlan.summary?.trim()) {
    lines.push(
      `- Summary: ${truncateText(pendingPlan.summary.trim(), MAX_PENDING_PLAN_SUMMARY_CHARS)}`,
    );
  }

  if (pendingPlan.goal?.trim()) {
    lines.push(`- Goal: ${truncateText(pendingPlan.goal.trim(), MAX_PENDING_PLAN_SUMMARY_CHARS)}`);
  }

  if (Array.isArray(pendingPlan.affectedAgents) && pendingPlan.affectedAgents.length > 0) {
    lines.push(`- Affected agents: ${pendingPlan.affectedAgents.join(', ')}`);
  }

  if (Array.isArray(pendingPlan.plannedMutations) && pendingPlan.plannedMutations.length > 0) {
    const mutationSummaries = pendingPlan.plannedMutations.slice(0, 5).map((mutation) => {
      const target = mutation.agentName ?? mutation.targetId ?? mutation.targetKind;
      return `${mutation.operation} ${target} via ${mutation.sourceTool}.${mutation.sourceAction}`;
    });
    lines.push(`- Planned mutations: ${mutationSummaries.join('; ')}`);
  }

  if (pendingPlan.status === 'proposed') {
    lines.push(
      '- User can approve, refine, or cancel this plan. Do not perform project mutations until approved.',
    );
  } else if (pendingPlan.status === 'approved') {
    lines.push(
      '- This plan is approved. Continue by drafting or proposing only the changes covered by the approved plan.',
    );
  } else if (pendingPlan.status === 'refining') {
    lines.push('- User asked to refine this plan before any implementation proposal.');
  }

  return lines.join('\n');
}

function shouldRefreshHistorySummary(params: {
  session: ArchSession;
  existingSummary: HistorySummary | null;
  compactedMessages: StoredMessage[];
  currentPhase: ArchSession['metadata']['phase'];
}): boolean {
  const { session, existingSummary, compactedMessages, currentPhase } = params;

  if (compactedMessages.length === 0) {
    return Boolean(existingSummary && existingSummary.phase !== currentPhase);
  }

  const unsummarizedMessages = getUnsummarizedMessages(
    session.metadata.messages ?? [],
    existingSummary?.compactedThroughMessageId,
  );
  const estimatedRawChars = unsummarizedMessages.reduce(
    (total, message) => total + estimateStoredMessageSize(message),
    0,
  );

  return (
    unsummarizedMessages.length > RAW_HISTORY_REFRESH_MESSAGE_THRESHOLD ||
    estimatedRawChars > RAW_HISTORY_CHAR_REFRESH_THRESHOLD ||
    unsummarizedMessages.length > RAW_HISTORY_UNSUMMARIZED_TAIL_LIMIT ||
    existingSummary?.phase !== currentPhase
  );
}

function areSummariesEqual(
  left: HistorySummary | null | undefined,
  right: HistorySummary | null | undefined,
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export async function prepareTurnHistory(params: {
  session: ArchSession;
  fileStore: ArchFileStore;
  ctx: SessionContext;
  sessionId: string;
  capabilities?: ContextCapabilities;
  excludedBlobIds?: Iterable<string>;
  currentPhase?: ArchSession['metadata']['phase'];
  persistHistorySummary?: (historySummary: HistorySummary | null) => Promise<void>;
}): Promise<{
  history: LLMMessage[];
  filePreamble: string;
  carriedBlobIds: string[];
  historySummary: HistorySummary | null;
}> {
  const {
    session,
    fileStore,
    ctx,
    sessionId,
    capabilities = DEFAULT_CONTEXT_CAPABILITIES,
    excludedBlobIds,
    currentPhase = session.metadata.phase,
    persistHistorySummary,
  } = params;

  const storedMessages = Array.isArray(session.metadata.messages) ? session.metadata.messages : [];
  const rawMessages = selectRawMessagesForContext(session);
  const rawMessageIds = new Set(rawMessages.map((message) => message.id));
  const compactedMessages = storedMessages.filter((message) => !rawMessageIds.has(message.id));
  const existingSummary = session.metadata.historySummary ?? null;

  let historySummary = existingSummary;

  if (shouldRefreshHistorySummary({ session, existingSummary, compactedMessages, currentPhase })) {
    const nextSummary =
      compactedMessages.length > 0
        ? buildHistorySummary(session, compactedMessages, currentPhase)
        : existingSummary
          ? {
              ...existingSummary,
              phase: currentPhase,
              updatedAt: new Date().toISOString(),
              specSnapshot: buildSpecSnapshot(session),
            }
          : null;

    if (!areSummariesEqual(existingSummary, nextSummary)) {
      historySummary = nextSummary;
      try {
        await persistHistorySummary?.(nextSummary);
      } catch (err) {
        log.warn('failed to persist history summary; continuing turn with in-memory summary', {
          sessionId,
          phase: currentPhase,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      historySummary = nextSummary;
    }
  }

  const {
    history: rawHistory,
    filePreamble,
    carriedBlobIds,
  } = await buildArchTurnContext({
    storedMessages: rawMessages,
    fileStore,
    ctx,
    sessionId,
    capabilities,
    excludedBlobIds,
  });

  const summaryText = renderHistorySummary(historySummary);
  const pendingMutationText = renderPendingMutationContext(session.metadata.pendingMutation);
  const pendingPlanText = renderPendingPlanContext(session.metadata.pendingPlan);
  const syntheticHistory: LLMMessage[] = [];
  if (summaryText) {
    syntheticHistory.push({ role: 'assistant', content: summaryText });
  }
  if (pendingPlanText) {
    syntheticHistory.push({ role: 'assistant', content: pendingPlanText });
  }
  if (pendingMutationText) {
    syntheticHistory.push({ role: 'assistant', content: pendingMutationText });
  }

  return {
    history:
      syntheticHistory.length > 0
        ? ([...syntheticHistory, ...rawHistory] as LLMMessage[])
        : rawHistory,
    filePreamble,
    carriedBlobIds,
    historySummary,
  };
}

export async function resolveUserContentForArchLlm(params: {
  userContent?: ArchContentBlock[];
  fileStore: ArchFileStore;
  ctx: SessionContext;
  sessionId: string;
  capabilities?: ContextCapabilities;
}): Promise<ProviderContentBlock[] | undefined> {
  const {
    userContent,
    fileStore,
    ctx,
    sessionId,
    capabilities = DEFAULT_CONTEXT_CAPABILITIES,
  } = params;

  if (!userContent || userContent.length === 0) {
    return undefined;
  }

  const resolved = await resolveContentBlocks(userContent, fileStore, ctx, sessionId, capabilities);
  return resolved.length > 0 ? resolved : undefined;
}

export function collectBlobIdsFromContent(
  content: string | ArchContentBlock[] | undefined,
): Set<string> {
  return collectBlobIdsFromBlocks(extractContentBlocks(content));
}

export function formatToolAnswerForHistory(
  toolCallId: string,
  answer: unknown,
  pendingPayload?: Record<string, unknown> | null,
): string {
  const prompt = pendingPayload ? extractToolPrompt(pendingPayload) : null;
  const answerText = summarizeUnknownValue(answer, MAX_TOOL_CONTEXT_CHARS);

  if (prompt) {
    return `Answer to "${prompt}": ${answerText}`;
  }

  return `Widget answer (${toolCallId}): ${answerText}`;
}
