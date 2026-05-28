// Core types
export type {
  PipelineStepContext,
  StepOutput,
  PipelineRunInput,
  ResolvedPipelineConfig,
  PipelineStep,
  PipelineDefinition,
  PipelineRunState,
  ConfigField,
  ConfigFieldOption,
  TriggerEntry,
  ExecutionStrategy,
  NodeTypeDefinition,
  NodeCategory,
  PortSchema,
  PipelineNode,
  NodeTransition,
  GroupChildNode,
  ConfigFieldDefinition,
  StorageTableDefinition,
  StorageColumnDefinition,
  NodeTypeDefinitionDoc,
  NodeTrait,
} from './pipeline/types.js';

// Node registry
export { NodeRegistry } from './pipeline/node-registry.js';
export type { ValidationResult } from './pipeline/node-registry.js';

// Trigger registry
export {
  listTriggerDefinitions,
  getTriggerDefinition,
  getTriggerCategories,
} from './pipeline/trigger-registry.js';
export type { TriggerDefinition } from './pipeline/trigger-registry.js';

// Node registration
export {
  registerAnalyticsNodes,
  registerBuiltinNodes,
  inferCategory,
} from './pipeline/register-nodes.js';

// Graph utilities
export {
  stepsToGraph,
  findReachableNodes,
  detectBackEdges,
  resolveTransition,
} from './pipeline/graph-utils.js';

// Graph walker
export { walkGraph } from './pipeline/graph-walker.js';
export type { GraphWalkResult, NodeExecutorFn } from './pipeline/graph-walker.js';

// Validation
export {
  validatePipeline,
  validateActiveTriggers,
  validateGraphPipeline,
  validateNodeModels,
} from './pipeline/validation.js';
export type { ValidationError, GraphValidationResult } from './pipeline/validation.js';

// Activity metadata
export {
  ACTIVITY_TYPES,
  listActivityTypes,
  getActivityMetadata,
} from './pipeline/activity-metadata.js';
export type { ActivityTypeMetadata } from './pipeline/activity-metadata.js';

// Expression evaluator
export {
  evaluateExpression,
  resolveExpression,
  isSafeExpression,
  extractStepReferences,
} from './pipeline/expression-evaluator.js';

// Node reference helpers
export {
  normalizeNodeReferenceName,
  getNodeReferenceName,
  buildStepOutputReferences,
} from './pipeline/node-references.js';

// Template engine
export { substituteTemplates } from './pipeline/template-engine.js';

// Trait merger
export { mergeTraitFields } from './pipeline/trait-merger.js';

// Execution context utilities
export {
  deriveContextKey,
  resolveContextInput,
  buildExecutionContext,
} from './pipeline/execution-context.js';

// Restate client
export { getRestateClient } from './client.js';

// Restate handler references (for SDK invocation)
export { pipelineRun } from './pipeline/handlers/pipeline-run.workflow.js';
export { pipelineTrigger } from './pipeline/handlers/pipeline-trigger.service.js';
export { pipelineScheduler } from './pipeline/handlers/pipeline-scheduler.js';
export {
  auditKafkaSubscriptions,
  buildKafkaSubscriptionSources,
  summarizeStartupProbes,
} from './pipeline/startup-diagnostics.js';
export type {
  KafkaSubscriptionAudit,
  StartupProbe,
  StartupProbeStatus,
  StartupProbeSummary,
} from './pipeline/startup-diagnostics.js';

// Definition cache (Redis-backed)
export {
  initDefinitionCache,
  invalidateDefinitionCache,
  DEFINITION_CACHE_KEY_PREFIX,
} from './pipeline/services/definition-cache.js';
export type { RedisLike as DefinitionCacheRedisLike } from './pipeline/services/definition-cache.js';

// Pipeline config service
export {
  PipelineConfigService,
  resolveActiveTriggers,
  resolveSamplingRate,
} from './pipeline/services/pipeline-config.service.js';
export type { PipelineConfigSummary } from './pipeline/services/pipeline-config.service.js';

// Config validation schemas
export {
  parseAndValidateConfig,
  PIPELINE_CONFIG_SCHEMAS,
  SHARED_CONFIG_FIELDS,
  buildZodSchema,
  parseAndValidateConfigFromDefinition,
} from './pipeline/config-schemas.js';
export { PLATFORM_DEFAULTS, getPlatformDefaults } from './pipeline/config-defaults.js';

// Curated metric source allowlist for AD / Drift detection
export {
  METRIC_SOURCES,
  METRIC_TABLE_NAMES,
  getMetricTables,
  getMetricTable,
  getMetricColumns,
  isValidMetricTable,
  isValidMetricColumn,
  resolveMetricDynamicOptions,
  resolveMetricDynamicOptionsAll,
} from './pipeline/metric-sources.js';
export type { MetricTable, MetricColumn } from './pipeline/metric-sources.js';

// Backfill service
export { BackfillService } from './pipeline/services/backfill.service.js';
export type { BackfillOptions, BackfillResult } from './pipeline/services/backfill.service.js';

// Analytics cache
export { AnalyticsCache } from './pipeline/services/analytics-cache.js';
export type { AnalyticsCacheOptions } from './pipeline/services/analytics-cache.js';

// Pipeline definitions
export {
  sentimentPipelineDefinition,
  SENTIMENT_PIPELINE_ID,
} from './pipeline/definitions/sentiment-pipeline.js';
export {
  intentPipelineDefinition,
  INTENT_PIPELINE_ID,
} from './pipeline/definitions/intent-pipeline.js';
export {
  qualityPipelineDefinition,
  QUALITY_PIPELINE_ID,
} from './pipeline/definitions/quality-pipeline.js';
export {
  hallucinationPipelineDefinition,
  HALLUCINATION_PIPELINE_ID,
} from './pipeline/definitions/hallucination-pipeline.js';
export {
  knowledgeGapPipelineDefinition,
  KNOWLEDGE_GAP_PIPELINE_ID,
} from './pipeline/definitions/knowledge-gap-pipeline.js';
export {
  guardrailPipelineDefinition,
  GUARDRAIL_PIPELINE_ID,
} from './pipeline/definitions/guardrail-pipeline.js';
export {
  frictionPipelineDefinition,
  FRICTION_PIPELINE_ID,
} from './pipeline/definitions/friction-pipeline.js';
export {
  anomalyPipelineDefinition,
  ANOMALY_PIPELINE_ID,
} from './pipeline/definitions/anomaly-pipeline.js';
export {
  driftPipelineDefinition,
  DRIFT_PIPELINE_ID,
} from './pipeline/definitions/drift-pipeline.js';
export { evalPipelineDefinition, EVAL_PIPELINE_ID } from './pipeline/definitions/eval-pipeline.js';
export { BUILTIN_DEFINITIONS } from './pipeline/definitions/index.js';

// Conversation analyzer service (formerly compute-llm-evaluation)
export { conversationAnalyzerService } from './pipeline/services/compute-llm-evaluation.service.js';

// Statistical analysis service
export { computeStatisticalService } from './pipeline/services/compute-statistical.service.js';
export {
  computeZScore,
  computeSPC,
  computeIQR,
  computeLinearRegressionSlope,
} from './pipeline/services/compute-statistical.service.js';

// Read message window service
export { readMessageWindowService } from './pipeline/services/read-message-window.service.js';

// Mongoose schemas
export {
  PipelineDefinitionModel,
  type IPipelineDefinition,
} from './schemas/pipeline-definition.schema.js';
export {
  PipelineRunRecordModel,
  type IPipelineRunRecord,
} from './schemas/pipeline-run-record.schema.js';

// Tag rules
export { TagRuleModel, type ITagRule } from './schemas/tag-rule.schema.js';

// Node type definitions
export { NodeTypeDefinitionModel } from './schemas/node-type-definition.schema.js';

// Seed script
export { seedNodeTypes } from './pipeline/seed-node-types.js';
export type { SeedResult } from './pipeline/seed-node-types.js';
export {
  seedBuiltinPipelineDefinitions,
  seedTenantPipelineConfigs,
  type PipelineSeedOptions,
  type TenantPipelineSeedOptions,
} from './pipeline/seed-defaults.js';

// Alert rules
export { AlertRuleModel, type IAlertRule } from './schemas/alert-rule.schema.js';

// Alert evaluator service
export {
  alertEvaluatorService,
  evaluateCondition,
} from './pipeline/services/alert-evaluator.service.js';

// Project cost config
export {
  ProjectCostConfigModel,
  type IProjectCostConfig,
} from './schemas/project-cost-config.schema.js';

// ROI calculator
export { ROICalculator } from './pipeline/services/roi-calculator.service.js';
export type { ROISummary, SimulationResult } from './pipeline/services/roi-calculator.service.js';

// Experiments
export {
  ExperimentModel,
  type IExperiment,
  type ExperimentSafetyRule,
  type StoredExperimentResults,
  type StoredSignificanceResult,
  type ExperimentBreachDetail,
} from './schemas/experiment.schema.js';

// Experiment results service
export { ExperimentResultsService } from './pipeline/services/experiment-results.service.js';
export type {
  GroupMetrics,
  SignificanceResult,
  ExperimentResults,
} from './pipeline/services/experiment-results.service.js';

// Predictive features service
export {
  computePredictiveFeaturesService,
  computeChurnRisk,
} from './pipeline/services/compute-predictive-features.service.js';
export type { PredictiveFeatures } from './pipeline/services/compute-predictive-features.service.js';

// Mention detection service
export {
  computeMentionsService,
  parseMentionResponse,
} from './pipeline/services/compute-mentions.service.js';

// Goal completion service
export { computeGoalCompletionService } from './pipeline/services/compute-goal-completion.service.js';
export type { MentionResult } from './pipeline/services/compute-mentions.service.js';

// Semantic layer
export { SEMANTIC_LAYER, getSemanticLayerPrompt } from './pipeline/services/semantic-layer.js';
export type { TableDescription, ColumnDescription } from './pipeline/services/semantic-layer.js';

// NL query service
export { NLQueryService, validateSQL } from './pipeline/services/nl-query.service.js';
export type { NLQueryResult } from './pipeline/services/nl-query.service.js';

// Contracts (Phase 1 of custom-pipeline UX redesign — ABLP-564)
export * from './pipeline/contracts/index.js';

// Experiment assignment (pure functions)
export {
  assignExperimentGroup,
  getAssignmentKey,
  checkSessionEligibility,
} from './services/experiment-assignment.js';
export type {
  CachedExperiment,
  SessionEligibilityResult,
} from './services/experiment-assignment.js';

// Experiment safety (pure functions)
export { evaluateSafetyRules } from './services/experiment-safety.js';
export type { ExperimentSafetyCheckResult } from './services/experiment-safety.js';

// Experiment service (Redis-cached active experiment lookup)
export { ExperimentService } from './services/experiment.service.js';
