/**
 * Core type definitions for the Arch AI engine.
 * Source of truth: docs/arch/contracts/
 */

export type {
  ArchPhase,
  ArchMode,
  SessionState,
  BlueprintStage,
  ArchSession,
  SessionMetadata,
  BuildProgress,
  BuildAgentStatus,
  BuildToolStatus,
  PendingWidgetPayload,
  ToolGenerationEntry,
  QualityIssue,
  PendingWidgetInteraction,
  PendingInteraction,
  StoredMessage,
  StoredMessageMetadata,
  StoredToolCall,
  HistorySummarySpecSnapshot,
  HistorySummaryCapturedAnswer,
  HistorySummaryDecision,
  HistorySummaryToolOutcome,
  HistorySummaryOpenThread,
  HistorySummary,
  SessionCheckpoint,
  PendingMutation,
  PendingPlan,
  PendingPlanAlternative,
  PendingPlanCitation,
  PendingPlanDependentsAnalysis,
  PendingPlanMutation,
  PendingPlanReference,
  PendingPlanRisk,
  PendingPlanSectionChange,
  PersistedValidation,
  ValidationIssue,
  ResumeCheckpoint,
  ResumePendingState,
  ResumeNextAction,
  ResumeArtifacts,
  ResumeInterruption,
  ResumeSnapshot,
} from './session.js';

export type {
  Specification,
  ConversationNote,
  ConversationNoteCategory,
  FileRef,
} from './specification.js';

export type {
  ArchSSEEvent,
  CompletionMeta,
  BuildAgentValidatedEvent,
  BuildReconciledEvent,
  BuildRetryStartEvent,
  FileContentDeltaEvent,
  KBStatusCardEvent,
  UploadProgressCardEvent,
  SearchResultsCardEvent,
  KBHealthCardEvent,
  ConnectorStatusCardEvent,
  DocProcessingCardEvent,
  ExternalAgentCardEvent,
} from './sse-events.js';
export {
  CompletionMetaSchema,
  QualityFloorSchema,
  BuildAgentStartEventSchema,
  BuildAgentStageEventSchema,
  BuildAgentCompiledEventSchema,
  BuildAgentEnrichedEventSchema,
  BuildAgentErrorEventSchema,
  BuildAgentValidatedEventSchema,
  BuildReconciledEventSchema,
  BuildRetryStartEventSchema,
  FileContentDeltaEventSchema,
  KBStatusCardEventSchema,
  UploadProgressCardEventSchema,
  SearchResultsCardEventSchema,
  KBHealthCardEventSchema,
  ConnectorStatusCardEventSchema,
  DocProcessingCardEventSchema,
  ExternalAgentCardEventSchema,
} from './sse-events.js';

export type { ArchContentBlock, ProviderContentBlock } from './content-blocks.js';
export {
  normalizeContent,
  extractContentBlocks,
  isArchContentBlockArray,
} from './content-blocks.js';

export type { MessageRequest, FileAttachment } from './message-request.js';

export type { PageContext, PageContextEntity } from './page-context.js';
export { PageContextSchema, PageContextEntitySchema } from './page-context.js';

export type { SpecialistId, ToolName, ToolType, ToolDefinition, PhaseToolMap } from './tools.js';

export type { ExecutionResult, ExecutionStatus } from './execution.js';

export type {
  TopologyOutput,
  TopologyAgent,
  TopologyEdge,
  AgentSpec,
  BlueprintOutput,
} from './blueprint.js';

export type {
  BlueprintV2Output,
  BlueprintV2PerAgentSpec,
  BlueprintV2ValidationIssue,
  BlueprintRenderedAgent,
  BlueprintRenderedProject,
  BlueprintLookup,
  CreateBlueprintInput,
  BlueprintEditInput,
} from '../blueprint/index.js';

export {
  ARCH_PHASES,
  ARCH_MODES,
  SESSION_STATES,
  SPECIALIST_IDS,
  MESSAGE_LIMITS,
} from './constants.js';

export {
  InvalidTransitionError,
  ExitCriteriaNotMetError,
  SessionBusyError,
  SessionNotFoundError,
  SessionArchivedError,
  SessionAlreadyExistsError,
  LoopDetectedError,
  FileNotFoundError,
  FileTooLargeError,
  FileCorruptError,
  SessionFileQuotaError,
} from './errors.js';

export type {
  Envelope,
  ActivityStep,
  AgentBuildStage,
  AgentBuildState,
  BuildStats,
  SpecPatch,
  CompletionMetadata,
  ArchSuggestion,
  ArtifactUpdate,
  TurnEndReason,
  TurnEvent,
  TurnStartedEvent,
  TextDeltaEvent,
  StatusEvent,
  ArtifactUpdatedEvent,
  TurnCommittedEvent,
  InteractiveToolEvent,
  TurnEndedEvent,
  ErrorEvent,
  PhaseTransitionEvent,
  SessionSignal,
  FanOutEnvelope,
} from './turn-events.js';
export {
  EnvelopeSchema,
  TurnEventSchema,
  SessionSignalSchema,
  FanOutEnvelopeSchema,
} from './turn-events.js';
