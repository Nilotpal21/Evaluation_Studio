/**
 * spec-document — barrel export.
 * Exports all types, schemas, status functions, and field-map utilities
 * for the Arch AI persistent spec document feature.
 */

// Types and schemas
export type {
  ConversationNote,
  ComplianceEntry,
  PersonaEntry,
  SLAEntry,
  AgentSummary,
  EdgeSummary,
  ToolSummary,
  GuardrailSummary,
  DecisionEntry,
  BusinessSection,
  ArchitectureSection,
  ImplementationSection,
  IArchSpecDocument,
  SectionStatus,
} from './types.js';

export {
  ComplianceEntrySchema,
  PersonaEntrySchema,
  SLAEntrySchema,
  AgentSummarySchema,
  EdgeSummarySchema,
  ToolSummarySchema,
  GuardrailSummarySchema,
  DecisionEntrySchema,
  BusinessSectionSchema,
  ArchitectureSectionSchema,
  ImplementationSectionSchema,
  getBusinessStatus,
  getArchitectureStatus,
  getImplementationStatus,
} from './types.js';

// Field map and validation
export {
  V1_EDITABLE_PATHS,
  SPEC_TO_SESSION_FIELD_MAP,
  ValidationError,
  validateEditablePath,
} from './field-map.js';

// Service
export { SpecDocumentService, ProjectScopeAccessRequiredError } from './spec-document-service.js';

// Markdown renderer
export { renderMarkdown } from './markdown-renderer.js';
