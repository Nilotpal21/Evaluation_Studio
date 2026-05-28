/**
 * Decision Engine - Autonomous crawl strategy selection
 *
 * Exports:
 * - Interfaces: IDecisionEngine, CrawlDecision, DecisionContext, etc.
 * - Types: CrawlStrategy, UserPreference, TenantPolicy, LearnedPattern
 * - Implementations: DecisionEngine
 * - Errors: DecisionError
 */

export {
  // Core decision types
  type CrawlStrategy,
  type CrawlDecision,
  type Alternative,
  type DecisionContext,

  // User preferences
  type UserPreference,

  // Tenant policies
  type TenantPolicy,

  // Learned patterns
  type LearnedPattern,
  type CrawlOutcome,

  // Core interfaces
  type IDecisionEngine,
  type IUserPreferenceStore,
  type ITenantPolicyStore,
  type IPatternLearner,

  // Error
  DecisionError,
} from './interfaces.js';

export {
  // Core implementation
  DecisionEngine,
  type DecisionEngineOptions,
} from './decision-engine.js';

export {
  // Store implementations
  MongoUserPreferenceStore,
} from './user-preference-store.js';

export { MongoTenantPolicyStore } from './tenant-policy-store.js';
