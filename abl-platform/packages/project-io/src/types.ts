/**
 * Shared types for project-io package
 *
 * Types for project manifests, lockfiles, dependencies, diffs, and git operations.
 */

// ─── Section Splicer Types ─────────────────────────────────────────────────

export interface SectionBoundary {
  name: string;
  startLine: number;
  endLine: number;
  headerLine: string;
}

export interface SectionEdit {
  section: string;
  content: string | null;
}

// ─── ABL Diff Types ────────────────────────────────────────────────────────

export type SectionStatus = 'added' | 'removed' | 'modified' | 'unchanged';

export interface SectionDiff {
  section: string;
  status: SectionStatus;
  beforeContent: string | null;
  afterContent: string | null;
}

export interface ABLDiffResult {
  hasChanges: boolean;
  sections: SectionDiff[];
  summary: {
    added: string[];
    removed: string[];
    modified: string[];
    unchanged: string[];
  };
}

// ─── Dependency Types ──────────────────────────────────────────────────────

export type DependencyType =
  | 'handoff'
  | 'delegate'
  | 'tool_import'
  | 'inline_handoff'
  | 'profile_use';

export interface AgentDependency {
  type: DependencyType;
  targetAgent: string;
  sourceLine: number;
  sourceSection: string;
  toolNames?: string[];
  sourcePath?: string;
}

export interface AgentEntry {
  name: string;
  dslContent: string;
  path?: string;
}

export interface ToolFileEntry {
  name: string;
  path?: string;
  content: string;
}

export type AgentArchiveFormat = 'yaml' | 'abl';
export type ExportDslFormat = 'source' | 'yaml';
export type GuardrailArchiveFormat = 'json' | 'yaml';
export type ProjectDslFormat = 'yaml' | 'legacy' | 'mixed';

export interface DependencyEdge {
  from: string;
  to: string;
  type: DependencyType;
  toolNames?: string[];
  sourcePath?: string;
}

export interface DependencyGraph {
  agents: string[];
  toolFiles: string[];
  profiles: string[];
  edges: DependencyEdge[];
  adjacency: Map<string, DependencyEdge[]>;
  reverseAdjacency: Map<string, DependencyEdge[]>;
}

export interface DependencyValidation {
  valid: boolean;
  missing: DependencyEdge[];
  circular: string[][];
}

// ─── Project Manifest Types ────────────────────────────────────────────────

export interface ProjectManifest {
  name: string;
  slug: string;
  description: string | null;
  version: string;
  abl_version: '1.0';
  exported_at: string;
  exported_by: string;
  entry_agent: string | null;
  dsl_format: ProjectDslFormat;
  agents: Record<string, ManifestAgent>;
  tools: Record<string, ManifestTool>;
  behavior_profiles?: Record<string, ManifestBehaviorProfile>;
  dependencies: {
    agent_references: Array<{ from: string; to: string; type: 'handoff' | 'delegate' }>;
    tool_imports: Array<{ agent: string; source: string; tools: string[] }>;
  };
}

export interface ManifestAgent {
  path: string;
  owner: string | null;
  ownerTeam: string | null;
  description: string | null;
  version: string | null;
  systemPromptLibraryRef?: {
    promptId: string;
    versionId: string;
    resolvedHash?: string;
  } | null;
}

export interface ManifestTool {
  path: string;
  owner: string | null;
}

export interface ManifestBehaviorProfile {
  name: string;
  path: string;
  priority: number;
  when_summary: string;
  used_by: string[];
}

// ─── Lock File Types ───────────────────────────────────────────────────────

export interface LockFile {
  lockfile_version: '1.0';
  generated_at: string;
  agents: Record<string, LockFileAgent>;
  tools: Record<string, LockFileTool>;
  integrity: string;
}

export interface LockFileAgent {
  version: string;
  source_hash: string;
  status: string;
}

export interface LockFileTool {
  source_hash: string;
}

// ─── Export Types ──────────────────────────────────────────────────────────

export interface ExportOptions {
  projectId: string;
  userId: string;
  tenantId: string;
  format: 'folder' | 'zip' | 'tar.gz';
  pinVersions?: boolean;
  versionManifest?: Record<string, string>;
  includeDeployments?: boolean;
  environments?: string[];
  dslFormat?: ExportDslFormat;
  compileFn?: (dsl: string) => Record<string, unknown> | null;
}

export interface ExportResult {
  success: boolean;
  manifest: ProjectManifest | null;
  files: Map<string, string>;
  lockfile: LockFile | null;
  warnings: string[];
  error?: { code: string; message: string };
}

// ─── Import Types ──────────────────────────────────────────────────────────

export interface ImportOptions {
  projectId: string;
  userId: string;
  tenantId: string;
  files: Map<string, string>;
}

export interface ImportPreview {
  valid: boolean;
  changes: {
    agents: {
      added: string[];
      modified: Array<{ name: string; diff: ABLDiffResult }>;
      removed: string[];
      unchanged: string[];
    };
    tools: {
      added: Array<{ name: string; toolType: string; sourceFile: string }>;
      modified: Array<{ name: string; toolType: string; sourceFile: string }>;
      removed: string[];
    };
    locales: {
      added: string[];
      modified: string[];
      removed: string[];
    };
    profiles: {
      added: string[];
      modified: string[];
      removed: string[];
    };
  };
  dependencyValidation: DependencyValidation;
  syntaxErrors: Array<{ file: string; errors: Array<{ line: number; message: string }> }>;
  warnings: string[];
}

// ─── Ownership Types ───────────────────────────────────────────────────────

export type AgentOperation = 'view' | 'edit' | 'deploy' | 'delete' | 'transfer_ownership';

export type PrincipalType = 'user' | 'team';

export interface PermissionGrant {
  principalType: PrincipalType;
  principalId: string;
  operations: AgentOperation[];
  grantedBy: string;
  expiresAt?: Date | null;
}

export type LockType = 'edit' | 'deploy';

// ─── Git Types ─────────────────────────────────────────────────────────────

export type GitProviderType = 'github' | 'gitlab' | 'bitbucket' | 'generic';
export type GitCredentialType = 'oauth' | 'token' | 'app';
export type ConflictStrategy = 'manual' | 'local_wins' | 'remote_wins';
export type SyncDirection = 'push' | 'pull';
export type SyncStatus = 'success' | 'failed' | 'conflict';

export interface GitFile {
  path: string;
  content: string;
  sha?: string;
}

export interface Committer {
  name: string;
  email: string;
}

export interface PullResult {
  files: GitFile[];
  commitSha: string;
  branch: string;
  /** Commits in the diff range (base..head). Used by branch-manager for ahead/behind counts. */
  commits?: Array<{ sha: string; message?: string }>;
}

export interface PushResult {
  commitSha: string;
  branch: string;
  url?: string;
}

export interface PushFilesOptions {
  deletedPaths?: string[];
}

export interface GitBranch {
  name: string;
  sha: string;
}

export interface PRParams {
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
}

export interface CreatePRResult {
  id: number;
  url: string;
  number: number;
}

export interface GitCommit {
  sha: string;
  message: string;
  author: Committer;
  date: string;
}

export interface ConflictDetail {
  agentName: string;
  file: string;
  baseContent: string | null;
  localContent: string;
  remoteContent: string;
}

export interface ConflictResolution {
  file: string;
  resolution: 'local' | 'remote' | 'merged';
  mergedContent?: string;
}

export interface GitSyncConfig {
  autoSync: boolean;
  autoDeploy: {
    enabled: boolean;
    environment: string;
    branch: string;
  } | null;
  conflictStrategy: ConflictStrategy;
}

export interface ChangesSummary {
  added: string[];
  modified: string[];
  deleted: string[];
}

// ─── Layer Types (v2) ─────────────────────────────────────────────────────

export type LayerName =
  | 'core'
  | 'connections'
  | 'prompts'
  | 'guardrails'
  | 'workflows'
  | 'evals'
  | 'search'
  | 'channels'
  | 'vocabulary';

export type ImportConflictStrategyV2 = 'replace' | 'skip' | 'merge';

export const LAYER_DEFAULTS: Record<LayerName, 'always' | 'on' | 'off'> = {
  core: 'always',
  connections: 'always',
  prompts: 'on',
  guardrails: 'on',
  workflows: 'on',
  evals: 'off',
  search: 'off',
  channels: 'off',
  vocabulary: 'off',
};

export const LAYER_SIZE_LIMITS: Record<LayerName, { entity: string; max: number }> = {
  core: { entity: 'agents', max: 1000 },
  connections: { entity: 'connections', max: 200 },
  prompts: { entity: 'prompts', max: 500 },
  guardrails: { entity: 'policies', max: 100 },
  workflows: { entity: 'workflows', max: 200 },
  evals: { entity: 'scenarios', max: 500 },
  search: { entity: 'indexes', max: 100 },
  channels: { entity: 'channels', max: 50 },
  vocabulary: { entity: 'entries', max: 10000 },
};

// ─── Export v2 Types ──────────────────────────────────────────────────────

export interface ExportOptionsV2 {
  projectId: string;
  userId: string;
  tenantId: string;
  format: 'folder' | 'zip' | 'tar.gz';
  layers: LayerName[];
  dslFormat?: ExportDslFormat;
  /** Archive format for project guardrail assets. Defaults to canonical JSON. */
  guardrailFormat?: GuardrailArchiveFormat;
  includeDeployments?: boolean;
  environments?: string[];
  compileFn?: (dsl: string) => Record<string, unknown> | null;
}

export interface LayerAssemblyMetadata {
  agents?: Array<{
    name: string;
    path: string;
    format: AgentArchiveFormat;
  }>;
  tools?: Array<{
    name: string;
    path: string;
  }>;
  profiles?: Array<{
    name: string;
    path: string;
  }>;
}

export interface LayerAssemblyResult {
  layer: LayerName;
  files: Map<string, string>;
  entityCount: number;
  warnings: string[];
  metadata?: LayerAssemblyMetadata;
}

// ─── Project Manifest v2 Types ────────────────────────────────────────────

export interface ProjectManifestV2 {
  format_version: '2.0';
  name: string;
  slug: string;
  description: string | null;
  abl_version: string;
  exported_at: string;
  exported_by: string;
  entry_agent: string | null;
  dsl_format: ProjectDslFormat;
  layers_included: LayerName[];
  agents: Record<string, ManifestAgent>;
  tools: Record<string, ManifestTool>;
  behavior_profiles?: Record<string, ManifestBehaviorProfile>;
  metadata: {
    entity_counts: Record<string, number>;
    required_env_vars: string[];
    required_connectors: string[];
    required_mcp_servers: string[];
    required_auth_profiles?: Array<{
      name: string;
      authType: string;
      scope: 'tenant' | 'project';
      connector?: string;
      category?: string;
      connectionMode?: 'shared' | 'per_user';
      config: Record<string, unknown>;
      referencedBy: string[];
    }>;
  };
}

// ─── Lock File v2 Types ───────────────────────────────────────────────────

export interface LockFileV2 {
  lockfile_version: '2.0';
  generated_at: string;
  agents: Record<string, { version: string; source_hash: string; status: string }>;
  tools: Record<string, { source_hash: string }>;
  configs: Record<string, { source_hash: string }>;
  connections: Record<string, { source_hash: string }>;
  guardrails: Record<string, { source_hash: string }>;
  workflows: Record<string, { source_hash: string; version?: string; status?: string }>;
  evals: Record<string, { source_hash: string }>;
  search: Record<string, { source_hash: string }>;
  channels: Record<string, { source_hash: string }>;
  vocabulary: Record<string, { source_hash: string }>;
  behavior_profiles?: Record<string, { source_hash: string }>;
  layer_hashes: Partial<Record<LayerName, string>>;
  integrity: string;
}

// ─── Export Result v2 ─────────────────────────────────────────────────────

export interface ExportResultV2 {
  success: boolean;
  manifest: ProjectManifestV2;
  files: Map<string, string>;
  lockfile: LockFileV2;
  warnings: string[];
  error?: { code: string; message: string };
}

// ─── Import v2 Types ──────────────────────────────────────────────────────

export type ImportPhase =
  | 'validating'
  | 'staging'
  | 'activating'
  | 'completed'
  | 'failed'
  | 'rolling_back'
  | 'reverted';

export type LayerImportStatus = 'pending' | 'staged' | 'activated' | 'rolled_back';

export interface ImportOperationState {
  projectId: string;
  tenantId: string;
  status: ImportPhase;
  layers: Record<string, { status: LayerImportStatus }>;
  stagedRecordIds: Record<string, string[]>;
  supersededRecordIds: Record<string, string[]>;
  error?: { phase: string; layer: string; message: string };
  createdAt: Date;
  expiresAt: Date;
}

// ─── Import v2 Orchestrator Types ──────────────────────────────────────

/**
 * Extended import phase type for v2 import orchestrator.
 * Adds 'queued', 'cancelled', and 'resolving_refs' phases to the base ImportPhase.
 * Coexists with ImportPhase — v1 import continues to use ImportPhase.
 */
export type ImportPhaseV2 =
  | 'queued'
  | 'validating'
  | 'staging'
  | 'resolving_refs'
  | 'activating'
  | 'completed'
  | 'failed'
  | 'rolling_back'
  | 'reverted'
  | 'cancelled';

export interface ImportV2ToolBindingSaveValidationInput {
  tenantId: string;
  projectId: string;
  toolType: 'http' | 'mcp' | 'sandbox' | 'searchai' | 'workflow';
  dslContent: string;
}

export type ImportV2ToolBindingSaveValidationResult =
  | { valid: true; dslContent?: string }
  | {
      valid: false;
      code?: string;
      status?: number;
      message: string;
    };

export type ImportV2ToolBindingSaveValidator = (
  input: ImportV2ToolBindingSaveValidationInput,
) => Promise<ImportV2ToolBindingSaveValidationResult>;

export type ImportBindingResolutionKind = 'searchai_index' | 'workflow_trigger';

export type ImportBindingResolutionAction = 'map_existing';

export interface ImportBindingResolutionRequest {
  id: string;
  kind: ImportBindingResolutionKind;
  toolName: string;
  toolType: 'searchai' | 'workflow';
  message: string;
  required: boolean;
  supportedActions: ImportBindingResolutionAction[];
  source: {
    tenantId?: string;
    indexId?: string;
    kbName?: string;
    workflowId?: string;
    workflowVersion?: string;
    triggerId?: string;
  };
}

export interface ImportBindingResolutionInput {
  action: ImportBindingResolutionAction;
  target?: {
    indexId?: string;
    workflowId?: string;
    workflowVersion?: string;
    triggerId?: string;
  };
}

export interface ImportV2RuntimeConfigSaveValidationInput {
  tenantId: string;
  projectId: string;
  data: Record<string, unknown>;
  sourceFile: string | null;
}

export type ImportV2RuntimeConfigSaveValidationResult =
  | { valid: true; data?: Record<string, unknown> }
  | {
      valid: false;
      code?: string;
      status?: number;
      message: string;
    };

export type ImportV2RuntimeConfigSaveValidator = (
  input: ImportV2RuntimeConfigSaveValidationInput,
) => Promise<ImportV2RuntimeConfigSaveValidationResult>;

export interface ImportOptionsV2 {
  projectId: string;
  tenantId: string;
  userId: string;
  /** Which layers to import. If omitted, auto-detected from folder contents. */
  layers?: LayerName[];
  /** Conflict strategy: replace full layers, skip existing matches, or merge/upsert matching records */
  conflictStrategy: ImportConflictStrategyV2;
  /** Whether to run validation only (dry-run preview) */
  dryRun: boolean;
  /** Auth profile ID mapping: exported profile name -> target profile ID */
  authProfileMapping?: Record<string, string>;
  /** User-selected binding resolutions keyed by ImportBindingResolutionRequest.id. */
  bindingResolutions?: Record<string, ImportBindingResolutionInput>;
  /** Canonical Studio/API tool binding validation for layered imports. */
  validateToolBindingForSave?: ImportV2ToolBindingSaveValidator;
  /** Canonical Studio/API runtime config validation/normalization for layered imports. */
  validateRuntimeConfigForSave?: ImportV2RuntimeConfigSaveValidator;
  /** Progress callback for async tracking */
  onProgress?: (event: ImportProgressEvent) => void;
}

export interface ImportProgressEvent {
  phase: ImportPhaseV2;
  layer?: LayerName;
  layerStatus?: LayerImportStatus;
  message: string;
  /** 0.0 to 1.0 */
  progress: number;
  timestamp: number;
}

export type ImportIssueSeverity = 'error' | 'warning' | 'info';
export type ImportIssueCategory =
  | 'general'
  | 'syntax'
  | 'tool'
  | 'compile'
  | 'dependency'
  | 'integrity'
  | 'entry_agent'
  | 'identity'
  | 'binding';

export interface ImportIssue {
  id: string;
  severity: ImportIssueSeverity;
  blocking: boolean;
  category: ImportIssueCategory;
  message: string;
  code?: string;
  file?: string;
  line?: number;
  agent?: string;
}

export interface ImportEntryAgentResolution {
  requested: string | null;
  resolved: string | null;
  matchedBy: 'exact' | 'alias' | 'missing' | 'none';
}

export interface ImportResultV2 {
  success: boolean;
  operationId: string;
  phase: ImportPhaseV2;
  preview: ImportPreviewV2;
  postImportReport?: {
    status: 'ready' | 'imported_with_warnings' | 'action_required';
    provisioning_required: {
      env_vars: string[];
      connectors_needing_credentials: string[];
      mcp_servers_needing_auth: string[];
      auth_profiles: Array<{ name: string; connectionMode?: 'shared' | 'per_user' }>;
    };
    warnings: string[];
    layer_summary: Record<string, { imported: number; skipped: number }>;
  };
  warnings: string[];
  error?: { code: string; message: string };
}

export interface ImportPreviewV2 {
  valid: boolean;
  formatVersion: '1.0' | '2.0';
  layers: LayerName[];
  /** Per-layer change summary */
  layerChanges: Partial<
    Record<
      LayerName,
      {
        added: number;
        modified: number;
        removed: number;
        unchanged: number;
      }
    >
  >;
  /** Detailed agent-level changes (same shape as v1 for backward compat) */
  agentChanges: ImportPreview['changes']['agents'];
  /** Detailed tool-level changes */
  toolChanges: {
    added: string[];
    modified: string[];
    removed: string[];
  };
  /** Detailed locale-file changes (canonical file paths under locales/) */
  localeChanges?: {
    added: string[];
    modified: string[];
    removed: string[];
  };
  /** Detailed behavior-profile file changes */
  profileChanges?: {
    added: string[];
    modified: string[];
    removed: string[];
  };
  /** SHA integrity check results */
  shaIntegrity: {
    valid: boolean;
    integrityMatch: boolean;
    layerResults: Record<string, { valid: boolean; mismatchedFiles: string[] }>;
    errors: string[];
    warnings: string[];
  };
  /** Cross-layer dependency validation results */
  crossLayerDeps: {
    valid: boolean;
    missingDependencies: Array<{
      source: string;
      sourceLayer: LayerName;
      target: string;
      targetLayer: LayerName;
      type: string;
    }>;
    warnings: string[];
  };
  syntaxErrors: Array<{ file: string; errors: Array<{ line: number; message: string }> }>;
  /** Imported bindings that need a target-project mapping before apply can proceed. */
  bindingResolutionRequests?: ImportBindingResolutionRequest[];
  issues: ImportIssue[];
  hasBlockingIssues: boolean;
  requiresAcknowledgement: boolean;
  blockingIssueCount: number;
  nonBlockingIssueCount: number;
  entryAgentResolution: ImportEntryAgentResolution;
  previewDigest?: string;
  warnings: string[];
}
