/**
 * v2 import barrel exports — aggregates all v2-specific modules
 * to avoid merge conflicts with other agents modifying index.ts.
 */

export {
  importProjectV2,
  type ImportV2Deps,
  type ExistingProjectStateV2,
  type CrossRefDbAdapter,
} from './project-importer-v2.js';

export {
  validateImportPrerequisites,
  type PrerequisiteResult,
  type PrerequisiteIssue,
  type PrerequisiteSeverity,
  type PrereqContext,
} from './prerequisite-validator.js';

export {
  resolveAuthProfiles,
  rewriteConnectionAuthProfiles,
  type AuthProfileResolution,
  type ResolvedAuthProfile,
  type UnresolvedAuthProfile,
  type TargetAuthProfile,
  type RequiredAuthProfileRef,
  type ResolutionStrategy,
} from './auth-profile-resolver.js';

export {
  validateEntitySchema,
  getSchemaForFile,
  ImportedConnectionSchema,
  ImportedConnectorConfigSchema,
  ImportedGuardrailSchema,
  ImportedWorkflowSchema,
  ImportedWorkflowVersionSchema,
  ImportedEvalSetSchema,
  ImportedEvalScenarioSchema,
  ImportedEvalPersonaSchema,
  ImportedEvaluatorSchema,
  ImportedSearchIndexSchema,
  ImportedSearchSourceSchema,
  ImportedKnowledgeBaseSchema,
  ImportedCrawlPatternSchema,
  ImportedChannelSchema,
  ImportedWebhookSchema,
  ImportedWidgetConfigSchema,
  ImportedLookupEntrySchema,
  ImportedLookupTableSchema,
  ImportedCanonicalSchemaFile,
  ImportedDomainVocabularySchema,
  ImportedFactSchema,
  type SchemaValidationResult,
  type SchemaValidationIssue,
} from './entity-schemas.js';
