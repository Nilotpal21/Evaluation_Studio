/**
 * Engine barrel — Arch turn engine public API.
 *
 * Re-exports all types, classes, and functions from the engine sub-modules
 * so callers can import from '@agent-platform/arch-ai/engine' without
 * reaching into internal paths.
 */

// ─── Turn Buffer ──────────────────────────────────────────────────────────
export { TurnBuffer } from './turn-buffer.js';
export type { TurnBufferOptions, TurnCommitResult } from './turn-buffer.js';

// ─── Turn Engine ──────────────────────────────────────────────────────────
export { TurnEngine } from './turn-engine.js';
export type { TurnEngineDeps, RunTurnInput } from './turn-engine.js';

// ─── LLM Client ───────────────────────────────────────────────────────────
export type {
  LLMStreamChunk,
  LLMToolDescriptor,
  LLMMessage,
  LLMStreamRequest,
  LLMStreamClient,
} from './llm-client.js';

// Backwards-compatible type aliases for seeded engine-factory code.
export type {
  LLMStreamChunk as V2LLMStreamChunk,
  LLMMessage as V2LLMMessage,
  LLMStreamRequest as V2LLMStreamRequest,
  LLMStreamClient as V2LLMStreamClient,
} from './llm-client.js';

// ─── Buffered Services ────────────────────────────────────────────────────
export {
  createBufferedSessionService,
  createBufferedJournalService,
  createBufferedSpecDocumentService,
  createBufferedProjectService,
  createBufferedArchSessionsCollection,
} from './buffered-services.js';
export type { MinimalCollection } from './buffered-services.js';

// ─── Coordinator Bridge ───────────────────────────────────────────────────
export { resolveTurnPlan } from './coordinator-bridge.js';
export type { TurnPlan, ResolveTurnPlanInput } from './coordinator-bridge.js';

// ─── Queue ────────────────────────────────────────────────────────────────
export { classifyRequestForQueue, nextFlushDecision } from './queue.js';
export type { QueueClassification, QueueEntry, FlushDecision } from './queue.js';

// ─── Outbox ───────────────────────────────────────────────────────────────
export { createOutbox } from './outbox.js';
export type { OutboxEvent, OutboxEnvelope, OutboxHandle, CreateOutboxOpts } from './outbox.js';

// ─── Tool Invoker ─────────────────────────────────────────────────────────
export { ToolInvoker } from './tool-invoker.js';
export type { InvocationRequest, InvocationResult, ToolInvokerOptions } from './tool-invoker.js';

// ─── Turn Context ─────────────────────────────────────────────────────────
export type { TurnContext } from './turn-context.js';

// ─── Error Classifier ─────────────────────────────────────────────────────
export {
  ToolErrorCode,
  ModelErrorCode,
  classifyToolError,
  classifyModelError,
  backoffDelayMs,
  TimeoutError,
  AbortError,
  ZodValidationError,
} from './error-classifier.js';
export type { ToolExecutionError, ModelProviderError } from './error-classifier.js';

// ─── Hard Limits ──────────────────────────────────────────────────────────
export { ARCH_AI_TURN, ARCH_AI_BUILD, ARCH_AI_LOCK } from './hard-limits.js';

// ─── Session Lock (pub/sub) ───────────────────────────────────────────────
// acquireTurnLock and releaseTurnLock live in session/session-lock.ts but
// are exposed here for convenience so engine-factory callers can import from
// a single subpath. Re-exported from the session barrel too.

// ─── V1 Core Function Refs (v4 new) ──────────────────────────────────────

import type { ToolRegistry } from '../tools/v2/registry.js';

/**
 * Record of "core" function refs extracted from Studio tool modules.
 * Each key is a tool name; each value is the underlying async function
 * that the turn engine calls via ToolInvoker (bypassing the SSE surface).
 *
 * Tools that do not yet have a v4 core implementation are typed as
 * `(...args: unknown[]) => Promise<unknown>` until they are wired.
 */
export interface V1CoreFunctionRefs {
  updateSpecification: (...args: unknown[]) => Promise<unknown>;
  generateTopology: (...args: unknown[]) => Promise<unknown>;
  proceedToNextPhase: (...args: unknown[]) => Promise<unknown>;
  generateAgent: (...args: unknown[]) => Promise<unknown>;
  compileAbl: (...args: unknown[]) => Promise<unknown>;
  proposeModification: (...args: unknown[]) => Promise<unknown>;
  saveToolDsl: (...args: unknown[]) => Promise<unknown>;
  kbManage: (...args: unknown[]) => Promise<unknown>;
  kbSearch: (...args: unknown[]) => Promise<unknown>;
  kbHealth: (...args: unknown[]) => Promise<unknown>;
  kbIngest: (...args: unknown[]) => Promise<unknown>;
  kbConnector: (...args: unknown[]) => Promise<unknown>;
  kbDocuments: (...args: unknown[]) => Promise<unknown>;
  kbCrawl: (...args: unknown[]) => Promise<unknown>;
  kbSchema: (...args: unknown[]) => Promise<unknown>;
  readJournal: (...args: unknown[]) => Promise<unknown>;
  readTopology: (...args: unknown[]) => Promise<unknown>;
  readAgent: (...args: unknown[]) => Promise<unknown>;
  readInsights: (...args: unknown[]) => Promise<unknown>;
  sessionOps: (...args: unknown[]) => Promise<unknown>;
  traceDiagnosis: (...args: unknown[]) => Promise<unknown>;
  queryTraces: (...args: unknown[]) => Promise<unknown>;
  applyModification: (...args: unknown[]) => Promise<unknown>;
  dismissProposal: (...args: unknown[]) => Promise<unknown>;
  validateAgent: (...args: unknown[]) => Promise<unknown>;
  diagnoseProject: (...args: unknown[]) => Promise<unknown>;
  explainDiagnostic: (...args: unknown[]) => Promise<unknown>;
  healthCheck: (...args: unknown[]) => Promise<unknown>;
  analyzeConstraints: (...args: unknown[]) => Promise<unknown>;
  toolsOps: (...args: unknown[]) => Promise<unknown>;
  mcpServerOps: (...args: unknown[]) => Promise<unknown>;
  variableOps: (...args: unknown[]) => Promise<unknown>;
  integrationOps: (...args: unknown[]) => Promise<unknown>;
  projectConfig: (...args: unknown[]) => Promise<unknown>;
  authOps: (...args: unknown[]) => Promise<unknown>;
  recommendModel: (...args: unknown[]) => Promise<unknown>;
  configureModel: (...args: unknown[]) => Promise<unknown>;
  runTest: (...args: unknown[]) => Promise<unknown>;
  manageMemory: (...args: unknown[]) => Promise<unknown>;
  platformContext: (...args: unknown[]) => Promise<unknown>;
}

// ─── ToolRegistry re-export for registerAllV1Tools ───────────────────────
import { ToolRegistry as _ToolRegistryImpl } from '../tools/v2/registry.js';

/**
 * Register all v1 core function refs into a new ToolRegistry.
 *
 * This is a v4 placeholder — actual tool registration will be wired
 * in a subsequent implementation phase. Returns an empty registry
 * until the tool descriptors are defined.
 */
export function registerAllV1Tools(_cores: V1CoreFunctionRefs): ToolRegistry {
  // TODO(v4): Build ToolDefinition wrappers from _cores and register them.
  // For now, return an empty registry so engine-factory.ts type-checks.
  return new _ToolRegistryImpl();
}

// ─── Schema Version ───────────────────────────────────────────────────────
export { SCHEMA_VERSION_V2 } from '../types/session-v2.js';
