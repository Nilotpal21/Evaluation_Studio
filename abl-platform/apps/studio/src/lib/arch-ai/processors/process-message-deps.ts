import type { ArchSSEEvent, ArchSession, ProcessMessageDeps } from '@agent-platform/arch-ai';
import { resolveArchVercelModel } from '@/lib/arch-llm';
import { createProductionTurnEngine, buildServiceBagForTurn } from '@/lib/arch-ai/engine-factory';
import { finalizeProject } from '@/lib/arch-ai/processors/finalize-project';
import {
  sessionService,
  journalService,
  specDocumentService,
  projectMemoryService,
  fileStoreService,
} from '@/lib/arch-ai/message-services';
import {
  augmentUserInputWithFileRefs,
  buildUserContentFromFileRefs,
} from '@/lib/arch-ai/processors/attachment-context';
import {
  buildSuggestionGenerator,
  buildTurnPlanLoaders,
} from '@/lib/arch-ai/processors/runtime-support';
import {
  closeAndResetIfActive,
  transitionSessionToIdle,
} from '@/lib/arch-ai/helpers/session-helpers';
import { projectExistsByName } from '@/services/project-service';
import { runParallelGeneration } from '@/lib/arch-ai/build-parallel-gen';
import {
  buildCompletionSummary,
  buildCompletionWidgetPayload,
  handleBuildAction,
  type AgentGenResult,
} from '@/lib/arch-ai/build-completion';
import { extractBuildResultsFromPendingWidgetPayload } from '@/lib/arch-ai/build-result-reconciliation';
import { executePhaseTransition } from '@/lib/arch-ai/phase-transition';
import type { LanguageModel } from 'ai';

export const studioProcessMessageDeps: ProcessMessageDeps = {
  sessionService,
  journalService,
  specDocumentService,
  projectMemoryService,
  fileStoreService,
  resolveModel: resolveArchVercelModel,
  createTurnEngine: createProductionTurnEngine,
  buildServiceBagForTurn: (buffer) =>
    buildServiceBagForTurn(buffer) as unknown as Record<string, unknown>,
  buildSuggestionGenerator,
  buildTurnPlanLoaders,
  augmentUserInputWithFileRefs,
  buildUserContentFromFileRefs,
  transitionSessionToIdle,
  closeAndResetIfActive,
  projectExistsByName,
  finalizeProject,
  runParallelGeneration: (agentNames, ctx, session, emit, model, abortSignal, options) =>
    runParallelGeneration(
      agentNames,
      ctx,
      session,
      emit,
      model as LanguageModel,
      abortSignal,
      options,
    ) as Promise<AgentGenResult[]>,
  buildCompletionSummary: (results) => buildCompletionSummary(results as AgentGenResult[]),
  buildCompletionWidgetPayload: (results, projectName) =>
    buildCompletionWidgetPayload(results as AgentGenResult[], projectName) as unknown as Record<
      string,
      unknown
    >,
  extractBuildResultsFromPendingWidgetPayload: (payload) =>
    extractBuildResultsFromPendingWidgetPayload(payload) as AgentGenResult[],
  handleBuildAction: (answer, ctx, session, results, emit, close, deps, projectName) =>
    handleBuildAction(
      answer,
      ctx,
      session,
      results as AgentGenResult[],
      emit as (event: ArchSSEEvent) => void,
      close,
      deps,
      projectName,
    ),
  executePhaseTransition: (ctx, session: ArchSession, service, emit, journalFn, timing) =>
    executePhaseTransition(ctx, session, service, emit, journalFn, timing),
};
