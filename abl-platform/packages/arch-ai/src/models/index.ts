/**
 * Arch Mongoose models for the active Arch engine.
 *
 * These models still point at the versioned `_v4` MongoDB collections that
 * back the current production Arch storage contract.
 */

// ArchSession
export { ArchSessionModel } from './arch-session.model.js';
export type { IArchSessionRecord } from './arch-session.model.js';

// ArchSpecDocument
export { ArchSpecDocumentModel } from './arch-spec-document.model.js';
export type {
  IArchSpecDocumentRecord,
  IComplianceItem,
  IPersona,
  ISLA,
  ISpecAgent,
  ISpecEdge,
  ISpecTool,
  IGuardrail,
  ISpecDecision,
  ISpecBusiness,
  ISpecArchitecture,
  ISpecImplementation,
} from './arch-spec-document.model.js';

// ArchJournal
export { ArchJournalModel } from './arch-journal.model.js';
export type { IArchJournalRecord } from './arch-journal.model.js';

// ArchAuditLog
export { ArchAuditLogModel } from './arch-audit-log.model.js';
export type { IArchAuditLogRecord } from './arch-audit-log.model.js';

// ArchSessionAttachment
export { ArchSessionAttachmentModel } from './arch-session-attachment.model.js';
export type { IArchSessionAttachmentRecord } from './arch-session-attachment.model.js';

// ArchConversation
export { ArchConversationModel } from './arch-conversation.model.js';
export type { IArchConversationRecord, IArchMessage } from './arch-conversation.model.js';

// ArchLearningMemory
export { ArchLearningMemoryModel } from './arch-learning-memory.model.js';
export type {
  IArchLearningMemoryRecord,
  LearningMemoryType,
} from './arch-learning-memory.model.js';

// ArchProjectMemory
export { ArchProjectMemoryModel } from './arch-project-memory.model.js';
export type {
  IArchProjectMemoryRecord,
  IProjectMemoryEntry,
  ProjectMemoryType,
  ProjectMemorySource,
} from './arch-project-memory.model.js';

// ArchWorkspaceConfig
export { ArchWorkspaceConfigModel } from './arch-workspace-config.model.js';
export type { IArchWorkspaceConfigRecord } from './arch-workspace-config.model.js';
