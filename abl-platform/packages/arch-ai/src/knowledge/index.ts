/**
 * Knowledge Layer — construct-specific knowledge cards for Arch prompts.
 *
 * Architecture: 4-layer system
 *   L0: Platform foundation (always loaded, hand-curated)
 *   L1: Specialist baselines (per specialist, loaded from specialist prompts)
 *   L2: Construct cards (intent-triggered, auto-generated from docs-internal MDX)
 *   L3: Docs RAG fallback (BM25 keyword search over docs-internal chunks)
 */

export { PLATFORM_LIMITS_CARD } from './platform-limits.js';
export { renderInProjectKnowledgeCore } from './in-project-knowledge-core.generated.js';
export { ABL_ANATOMY_CARD } from './cards/generated/abl-anatomy.js';
export { EXECUTION_CONFIG_CARD } from './cards/generated/execution-config.js';
export { LIMITATIONS_VS_CONSTRAINTS_CARD } from './cards/generated/limitations-vs-constraints.js';
export { FLOW_PATTERNS_CARD } from './cards/generated/flow-patterns.js';
export { FLOW_REASONING_ZONES_CARD } from './cards/generated/flow-reasoning-zones.js';
export { FLOW_TRANSFORM_CARD } from './cards/generated/flow-transform.js';
export { FLOW_DIGRESSIONS_CARD } from './cards/generated/flow-digressions.js';
export { GATHER_FIELDS_CARD } from './cards/generated/gather-fields.js';
export { GATHER_VALIDATION_PII_CARD } from './cards/generated/gather-validation-pii.js';
export { TOOL_BINDING_AUTH_CARD } from './cards/generated/tool-binding-auth.js';
export { TOOL_RESOLUTION_CARD } from './cards/generated/tool-resolution.js';
export { TOOL_TEMPLATES_CARD } from './cards/generated/tool-templates.js';
export { HANDOFF_DELEGATE_CARD } from './cards/generated/handoff-delegate.js';
export { ROUTING_INTENTS_CARD } from './cards/generated/routing-intents.js';
export { CROSS_AGENT_CONTRACTS_CARD } from './cards/generated/cross-agent-contracts.js';
export { GUARDRAILS_TIERS_CARD } from './cards/generated/guardrails-tiers.js';
export { ERROR_HANDLING_CARD } from './cards/generated/error-handling.js';
export { ESCALATE_A2A_CARD } from './cards/generated/escalate-a2a.js';
export { CEL_FUNCTIONS_CARD } from './cards/generated/cel-functions.js';
export { CEL_PITFALLS_CARD } from './cards/generated/cel-pitfalls.js';
export { MEMORY_FULL_CARD } from './cards/generated/memory-full.js';
export { NLU_ENTITIES_CARD } from './cards/generated/nlu-entities.js';
export { BEHAVIOR_PROFILES_CARD } from './cards/generated/behavior-profiles.js';
export { HOOKS_LIFECYCLE_CARD } from './cards/generated/hooks-lifecycle.js';
export { RICH_CONTENT_CARD } from './cards/generated/rich-content.js';
export { ATTACHMENTS_KB_CARD } from './cards/generated/attachments-kb.js';
export { PROJECT_CONFIG_CARD } from './cards/generated/project-config.js';
export { DIAGNOSTICS_WORKFLOW_CARD } from './cards/generated/diagnostics-workflow.js';
export { OBSERVER_ANALYTICS_CARD } from './cards/generated/observer-analytics.js';
export { TESTING_WORKFLOW_CARD } from './cards/generated/testing-workflow.js';
export { RUNTIME_CONSTRUCT_DECISION_CARD } from './cards/runtime-construct-decision.js';
export { selectKnowledgeCards } from './card-router.js';
export type { CardSelection, PageContextInput } from './card-router.js';
export {
  searchBm25,
  loadL3Index,
  estimateTokens,
  resetL3Cache,
  searchDocsGrouped,
} from './l3-search.js';
export type { L3Index, L3Chunk, L3SearchResult, DocSearchResult } from './l3-search.js';
export { getCoveredFiles } from './cards/_mapping.js';
export {
  getConstructAuthoringContract,
  renderConstructCompileHint,
  renderConstructExample,
  renderConstructFieldSummary,
  renderDefaultMemorySessionBlock,
  renderDefaultSupervisorCatchAllHandoff,
  renderDelegateMissingCompleteWarning,
  renderDelegateMissingGatherWarning,
  renderHandoffContextPassMissingMemoryWarning,
  renderKnownConstructsHint,
  renderMissingAgentDeclarationWarning,
  renderMissingConstructWarning,
  renderMissingMemoryWarning,
  renderMissingToolsWarning,
  renderPciMissingConstraintsWarning,
  renderSupervisorCatchAllHandoffWarning,
  renderSupervisorMissingHandoffWarning,
} from './construct-contract.js';
export {
  getCatalogVersion,
  getCelGrammar,
  getConstructSpec,
  getCrossConstructMandatories,
  listAllConstructs,
  listCelFunctions,
  listFeasibilityChecks,
  listValidCombinations,
  lookupValidationCode,
} from './spine.js';
export {
  getGuardrailAuthoringContract,
  renderDefaultContentSafetyGuardrail,
  renderDefaultContentSafetyInline,
  renderDefaultContentSafetySummary,
  renderGuardrailAuthoringGuidance,
  renderGuardrailCompileHint,
  renderMissingGuardrailsWarning,
} from './guardrail-contract.js';
