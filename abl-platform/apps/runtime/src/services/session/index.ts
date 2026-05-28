/**
 * Session Module
 *
 * Cluster-ready session management for the Agent ABL runtime.
 */

export type {
  SessionData,
  HydratedSession,
  SessionState,
  ConversationWindowConfig,
  SessionConfig,
} from './types.js';
export { DEFAULT_SESSION_CONFIG, DEFAULT_CONVERSATION_WINDOW } from './types.js';
export type {
  IdentityEvidence,
  IdentityEvidenceArtifact,
  ProductionExecutionScope,
  DebugExecutionScope,
  SystemExecutionScope,
  ExecutionScope,
  SessionScope,
  SessionActor,
  SessionSubject,
  SessionLocator,
  PrivilegedSessionLocator,
  ScopeDiagnostics,
} from './execution-scope.js';
export { toSessionLocator, buildProductionSessionLocator } from './execution-scope.js';
export {
  buildContactProductionExecutionScope,
  buildRequiredContactProductionExecutionScope,
  buildServicePrincipalProductionExecutionScope,
  buildRequiredServicePrincipalProductionExecutionScope,
  requiresCanonicalContactProductionScope,
  resolveIdentityEvidenceArtifactType,
} from './execution-scope-factory.js';
export { resolveRequiredContactProductionScope } from './production-contact-scope.js';
export { ScopeValidationError, assertProductionExecutionScope } from './scope-policy.js';
export type { SessionStore } from './session-store.js';
export { MemorySessionStore } from './memory-session-store.js';
export { RedisSessionStore } from './redis-session-store.js';
export { TwoTierIRCache, type IRCacheConfig } from './ir-cache.js';
export {
  SessionService,
  getSessionService,
  ensureSessionService,
  createSessionService,
  resetSessionService,
} from './session-service.js';
export { SessionFactory, getSessionFactory, resetSessionFactory } from './session-factory.js';
