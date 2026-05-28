/**
 * Arch AI Audit Log — public API
 */

export { AuditLogEmitter } from './audit-log-emitter.js';
export type {
  AuditLogEmitterOpts,
  ArchAuditLogWriter,
  BufferedArchAuditLogEntry,
} from './audit-log-emitter.js';

export type {
  AuditLogCategory,
  AuditLogSeverity,
  AuditLogTokens,
  AuditLogEntry,
  AuditSpanKind,
  AuditEmitterContext,
  LLMCallDetail,
  ToolExecutionDetail,
  PhaseTransitionDetail,
  UserActionDetail,
  BuildEventDetail,
  ErrorDetail,
  SystemEventDetail,
} from './types.js';

export { AUDIT_LOG_CATEGORIES, AUDIT_LOG_SEVERITIES } from './types.js';
