export type { GitProvider, ConnectionValidationResult } from './git-provider.js';
export { GitHubProvider, type GitHubProviderConfig } from './github-provider.js';
export { GitLabProvider, type GitLabProviderConfig } from './gitlab-provider.js';
export { BitbucketProvider, type BitbucketProviderConfig } from './bitbucket-provider.js';
export { GenericGitProvider, type GenericGitProviderConfig } from './generic-git-provider.js';
export {
  GitSyncService,
  type SyncResult,
  type PushOptions,
  type PullOptions,
  type PullProjectFilesResult,
} from './git-sync-service.js';
export {
  checkConflict,
  checkConflicts,
  autoResolveConflicts,
  type ThreeWayInput,
  type ConflictCheckResult,
} from './conflict-resolver.js';
export {
  verifyWebhookSignature,
  parseWebhookPayload,
  hasRelevantChanges,
  type WebhookPayload,
} from './webhook-handler.js';
export { BranchManager } from './branch-manager.js';
export {
  GitCircuitBreaker,
  GitCircuitBreakerError,
  type GitBreakerState,
  type GitCircuitBreakerConfig,
} from './git-circuit-breaker.js';
export {
  createGitProvider,
  parseGitHubUrl,
  parseGitLabUrl,
  parseBitbucketUrl,
  type GitIntegrationConfig,
  type ResolvedCredentials,
} from './provider-factory.js';
