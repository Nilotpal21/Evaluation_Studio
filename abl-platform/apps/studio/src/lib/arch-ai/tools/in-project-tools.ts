/**
 * IN_PROJECT mode tool builder — contract 8 (in-project tools).
 * Used by the v4 message flow under apps/studio/src/app/api/arch-ai/message/route.ts.
 */

import { createHash, randomUUID } from 'node:crypto';
import { tool } from 'ai';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform/logger.js';
import type { CompilationError, CompilationOutput, CompilerOptions } from '@abl/compiler';
import { parseAgentBasedABL } from '@abl/core';
import { computeProjectAgentDraftSourceHash } from '@agent-platform/project-io/project-agent-draft-metadata';
import { behaviorProfileNameToConfigKey } from '@agent-platform/project-io';
import { withTransaction as defaultWithTransaction } from '@agent-platform/shared/repos';
import {
  ARCH_MUTATION_LOCK_TTL_MS,
  ARCH_MUTATION_LOCK_STALE_RECLAIM_MS,
} from '@agent-platform/config/constants';
import type { DiagnosticFinding, DiagnosticReport, ValidationIssue } from '@agent-platform/arch-ai';
import type { PageContext, PendingPlan, PendingPlanMutation } from '@agent-platform/arch-ai/types';
import { computeArchitecturePlans } from '@agent-platform/arch-ai/planning';
import {
  findAgentRefs,
  findCelVarRefs,
  findGatherFieldRefs,
  findMemoryRefs,
  findToolConsumers,
  type ProjectAgentReferenceSource,
} from '@agent-platform/arch-ai/references';
import { runFeasibilityChecks } from '@agent-platform/arch-ai/feasibility';
import {
  getCelGrammar,
  getConstructSpec,
  listValidCombinations,
  listFeasibilityChecks,
  lookupValidationCode,
} from '@agent-platform/arch-ai/knowledge';
import { renderKnownConstructsHint } from '@agent-platform/arch-ai/constructs';
import {
  sessionService,
  journalService,
  projectMemoryService,
} from '@/lib/arch-ai/message-services';
import { buildBuildTools } from '@/lib/arch-ai/tools/build-tools';
import {
  extractRoutingEdgesFromParsedDocument,
  type RoutingEdge as AgentDependencyEdge,
} from '@/lib/arch-ai/routing-edge-extraction';
import { executeProjectConfig } from '@/lib/arch-ai/tools/project-config';
import { TraceDiagnosisInputSchema } from '@/lib/arch-ai/tools/trace-diagnosis';
import { executeKBManage } from '@/lib/arch-ai/tools/kb-manage';
import { executeKBSearch } from '@/lib/arch-ai/tools/kb-search';
import { executeKBHealth } from '@/lib/arch-ai/tools/kb-health';
import { executeKBIngest } from '@/lib/arch-ai/tools/kb-ingest';
import { executeKBConnector } from '@/lib/arch-ai/tools/kb-connector';
import { executeKBDocuments } from '@/lib/arch-ai/tools/kb-documents';
import { extractMode, extractIsEntryPoint, extractToolNames } from '@/lib/arch-ai/topology-helpers';
import { invalidateProjectCaches } from '@/lib/arch-ai/tools/cache-invalidation';
import { refreshProjectAgentDraftMetadataForConfigMutation } from '@/lib/project-config-draft-invalidation';
import { connectionOpsInputSchema } from '@/lib/arch-ai/tools/connection-ops';
import { buildModelRecommendationInputFromAgent } from '@/lib/arch-ai/helpers/model-recommendation-input';
import { resolveArchModelPolicyDefaultsForProject } from '@/lib/arch-ai/model-policy-defaults';
import {
  checkArchMutationAllowed,
  checkToolPermission,
  isArchMutationAction,
  type ToolPermissionContext,
} from '@/lib/arch-ai/guards';
import { getRedisClient } from '@/lib/redis-client';

const log = createLogger('api:arch-ai:message');

const SearchFilterOperatorSchema = z.enum([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'not_in',
  'contains',
  'not_contains',
  'exists',
  'not_exists',
]);

const SearchFilterInputSchema = z.union([
  z.record(z.unknown()),
  z.array(
    z.object({
      field: z.string(),
      operator: SearchFilterOperatorSchema,
      value: z.unknown().optional(),
    }),
  ),
]);

const mcpServerOpsInputSchema = z.object({
  action: z.enum([
    'list',
    'read',
    'create',
    'update',
    'delete',
    'test_connection',
    'discover_preview',
    'import_tools',
    'list_tools',
    'test_tool',
  ]),
  serverId: z.string().optional().describe('MCP server ID'),
  name: z.string().optional().describe('MCP server display name'),
  description: z.string().optional(),
  transport: z.enum(['sse', 'http']).optional(),
  url: z.string().optional().describe('MCP server URL; env placeholders are allowed'),
  env: z.record(z.string()).optional().describe('Server environment variables'),
  authType: z
    .enum(['none', 'bearer', 'api_key', 'custom_headers', 'oauth2_client_credentials'])
    .optional(),
  authConfig: z
    .record(z.unknown())
    .optional()
    .describe('Non-secret MCP auth config such as headerName, tokenEndpoint, scopes'),
  headers: z.record(z.string()).optional().describe('Non-secret custom request headers'),
  priority: z.number().optional(),
  tags: z.array(z.string()).optional(),
  connectionTimeoutMs: z.number().optional(),
  requestTimeoutMs: z.number().optional(),
  autoReconnect: z.boolean().optional(),
  maxReconnectAttempts: z.number().optional(),
  flowId: z.string().optional().describe('Flow ID after collect_secret captures MCP auth secrets'),
  toolNames: z.array(z.string()).optional().describe('Specific MCP tool names to import'),
  toolName: z.string().optional().describe('MCP tool name for test_tool'),
  testInput: z.record(z.unknown()).optional().describe('Input payload for test_tool'),
  confirmed: z.boolean().optional().describe('Required true for delete'),
});

const externalAgentOpsInputSchema = z.object({
  action: z.enum([
    'list',
    'read',
    'discover_preview',
    'create',
    'update',
    'delete',
    'test_connection',
  ]),
  agentId: z.string().min(1).optional().describe('External agent config ID'),
  name: z
    .string()
    .min(1)
    .optional()
    .describe(
      'External agent name (required for create; used as alias for discover_preview/handoff)',
    ),
  displayName: z.string().nullable().optional(),
  endpoint: z
    .string()
    .min(1)
    .optional()
    .describe('Remote agent base URL (required for create + discover_preview)'),
  protocol: z.enum(['a2a', 'rest']).optional().describe('Wire protocol; defaults to a2a'),
  authType: z
    .enum(['none', 'bearer', 'api_key'])
    .optional()
    .describe('Auth type; non-secret fields go in authConfig, secrets via collect_secret/flowId'),
  authConfig: z
    .record(z.unknown())
    .optional()
    .describe('Non-secret auth config (e.g., custom header name for api_key)'),
  flowId: z
    .string()
    .optional()
    .describe('Flow ID after collect_secret captures external-agent auth secrets'),
  confirmed: z.boolean().optional().describe('Required true for delete'),
});

const PLAN_CONSTRUCTS = [
  'AGENT',
  'SUPERVISOR',
  'GOAL',
  'PERSONA',
  'MEMORY',
  'GATHER',
  'COMPLETE',
  'FLOW',
  'HANDOFF',
  'DELEGATE',
  'ON_RETURN',
  'TOOLS',
  'GUARDRAILS',
  'CONSTRAINTS',
  'RECALL',
  'EXECUTION',
  'MODEL',
  'VOICE',
  'EVENTS',
  'CHANNELS',
] as const;

const planMutationInputSchema = z.object({
  sourceTool: z.string().min(1),
  sourceAction: z.string().min(1),
  targetKind: z.enum([
    'agent_dsl',
    'agent_topology',
    'project_memory',
    'tool_binding',
    'project_config',
    'integration_config',
    'test_or_eval',
  ]),
  operation: z.enum(['create', 'modify', 'delete', 'rename', 'apply']),
  agentName: z.string().min(1).optional(),
  targetId: z.string().min(1).optional(),
  rationale: z.string().min(1).optional(),
});

const planSectionChangeInputSchema = z.object({
  agentName: z.string().min(1).max(128),
  construct: z.enum(PLAN_CONSTRUCTS),
  operation: z.enum(['create', 'modify', 'delete', 'rename']),
  reason: z.string().min(1).max(1000),
});

const planReferenceInputSchema = z.object({
  kind: z.enum(['memory', 'gather_field', 'tool', 'agent', 'cel_var']),
  sourceAgent: z.string().min(1).max(128),
  targetAgent: z.string().min(1).max(128).optional(),
  fieldName: z.string().min(1).max(128).optional(),
  toolName: z.string().min(1).max(128).optional(),
  variableName: z.string().min(1).max(128).optional(),
  detail: z.string().min(1).max(1000).optional(),
});

const planRiskInputSchema = z.object({
  severity: z.enum(['low', 'medium', 'high']),
  description: z.string().min(1).max(1000),
  mitigation: z.string().min(1).max(1000),
});

const proposePlanInputSchema = z.object({
  title: z.string().min(1).max(160),
  goal: z.string().min(1).max(1000),
  summary: z.string().min(1).max(2000),
  architecturalPattern: z.string().min(1).max(300),
  evidence: z.array(z.string().min(1).max(1000)).min(1).max(20),
  affectedAgents: z.array(z.string().min(1).max(128)).max(50).default([]),
  sectionsToChange: z.array(planSectionChangeInputSchema).min(1).max(50),
  dependentsAnalysis: z.object({
    summary: z.string().min(1).max(1500),
    referencesFound: z.array(planReferenceInputSchema).max(100).default([]),
  }),
  alternativesConsidered: z
    .array(
      z.object({
        option: z.string().min(1).max(1000),
        rejectedBecause: z.string().min(1).max(1000),
      }),
    )
    .min(1)
    .max(10),
  citations: z
    .array(
      z.object({
        sourceType: z.enum([
          'construct_spec',
          'validation_code',
          'topology_pattern',
          'reference_analysis',
          'feasibility_check',
          'runtime_context',
          'tool_readiness',
        ]),
        reference: z.string().min(1).max(300),
        relevance: z.string().min(1).max(1000),
      }),
    )
    .min(1)
    .max(30),
  plannedMutations: z.array(planMutationInputSchema).min(1).max(50),
  risks: z.array(planRiskInputSchema).min(1).max(20),
  questionsForUser: z.array(z.string().min(1).max(1000)).max(10).optional(),
  validationNotes: z.array(z.string().min(1).max(1000)).max(20).default([]),
});

type ProposePlanInput = z.infer<typeof proposePlanInputSchema>;

// ─── Private helpers ────────────────────────────────────────────────────────

/** Rough heuristic based on line-count delta (not edit distance). */
export function classifyMutationScope(before: string, after: string): 'SMALL' | 'MEDIUM' | 'LARGE' {
  const lineDelta = Math.abs(after.split('\n').length - before.split('\n').length);

  if (lineDelta <= 20) {
    return 'SMALL';
  }
  if (lineDelta <= 100) {
    return 'MEDIUM';
  }
  return 'LARGE';
}

function hasTopologyEdgeChanges(impact: {
  topology: { addedEdges: unknown[]; removedEdges: unknown[] };
}): boolean {
  return impact.topology.addedEdges.length > 0 || impact.topology.removedEdges.length > 0;
}

function normalizeAgentNameForEditorScope(agentName: string): string {
  return agentName.trim();
}

function normalizePlannerExecutionMode(
  mode: ReturnType<typeof extractMode>,
): 'reasoning' | 'scripted' | 'hybrid' {
  return mode === 'scripted' || mode === 'hybrid' ? mode : 'reasoning';
}

function normalizePlanAgentName(name: string): string {
  return name.trim().toLowerCase();
}

function normalizeCatalogReference(reference: string): string {
  const trimmed = reference.trim();
  const separatorIndex = trimmed.indexOf(':');
  return (separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed).trim();
}

function isKnownPlanConstruct(reference: string): boolean {
  const normalized = normalizeCatalogReference(reference).toUpperCase();
  return (
    Boolean(getConstructSpec(normalized)) ||
    PLAN_CONSTRUCTS.includes(normalized as (typeof PLAN_CONSTRUCTS)[number])
  );
}

function validatePlanDraft(input: ProposePlanInput, knownAgentNames: string[]): string[] {
  const errors: string[] = [];
  const knownAgents = new Set(knownAgentNames.map(normalizePlanAgentName));
  const hasKnownAgents = knownAgents.size > 0;
  const knownFeasibilityChecks = new Set(listFeasibilityChecks().map((check) => check.name));
  const sectionAgents = new Set(
    input.sectionsToChange.map((section) => normalizePlanAgentName(section.agentName)),
  );

  const requireKnownAgent = (agentName: string, path: string): void => {
    if (hasKnownAgents && !knownAgents.has(normalizePlanAgentName(agentName))) {
      errors.push(`${path} references unknown agent "${agentName}".`);
    }
  };

  for (const [index, agentName] of input.affectedAgents.entries()) {
    requireKnownAgent(agentName, `affectedAgents[${index}]`);
  }
  for (const [index, section] of input.sectionsToChange.entries()) {
    requireKnownAgent(section.agentName, `sectionsToChange[${index}].agentName`);
    if (!isKnownPlanConstruct(section.construct)) {
      errors.push(
        `sectionsToChange[${index}].construct references unknown ABL construct "${section.construct}". Use Knowledge Spine constructs, not legacy or invented DSL blocks.`,
      );
    }
  }
  for (const [index, mutation] of input.plannedMutations.entries()) {
    if (mutation.agentName) {
      requireKnownAgent(mutation.agentName, `plannedMutations[${index}].agentName`);
      if (!sectionAgents.has(normalizePlanAgentName(mutation.agentName))) {
        errors.push(
          `plannedMutations[${index}] targets "${mutation.agentName}" but sectionsToChange does not include that agent.`,
        );
      }
    }
  }
  for (const [index, reference] of input.dependentsAnalysis.referencesFound.entries()) {
    requireKnownAgent(
      reference.sourceAgent,
      `dependentsAnalysis.referencesFound[${index}].sourceAgent`,
    );
    if (reference.targetAgent) {
      requireKnownAgent(
        reference.targetAgent,
        `dependentsAnalysis.referencesFound[${index}].targetAgent`,
      );
    }
  }
  for (const [index, citation] of input.citations.entries()) {
    const citationRef = normalizeCatalogReference(citation.reference);
    if (citation.sourceType === 'construct_spec' && !isKnownPlanConstruct(citationRef)) {
      errors.push(`citations[${index}] references unknown construct_spec "${citation.reference}".`);
    }
    if (citation.sourceType === 'validation_code' && !lookupValidationCode(citationRef)) {
      errors.push(
        `citations[${index}] references unknown validation_code "${citation.reference}".`,
      );
    }
    if (citation.sourceType === 'feasibility_check' && !knownFeasibilityChecks.has(citationRef)) {
      errors.push(
        `citations[${index}] references unknown feasibility_check "${citation.reference}".`,
      );
    }
  }

  return errors;
}

function getEditorModeAgentName(pageContext?: PageContext | null): string | null {
  if (pageContext?.surface !== 'agent-editor') {
    return null;
  }

  if (pageContext.entity?.type !== 'agent') {
    return '';
  }

  return normalizeAgentNameForEditorScope(pageContext.entity.name ?? pageContext.entity.id);
}

function buildEditorScopeError(message: string) {
  return {
    success: false,
    error: {
      code: 'EDITOR_SCOPE_ESCALATION_REQUIRED',
      message,
    },
  };
}

function enforceEditorModeAgentTarget(
  pageContext: PageContext | null | undefined,
  agentName: string,
) {
  const editorAgentName = getEditorModeAgentName(pageContext);
  if (editorAgentName === null) {
    return null;
  }

  const requested = normalizeAgentNameForEditorScope(agentName);
  if (editorAgentName.length === 0 || requested !== editorAgentName) {
    return buildEditorScopeError(
      'Editor-mode Arch can only modify the agent currently open in the DSL editor. Open project Arch for cross-agent edits.',
    );
  }

  return null;
}

export function classifyAgentMutationScope(params: {
  before: string;
  after: string;
  isNew?: boolean;
  impact: { topology: { addedEdges: unknown[]; removedEdges: unknown[] } };
}): 'SMALL' | 'MEDIUM' | 'LARGE' {
  if (params.isNew === true || hasTopologyEdgeChanges(params.impact)) {
    return 'LARGE';
  }

  return classifyMutationScope(params.before, params.after);
}

export function buildProposalResponseMessage(
  action: 'accept' | 'modify' | 'reject',
  target?: string,
  feedback?: string,
): string {
  const targetLabel = target ? ` for ${target}` : '';

  switch (action) {
    case 'accept':
      return `Accepted the proposed changes${targetLabel}.`;
    case 'reject':
      return `Rejected the proposed changes${targetLabel}.`;
    case 'modify':
      return `Requested revisions to the proposed changes${targetLabel}: ${feedback ?? 'Please revise the proposal.'}`;
  }
}

type ProjectAgentValidationResult =
  | {
      valid: true;
      warnings: ValidationIssue[];
      agentsInScope: number;
    }
  | {
      valid: false;
      errors: ValidationIssue[];
      warnings: ValidationIssue[];
      hint?: string;
    };

interface ParsedAgentImpact {
  recordName: string;
  declaredName: string;
  type: 'agent' | 'supervisor';
  tools: string[];
  edges: AgentDependencyEdge[];
}

interface AgentChangeImpact {
  runtimeReady: boolean;
  summary: string;
  changedAgent: string;
  declaredAgentName: string;
  impactedAgents: string[];
  rename?: {
    from: string;
    to: string;
    cascadeAgents: string[];
    referenceUpdates: Array<{ agent: string; from: string; to: string; count: number }>;
  };
  topology: {
    incomingBefore: AgentDependencyEdge[];
    incomingAfter: AgentDependencyEdge[];
    outgoingBefore: AgentDependencyEdge[];
    outgoingAfter: AgentDependencyEdge[];
    addedEdges: AgentDependencyEdge[];
    removedEdges: AgentDependencyEdge[];
  };
  tools: {
    before: string[];
    after: string[];
    added: string[];
    removed: string[];
    unresolved: string[];
  };
  nextActions: string[];
}

interface ProjectAgentRecord {
  [key: string]: unknown;
  _id?: unknown;
  id?: string;
  name: string;
  dslContent?: string;
  description?: string;
}

type QueryLike<T> = PromiseLike<T> & {
  lean?: () => Promise<T>;
};

interface ProjectAgentModelLike {
  find(
    filter: Record<string, unknown>,
    projection?: unknown,
    options?: Record<string, unknown>,
  ): QueryLike<ProjectAgentRecord[]> | Promise<ProjectAgentRecord[]> | ProjectAgentRecord[];
  findOne(
    filter: Record<string, unknown>,
    projection?: unknown,
    options?: Record<string, unknown>,
  ): Promise<(ProjectAgentRecord & Record<string, unknown>) | null>;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
}

interface ProjectModelLike {
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
}

interface AgentVersionModelLike {
  create(payload: unknown, options?: Record<string, unknown>): Promise<unknown>;
}

async function resolveProjectAgentFindResult(
  result: ReturnType<ProjectAgentModelLike['find']>,
): Promise<ProjectAgentRecord[]> {
  if (Array.isArray(result)) {
    return result;
  }
  const maybeLeanQuery = result as { lean?: unknown };
  if (typeof maybeLeanQuery.lean === 'function') {
    return (maybeLeanQuery.lean as () => Promise<ProjectAgentRecord[]>)();
  }
  return await result;
}

interface InProjectToolDependencyOverrides {
  projectAgentModel?: ProjectAgentModelLike;
  projectModel?: ProjectModelLike;
  agentVersionModel?: AgentVersionModelLike;
  resolveToolImplementations?: typeof import('@agent-platform/shared/tools/resolve').resolveToolImplementations;
  findMcpServerConfigsByProject?: typeof import('@agent-platform/shared/repos').findMcpServerConfigsByProject;
  withTransaction?: typeof defaultWithTransaction;
  findProjectAgent?: typeof import('@/repos/project-repo').findProjectAgent;
  addAgentToProject?: typeof import('@/services/project-service').addAgentToProject;
  buildProjectAgentPath?: typeof import('@/services/project-service').buildProjectAgentPath;
  refreshPersistedStudioProjectAgentDraftMetadata?: typeof import('@/lib/abl/project-agent-draft-metadata').refreshPersistedStudioProjectAgentDraftMetadata;
  compileABLtoIR?: typeof import('@abl/compiler').compileABLtoIR;
  runProjectDiagnostics?: (compiled: CompilationOutput) => Promise<DiagnosticFinding[]>;
}

let inProjectToolDependencyOverrides: InProjectToolDependencyOverrides = {};

export function __setInProjectToolTestDeps(deps: InProjectToolDependencyOverrides): () => void {
  const previous = inProjectToolDependencyOverrides;
  inProjectToolDependencyOverrides = deps;
  return () => {
    inProjectToolDependencyOverrides = previous;
  };
}

function getInProjectToolDeps(): Required<
  Pick<InProjectToolDependencyOverrides, 'withTransaction'>
> {
  return {
    withTransaction: inProjectToolDependencyOverrides.withTransaction ?? defaultWithTransaction,
  };
}

async function getProjectAgentModel(): Promise<ProjectAgentModelLike> {
  if (inProjectToolDependencyOverrides.projectAgentModel) {
    return inProjectToolDependencyOverrides.projectAgentModel;
  }
  const { ProjectAgent } = await import('@agent-platform/database/models');
  return ProjectAgent as ProjectAgentModelLike;
}

async function getProjectModel(): Promise<ProjectModelLike> {
  if (inProjectToolDependencyOverrides.projectModel) {
    return inProjectToolDependencyOverrides.projectModel;
  }
  const { Project } = await import('@agent-platform/database/models');
  return Project as ProjectModelLike;
}

async function getAgentVersionModel(): Promise<AgentVersionModelLike> {
  if (inProjectToolDependencyOverrides.agentVersionModel) {
    return inProjectToolDependencyOverrides.agentVersionModel;
  }
  const { AgentVersion } = await import('@agent-platform/database/models');
  return AgentVersion as AgentVersionModelLike;
}

async function resolveToolImplementationsForValidation(
  ...args: Parameters<
    typeof import('@agent-platform/shared/tools/resolve').resolveToolImplementations
  >
): ReturnType<typeof import('@agent-platform/shared/tools/resolve').resolveToolImplementations> {
  const resolver = inProjectToolDependencyOverrides.resolveToolImplementations;
  if (resolver) {
    return resolver(...args);
  }
  const { resolveToolImplementations } = await import('@agent-platform/shared/tools/resolve');
  return resolveToolImplementations(...args);
}

async function findMcpServerConfigsForValidation(
  tenantId: string,
  projectId: string,
): ReturnType<typeof import('@agent-platform/shared/repos').findMcpServerConfigsByProject> {
  const loader = inProjectToolDependencyOverrides.findMcpServerConfigsByProject;
  if (loader) {
    return loader(tenantId, projectId);
  }
  const { findMcpServerConfigsByProject } = await import('@agent-platform/shared/repos');
  return findMcpServerConfigsByProject(tenantId, projectId);
}

async function getProjectAgentCreateDeps(): Promise<{
  findProjectAgent: NonNullable<InProjectToolDependencyOverrides['findProjectAgent']>;
  addAgentToProject: NonNullable<InProjectToolDependencyOverrides['addAgentToProject']>;
}> {
  const findProjectAgent = inProjectToolDependencyOverrides.findProjectAgent;
  const addAgentToProject = inProjectToolDependencyOverrides.addAgentToProject;
  if (findProjectAgent && addAgentToProject) {
    return { findProjectAgent, addAgentToProject };
  }

  const projectRepo = await import('@/repos/project-repo');
  const projectService = await import('@/services/project-service');
  return {
    findProjectAgent: findProjectAgent ?? projectRepo.findProjectAgent,
    addAgentToProject: addAgentToProject ?? projectService.addAgentToProject,
  };
}

async function getProjectAgentApplyDeps(): Promise<{
  buildProjectAgentPath: NonNullable<InProjectToolDependencyOverrides['buildProjectAgentPath']>;
  refreshPersistedStudioProjectAgentDraftMetadata: NonNullable<
    InProjectToolDependencyOverrides['refreshPersistedStudioProjectAgentDraftMetadata']
  >;
}> {
  const buildProjectAgentPath = inProjectToolDependencyOverrides.buildProjectAgentPath;
  const refreshPersistedStudioProjectAgentDraftMetadata =
    inProjectToolDependencyOverrides.refreshPersistedStudioProjectAgentDraftMetadata;
  if (buildProjectAgentPath && refreshPersistedStudioProjectAgentDraftMetadata) {
    return { buildProjectAgentPath, refreshPersistedStudioProjectAgentDraftMetadata };
  }

  const projectService = await import('@/services/project-service');
  const draftMetadata = await import('@/lib/abl/project-agent-draft-metadata');
  return {
    buildProjectAgentPath: buildProjectAgentPath ?? projectService.buildProjectAgentPath,
    refreshPersistedStudioProjectAgentDraftMetadata:
      refreshPersistedStudioProjectAgentDraftMetadata ??
      draftMetadata.refreshPersistedStudioProjectAgentDraftMetadata,
  };
}

async function getCompileABLtoIR(): Promise<typeof import('@abl/compiler').compileABLtoIR> {
  if (inProjectToolDependencyOverrides.compileABLtoIR) {
    return inProjectToolDependencyOverrides.compileABLtoIR;
  }
  const { compileABLtoIR } = await import('@abl/compiler');
  return compileABLtoIR;
}

interface MutationLockValue {
  tenantId: string;
  projectId: string;
  agentName: string;
  sessionId: string;
  proposalRef: string;
  acquiredAt: string;
}

interface MutationLockRedis {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    modeOrExpiry?: string,
    ttlOrMode?: number | string,
    mode?: string,
  ): Promise<'OK' | null>;
  eval(script: string, keyCount: number, key: string, sessionId: string): Promise<unknown>;
}

function diagnosticFindingKey(finding: DiagnosticFinding): string {
  // Stability-first identity: identical (severity, code, owner, category,
  // path) means "same defect at the same location". `finding.message` is
  // INTENTIONALLY excluded — many cross-agent rules (e.g. CO-04) embed the
  // sibling agent's name in their message text. On rename, the message
  // changes even though the underlying defect at the SAME path on the SAME
  // owner agent is unchanged, which would falsely flag the finding as
  // `introduced: true` in the propose-edit diff. `path` is now populated for
  // most findings (see fix-up §1 for the IR path emission), giving us a
  // stable per-defect locator without relying on message text. Empty-string
  // path is the fallback for project-level findings that don't carry one.
  return [
    finding.severity,
    finding.code,
    finding.agentName ?? '_project',
    finding.category,
    finding.path ?? '',
  ].join('|');
}

function mutationLockKey(params: {
  tenantId: string;
  projectId: string;
  agentName: string;
}): string {
  const encodedAgentName = Buffer.from(normalizeAgentNameForEditorScope(params.agentName), 'utf8')
    .toString('base64url')
    .replace(/=+$/g, '');
  return `arch:tenant:${params.tenantId}:project:${params.projectId}:agent:${encodedAgentName}:mutation_lock`;
}

function parseMutationLockValue(raw: string | null): MutationLockValue | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<MutationLockValue>;
    if (
      typeof parsed.sessionId === 'string' &&
      typeof parsed.proposalRef === 'string' &&
      typeof parsed.agentName === 'string'
    ) {
      return parsed as MutationLockValue;
    }
  } catch {
    return null;
  }
  return null;
}

function allowMutationWithoutRedis(): boolean {
  return process.env.ARCH_MUTATION_LOCK_REDIS_OPTIONAL === 'true';
}

async function acquireMutationLock(params: {
  tenantId: string;
  projectId: string;
  agentName: string;
  sessionId: string;
}): Promise<{ acquired: true; proposalRef: string } | { acquired: false; error: unknown }> {
  const redis = getRedisClient() as MutationLockRedis | null;
  if (!redis) {
    if (allowMutationWithoutRedis()) {
      log.warn('Redis unavailable; proceeding without Arch mutation lock by explicit opt-out', {
        projectId: params.projectId,
        agentName: params.agentName,
        sessionId: params.sessionId,
      });
      return { acquired: true, proposalRef: `proposal_${randomUUID()}` };
    }

    log.error('Redis unavailable; blocking Arch mutation lock acquisition', {
      projectId: params.projectId,
      agentName: params.agentName,
      sessionId: params.sessionId,
    });
    return {
      acquired: false,
      error: {
        code: 'MUTATION_LOCK_UNAVAILABLE',
        message:
          'Arch cannot safely prepare this change because the mutation lock service is unavailable. Please retry when the service is healthy.',
      },
    };
  }

  const key = mutationLockKey(params);
  const existing = parseMutationLockValue(await redis.get(key));
  if (existing && existing.sessionId === params.sessionId) {
    await redis.set(key, JSON.stringify(existing), 'PX', ARCH_MUTATION_LOCK_TTL_MS);
    return { acquired: true, proposalRef: existing.proposalRef };
  }
  if (existing) {
    // Different session owns the lock. Before returning MUTATION_LOCKED,
    // soft-reclaim if the lock looks abandoned: acquiredAt older than the
    // reclaim threshold means the owning session never released (browser
    // closed, force-archived stuck session, network blip during apply).
    // The Redis TTL is a longer hard ceiling; this catches the in-window
    // abandoned case so a new session can make progress.
    const acquiredMs = Date.parse(existing.acquiredAt);
    const ageMs = Number.isFinite(acquiredMs) ? Date.now() - acquiredMs : 0;
    if (Number.isFinite(acquiredMs) && ageMs > ARCH_MUTATION_LOCK_STALE_RECLAIM_MS) {
      log.warn('Reclaiming stale Arch mutation lock from previous session', {
        projectId: params.projectId,
        agentName: params.agentName,
        previousSessionId: existing.sessionId,
        previousProposalRef: existing.proposalRef,
        ageMs,
        thresholdMs: ARCH_MUTATION_LOCK_STALE_RECLAIM_MS,
        sessionId: params.sessionId,
      });
      // Fall through to create a fresh lock below. We use SET (no NX) so
      // the new owner overwrites the abandoned value atomically.
      const proposalRef = `proposal_${randomUUID()}`;
      const value: MutationLockValue = {
        tenantId: params.tenantId,
        projectId: params.projectId,
        agentName: normalizeAgentNameForEditorScope(params.agentName),
        sessionId: params.sessionId,
        proposalRef,
        acquiredAt: new Date().toISOString(),
      };
      await redis.set(key, JSON.stringify(value), 'PX', ARCH_MUTATION_LOCK_TTL_MS);
      return { acquired: true, proposalRef };
    }
    return {
      acquired: false,
      error: {
        code: 'MUTATION_LOCKED',
        message:
          'Another Arch session is already preparing changes for this agent. Finish or discard that proposal before starting a new one.',
        proposalRef: existing.proposalRef,
      },
    };
  }

  const proposalRef = `proposal_${randomUUID()}`;
  const value: MutationLockValue = {
    tenantId: params.tenantId,
    projectId: params.projectId,
    agentName: normalizeAgentNameForEditorScope(params.agentName),
    sessionId: params.sessionId,
    proposalRef,
    acquiredAt: new Date().toISOString(),
  };
  const result = await redis.set(key, JSON.stringify(value), 'PX', ARCH_MUTATION_LOCK_TTL_MS, 'NX');
  if (result === 'OK') {
    return { acquired: true, proposalRef };
  }

  const winner = parseMutationLockValue(await redis.get(key));
  return {
    acquired: false,
    error: {
      code: 'MUTATION_LOCKED',
      message:
        'Another Arch session is already preparing changes for this agent. Finish or discard that proposal before starting a new one.',
      proposalRef: winner?.proposalRef,
    },
  };
}

async function releaseMutationLock(params: {
  tenantId: string;
  projectId: string;
  agentName: string;
  sessionId: string;
}): Promise<void> {
  const redis = getRedisClient() as MutationLockRedis | null;
  if (!redis) {
    return;
  }
  const key = mutationLockKey(params);
  await redis.eval(
    `
      local v = redis.call('GET', KEYS[1])
      if not v then return 0 end
      local ok, decoded = pcall(cjson.decode, v)
      if not ok or type(decoded) ~= 'table' then return 0 end
      if decoded.sessionId ~= ARGV[1] then return 0 end
      return redis.call('DEL', KEYS[1])
    `,
    1,
    key,
    params.sessionId,
  );
}

function collectDiagnosticFindings(report: DiagnosticReport): DiagnosticFinding[] {
  const findings = [...report.sections.flatMap((section) => section.findings), ...report.topIssues];
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = diagnosticFindingKey(finding);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function runProjectDiagnostics(compiled: CompilationOutput): Promise<DiagnosticFinding[]> {
  if (inProjectToolDependencyOverrides.runProjectDiagnostics) {
    return inProjectToolDependencyOverrides.runProjectDiagnostics(compiled);
  }
  const { runDiagnostics } = await import('@agent-platform/arch-ai');
  return collectDiagnosticFindings(
    runDiagnostics(compiled, {
      depth: 'deep',
      maxFindings: 200,
    }),
  );
}

function isFindingRelevantToAgent(finding: DiagnosticFinding, agentName: string): boolean {
  return finding.agentName === agentName || finding.message.includes(`"${agentName}"`);
}

function isRuntimeReadinessDiagnostic(finding: DiagnosticFinding): boolean {
  return finding.code === 'T-04' && finding.category === 'tool';
}

function toDiagnosticValidationIssue(
  finding: DiagnosticFinding,
  prefix: string,
  severity: ValidationIssue['severity'] = 'warning',
  introduced?: boolean,
): ValidationIssue {
  // Compose the message: code + prefix + finding text, then append the fix
  // description and (when present) the ABL template snippet on its own block
  // so the LLM can copy/paste it during repair. The 20 codes that ship with
  // FIX_MAP templates rely on this passthrough — `description` alone tells the
  // LLM what to do, but the template tells it exactly how.
  let message = `[${finding.code}] ${prefix}${finding.message}`;
  if (finding.fix) {
    message += ` Fix: ${finding.fix.description}`;
    if (finding.fix.template) {
      message += `\nTemplate:\n${finding.fix.template}`;
    }
  }
  return {
    message,
    severity,
    source: 'diagnostics',
    agent: finding.agentName ?? undefined,
    path: finding.path,
    introduced,
  };
}

function compilationIssueKey(issue: CompilationError): string {
  return [
    issue.agent ?? '_project',
    issue.code ?? '_code',
    issue.path ?? '_path',
    issue.referenced_agent ?? '_ref',
    issue.type,
    issue.code || issue.path ? '' : issue.message,
  ].join('|');
}

function isCompilationIssueRelevantToAgent(issue: CompilationError, agentName: string): boolean {
  return (
    issue.agent === agentName ||
    issue.referenced_agent === agentName ||
    issue.message.includes(`"${agentName}"`) ||
    issue.message.includes(`'${agentName}'`)
  );
}

function toCompilationValidationIssue(
  issue: CompilationError,
  agentName: string,
  severity: ValidationIssue['severity'],
  prefix = '',
): ValidationIssue {
  return {
    message: `${prefix}${issue.message}`,
    severity,
    source: 'compile',
    agent: issue.agent && issue.agent !== agentName ? issue.agent : undefined,
    path: issue.path,
  };
}

function rewriteAgentDeclarationName(code: string, newName: string): string {
  return code.replace(/^(\s*(?:AGENT|SUPERVISOR)\s*:\s*)\S+/m, `$1${escapeReplacement(newName)}`);
}

export async function validateProjectAgentCode(
  ctx: { tenantId: string; userId: string; permissions?: string[] },
  projectId: string,
  agentName: string,
  code: string,
): Promise<ProjectAgentValidationResult> {
  const compileABLtoIR = await getCompileABLtoIR();
  const ProjectAgent = await getProjectAgentModel();

  const parseResult = parseAgentBasedABL(code);
  const parseErrors: ValidationIssue[] = (parseResult.errors ?? []).map(
    (e: { line?: number; message: string }) => ({
      line: typeof e.line === 'number' ? e.line : undefined,
      message: e.message,
      severity: 'error' as const,
      source: 'parse' as const,
    }),
  );

  if (parseErrors.length > 0) {
    return {
      valid: false,
      errors: parseErrors,
      warnings: [],
      hint: `${renderKnownConstructsHint()} Check your syntax.`,
    };
  }

  if (!parseResult.document) {
    return {
      valid: false,
      errors: [
        {
          message:
            'No AGENT: or SUPERVISOR: declaration found. ABL requires UPPERCASE construct keywords.',
          severity: 'error',
          source: 'parse',
        },
      ],
      warnings: [],
      hint: 'Use AGENT: AgentName (not agent: name: AgentName)',
    };
  }

  const projectAgents = (await ProjectAgent.find({
    projectId,
    tenantId: ctx.tenantId,
  })) as ProjectAgentRecord[];

  const proposedAgentName = parseResult.document.name;
  const isRenameProposal = proposedAgentName !== agentName;
  if (isRenameProposal && !AGENT_NAME_PATTERN.test(proposedAgentName)) {
    return {
      valid: false,
      errors: [
        {
          message: `New agent name "${proposedAgentName}" must match ${AGENT_NAME_PATTERN.source}`,
          severity: 'error',
          source: 'parse',
        },
      ],
      warnings: [],
    };
  }

  const allDocs = [parseResult.document];
  const comparisonProjectDocs: NonNullable<typeof parseResult.document>[] = [];
  const contextWarnings: ValidationIssue[] = [];
  for (const agent of projectAgents) {
    if (!agent.dslContent) {
      continue;
    }

    const isEditedAgent = agent.name === agentName;
    try {
      const currentParse = parseAgentBasedABL(agent.dslContent);
      if ((currentParse.errors ?? []).length > 0 && !isEditedAgent) {
        contextWarnings.push({
          message: `Existing sibling agent "${agent.name ?? 'unknown'}" has parse errors; full project runtime validation is incomplete until that agent is fixed.`,
          severity: 'warning',
          source: 'parse',
          agent: agent.name,
        });
      }
      if (currentParse.document) {
        const comparisonDsl = isRenameProposal
          ? isEditedAgent
            ? rewriteAgentDeclarationName(agent.dslContent, proposedAgentName)
            : agent.dslContent.replace(
                buildHandoffRenamePattern(agentName),
                `$1${escapeReplacement(proposedAgentName)}`,
              )
          : agent.dslContent;
        const comparisonParse =
          comparisonDsl === agent.dslContent ? currentParse : parseAgentBasedABL(comparisonDsl);
        if ((comparisonParse.errors ?? []).length > 0) {
          contextWarnings.push({
            message: `Existing agent "${agent.name ?? 'unknown'}" could not be parsed in the comparison baseline; full project runtime validation is incomplete until that agent is fixed.`,
            severity: 'warning',
            source: 'parse',
            agent: agent.name,
          });
        }
        if (comparisonParse.document) {
          comparisonProjectDocs.push(comparisonParse.document);
        }
        if (!isEditedAgent) {
          const siblingDslForAfter = isRenameProposal
            ? agent.dslContent.replace(
                buildHandoffRenamePattern(agentName),
                `$1${escapeReplacement(proposedAgentName)}`,
              )
            : agent.dslContent;
          const afterParse =
            siblingDslForAfter === agent.dslContent
              ? currentParse
              : parseAgentBasedABL(siblingDslForAfter);
          if ((afterParse.errors ?? []).length > 0) {
            contextWarnings.push({
              message: `Existing sibling agent "${agent.name ?? 'unknown'}" could not be parsed after planned rename cascade; full project runtime validation is incomplete until that agent is fixed.`,
              severity: 'warning',
              source: 'parse',
              agent: agent.name,
            });
          }
          if (afterParse.document) {
            allDocs.push(afterParse.document);
          }
        }
      }
    } catch (err: unknown) {
      if (!isEditedAgent) {
        contextWarnings.push({
          message: `Existing sibling agent "${agent.name ?? 'unknown'}" could not be parsed; full project runtime validation is incomplete until that agent is fixed.`,
          severity: 'warning',
          source: 'parse',
          agent: agent.name,
        });
      }
      log.warn('Skipping agent with parse errors during validation', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const compilerOptions: CompilerOptions = { mode: 'preview' };
  const targetToolNames = extractToolNamesFromParsedDocument(parseResult.document);
  let resolvedToolNames: string[] = [];
  if (targetToolNames.length > 0) {
    try {
      const { buildModuleToolResolver } =
        await import('@agent-platform/shared/tools/resolve-module-tool');
      const resolved = await resolveToolImplementationsForValidation(
        {
          tenantId: ctx.tenantId,
          projectId,
          toolsByAgent: new Map([[parseResult.document.name, targetToolNames]]),
        },
        {
          mcpServerConfigLoader: (tenantId: string, projectId: string) =>
            findMcpServerConfigsForValidation(tenantId, projectId),
          moduleToolResolver: buildModuleToolResolver(ctx.tenantId, projectId),
        },
      );

      if (resolved.errors.length > 0) {
        contextWarnings.push(
          ...resolved.errors.map((entry: { code: string; message: string }) => ({
            message: `[${entry.code}] ${entry.message}`,
            severity: 'warning' as const,
            source: 'compile' as const,
          })),
        );
      }

      if (resolved.resolvedByAgent.size > 0) {
        compilerOptions.resolvedToolImplementations = resolved.resolvedByAgent as NonNullable<
          CompilerOptions['resolvedToolImplementations']
        >;
        resolvedToolNames = (resolved.resolvedByAgent.get(parseResult.document.name) ?? []).map(
          (tool) => tool.name,
        );
      }
      contextWarnings.push(
        ...resolved.warnings.map((entry: { code: string; message: string }) => ({
          message: `[${entry.code}] ${entry.message}`,
          severity: 'warning' as const,
          source: 'compile' as const,
        })),
      );
    } catch (err: unknown) {
      return {
        valid: false,
        errors: [
          {
            message: `Tool runtime binding validation failed: ${err instanceof Error ? err.message : String(err)}`,
            severity: 'error',
            source: 'compile',
          },
        ],
        warnings: contextWarnings,
        hint: 'Arch could not verify ProjectTool runtime bindings, so it cannot safely propose this agent edit without assumptions.',
      };
    }
  }

  const beforeCompileResult =
    comparisonProjectDocs.length > 0
      ? compileABLtoIR(comparisonProjectDocs, { mode: 'preview' })
      : null;
  const beforeCompilationErrorKeys = new Set(
    (beforeCompileResult?.compilation_errors ?? [])
      .filter((entry) => entry.severity === 'error')
      .map(compilationIssueKey),
  );

  const compileResult = compileABLtoIR(allDocs, compilerOptions);
  const compileErrorEntries = (compileResult.compilation_errors ?? []).filter(
    (entry) => entry.severity === 'error',
  );
  const blockingCompileErrors = compileErrorEntries.filter(
    (entry) =>
      isCompilationIssueRelevantToAgent(entry, agentName) ||
      !beforeCompilationErrorKeys.has(compilationIssueKey(entry)),
  );
  const preExistingCompileIssues = compileErrorEntries.filter(
    (entry) => !blockingCompileErrors.includes(entry),
  );

  const errors: ValidationIssue[] = blockingCompileErrors.map((entry) =>
    toCompilationValidationIssue(entry, agentName, 'error'),
  );

  const warnings: ValidationIssue[] = (compileResult.compilation_warnings ?? [])
    .filter((w: { agent?: string }) => !w.agent || w.agent === agentName || w.agent === '_global')
    .map((w: { line?: number; message: string; agent?: string }) => ({
      line: typeof w.line === 'number' ? w.line : undefined,
      message: w.message,
      severity: 'warning' as const,
      source: 'compile' as const,
      agent: w.agent && w.agent !== agentName ? w.agent : undefined,
    }));
  warnings.push(
    ...preExistingCompileIssues.map((entry) =>
      toCompilationValidationIssue(
        entry,
        agentName,
        'warning',
        'Existing project issue outside this edit: ',
      ),
    ),
  );

  if (errors.length > 0) {
    return { valid: false, errors, warnings: [...contextWarnings, ...warnings] };
  }

  let diagnosticWarnings: ValidationIssue[] = [];
  try {
    const beforeDiagnosticKeys = new Set<string>();
    if (beforeCompileResult) {
      for (const finding of await runProjectDiagnostics(beforeCompileResult)) {
        beforeDiagnosticKeys.add(diagnosticFindingKey(finding));
      }
    }

    const afterDiagnosticFindings = await runProjectDiagnostics(compileResult);
    const semanticRegressions = afterDiagnosticFindings.filter(
      (finding) =>
        finding.severity === 'error' &&
        !isRuntimeReadinessDiagnostic(finding) &&
        !beforeDiagnosticKeys.has(diagnosticFindingKey(finding)),
    );

    if (semanticRegressions.length > 0) {
      return {
        valid: false,
        errors: semanticRegressions
          .slice(0, 10)
          .map((finding) =>
            toDiagnosticValidationIssue(
              finding,
              'Proposed edit introduces a project health error: ',
              'error',
              true,
            ),
          ),
        warnings: [...contextWarnings, ...warnings],
        hint: 'Revise the proposal so full-project diagnostics do not introduce new blocking errors. For return-target agents, preserve a COMPLETE condition so the runtime can return through the parent thread stack.',
      };
    }

    diagnosticWarnings = afterDiagnosticFindings
      .filter((finding) => finding.severity === 'error' || finding.severity === 'warning')
      .filter(
        (finding) =>
          isFindingRelevantToAgent(finding, agentName) ||
          !beforeDiagnosticKeys.has(diagnosticFindingKey(finding)),
      )
      .slice(0, 20)
      .map((finding) =>
        toDiagnosticValidationIssue(
          finding,
          '',
          'warning',
          // The diff filter above already knows: a finding NOT present in
          // beforeDiagnosticKeys is one this edit introduced. Findings the
          // edit did NOT introduce are pre-existing and tolerated.
          !beforeDiagnosticKeys.has(diagnosticFindingKey(finding)),
        ),
      );
  } catch (err: unknown) {
    // Diagnostic-suite failure is non-fatal for the edit (compile already
    // passed), but it MUST NOT silently bypass regression detection. Log so
    // ops sees the failure, and surface a structured warning so the user/LLM
    // see that regression checks were skipped — a silent pass here means the
    // proposal can ship a runtime regression undetected (G2 in the in-project
    // update-flow audit).
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error('Project diagnostics threw during validation; regression check skipped', {
      tenantId: ctx.tenantId,
      projectId,
      agentName,
      error: errorMessage,
    });
    diagnosticWarnings = [
      {
        message: `Project diagnostics did not run for this edit (${errorMessage}). Regression detection is incomplete; verify project health manually after applying.`,
        severity: 'warning',
        source: 'diagnostics',
      },
    ];
  }

  const feasibilityWarnings: ValidationIssue[] = runFeasibilityChecks({
    code,
    declaredToolNames: targetToolNames,
    resolvedToolNames,
  }).map((finding) => ({
    message: `[${finding.checkName}] ${finding.message}`,
    severity: finding.severity,
    source: 'diagnostics',
  }));

  return {
    valid: true,
    warnings: [...contextWarnings, ...warnings, ...diagnosticWarnings, ...feasibilityWarnings],
    agentsInScope: allDocs.length,
  };
}

/**
 * Extract the AGENT: or SUPERVISOR: name from ABL YAML code.
 * Returns null if no agent declaration is found.
 */
function extractAgentNameFromABL(code: string): string | null {
  const match = code.match(/^\s*(?:AGENT|SUPERVISOR)\s*:\s*(\S+)/m);
  return match ? match[1] : null;
}

/**
 * Compute the SHA-256 hex digest of an agent's DSL content. Used as the
 * concurrency token for propose → apply: the proposal captures the hash of
 * `before`, and apply rejects with PROPOSAL_STALE if the DB no longer
 * matches at apply time. Stable: empty string maps to a fixed digest.
 */
export function computeBeforeHash(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

async function compileAgentVersionIrContent(dslContent: string): Promise<string> {
  try {
    const { compileABLtoIR } = await import('@abl/compiler');
    const parsed = parseAgentBasedABL(dslContent);
    if (!parsed.document || parsed.errors.length > 0) {
      return JSON.stringify({ parseErrors: parsed.errors });
    }
    return JSON.stringify(
      compileABLtoIR([parsed.document], {
        mode: 'preview',
        skipCrossAgentValidation: true,
      }),
    );
  } catch (err: unknown) {
    return JSON.stringify({ compileError: err instanceof Error ? err.message : String(err) });
  }
}

async function createAgentVersionSnapshot(input: {
  agentId: string;
  dslContent: string;
  sourceHash: string;
  createdBy: string;
  changelog: string;
  session?: unknown;
}): Promise<void> {
  const AgentVersion = await getAgentVersionModel();
  const payload = {
    agentId: input.agentId,
    version: `draft-${Date.now()}-${randomUUID().slice(0, 8)}`,
    status: 'draft',
    dslContent: input.dslContent,
    irContent: await compileAgentVersionIrContent(input.dslContent),
    sourceHash: input.sourceHash,
    changelog: input.changelog,
    createdBy: input.createdBy,
    toolSnapshot: null,
  };

  if (input.session) {
    await AgentVersion.create([payload], { session: input.session });
    return;
  }
  await AgentVersion.create(payload);
}

/**
 * Sentinel error thrown from inside `withTransaction` when the in-transaction
 * hash re-check detects a concurrent edit. The outer `applyProjectAgentModification`
 * catch translates this into a `PROPOSAL_STALE` envelope. Throwing aborts the
 * transaction so any pending writes (rename cascade, sibling updates) roll
 * back atomically.
 */
class ProposalStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposalStaleError';
  }
}

/** Allowed agent-name shape: identifier-style. Matches ABL DSL parser expectations. */
export const AGENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Escape all regex metacharacters so `str` matches literally inside a `RegExp`. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Escape `$` so the string is literal inside `String.prototype.replace` replacement. */
function escapeReplacement(str: string): string {
  return str.replace(/\$/g, '$$$$');
}

/** Build the handoff-rename regex with proper escaping of the literal agent name. */
function buildHandoffRenamePattern(agentName: string): RegExp {
  return new RegExp(`(\\bTO\\s*:\\s*)${escapeRegex(agentName)}\\b`, 'gm');
}

/**
 * Cascade an agent rename through all other agents' HANDOFF references.
 * Updates `TO: OldName` → `TO: NewName` in all sibling agent files.
 * Returns the list of agents that were updated.
 */
export function cascadeHandoffRename(
  files: Record<string, { path: string; content: string }>,
  oldName: string,
  newName: string,
): string[] {
  const updated: string[] = [];
  const pattern = buildHandoffRenamePattern(oldName);
  const safeNewName = escapeReplacement(newName);

  for (const [key, file] of Object.entries(files)) {
    if (key === oldName || key === newName) continue;
    if (pattern.test(file.content)) {
      file.content = file.content.replace(pattern, `$1${safeNewName}`);
      updated.push(key);
    }
    // Reset lastIndex since we used the same regex with `g` flag
    pattern.lastIndex = 0;
  }
  return updated;
}

function extractToolNamesFromParsedDocument(doc: unknown): string[] {
  const names = new Set<string>();
  const tools =
    doc && typeof doc === 'object' && 'tools' in doc
      ? (doc as { tools?: unknown }).tools
      : undefined;
  if (Array.isArray(tools)) {
    for (const toolDef of tools) {
      if (
        toolDef &&
        typeof toolDef === 'object' &&
        'name' in toolDef &&
        typeof toolDef.name === 'string' &&
        toolDef.name.trim().length > 0
      ) {
        names.add(toolDef.name.trim());
      }
    }
  }
  return [...names];
}

function extractFlowCallToolNames(dslContent: string | null | undefined): string[] {
  if (!dslContent) {
    return [];
  }

  const names = new Set<string>();
  const callPattern = /^\s*CALL\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\b/gm;
  let match = callPattern.exec(dslContent);
  while (match) {
    if (match[1]) {
      names.add(match[1]);
    }
    match = callPattern.exec(dslContent);
  }
  return [...names];
}

async function buildAgentToolRuntimeContext(params: {
  tenantId: string;
  projectId: string;
  dslContent: string | null | undefined;
}): Promise<{
  declaredTools: string[];
  flowCallTools: string[];
  existingProjectTools: string[];
  resolvedDeclaredTools: string[];
  unresolvedDeclaredTools: string[];
  callsMissingToolSignature: string[];
  toolCreationCandidates: string[];
}> {
  const declaredTools = extractToolNames(params.dslContent ?? null);
  const flowCallTools = extractFlowCallToolNames(params.dslContent);
  const { findProjectToolsByProject } = await import('@agent-platform/shared/repos');
  const projectTools = await findProjectToolsByProject(params.tenantId, params.projectId);
  const existingProjectTools = projectTools.data.map((tool) => tool.name);
  const existingToolKeys = new Set(existingProjectTools.map((name) => name.toLowerCase()));
  const declaredToolKeys = new Set(declaredTools.map((name) => name.toLowerCase()));
  const resolvedDeclaredTools = declaredTools.filter((name) =>
    existingToolKeys.has(name.toLowerCase()),
  );
  const unresolvedDeclaredTools = declaredTools.filter(
    (name) => !existingToolKeys.has(name.toLowerCase()),
  );
  const callsMissingToolSignature = flowCallTools.filter(
    (name) => !declaredToolKeys.has(name.toLowerCase()),
  );

  return {
    declaredTools,
    flowCallTools,
    existingProjectTools,
    resolvedDeclaredTools,
    unresolvedDeclaredTools,
    callsMissingToolSignature,
    toolCreationCandidates: uniqueStrings([
      ...unresolvedDeclaredTools,
      ...callsMissingToolSignature,
    ]),
  };
}

function getParsedDocumentName(doc: unknown, fallback: string): string {
  if (
    doc &&
    typeof doc === 'object' &&
    'name' in doc &&
    typeof (doc as { name?: unknown }).name === 'string' &&
    (doc as { name: string }).name.length > 0
  ) {
    return (doc as { name: string }).name;
  }
  return fallback;
}

function getParsedDocumentType(
  doc: unknown,
  fallback: 'agent' | 'supervisor',
): 'agent' | 'supervisor' {
  if (!doc || typeof doc !== 'object') {
    return fallback;
  }

  const typedDoc = doc as { type?: unknown; meta?: { kind?: unknown } };
  if (typedDoc.type === 'supervisor' || typedDoc.meta?.kind === 'supervisor') {
    return 'supervisor';
  }
  return 'agent';
}

function parseAgentImpact(recordName: string, dslContent: string | null): ParsedAgentImpact {
  if (!dslContent?.trim()) {
    return {
      recordName,
      declaredName: recordName,
      type: 'agent',
      tools: [],
      edges: [],
    };
  }

  try {
    const parsed = parseAgentBasedABL(dslContent);
    const doc = parsed.document;
    if (!doc) {
      return {
        recordName,
        declaredName: recordName,
        type: dslContent.includes('SUPERVISOR:') ? 'supervisor' : 'agent',
        tools: extractToolNames(dslContent),
        edges: [],
      };
    }

    const declaredName = getParsedDocumentName(doc, recordName);
    return {
      recordName,
      declaredName,
      type: getParsedDocumentType(doc, dslContent.includes('SUPERVISOR:') ? 'supervisor' : 'agent'),
      tools: extractToolNamesFromParsedDocument(doc),
      edges: extractRoutingEdgesFromParsedDocument(doc, declaredName),
    };
  } catch {
    return {
      recordName,
      declaredName: recordName,
      type: dslContent.includes('SUPERVISOR:') ? 'supervisor' : 'agent',
      tools: extractToolNames(dslContent),
      edges: [],
    };
  }
}

function edgeKey(edge: AgentDependencyEdge): string {
  return `${edge.from}->${edge.to}:${edge.type}`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function diffEdges(
  before: AgentDependencyEdge[],
  after: AgentDependencyEdge[],
): { added: AgentDependencyEdge[]; removed: AgentDependencyEdge[] } {
  const beforeKeys = new Set(before.map(edgeKey));
  const afterKeys = new Set(after.map(edgeKey));
  return {
    added: after.filter((edge) => !beforeKeys.has(edgeKey(edge))),
    removed: before.filter((edge) => !afterKeys.has(edgeKey(edge))),
  };
}

function diffStrings(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: after.filter((value) => !beforeSet.has(value)),
    removed: before.filter((value) => !afterSet.has(value)),
  };
}

function countRegexMatches(value: string, pattern: RegExp): number {
  let count = 0;
  pattern.lastIndex = 0;
  while (pattern.exec(value) !== null) {
    count += 1;
  }
  pattern.lastIndex = 0;
  return count;
}

function rewriteHandoffReferences(value: string, pattern: RegExp, newName: string): string {
  pattern.lastIndex = 0;
  const rewritten = value.replace(pattern, `$1${escapeReplacement(newName)}`);
  pattern.lastIndex = 0;
  return rewritten;
}

function extractUnresolvedToolsFromWarnings(warnings: ValidationIssue[]): string[] {
  const unresolved = new Set<string>();
  for (const warning of warnings) {
    if (warning.source === 'compile' && warning.message.includes('[E721]')) {
      const match = warning.message.match(/Tool '([^']+)' not found/);
      if (match?.[1]) {
        unresolved.add(match[1]);
      }
    }

    if (warning.source === 'diagnostics' && warning.message.includes('[T-04]')) {
      const match = warning.message.match(/tool "([^"]+)"/);
      if (match?.[1]) {
        unresolved.add(match[1]);
      }
    }
  }
  return [...unresolved];
}

function isRuntimeReadinessWarning(warning: ValidationIssue): boolean {
  return (
    (warning.source === 'compile' && warning.message.includes('[E721]')) ||
    (warning.source === 'diagnostics' && warning.message.includes('[T-04]'))
  );
}

async function buildAgentChangeImpact(params: {
  tenantId: string;
  projectId: string;
  agentName: string;
  currentCode: string;
  proposedCode: string;
  validationWarnings: ValidationIssue[];
}): Promise<AgentChangeImpact> {
  const ProjectAgent = await getProjectAgentModel();
  const agents = await resolveProjectAgentFindResult(
    ProjectAgent.find(
      {
        projectId: params.projectId,
        tenantId: params.tenantId,
      },
      'name dslContent',
    ),
  );

  const siblingImpacts = agents
    .filter((agent) => agent.name !== params.agentName)
    .map((agent) => parseAgentImpact(String(agent.name ?? ''), agent.dslContent ?? null));
  const beforeTarget = parseAgentImpact(params.agentName, params.currentCode || null);
  const afterTarget = parseAgentImpact(params.agentName, params.proposedCode);
  const isRename = beforeTarget.declaredName !== afterTarget.declaredName;
  const renamePattern = isRename ? buildHandoffRenamePattern(beforeTarget.declaredName) : null;
  const renameReferenceUpdates =
    renamePattern === null
      ? []
      : agents
          .filter((agent) => agent.name !== params.agentName)
          .map((agent) => {
            const dslContent = agent.dslContent ?? '';
            const count = countRegexMatches(dslContent, renamePattern);
            return {
              agent: String(agent.name ?? ''),
              from: beforeTarget.declaredName,
              to: afterTarget.declaredName,
              count,
            };
          })
          .filter((entry) => entry.count > 0);
  const siblingImpactsAfter =
    renamePattern === null
      ? siblingImpacts
      : agents
          .filter((agent) => agent.name !== params.agentName)
          .map((agent) =>
            parseAgentImpact(
              String(agent.name ?? ''),
              rewriteHandoffReferences(
                agent.dslContent ?? '',
                renamePattern,
                afterTarget.declaredName,
              ),
            ),
          );

  const beforeEdges = [...siblingImpacts.flatMap((agent) => agent.edges), ...beforeTarget.edges];
  const afterEdges = [...siblingImpactsAfter.flatMap((agent) => agent.edges), ...afterTarget.edges];
  const beforeNames = uniqueStrings([params.agentName, beforeTarget.declaredName]);
  const afterNames = uniqueStrings([params.agentName, afterTarget.declaredName]);

  const incomingBefore = beforeEdges.filter((edge) => beforeNames.includes(edge.to));
  const incomingAfter = afterEdges.filter((edge) => afterNames.includes(edge.to));
  const outgoingBefore = beforeEdges.filter((edge) => beforeNames.includes(edge.from));
  const outgoingAfter = afterEdges.filter((edge) => afterNames.includes(edge.from));
  const edgeDiff = diffEdges(
    [...incomingBefore, ...outgoingBefore],
    [...incomingAfter, ...outgoingAfter],
  );
  const toolDiff = diffStrings(beforeTarget.tools, afterTarget.tools);
  const unresolvedTools = extractUnresolvedToolsFromWarnings(params.validationWarnings);
  const runtimeReady = !params.validationWarnings.some(isRuntimeReadinessWarning);

  const impactedAgents = uniqueStrings([
    params.agentName,
    beforeTarget.declaredName,
    afterTarget.declaredName,
    ...renameReferenceUpdates.map((entry) => entry.agent),
    ...incomingBefore.map((edge) => edge.from),
    ...incomingAfter.map((edge) => edge.from),
    ...outgoingBefore.map((edge) => edge.to),
    ...outgoingAfter.map((edge) => edge.to),
    ...edgeDiff.added.flatMap((edge) => [edge.from, edge.to]),
    ...edgeDiff.removed.flatMap((edge) => [edge.from, edge.to]),
  ]);

  const nextActions = [
    ...(edgeDiff.added.length > 0 || edgeDiff.removed.length > 0
      ? [
          'Run health_check after apply to verify the updated topology from the project entry agent.',
        ]
      : []),
    ...(toolDiff.added.length > 0
      ? [
          `Run tools_ops test for added tool(s): ${toolDiff.added.join(', ')} before production traffic.`,
        ]
      : []),
    ...(unresolvedTools.length > 0
      ? [
          `Create or link ProjectTool implementation(s) before production traffic: ${unresolvedTools.join(', ')}.`,
        ]
      : []),
    ...(renameReferenceUpdates.length > 0
      ? [
          `Review rename cascade: ${renameReferenceUpdates
            .map(
              (entry) => `${entry.agent} (${entry.count} reference${entry.count === 1 ? '' : 's'})`,
            )
            .join(', ')}.`,
        ]
      : []),
    ...(params.validationWarnings.length > 0
      ? ['Review validation warnings before applying; they are included in the proposal payload.']
      : []),
    'Run run_test against the changed agent after apply with the user scenario that motivated the edit.',
  ];

  const changedParts = [
    toolDiff.added.length > 0 || toolDiff.removed.length > 0
      ? `${toolDiff.added.length} tool(s) added, ${toolDiff.removed.length} removed`
      : null,
    edgeDiff.added.length > 0 || edgeDiff.removed.length > 0
      ? `${edgeDiff.added.length} topology edge(s) added, ${edgeDiff.removed.length} removed`
      : null,
    renameReferenceUpdates.length > 0
      ? `${renameReferenceUpdates.length} agent(s) will receive handoff rename updates`
      : null,
    unresolvedTools.length > 0
      ? `${unresolvedTools.length} unresolved tool implementation(s)`
      : null,
    impactedAgents.length > 1 ? `${impactedAgents.length} agent(s) in impact radius` : null,
  ].filter((part): part is string => part !== null);

  return {
    runtimeReady,
    summary:
      changedParts.length > 0 ? changedParts.join('; ') : 'No topology or tool link changes.',
    changedAgent: params.agentName,
    declaredAgentName: afterTarget.declaredName,
    impactedAgents,
    ...(isRename && {
      rename: {
        from: beforeTarget.declaredName,
        to: afterTarget.declaredName,
        cascadeAgents: renameReferenceUpdates.map((entry) => entry.agent),
        referenceUpdates: renameReferenceUpdates,
      },
    }),
    topology: {
      incomingBefore,
      incomingAfter,
      outgoingBefore,
      outgoingAfter,
      addedEdges: edgeDiff.added,
      removedEdges: edgeDiff.removed,
    },
    tools: {
      before: beforeTarget.tools,
      after: afterTarget.tools,
      added: toolDiff.added,
      removed: toolDiff.removed,
      unresolved: unresolvedTools,
    },
    nextActions,
  };
}

function markImpactBlocked(
  impact: AgentChangeImpact,
  validation: ProjectAgentValidationResult,
): AgentChangeImpact {
  const firstError = !validation.valid ? validation.errors[0]?.message : undefined;
  return {
    ...impact,
    runtimeReady: false,
    summary: firstError
      ? `Proposal blocked by validation: ${firstError}`
      : 'Proposal blocked by validation.',
    nextActions: uniqueStrings([
      'Fix validation errors before asking the user to apply this proposal.',
      ...impact.nextActions,
    ]),
  };
}

function buildFallbackBlockedImpact(params: {
  agentName: string;
  currentCode: string;
  proposedCode: string;
  validation: ProjectAgentValidationResult;
}): AgentChangeImpact {
  const beforeTarget = parseAgentImpact(params.agentName, params.currentCode || null);
  const afterTarget = parseAgentImpact(params.agentName, params.proposedCode);
  const toolDiff = diffStrings(beforeTarget.tools, afterTarget.tools);
  const edgeDiff = diffEdges(beforeTarget.edges, afterTarget.edges);
  const firstError = !params.validation.valid ? params.validation.errors[0]?.message : undefined;

  return {
    runtimeReady: false,
    summary: firstError
      ? `Proposal blocked by validation: ${firstError}`
      : 'Proposal blocked by validation.',
    changedAgent: params.agentName,
    declaredAgentName: afterTarget.declaredName,
    impactedAgents: uniqueStrings([
      params.agentName,
      beforeTarget.declaredName,
      afterTarget.declaredName,
      ...beforeTarget.edges.flatMap((edge) => [edge.from, edge.to]),
      ...afterTarget.edges.flatMap((edge) => [edge.from, edge.to]),
    ]),
    topology: {
      incomingBefore: [],
      incomingAfter: [],
      outgoingBefore: beforeTarget.edges,
      outgoingAfter: afterTarget.edges,
      addedEdges: edgeDiff.added,
      removedEdges: edgeDiff.removed,
    },
    tools: {
      before: beforeTarget.tools,
      after: afterTarget.tools,
      added: toolDiff.added,
      removed: toolDiff.removed,
      unresolved: [],
    },
    nextActions: ['Fix validation errors before asking the user to apply this proposal.'],
  };
}

/**
 * Count assistant-side ask_user tool calls in stored session history for a
 * given phase. Used by the BLUEPRINT turn cap to detect cross-turn question
 * loops that the per-turn LoopDetector cannot catch.
 */
export function countAskUserCallsInHistory(
  storedMessages: Array<{
    role: string;
    toolCalls?: Array<{ toolName?: string }>;
    phase?: string;
  }>,
  phaseFilter: string,
): number {
  let count = 0;
  for (const m of storedMessages) {
    if (m.role !== 'assistant') continue;
    if (m.phase !== phaseFilter) continue;
    if (!m.toolCalls) continue;
    for (const tc of m.toolCalls) {
      if (tc?.toolName === 'ask_user') count++;
    }
  }
  return count;
}

/**
 * Create a new agent from a reviewed proposal.
 * Validates, checks for duplicates, creates in DB.
 * Return shape matches applyProjectAgentModification for uniform handling.
 */
export async function createNewProjectAgent(
  ctx: { tenantId: string; userId: string; permissions?: string[] },
  projectId: string,
  agentName: string,
  code: string,
): Promise<
  | { success: true; agentName: string; applied: true }
  | { success: false; error: { code: string; message: string } }
> {
  try {
    const { findProjectAgent, addAgentToProject } = await getProjectAgentCreateDeps();

    // Duplicate check
    const existing = await findProjectAgent(projectId, agentName, ctx.tenantId);
    if (existing) {
      return {
        success: false,
        error: {
          code: 'ALREADY_EXISTS',
          message: `Agent "${agentName}" already exists in this project. Use propose_modification without isNew to modify it.`,
        },
      };
    }

    const declaredName = extractAgentNameFromABL(code);
    if (declaredName && declaredName !== agentName) {
      return {
        success: false,
        error: {
          code: 'DECLARATION_NAME_MISMATCH',
          message: `New agent target "${agentName}" must match the ABL declaration "${declaredName}".`,
        },
      };
    }

    // Validate with full project context
    const validation = await validateProjectAgentCode(ctx, projectId, agentName, code);
    if (!validation.valid) {
      return {
        success: false,
        error: {
          code: 'VALIDATION_FAILED',
          message: validation.errors[0]?.message ?? 'ABL validation failed for new agent.',
        },
      };
    }

    // Create
    await addAgentToProject({
      name: agentName,
      projectId,
      tenantId: ctx.tenantId,
      dslContent: code,
      description: 'Agent created via Arch AI',
      ownerId: ctx.userId,
    });

    // Drop cached project_summary / list_agents reads so the next LLM turn
    // sees the new agent. Sibling tools (tools-ops, auth-ops, variable-ops)
    // all invalidate after writes; we were the outlier.
    invalidateProjectCaches(ctx.tenantId, projectId);

    log.info('New agent created via apply_modification(isNew)', { projectId, agentName });
    return { success: true, agentName, applied: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('createNewProjectAgent failed', { error: message, projectId, agentName });
    return { success: false, error: { code: 'INTERNAL', message } };
  }
}

export async function applyProjectAgentModification(
  ctx: { tenantId: string; userId: string; permissions?: string[] },
  projectId: string,
  agentName: string,
  updatedCode: string,
  // Optional concurrency token captured at propose time. When present, the
  // function recomputes the hash of the live DB DSL and rejects with
  // PROPOSAL_STALE if it does not match — preventing a concurrent canvas /
  // sibling-session edit from being silently overwritten by apply. Optional
  // for backward compatibility with callers (and persisted sessions) that
  // predate this field.
  expectedBeforeHash?: string,
): Promise<
  | {
      success: true;
      agentName: string;
      applied: true;
    }
  | {
      success: false;
      error: {
        code: string;
        message: string;
      };
      validation?: {
        errors: ValidationIssue[];
        warnings: ValidationIssue[];
        hint?: string;
      };
    }
> {
  try {
    const ProjectAgent = await getProjectAgentModel();
    const { buildProjectAgentPath, refreshPersistedStudioProjectAgentDraftMetadata } =
      await getProjectAgentApplyDeps();

    const agent = await ProjectAgent.findOne({
      projectId,
      tenantId: ctx.tenantId,
      name: agentName,
    });
    if (!agent) {
      return {
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: `Agent "${agentName}" not found in this project`,
        },
      };
    }

    // Concurrency fast-fail: the proposal captured a SHA-256 of the DB DSL
    // at propose time. Check it once OUTSIDE the transaction so we can avoid
    // entering an expensive validation pass and a transaction altogether
    // when we already know the proposal is stale. The authoritative check is
    // re-run INSIDE the transaction (with the session attached) below — that
    // is the one that closes the residual TOCTOU window between this read
    // and `updateOne`. Empty string is hashed identically to a stored empty
    // `dslContent` so blank-state agents stay verifiable.
    if (expectedBeforeHash) {
      const liveCode = (agent as { dslContent?: string }).dslContent ?? '';
      const liveHash = computeBeforeHash(liveCode);
      if (liveHash !== expectedBeforeHash) {
        return {
          success: false,
          error: {
            code: 'PROPOSAL_STALE',
            message: `Agent "${agentName}" changed since the proposal was created. Re-propose to see the current state.`,
          },
        };
      }
    }

    const validation = await validateProjectAgentCode(ctx, projectId, agentName, updatedCode);
    if (!validation.valid) {
      return {
        success: false,
        error: {
          code: 'VALIDATION_FAILED',
          message: validation.errors[0]?.message ?? 'Accepted changes failed ABL validation.',
        },
        validation: {
          errors: validation.errors,
          warnings: validation.warnings,
          hint: validation.hint,
        },
      };
    }

    // Detect rename: compare AGENT: name in updated code to the DB record name
    const newName = extractAgentNameFromABL(updatedCode);
    const isRename = Boolean(newName) && newName !== agentName;

    // Guard: renames must target a valid ABL identifier. A `newName` containing
    // regex metacharacters or `$` substitution markers would corrupt sibling
    // DSL via the cascade replace below.
    if (isRename && newName && !AGENT_NAME_PATTERN.test(newName)) {
      return {
        success: false,
        error: {
          code: 'INVALID_AGENT_NAME',
          message: `New agent name "${newName}" must match ${AGENT_NAME_PATTERN.source}`,
        },
      };
    }

    const nextRecordName = isRename && newName ? newName : agentName;
    const nextSourceHash =
      computeProjectAgentDraftSourceHash({
        recordName: nextRecordName,
        dslContent: updatedCode,
        systemPromptLibraryRef:
          (agent as { systemPromptLibraryRef?: unknown }).systemPromptLibraryRef ?? null,
      }) ?? computeBeforeHash(updatedCode);
    const updateFields: Record<string, unknown> = {
      dslContent: updatedCode,
      sourceHash: nextSourceHash,
    };
    if (isRename && newName) {
      updateFields.name = newName;
      updateFields.agentPath = buildProjectAgentPath(projectId, newName);
    }

    // Wrap the rename cascade in a transaction so a mid-loop failure can't
    // leave the DB in a partial state: primary renamed but siblings still
    // reference the old name, or everything renamed except `Project.entryAgentName`.
    // `withTransaction` gracefully degrades to session-less execution on
    // standalone Mongo deployments.
    await getInProjectToolDeps().withTransaction(async (session) => {
      const sessionOpts = session ? { session } : {};

      // Authoritative concurrency check: re-read the agent INSIDE the
      // transaction with the session attached so this is true compare-and-
      // swap. Without this, validation time (multi-second on large projects)
      // leaves a TOCTOU window where a concurrent canvas edit could land
      // between the outer read and the updateOne below — silently
      // overwriting the concurrent edit. Throwing `ProposalStaleError` aborts
      // the transaction (rolling back any rename cascade writes that may
      // have happened earlier in this callback iteration) and is caught by
      // the outer try/catch which converts it to a `PROPOSAL_STALE` envelope.
      if (expectedBeforeHash) {
        const liveInTxn = await ProjectAgent.findOne(
          { _id: agent._id, projectId, tenantId: ctx.tenantId },
          null,
          sessionOpts,
        );
        const liveCodeInTxn = (liveInTxn as { dslContent?: string } | null)?.dslContent ?? '';
        const liveHashInTxn = computeBeforeHash(liveCodeInTxn);
        if (liveHashInTxn !== expectedBeforeHash) {
          throw new ProposalStaleError(
            `Agent "${agentName}" changed since the proposal was created. Re-propose to see the current state.`,
          );
        }
      }

      await ProjectAgent.updateOne(
        { _id: agent._id, projectId, tenantId: ctx.tenantId },
        { $set: updateFields },
        sessionOpts,
      );
      await createAgentVersionSnapshot({
        agentId: String(agent._id),
        dslContent: updatedCode,
        sourceHash: String(updateFields.sourceHash),
        createdBy: ctx.userId,
        changelog:
          isRename && newName
            ? `Renamed ${agentName} to ${newName}`
            : 'Applied agent DSL modification',
        session: session ?? undefined,
      });

      if (isRename && newName) {
        const siblings = await ProjectAgent.find(
          {
            projectId,
            tenantId: ctx.tenantId,
            _id: { $ne: agent._id },
          },
          null,
          sessionOpts,
        );
        const handoffPattern = buildHandoffRenamePattern(agentName);
        const safeNewName = escapeReplacement(newName);
        for (const sibling of siblings) {
          const content = sibling.dslContent ?? '';
          handoffPattern.lastIndex = 0;
          if (!handoffPattern.test(content)) continue;
          handoffPattern.lastIndex = 0;
          const updated = content.replace(handoffPattern, `$1${safeNewName}`);
          const siblingSourceHash =
            computeProjectAgentDraftSourceHash({
              recordName: String(sibling.name ?? ''),
              dslContent: updated,
              systemPromptLibraryRef:
                (sibling as { systemPromptLibraryRef?: unknown }).systemPromptLibraryRef ?? null,
            }) ?? computeBeforeHash(updated);
          await ProjectAgent.updateOne(
            { _id: sibling._id, projectId, tenantId: ctx.tenantId },
            { $set: { dslContent: updated, sourceHash: siblingSourceHash } },
            sessionOpts,
          );
          await createAgentVersionSnapshot({
            agentId: String(sibling._id),
            dslContent: updated,
            sourceHash: siblingSourceHash,
            createdBy: ctx.userId,
            changelog: `Updated handoff references after ${agentName} was renamed to ${newName}`,
            session: session ?? undefined,
          });
        }

        // Update entryAgentName on the project if it was the renamed agent
        const Project = await getProjectModel();
        await Project.updateOne(
          { _id: projectId, tenantId: ctx.tenantId, entryAgentName: agentName },
          { $set: { entryAgentName: newName } },
          sessionOpts,
        );
      }

      await refreshPersistedStudioProjectAgentDraftMetadata({
        projectId,
        tenantId: ctx.tenantId,
        session: session ?? undefined,
      });
    });

    // Drop cached project_summary / list_agents / list_tools reads so the
    // next LLM turn sees the edit. Sibling tools (tools-ops, auth-ops,
    // variable-ops, integration-ops) all invalidate after writes; we were
    // the outlier — see audit follow-up §10 (Wave-4-style stale-cache).
    invalidateProjectCaches(ctx.tenantId, projectId);

    if (isRename && newName) {
      try {
        await sessionService.archiveAgentEditorSessionsForAgent(
          { tenantId: ctx.tenantId, userId: ctx.userId },
          projectId,
          agentName,
          'agent_renamed',
        );
      } catch (archiveErr: unknown) {
        log.warn('Failed to archive stale agent-editor sessions after agent rename', {
          projectId,
          agentName,
          newName,
          error: archiveErr instanceof Error ? archiveErr.message : String(archiveErr),
        });
      }
    }

    return {
      success: true,
      agentName: isRename && newName ? newName : agentName,
      applied: true,
    };
  } catch (err: unknown) {
    // The in-transaction concurrency check throws `ProposalStaleError` to
    // abort the transaction. Translate it back into the typed envelope so
    // the LLM-facing error code stays the same as the outer fast-fail path.
    // No write succeeded (transaction rolled back), no cache invalidation
    // happened — so the caller can safely retry after re-proposing.
    if (err instanceof ProposalStaleError) {
      return {
        success: false,
        error: {
          code: 'PROPOSAL_STALE',
          message: err.message,
        },
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error('applyProjectAgentModification failed', {
      error: message,
      projectId,
      agentName,
    });
    return {
      success: false,
      error: {
        code: 'INTERNAL',
        message,
      },
    };
  }
}

async function buildArchitectureNotesForPlan(params: {
  tenantId: string;
  projectId: string;
  affectedAgents: string[];
}): Promise<Record<string, unknown>> {
  const ProjectAgent = await getProjectAgentModel();
  const agents = await resolveProjectAgentFindResult(
    ProjectAgent.find(
      {
        tenantId: params.tenantId,
        projectId: params.projectId,
      },
      'name description dslContent',
    ),
  );

  const plannerAgents = agents.map((agent) => ({
    name: String(agent.name),
    role: typeof agent.description === 'string' ? agent.description : '',
    executionMode: normalizePlannerExecutionMode(extractMode(agent.dslContent ?? '')),
    description: typeof agent.description === 'string' ? agent.description : undefined,
    tools: extractToolNames(agent.dslContent ?? ''),
  }));

  const edges = agents.flatMap((agent) => {
    const dsl = agent.dslContent ?? '';
    try {
      const parsed = parseAgentBasedABL(dsl);
      return extractRoutingEdgesFromParsedDocument(parsed.document, String(agent.name)).map(
        (edge) => ({
          from: edge.from,
          to: edge.to,
          type: edge.type === 'escalate' ? edge.type : ('delegate' as const),
          expectReturn: false,
        }),
      );
    } catch {
      return [];
    }
  });

  const entryPoint =
    plannerAgents.find((agent) => {
      const match = agents.find((candidate) => candidate.name === agent.name);
      return match ? extractIsEntryPoint(match.dslContent ?? '') : false;
    })?.name ??
    plannerAgents[0]?.name ??
    '';

  if (!entryPoint || plannerAgents.length === 0) {
    return {
      agentCount: plannerAgents.length,
      edgeCount: edges.length,
      knownAgentNames: plannerAgents.map((agent) => agent.name),
      plans: [],
    };
  }

  const planResult = computeArchitecturePlans({
    agents: plannerAgents,
    edges,
    entryPoint,
  });
  const affected = new Set(params.affectedAgents.map((name) => name.toLowerCase()));
  const selectedPlans = Array.from(planResult.plans.entries())
    .filter(([name]) => affected.size === 0 || affected.has(name.toLowerCase()))
    .map(([name, plan]) => ({
      agentName: name,
      archetype: plan.archetype,
      keyword: plan.keyword,
      handoffTargets: plan.handoffs.targets.map((target) => ({
        to: target.to,
        edgeType: target.edgeType,
        returnExpected: target.returnExpected,
      })),
      blocked: plan.blocked,
      localAgents: plan.localTopology.agents,
      localEdges: plan.localTopology.edges,
    }));

  return {
    agentCount: plannerAgents.length,
    edgeCount: edges.length,
    entryPoint,
    knownAgentNames: plannerAgents.map((agent) => agent.name),
    globalBlocked: planResult.globalBlocked,
    plans: selectedPlans,
  };
}

async function loadProjectReferenceSources(params: {
  tenantId: string;
  projectId: string;
}): Promise<ProjectAgentReferenceSource[]> {
  const ProjectAgent = await getProjectAgentModel();
  const agents = await resolveProjectAgentFindResult(
    ProjectAgent.find(
      {
        tenantId: params.tenantId,
        projectId: params.projectId,
      },
      'name dslContent',
    ),
  );

  return agents
    .map((agent) => ({
      name: typeof agent.name === 'string' ? agent.name : '',
      dslContent: typeof agent.dslContent === 'string' ? agent.dslContent : '',
    }))
    .filter((agent) => agent.name.length > 0 && agent.dslContent.length > 0);
}

const MISSING_PLAN_FINGERPRINT = '__missing__';

function normalizePlanFingerprintAgentName(agentName: string): string {
  return normalizeAgentNameForEditorScope(agentName).toLowerCase();
}

function planFingerprintKey(agentName: string): string {
  return `agent:${normalizePlanFingerprintAgentName(agentName)}`;
}

function collectPlanFingerprintAgentNames(plan: PendingPlan): string[] {
  const names = new Map<string, string>();
  const addName = (value: string | undefined | null): void => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) {
      return;
    }
    const key = normalizePlanFingerprintAgentName(trimmed);
    if (!names.has(key)) {
      names.set(key, trimmed);
    }
  };

  for (const agentName of plan.affectedAgents) {
    addName(agentName);
  }
  for (const mutation of plan.plannedMutations) {
    addName(mutation.agentName);
  }
  for (const reference of plan.dependentsAnalysis.referencesFound) {
    addName(reference.sourceAgent);
    addName(reference.targetAgent);
  }

  return Array.from(names.values()).sort((left, right) =>
    normalizePlanFingerprintAgentName(left).localeCompare(normalizePlanFingerprintAgentName(right)),
  );
}

export async function computePlanStateFingerprints(
  ctx: { tenantId: string },
  projectId: string,
  plan: PendingPlan,
): Promise<Record<string, string>> {
  const sources = await loadProjectReferenceSources({ tenantId: ctx.tenantId, projectId });
  const sourceByKey = new Map(
    sources.map((source) => [normalizePlanFingerprintAgentName(source.name), source]),
  );
  const fingerprints: Record<string, string> = {};

  for (const agentName of collectPlanFingerprintAgentNames(plan)) {
    const normalized = normalizePlanFingerprintAgentName(agentName);
    const source = sourceByKey.get(normalized);
    fingerprints[planFingerprintKey(normalized)] = source
      ? computeBeforeHash(source.dslContent)
      : MISSING_PLAN_FINGERPRINT;
  }

  return fingerprints;
}

async function validateApprovedPlanState(
  ctx: { tenantId: string },
  projectId: string,
  plan: PendingPlan | undefined | null,
): Promise<{ valid: true } | { valid: false; error: { code: string; message: string } }> {
  const expected = plan?.stateFingerprintsAtApproval;
  if (!plan || plan.status !== 'approved' || !expected || Object.keys(expected).length === 0) {
    return { valid: true };
  }

  const current = await computePlanStateFingerprints(ctx, projectId, plan);
  for (const [key, expectedHash] of Object.entries(expected)) {
    if ((current[key] ?? MISSING_PLAN_FINGERPRINT) !== expectedHash) {
      return {
        valid: false,
        error: {
          code: 'PLAN_INVALIDATED',
          message:
            'Project state changed after this plan was approved. Regenerate the plan before applying changes.',
        },
      };
    }
  }

  return { valid: true };
}

// ─── Build IN_PROJECT Tools ──────────────────────────────────────────────────

export interface InProjectMutationGuardOptions {
  requireApprovedPlanForMutation?: boolean;
  approvedPlan?: ToolPermissionContext['approvedPlan'];
}

export interface InProjectToolEnvironment {
  pageContext?: PageContext | null;
  mutationGuard?: InProjectMutationGuardOptions;
}

/** Build tools for IN_PROJECT mode — all in-project tools per contract 8 */
export function buildInProjectTools(
  ctx: { tenantId: string; userId: string; permissions?: string[] },
  sessionId: string,
  projectId: string,
  authToken?: string,
  onCardEmit?: (event: Record<string, unknown>) => void,
  env?: InProjectToolEnvironment,
) {
  const emitCard = onCardEmit ?? (() => {});
  const buildToolContext = (): ToolPermissionContext => ({
    projectId,
    sessionId,
    user: {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      permissions: ctx.permissions ?? [],
    },
    authToken,
    requireApprovedPlanForMutation: env?.mutationGuard?.requireApprovedPlanForMutation,
    approvedPlan: env?.mutationGuard?.approvedPlan,
  });
  const requireReferenceReadPermission = async (toolName: string) => {
    const permission = await checkToolPermission(toolName, 'read', buildToolContext());
    return permission.allowed
      ? null
      : {
          success: false,
          error: {
            code: permission.code ?? 'FORBIDDEN',
            message: permission.error ?? 'Permission denied',
          },
        };
  };

  const clearApprovedPlanAfterSuccessfulMutation = async <T>(
    toolName: string,
    input: unknown,
    result: T,
  ): Promise<T> => {
    if (toolName === 'propose_modification' || toolName === 'apply_modification') {
      return result;
    }
    if (typeof input !== 'object' || input === null) {
      return result;
    }

    const action = (input as { action?: unknown }).action;
    if (typeof action !== 'string' || !isArchMutationAction(toolName, action)) {
      return result;
    }
    if (
      typeof result !== 'object' ||
      result === null ||
      (result as { success?: unknown }).success !== true
    ) {
      return result;
    }

    try {
      await sessionService.setPendingPlan(ctx, sessionId, null);
    } catch (err: unknown) {
      log.error('Failed to clear approved Arch plan after successful mutation', {
        toolName,
        action,
        sessionId,
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return result;
  };

  // Reuse build tools + add project-specific tools (no emit in IN_PROJECT — multi-turn handles it)
  const buildTools = buildBuildTools(ctx, sessionId);

  // Repair counter is intentionally per-request (fresh Map per POST /message call).
  // This means a client that disconnects and reconnects resets the budget.
  // This is acceptable: each request is a fresh LLM interaction, and the cap
  // prevents infinite compile→repair loops WITHIN a single multi-turn request,
  // not across requests. Cross-request repair tracking would require
  // session-level persistence with cleanup — unwarranted complexity for a
  // circuit-breaker that already works within its scope.
  // Key is lowercased agentName so LLM casing jitter can't accidentally
  // reset the budget.
  const repairCounts = new Map<string, number>();
  // Counts validation retries within a single proposal cycle. The LLM should
  // now iterate through dry_run_compile / run_feasibility_check before
  // proposing, so proposal validation stays a tight final circuit breaker.
  const REPAIR_CAP = 3;

  const recordRepairAttempt = (agentName: string): number => {
    const key = agentName.toLowerCase();
    const count = (repairCounts.get(key) ?? 0) + 1;
    repairCounts.set(key, count);
    return count;
  };
  const resetRepairAttempt = (agentName: string): void => {
    repairCounts.delete(agentName.toLowerCase());
  };

  return {
    ...buildTools,
    // Override compile_abl from buildBuildTools with a project-aware version
    // that compiles ALL agents together so cross-agent references resolve.
    compile_abl: tool({
      description:
        'Validate ABL YAML code against the real ABL compiler with full project context. Compiles this agent together with all other project agents so cross-agent references (HANDOFFs, routing) are validated. Call after generate_agent or propose_modification.',
      inputSchema: z.object({
        code: z.string().describe('ABL YAML code to validate'),
        agentName: z.string().describe('Agent name for error context'),
      }),
      execute: async (input) => {
        try {
          const validation = await validateProjectAgentCode(
            ctx,
            projectId,
            input.agentName,
            input.code,
          );

          if (!validation.valid) {
            return {
              status: 'fail',
              errors: validation.errors,
              warnings: validation.warnings,
              hint: validation.hint,
            };
          }

          return {
            status: 'pass',
            errors: [],
            warnings: validation.warnings,
            compiledWithProjectContext: true,
            agentsInScope: validation.agentsInScope,
          };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            status: 'fail',
            errors: [{ message, severity: 'error' as const, source: 'compile' as const }],
            warnings: [],
          };
        }
      },
    }),
    dry_run_compile: tool({
      description:
        'Dry-run a proposed agent DSL change against the same project-aware validation gate used by propose_modification. Use before propose_modification when repairing validation errors or checking risky topology changes.',
      inputSchema: z.object({
        code: z.string().describe('Proposed ABL YAML code to validate without saving'),
        agentName: z.string().describe('Agent name for error context'),
      }),
      execute: async (input) => {
        try {
          const validation = await validateProjectAgentCode(
            ctx,
            projectId,
            input.agentName,
            input.code,
          );
          const errors = validation.valid ? [] : validation.errors;
          return {
            success: validation.valid,
            status: validation.valid ? 'pass' : 'fail',
            errors,
            warnings: validation.warnings,
            hint: validation.valid ? undefined : validation.hint,
            agentsInScope: validation.valid ? validation.agentsInScope : undefined,
          };
        } catch (err: unknown) {
          return {
            success: false,
            status: 'fail',
            errors: [
              {
                message: err instanceof Error ? err.message : String(err),
                severity: 'error' as const,
                source: 'compile' as const,
              },
            ],
            warnings: [],
          };
        }
      },
    }),
    get_construct_spec: tool({
      description:
        'Read the compiler-backed Knowledge Spine spec for a canonical ABL construct. Use before planning when the requested DSL block or fields are uncertain.',
      inputSchema: z.object({
        construct: z
          .string()
          .min(1)
          .describe('ABL construct name, for example HANDOFF, DELEGATE, MEMORY, FLOW, or COMPLETE'),
      }),
      execute: async (input) => {
        const spec = getConstructSpec(input.construct);
        if (!spec) {
          return {
            success: false,
            error: {
              code: 'CONSTRUCT_NOT_FOUND',
              message: `Knowledge Spine has no construct named "${input.construct}". Treat it as unsupported unless docs/tools prove otherwise.`,
            },
          };
        }

        return { success: true, construct: spec };
      },
    }),
    list_valid_combinations: tool({
      description:
        'List compiler-backed construct-combination rules from the Knowledge Spine. Use when a proposal combines constructs such as FLOW, GATHER, HANDOFF, DELEGATE, MEMORY, COMPLETE, TOOLS, or EXECUTION.',
      inputSchema: z.object({
        construct: z
          .string()
          .min(1)
          .optional()
          .describe('Optional construct name to filter combination rules'),
      }),
      execute: async (input) => ({
        success: true,
        combinations: listValidCombinations(input.construct),
      }),
    }),
    get_cel_grammar: tool({
      description:
        'Read the Knowledge Spine CEL variable/function allowlist for a specific DSL condition context. Use before proposing WHEN, IF, COMPLETE, CONSTRAINT, GUARDRAIL, RECALL, or digression conditions.',
      inputSchema: z.object({
        context: z.enum([
          'handoff_when',
          'delegate_when',
          'flow_when',
          'complete_when',
          'constraint_condition',
          'guardrail_when',
          'routing_rule_when',
          'recall_condition',
          'digression_condition',
        ]),
      }),
      execute: async (input) => ({
        success: true,
        context: input.context,
        allowedReferences: getCelGrammar(input.context),
      }),
    }),
    lookup_validation_code: tool({
      description:
        'Look up a compiler validation code in the Knowledge Spine. Use when explaining validation failures or citing why a proposal avoids a specific compiler error.',
      inputSchema: z.object({
        code: z
          .string()
          .min(1)
          .describe('Compiler validation code, for example INVALID_HANDOFF_TARGET'),
      }),
      execute: async (input) => {
        const validationCode = lookupValidationCode(input.code);
        if (!validationCode) {
          return {
            success: false,
            error: {
              code: 'VALIDATION_CODE_NOT_FOUND',
              message: `Knowledge Spine has no validation code named "${input.code}".`,
            },
          };
        }

        return { success: true, code: input.code, validationCode };
      },
    }),
    run_feasibility_check: tool({
      description:
        'Run Arch runtime feasibility checks on proposed agent DSL without saving. Use before propose_modification for empty-response, tool-binding, voice-model, provider-allowlist, and memory-scope risks.',
      inputSchema: z.object({
        code: z.string().describe('Proposed ABL YAML code to inspect'),
        declaredToolNames: z.array(z.string()).optional(),
        resolvedToolNames: z.array(z.string()).optional(),
        checkName: z
          .enum([
            'empty-response',
            'tool-binding',
            'voice-model-feasibility',
            'provider-allowlist',
            'memory-scope-identity',
          ])
          .optional()
          .describe('Optional single feasibility check to return'),
      }),
      execute: async (input) => {
        const findings = runFeasibilityChecks({
          code: input.code,
          declaredToolNames: input.declaredToolNames,
          resolvedToolNames: input.resolvedToolNames,
        });
        const filtered = input.checkName
          ? findings.filter((finding) => finding.checkName === input.checkName)
          : findings;
        return {
          success: true,
          findings: filtered,
          passed: filtered.length === 0,
        };
      },
    }),
    read_agent: tool({
      description: 'Read the current ABL code and config of a live agent from the project.',
      inputSchema: z.object({
        agentName: z
          .string()
          .optional()
          .describe(
            'Name of the agent to read. Defaults to the current agent page when available.',
          ),
      }),
      execute: async (input) => {
        try {
          const resolvedAgentName =
            input.agentName ??
            (env?.pageContext?.entity?.type === 'agent' ? env.pageContext.entity.id : undefined);
          if (!resolvedAgentName) {
            return {
              success: false,
              error: {
                code: 'AGENT_NAME_REQUIRED',
                message: 'agentName is required unless you are already on a specific agent page.',
              },
            };
          }

          const ProjectAgent = await getProjectAgentModel();
          const agent = await ProjectAgent.findOne({
            projectId,
            tenantId: ctx.tenantId,
            name: resolvedAgentName,
          });
          if (!agent) {
            return { error: `Agent '${resolvedAgentName}' not found in project` };
          }
          const toolRuntimeContext = await buildAgentToolRuntimeContext({
            tenantId: ctx.tenantId,
            projectId,
            dslContent: agent.dslContent,
          });
          return {
            name: agent.name,
            dslContent: agent.dslContent,
            status: agent.status,
            agentPath: agent.agentPath,
            toolRuntimeContext,
          };
        } catch (err: unknown) {
          return {
            success: false,
            error: {
              code: 'READ_AGENT_ERROR',
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      },
    }),
    trace_diagnosis: tool({
      description:
        'Diagnose runtime behavior using sessions, traces, diagnostics, and analytics. ' +
        'Use this for questions like "my last session", "recent traces", "why are sessions failing today", ' +
        '"last 24 hours", "production health for this agent", "compare today vs yesterday", or "compare staging vs prod". ' +
        'Prefer passing the user wording in query when relative time, environment, or session references are involved.',
      inputSchema: TraceDiagnosisInputSchema,
      execute: async (input) => {
        const { executeTraceDiagnosis } = await import('@/lib/arch-ai/tools/trace-diagnosis');
        return executeTraceDiagnosis(input, buildToolContext(), { pageContext: env?.pageContext });
      },
    }),
    session_ops: tool({
      description:
        'List project sessions or read a specific session summary. Use this when you need exact session IDs or a lightweight summary; use trace_diagnosis for relative time windows, "my last session", comparisons, and deep trace evidence.',
      inputSchema: z.object({
        action: z.enum(['list', 'get', 'get_analysis']).describe('Session operation to perform'),
        sessionId: z.string().optional().describe('Session ID for get or get_analysis'),
        limit: z.number().int().min(1).max(50).optional().describe('Max sessions for list'),
        status: z.string().optional().describe('Optional status filter for list'),
      }),
      execute: async (input) => {
        const { executeSessionOps } = await import('@/lib/arch-ai/tools/session-ops');
        return executeSessionOps(input, buildToolContext());
      },
    }),
    query_traces: tool({
      description:
        'Query execution traces for debugging. Supports filtering by agent, session, event type, severity, and time range. Returns structured trace events with optional full data payloads.',
      inputSchema: z.object({
        agentName: z.string().optional().describe('Filter by agent name'),
        sessionId: z.string().optional().describe('Filter by session ID'),
        eventType: z
          .string()
          .optional()
          .describe('Filter by single event type (e.g., "tool_call", "error", "handoff")'),
        eventTypes: z.array(z.string()).optional().describe('Filter by multiple event types'),
        severity: z
          .enum(['debug', 'info', 'warn', 'error'])
          .optional()
          .describe('Filter by severity level'),
        since: z.string().optional().describe('ISO timestamp — only events after this time'),
        until: z.string().optional().describe('ISO timestamp — only events before this time'),
        limit: z.number().optional().describe('Max results (default: 50, max: 200)'),
        includeData: z
          .boolean()
          .optional()
          .describe('Include full event data payload (can be large)'),
      }),
      execute: async (input) => {
        const { executeTraceQuery } = await import('@/lib/arch-ai/tools/trace-query');
        return executeTraceQuery(input, buildToolContext());
      },
    }),
    health_check: tool({
      description:
        'Run a comprehensive health check on all agents in the project. Performs full project-level compilation to validate cross-agent references (HANDOFFs, routing, delegates). Returns per-agent status, semantic findings with diagnostic codes, and cross-agent findings. IMPORTANT: Only report findings that appear in the returned data with their exact codes and severity. Do NOT invent codes or extrapolate findings beyond what is returned.',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { executeHealthCheck } = await import('@/lib/arch-ai/tools/health-check');
          const result = await executeHealthCheck(
            { action: 'full_check' },
            {
              projectId,
              user: {
                permissions: ctx.permissions ?? [],
                tenantId: ctx.tenantId,
                userId: ctx.userId,
              },
            },
          );
          if (!result.success) {
            return {
              success: false,
              error: result.error,
            };
          }
          return result.data;
        } catch (err: unknown) {
          return {
            success: false,
            error: {
              code: 'HEALTH_CHECK_FAILED',
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      },
    }),
    validate_agent: tool({
      description:
        'Run semantic validation on one agent or all agents. Returns structured findings with severity, category, and fix suggestions. Use depth="quick" for structural checks only, "deep" for full semantic analysis (handoffs, tools, constraints, gather, memory, patterns). Only report findings that appear in the returned data with their exact codes and severity — never invent or extrapolate diagnostic codes.',
      inputSchema: z.object({
        agentName: z.string().min(1).describe('Agent name to validate, or "all" for all agents'),
        depth: z
          .enum(['quick', 'deep'])
          .optional()
          .default('deep')
          .describe('Validation depth: quick (structural only) or deep (all 98 rules)'),
      }),
      execute: async (input) => {
        try {
          const { executeValidateAgent } = await import('@/lib/arch-ai/tools/validate-agent');
          const result = await executeValidateAgent(input, buildToolContext());
          if (!result.success) return { success: false, error: result.error };
          return {
            ...(result.data as Record<string, unknown>),
            _instructions:
              'STRICT FIDELITY: Report ONLY findings present in this data with their exact codes and severity. Do NOT invent diagnostic codes. Do NOT extrapolate findings to agents not listed. Do NOT claim anti-patterns unless present in this data.',
          };
        } catch (err: unknown) {
          return {
            success: false,
            error: {
              code: 'VALIDATE_AGENT_FAILED',
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      },
    }),
    diagnose_project: tool({
      description:
        'Run a full project diagnostic report across all agents. Returns findings grouped by category with architecture pattern classification and anti-pattern detection. Use focus to narrow to a specific area. Only report architecture patterns and anti-patterns that are explicitly returned — never fabricate patterns not present in the output.',
      inputSchema: z.object({
        focus: z
          .enum(['handoffs', 'tools', 'constraints', 'data_flow', 'all'])
          .optional()
          .default('all')
          .describe('Focus area: handoffs, tools, constraints, data_flow, or all'),
      }),
      execute: async (input) => {
        try {
          const { executeDiagnoseProject } = await import('@/lib/arch-ai/tools/diagnose-project');
          const result = await executeDiagnoseProject(input, buildToolContext());
          if (!result.success) return { success: false, error: result.error };
          return {
            ...(result.data as Record<string, unknown>),
            _instructions:
              'STRICT FIDELITY: Report ONLY findings and antiPatterns present in this data. The antiPatterns array is authoritative — if empty, report NO anti-patterns. Do NOT invent codes or extrapolate findings to agents not listed.',
          };
        } catch (err: unknown) {
          return {
            success: false,
            error: {
              code: 'DIAGNOSE_PROJECT_FAILED',
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      },
    }),
    explain_diagnostic: tool({
      description:
        'Get a detailed explanation of a diagnostic code. Returns the rule description, impact, fix suggestion with ABL code template, and optionally agent-specific context. Use after validate_agent or diagnose_project to help the user understand and fix specific issues.',
      inputSchema: z.object({
        code: z.string().min(1).describe('Diagnostic code (e.g. H-01, CO-04, T-01, G-02, C-08)'),
        agentName: z.string().optional().describe('Agent name for context-specific explanation'),
      }),
      execute: async (input) => {
        try {
          const { executeExplainDiagnostic } =
            await import('@/lib/arch-ai/tools/explain-diagnostic');
          const result = await executeExplainDiagnostic(input, buildToolContext());
          if (!result.success) return { success: false, error: result.error };
          return result.data;
        } catch (err: unknown) {
          return {
            success: false,
            error: {
              code: 'EXPLAIN_DIAGNOSTIC_FAILED',
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      },
    }),
    read_insights: tool({
      description:
        'Read analytics insights about agent performance. Actions: overview (all insight scores), quality (helpfulness/accuracy/professionalism scores), outcomes (resolved/escalated/abandoned breakdown), agent_performance (per-agent metrics from traces), sentiment (sentiment trends and frustration rate), tool_performance (per-tool success/retry/latency).',
      inputSchema: z.object({
        action: z
          .enum([
            'overview',
            'quality',
            'outcomes',
            'agent_performance',
            'sentiment',
            'tool_performance',
          ])
          .describe('Type of insight to read'),
        agentName: z.string().optional().describe('Filter by agent name'),
        timeRange: z
          .enum(['1h', '24h', '7d', '30d'])
          .optional()
          .default('7d')
          .describe('Time range'),
      }),
      execute: async (input) => {
        try {
          const { queryInsights } = await import('@/lib/arch-ai/tools/insight-queries');
          return await queryInsights(input.action, ctx.tenantId, projectId, {
            agentName: input.agentName,
            timeRange: input.timeRange,
          });
        } catch (err: unknown) {
          return {
            success: false,
            error: {
              code: 'INSIGHT_QUERY_FAILED',
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      },
    }),
    recommend_model: tool({
      description:
        'Recommend optimal LLM models for an agent based on complexity, capabilities, cost, and tenant policy. Returns a comparison with primary recommendation, fallback, and alternatives.',
      inputSchema: z.object({
        agentName: z.string().describe('Agent name to analyze, or "all" for topology-wide'),
      }),
      execute: async (input) => {
        try {
          const { getModelRecommendation } =
            await import('@/lib/arch-ai/helpers/get-model-recommendation');
          const ProjectAgent = await getProjectAgentModel();

          if (input.agentName === 'all') {
            const agents = await resolveProjectAgentFindResult(
              ProjectAgent.find(
                {
                  projectId,
                  tenantId: ctx.tenantId,
                },
                'name dslContent',
              ),
            );
            const recommendations = agents
              .filter((agent): agent is ProjectAgentRecord & { name: string } => {
                return typeof agent.name === 'string' && agent.name.length > 0;
              })
              .map((agent) => {
                const rec = getModelRecommendation(
                  buildModelRecommendationInputFromAgent({ ...agent }),
                );
                return { agent: agent.name, ...rec };
              });
            return { recommendations, agentCount: agents.length };
          }

          const agent = await ProjectAgent.findOne({
            projectId,
            tenantId: ctx.tenantId,
            name: input.agentName,
          });
          if (!agent) {
            return {
              success: false,
              error: { code: 'AGENT_NOT_FOUND', message: `Agent '${input.agentName}' not found` },
            };
          }
          const rec = getModelRecommendation(
            buildModelRecommendationInputFromAgent(agent as unknown as Record<string, unknown>),
          );
          return { agent: input.agentName, ...rec };
        } catch (err: unknown) {
          return {
            success: false,
            error: {
              code: 'RECOMMEND_MODEL_ERROR',
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      },
    }),
    configure_model: tool({
      description:
        'Inspect, compare, or apply LLM model configurations for agents. ' +
        'Actions: inspect (show current config), diff (current vs recommended), ' +
        'apply (write config from recommendation or manual input). ' +
        'Supports single agent or "all" for topology-wide.',
      inputSchema: z.object({
        action: z.enum(['inspect', 'diff', 'apply']).describe('Action to perform'),
        agentName: z.string().min(1).describe('Agent name, or "all" for topology-wide'),
        source: z.enum(['recommendation', 'manual']).optional().describe('Required for apply'),
        modelId: z.string().optional().describe('Model ID for manual source'),
        provider: z.string().optional().describe('Provider for manual source'),
        temperature: z.number().min(0).max(2).optional(),
        maxTokens: z.number().int().min(1).optional(),
        operationModels: z.record(z.string(), z.string()).optional(),
        confirmed: z.boolean().optional(),
      }),
      execute: async (input) => {
        const { executeConfigureModel } = await import('@/lib/arch-ai/tools/configure-model');
        return executeConfigureModel(
          input,
          {
            projectId,
            user: {
              permissions: ctx.permissions ?? [],
              tenantId: ctx.tenantId,
              userId: ctx.userId,
            },
            authToken: authToken ?? '',
          },
          projectId,
        );
      },
    }),
    analyze_constraints: tool({
      description:
        'Analyze regulatory compliance constraint coverage (PCI-DSS, HIPAA, GDPR, SOC2) for project agents. Use ONLY when the user explicitly asks about compliance, regulations, or data sensitivity — NOT for general agent fixes or health check remediation.',
      inputSchema: z.object({
        agentName: z.string().describe('Agent name or "all" for full coverage matrix'),
        regulations: z
          .array(z.string())
          .optional()
          .describe('Regulations to check: PCI-DSS, HIPAA, GDPR, SOC2'),
      }),
      execute: async (input) => {
        try {
          const { classifyDataSensitivity } =
            await import('@/lib/arch-ai/helpers/classify-data-sensitivity');
          const { generateConstraints } =
            await import('@/lib/arch-ai/helpers/generate-constraints');
          const { analyzeConstraintCoverage } =
            await import('@/lib/arch-ai/helpers/constraint-coverage-analyzer');
          const ProjectAgent = await getProjectAgentModel();

          const regulations = input.regulations ?? ['PCI-DSS', 'HIPAA', 'GDPR', 'SOC2'];

          const query =
            input.agentName === 'all'
              ? { projectId, tenantId: ctx.tenantId }
              : { projectId, tenantId: ctx.tenantId, name: input.agentName };
          const agents = await ProjectAgent.find(query);

          const { parseAgentBasedABL } = await import('@abl/core');

          const agentStates = agents.map(
            (a: { name: string; dslContent?: string; tools?: string[] }) => {
              // Extract existing constraint conditions from DSL
              let existingConstraints: string[] = [];
              if (a.dslContent) {
                try {
                  const parsed = parseAgentBasedABL(a.dslContent);
                  if (parsed.document?.constraints) {
                    existingConstraints = parsed.document.constraints.flatMap((phase) =>
                      phase.requirements.map((r) => r.condition),
                    );
                  }
                } catch (err: unknown) {
                  log.warn('DSL parse failure during constraint extraction', {
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }
              return {
                name: a.name,
                tools: (a.tools ?? []).map((t: string) => ({ name: t })),
                existingConstraints,
              };
            },
          );

          const coverage = analyzeConstraintCoverage(agentStates, regulations);

          // Generate fix suggestions for gaps
          const gaps = coverage.entries
            .filter((e) => e.status === 'missing' || e.status === 'partial')
            .map((e) => {
              const agentState = agentStates.find((a: { name: string }) => a.name === e.agent);
              const sensitivity = agentState
                ? classifyDataSensitivity(agentState.tools)
                : { categories: ['general' as const], evidence: [] };
              const suggested = generateConstraints({
                regulations: [e.regulation],
                sensitivity: sensitivity.categories,
                agentRole: 'customer_facing',
                agentName: e.agent,
              });
              return { agent: e.agent, regulation: e.regulation, detail: e.detail, suggested };
            });

          return { coverage: coverage.entries, summary: coverage.summary, gaps };
        } catch (err: unknown) {
          return {
            success: false,
            error: {
              code: 'ANALYZE_CONSTRAINTS_ERROR',
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      },
    }),

    find_memory_refs: tool({
      description:
        'Find where a MEMORY field is declared or referenced across project agents. Use before changing memory variables.',
      inputSchema: z.object({
        memoryName: z.string().min(1),
        agentName: z.string().min(1).optional(),
      }),
      execute: async (input) => {
        const permissionError = await requireReferenceReadPermission('find_memory_refs');
        if (permissionError) return permissionError;
        const agents = await loadProjectReferenceSources({ tenantId: ctx.tenantId, projectId });
        return { success: true, ...findMemoryRefs(agents, input.memoryName, input.agentName) };
      },
    }),

    find_gather_field_refs: tool({
      description:
        'Find where a GATHER field is declared or referenced in COMPLETE, FLOW, HANDOFF, or CONSTRAINTS.',
      inputSchema: z.object({
        fieldName: z.string().min(1),
        agentName: z.string().min(1).optional(),
      }),
      execute: async (input) => {
        const permissionError = await requireReferenceReadPermission('find_gather_field_refs');
        if (permissionError) return permissionError;
        const agents = await loadProjectReferenceSources({ tenantId: ctx.tenantId, projectId });
        return { success: true, ...findGatherFieldRefs(agents, input.fieldName, input.agentName) };
      },
    }),

    find_tool_consumers: tool({
      description:
        'Find agents that declare or consume a tool by name. Use before renaming, deleting, or rebinding tools.',
      inputSchema: z.object({
        toolName: z.string().min(1),
      }),
      execute: async (input) => {
        const permissionError = await requireReferenceReadPermission('find_tool_consumers');
        if (permissionError) return permissionError;
        const agents = await loadProjectReferenceSources({ tenantId: ctx.tenantId, projectId });
        return { success: true, ...findToolConsumers(agents, input.toolName) };
      },
    }),

    find_agent_refs: tool({
      description:
        'Find agent declaration and cross-agent references such as HANDOFF, DELEGATE, FLOW, or COMPLETE mentions.',
      inputSchema: z.object({
        agentName: z.string().min(1),
      }),
      execute: async (input) => {
        const permissionError = await requireReferenceReadPermission('find_agent_refs');
        if (permissionError) return permissionError;
        const agents = await loadProjectReferenceSources({ tenantId: ctx.tenantId, projectId });
        return { success: true, ...findAgentRefs(agents, input.agentName) };
      },
    }),

    find_cel_var_refs: tool({
      description:
        'Find CEL-style variable references in COMPLETE, FLOW, HANDOFF, and CONSTRAINTS sections.',
      inputSchema: z.object({
        variableName: z.string().min(1),
        agentName: z.string().min(1).optional(),
      }),
      execute: async (input) => {
        const permissionError = await requireReferenceReadPermission('find_cel_var_refs');
        if (permissionError) return permissionError;
        const agents = await loadProjectReferenceSources({ tenantId: ctx.tenantId, projectId });
        return { success: true, ...findCelVarRefs(agents, input.variableName, input.agentName) };
      },
    }),

    propose_plan: tool({
      description:
        'Propose an evidence-backed implementation plan before any project mutation. ' +
        'Use this after reading relevant agents/topology and before propose_modification, direct agent_ops writes, tool/config/integration writes, or deletes. ' +
        'The user must approve the plan before mutation tools are allowed.',
      inputSchema: proposePlanInputSchema,
      execute: async (
        input,
      ): Promise<{ success: boolean; plan?: PendingPlan; error?: unknown }> => {
        try {
          const parsedInput = proposePlanInputSchema.safeParse(input);
          if (!parsedInput.success) {
            const details = parsedInput.error.errors.map((issue) => {
              const path = issue.path.length > 0 ? issue.path.join('.') : 'input';
              return `${path}: ${issue.message}`;
            });
            return {
              success: false,
              error: {
                code: 'PLAN_VALIDATION_FAILED',
                message: details.join(' '),
                details,
              },
            };
          }
          const planInput = parsedInput.data;
          const now = new Date().toISOString();
          const planId = `plan_${randomUUID()}`;
          const architectureNotes = await buildArchitectureNotesForPlan({
            tenantId: ctx.tenantId,
            projectId,
            affectedAgents: planInput.affectedAgents,
          });
          const knownAgentNames = Array.isArray(architectureNotes.knownAgentNames)
            ? architectureNotes.knownAgentNames.filter(
                (name): name is string => typeof name === 'string' && name.length > 0,
              )
            : [];
          const validationErrors = validatePlanDraft(planInput, knownAgentNames);
          if (validationErrors.length > 0) {
            return {
              success: false,
              error: {
                code: 'PLAN_VALIDATION_FAILED',
                message: validationErrors.join(' '),
                details: validationErrors,
              },
            };
          }
          const plannedMutations = planInput.plannedMutations.map(
            (mutation): PendingPlanMutation => ({
              sourceTool: mutation.sourceTool,
              sourceAction: mutation.sourceAction,
              targetKind: mutation.targetKind,
              operation: mutation.operation,
              agentName: mutation.agentName,
              targetId: mutation.targetId,
              rationale: mutation.rationale,
            }),
          );
          const affectedAgentByKey = new Map<string, string>();
          for (const name of [
            ...planInput.affectedAgents,
            ...plannedMutations
              .map((mutation) => mutation.agentName)
              .filter((value): value is string => typeof value === 'string' && value.length > 0),
          ]) {
            const trimmed = name.trim();
            if (trimmed.length > 0 && !affectedAgentByKey.has(trimmed.toLowerCase())) {
              affectedAgentByKey.set(trimmed.toLowerCase(), trimmed);
            }
          }
          const affectedAgents = Array.from(affectedAgentByKey.values());
          const plan: PendingPlan = {
            id: planId,
            projectId,
            status: 'proposed',
            title: planInput.title,
            goal: planInput.goal,
            summary: planInput.summary,
            architecturalPattern: planInput.architecturalPattern,
            evidence: planInput.evidence,
            affectedAgents,
            sectionsToChange: planInput.sectionsToChange,
            dependentsAnalysis: planInput.dependentsAnalysis,
            alternativesConsidered: planInput.alternativesConsidered,
            citations: planInput.citations,
            plannedMutations,
            risks: planInput.risks,
            questionsForUser: planInput.questionsForUser,
            validationNotes: planInput.validationNotes,
            architectureNotes,
            createdAt: now,
            updatedAt: now,
          };

          await sessionService.setPendingPlan(ctx, sessionId, plan);
          emitCard({
            artifact: 'plan',
            planId,
            status: 'proposed',
            payload: plan,
          });

          return { success: true, plan };
        } catch (err: unknown) {
          return {
            success: false,
            error: {
              code: 'PROPOSE_PLAN_FAILED',
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      },
    }),

    // ── Override propose_modification for IN_PROJECT ──
    // Supports two input modes:
    //   1. sections: targeted edits — server splices into existing DSL via spliceSections()
    //   2. updatedCode: full rewrite — for major restructuring
    // Also supports isNew=true for new agent creation proposals (before=null).
    // Output always uses the FULL before/after envelope for v03 client compat.
    propose_modification: tool({
      description:
        'Propose changes to an agent. Provide "sections" for targeted edits (preferred) or "updatedCode" for full rewrites. Set isNew=true when creating a new agent. Returns a diff for user review — does NOT apply. Use apply_modification after user confirms via ask_user.',
      inputSchema: z.object({
        agentName: z.string().min(1).describe('Name of the agent to modify or create'),
        change: z.string().min(1).describe('Description of the change'),
        updatedCode: z
          .string()
          .min(1)
          .optional()
          .describe('Full updated ABL YAML — for major restructuring across 3+ sections'),
        sections: z
          .array(
            z.object({
              construct: z
                .string()
                .min(1)
                .describe(
                  'ABL section name: PERSONA, GOAL, TOOLS, GATHER, CONSTRAINTS, GUARDRAILS, FLOW, HANDOFF, etc.',
                ),
              content: z
                .string()
                .nullable()
                .describe(
                  'New section content including header (e.g. "PERSONA:\\n  You are..."), or null to remove',
                ),
            }),
          )
          .optional()
          .describe('Section-level edits — preferred for targeted changes'),
        isNew: z
          .boolean()
          .optional()
          .describe('True when creating a brand-new agent (no existing agent)'),
      }),
      execute: async (input) => {
        try {
          const mutationCheck = checkArchMutationAllowed(
            {
              sourceTool: 'propose_modification',
              sourceAction: 'propose',
              targetKind: 'agent_dsl',
              operation: input.isNew === true ? 'create' : 'modify',
              agentName: input.agentName,
            },
            buildToolContext(),
          );
          if (!mutationCheck.allowed) {
            return {
              success: false,
              error: mutationCheck.error,
            };
          }

          const targetScopeError = enforceEditorModeAgentTarget(env?.pageContext, input.agentName);
          if (targetScopeError) {
            return targetScopeError;
          }

          const freshSession = await sessionService.getById(ctx, sessionId);
          const planStateCheck = await validateApprovedPlanState(
            ctx,
            projectId,
            freshSession?.metadata.pendingPlan,
          );
          if (!planStateCheck.valid) {
            const pendingPlan = freshSession?.metadata.pendingPlan;
            if (pendingPlan) {
              await sessionService.setPendingPlan(ctx, sessionId, {
                ...pendingPlan,
                status: 'invalidated',
                updatedAt: new Date().toISOString(),
              });
            }
            return {
              success: false,
              error: planStateCheck.error,
            };
          }

          if (env?.pageContext?.surface === 'agent-editor' && input.isNew === true) {
            return buildEditorScopeError(
              'Editor-mode Arch cannot create new persisted agents. Open project Arch to add a new agent.',
            );
          }

          const hasCode = Boolean(input.updatedCode);
          const hasSections =
            Boolean(input.sections) && Array.isArray(input.sections) && input.sections.length > 0;

          if (!hasCode && !hasSections) {
            return {
              success: false,
              error: {
                code: 'INVALID_INPUT',
                message: 'Provide either updatedCode or sections',
              },
            };
          }
          if (hasCode && hasSections) {
            return {
              success: false,
              error: {
                code: 'INVALID_INPUT',
                message: 'Provide either updatedCode or sections, not both',
              },
            };
          }

          // ── Resolve the proposed code ──
          let proposedCode: string;
          let currentCode = '';

          if (input.isNew) {
            // New agent: no existing agent to read
            if (!hasCode) {
              return {
                success: false,
                error: {
                  code: 'INVALID_INPUT',
                  message:
                    'updatedCode is required when isNew=true (sections not supported for new agents)',
                },
              };
            }
            proposedCode = input.updatedCode!;
            const declaredName = extractAgentNameFromABL(proposedCode);
            if (declaredName && declaredName !== input.agentName) {
              return {
                success: false,
                error: {
                  code: 'DECLARATION_NAME_MISMATCH',
                  message: `New agent proposal target "${input.agentName}" must match the ABL declaration "${declaredName}".`,
                },
              };
            }
          } else {
            // Existing agent: read current DSL
            const ProjectAgent = await getProjectAgentModel();
            const existing = await ProjectAgent.findOne({
              projectId,
              tenantId: ctx.tenantId,
              name: input.agentName,
            });
            if (!existing) {
              return {
                success: false,
                error: {
                  code: 'NOT_FOUND',
                  message: `Agent "${input.agentName}" not found in this project`,
                },
              };
            }
            currentCode = existing.dslContent || '';

            if (hasSections) {
              // Section-level edit: splice into existing DSL
              const { spliceSections } = await import('@agent-platform/project-io');
              const edits = input.sections!.map((s) => ({
                section: s.construct,
                content: s.content,
              }));
              proposedCode = spliceSections(currentCode, edits);
            } else {
              proposedCode = input.updatedCode!;
            }
          }

          // ── Validate the proposed code ──
          const validation = await validateProjectAgentCode(
            ctx,
            projectId,
            input.agentName,
            proposedCode,
          );

          if (!validation.valid) {
            const count = recordRepairAttempt(input.agentName);
            const capReached = count >= REPAIR_CAP;

            log.info('propose_modification validation failed', {
              sessionId,
              agentName: input.agentName,
              attempt: count,
              capReached,
              mode: hasSections ? 'sections' : 'full',
              isNew: input.isNew ?? false,
              firstError: validation.errors[0]?.message,
            });

            if (!capReached) {
              return {
                success: false,
                error: {
                  code: 'VALIDATION_FAILED',
                  message: validation.errors[0]?.message ?? 'ABL validation failed',
                },
                validation: {
                  errors: validation.errors,
                  warnings: validation.warnings,
                  hint: validation.hint,
                },
                attemptedCode: proposedCode,
                attemptNumber: count,
                repairBudgetRemaining: REPAIR_CAP - count,
              };
            }

            const blockedImpact = await buildAgentChangeImpact({
              tenantId: ctx.tenantId,
              projectId,
              agentName: input.agentName,
              currentCode,
              proposedCode,
              validationWarnings: validation.warnings,
            })
              .then((impact) => markImpactBlocked(impact, validation))
              .catch(() =>
                buildFallbackBlockedImpact({
                  agentName: input.agentName,
                  currentCode,
                  proposedCode,
                  validation,
                }),
              );

            // Cap reached: synthesize a blocked proposal
            const blockedProposal = {
              agentName: input.agentName,
              change: input.change,
              currentCode: currentCode || undefined,
              proposedCode,
              linesChanged: Math.abs(
                proposedCode.split('\n').length - (currentCode || '').split('\n').length,
              ),
              reviewStatus: 'blocked' as const,
              changes: [
                {
                  construct: 'FULL' as const,
                  before: currentCode || null,
                  after: proposedCode,
                  rationale: input.change,
                },
              ],
              validation: {
                valid: false,
                errors: validation.errors,
                warnings: validation.warnings,
                hint: validation.hint,
                repairAttempts: count,
              },
              impact: blockedImpact,
            };

            const lockResult = await acquireMutationLock({
              tenantId: ctx.tenantId,
              projectId,
              agentName: input.agentName,
              sessionId,
            });
            if (!lockResult.acquired) {
              return { success: false, error: lockResult.error };
            }

            try {
              await sessionService.setPendingMutation(ctx, sessionId, {
                tool: 'apply_modification',
                target: input.agentName,
                proposalId: lockResult.proposalRef,
                scope: classifyAgentMutationScope({
                  before: currentCode || '',
                  after: proposedCode,
                  isNew: input.isNew,
                  impact: blockedImpact,
                }),
                isNew: input.isNew ?? false,
                before: currentCode || null,
                // SHA-256 of `before` at propose time. Even for blocked
                // proposals we record this so the cap-bumped retry path
                // (revise + propose again) can still detect concurrent edits.
                beforeHash: computeBeforeHash(currentCode || ''),
                after: proposedCode,
                changeSummary: input.change,
                reviewStatus: 'blocked',
                validation: blockedProposal.validation,
                impact: blockedImpact,
              });
            } catch (err) {
              await releaseMutationLock({
                tenantId: ctx.tenantId,
                projectId,
                agentName: input.agentName,
                sessionId,
              }).catch((releaseErr) => {
                log.warn(
                  'Failed to release mutation lock after blocked proposal persistence failure',
                  {
                    sessionId,
                    projectId,
                    agentName: input.agentName,
                    error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
                  },
                );
              });
              throw err;
            }

            return { success: true, proposal: blockedProposal };
          }

          // ── Valid: build pending proposal ──
          resetRepairAttempt(input.agentName);
          log.info('propose_modification validation passed', {
            sessionId,
            agentName: input.agentName,
            // Mirror the failure-path log so telemetry can compare
            // partial-vs-full update usage and isNew creation patterns.
            mode: hasSections ? 'sections' : 'full',
            isNew: input.isNew ?? false,
            warnings: validation.warnings.length,
          });
          const impact = await buildAgentChangeImpact({
            tenantId: ctx.tenantId,
            projectId,
            agentName: input.agentName,
            currentCode,
            proposedCode,
            validationWarnings: validation.warnings,
          });

          if (env?.pageContext?.surface === 'agent-editor' && hasTopologyEdgeChanges(impact)) {
            return buildEditorScopeError(
              'This proposal changes agent topology. Open project Arch for cross-agent or routing edits.',
            );
          }

          const proposal = {
            agentName: input.agentName,
            change: input.change,
            currentCode: currentCode || undefined,
            proposedCode,
            linesChanged: Math.abs(
              proposedCode.split('\n').length - (currentCode || '').split('\n').length,
            ),
            reviewStatus: 'pending' as const,
            changes: [
              {
                construct: 'FULL' as const,
                before: currentCode || null,
                after: proposedCode,
                rationale: input.change,
              },
            ],
            validation: {
              valid: true,
              errors: [],
              warnings: validation.warnings,
              repairAttempts: 0,
            },
            impact,
          };

          const lockResult = await acquireMutationLock({
            tenantId: ctx.tenantId,
            projectId,
            agentName: input.agentName,
            sessionId,
          });
          if (!lockResult.acquired) {
            return { success: false, error: lockResult.error };
          }

          try {
            await sessionService.setPendingMutation(ctx, sessionId, {
              tool: 'apply_modification',
              target: input.agentName,
              proposalId: lockResult.proposalRef,
              scope: classifyAgentMutationScope({
                before: currentCode || '',
                after: proposedCode,
                isNew: input.isNew,
                impact,
              }),
              isNew: input.isNew ?? false,
              before: currentCode || null,
              // SHA-256 of `before` at propose time — verified in
              // applyProjectAgentModification to reject concurrent edits.
              beforeHash: computeBeforeHash(currentCode || ''),
              after: proposedCode,
              changeSummary: input.change,
              impact,
            });
          } catch (err) {
            await releaseMutationLock({
              tenantId: ctx.tenantId,
              projectId,
              agentName: input.agentName,
              sessionId,
            }).catch((releaseErr) => {
              log.warn('Failed to release mutation lock after proposal persistence failure', {
                sessionId,
                projectId,
                agentName: input.agentName,
                error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
              });
            });
            throw err;
          }

          return { success: true, proposal };
        } catch (err: unknown) {
          return {
            success: false,
            error: {
              code: 'INTERNAL',
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      },
    }),

    // ── apply_modification — server-enforced: reads from pendingMutation only ──
    apply_modification: tool({
      description:
        'Apply the reviewed proposal for an agent. Requires a prior propose_modification call that the user confirmed via ask_user Confirmation.',
      inputSchema: z.object({
        agentName: z.string().min(1).describe('Name of the agent to modify or create'),
      }),
      execute: async (input) => {
        try {
          const mutationCheck = checkArchMutationAllowed(
            {
              sourceTool: 'apply_modification',
              sourceAction: 'apply',
              targetKind: 'agent_dsl',
              operation: 'apply',
              agentName: input.agentName,
            },
            buildToolContext(),
          );
          if (!mutationCheck.allowed) {
            return {
              success: false,
              error: mutationCheck.error,
            };
          }

          const targetScopeError = enforceEditorModeAgentTarget(env?.pageContext, input.agentName);
          if (targetScopeError) {
            return targetScopeError;
          }

          // 1. Require a matching reviewed proposal — server-enforced gate
          const freshSession = await sessionService.getById(ctx, sessionId);
          const pendingMut = freshSession?.metadata.pendingMutation;
          const pendingPlan = freshSession?.metadata.pendingPlan;

          if (!pendingMut || pendingMut.target !== input.agentName) {
            return {
              success: false,
              error: {
                code: 'NO_REVIEWED_PROPOSAL',
                message:
                  'No reviewed proposal for this agent. Call propose_modification first, then ask the user to confirm before applying.',
              },
            };
          }

          if (pendingMut.reviewStatus === 'blocked') {
            return {
              success: false,
              error: {
                code: 'PROPOSAL_BLOCKED',
                message:
                  'The reviewed proposal is blocked by validation or runtime-readiness issues. Revise the proposal before applying it.',
              },
              validation: pendingMut.validation,
            };
          }

          const planStateCheck = await validateApprovedPlanState(ctx, projectId, pendingPlan);
          if (!planStateCheck.valid) {
            if (pendingPlan) {
              await sessionService.setPendingPlan(ctx, sessionId, {
                ...pendingPlan,
                status: 'invalidated',
                updatedAt: new Date().toISOString(),
              });
            }
            return {
              success: false,
              error: planStateCheck.error,
            };
          }

          // 2. Read code from the reviewed proposal — no direct updatedCode
          const updatedCode = typeof pendingMut.after === 'string' ? pendingMut.after : null;
          if (!updatedCode) {
            return {
              success: false,
              error: {
                code: 'PROPOSAL_PAYLOAD_MISSING',
                message: 'Reviewed proposal has no code to apply.',
              },
            };
          }

          // 3. Create or update based on isNew flag
          const isNew = pendingMut.isNew === true;
          let result;

          if (isNew) {
            result = await createNewProjectAgent(ctx, projectId, input.agentName, updatedCode);
          } else {
            // Forward the beforeHash captured at propose time so the apply
            // path can reject PROPOSAL_STALE if a concurrent edit landed
            // between propose and apply.
            result = await applyProjectAgentModification(
              ctx,
              projectId,
              input.agentName,
              updatedCode,
              pendingMut.beforeHash,
            );
          }

          // 4. Clear pendingMutation on success
          if (result.success) {
            try {
              await sessionService.setPendingMutation(ctx, sessionId, null);
              await sessionService.setPendingPlan(ctx, sessionId, null);
              await releaseMutationLock({
                tenantId: ctx.tenantId,
                projectId,
                agentName: input.agentName,
                sessionId,
              });
            } catch (clearErr: unknown) {
              log.warn('Failed to clear pending mutation/plan after successful apply', {
                sessionId,
                error: clearErr instanceof Error ? clearErr.message : String(clearErr),
              });
              // Non-fatal: the apply succeeded, just approval state is stale.
              // It will be cleared on next propose_modification.
            }
          }

          // 5. Clear pendingMutation on PROPOSAL_STALE so the LLM cannot
          // retry the same envelope indefinitely. A stale proposal is
          // unusable: every retry would fail the same way. Clearing it
          // forces the next apply_modification to return
          // NO_REVIEWED_PROPOSAL, which signals the LLM to call
          // propose_modification again with a fresh `before` snapshot.
          if (!result.success && result.error?.code === 'PROPOSAL_STALE') {
            try {
              await sessionService.setPendingMutation(ctx, sessionId, null);
              await releaseMutationLock({
                tenantId: ctx.tenantId,
                projectId,
                agentName: input.agentName,
                sessionId,
              });
            } catch (clearErr: unknown) {
              log.warn('Failed to clear pendingMutation after PROPOSAL_STALE', {
                sessionId,
                error: clearErr instanceof Error ? clearErr.message : String(clearErr),
              });
              // Non-fatal: the apply was rejected anyway. The next propose
              // call will overwrite the stale entry.
            }
          }

          return result;
        } catch (err: unknown) {
          return {
            success: false,
            error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) },
          };
        }
      },
    }),

    // ── dismiss_proposal — explicit clear for denied/abandoned proposals ──
    dismiss_proposal: tool({
      description:
        'Clear the current pending proposal. Call when the user rejects changes or the conversation moves to a different topic.',
      inputSchema: z.object({}),
      execute: async () => {
        const freshSession = await sessionService.getById(ctx, sessionId);
        const pendingMutationTarget = freshSession?.metadata.pendingMutation?.target;
        await sessionService.setPendingMutation(ctx, sessionId, null);
        if (pendingMutationTarget) {
          await releaseMutationLock({
            tenantId: ctx.tenantId,
            projectId,
            agentName: pendingMutationTarget,
            sessionId,
          });
        }
        log.info('Proposal dismissed', { sessionId, projectId });
        return { dismissed: true };
      },
    }),

    // ── read_journal — query project decision history ──
    read_journal: tool({
      description:
        'Query the project decision journal. Returns decisions, mutations, validations, and consultations from project creation and ongoing modifications. Use this to understand WHY the architecture was designed a certain way.',
      inputSchema: z.object({
        type: z
          .enum(['decision', 'consultation', 'mutation', 'validation', 'analysis'])
          .optional()
          .describe('Filter by entry type'),
        phase: z
          .string()
          .optional()
          .describe('Filter by phase (INTERVIEW, BLUEPRINT, BUILD, CREATE)'),
        limit: z.number().min(1).max(50).optional().describe('Max entries to return (default 20)'),
      }),
      execute: async (input) => {
        try {
          // Query by projectId (not sessionId) to get the full project decision
          // history across all sessions — onboarding + in-project modifications.
          // `requireProjectAccess` runs at the top of POST() for IN_PROJECT sessions
          // (line ~492), so passing `unsafeProjectScope: true` here is safe.
          const entries = await journalService.query(
            { tenantId: ctx.tenantId, userId: ctx.userId },
            {
              projectId,
              unsafeProjectScope: true,
              ...(input.type ? { type: input.type } : {}),
              ...(input.phase ? { phase: input.phase } : {}),
            },
          );
          const limited = entries.slice(-(input.limit ?? 20));
          return {
            count: limited.length,
            entries: limited.map((e) => {
              const c = e.content as unknown as Record<string, string | undefined>;
              return {
                type: e.type,
                phase: e.phase,
                summary: c.summary ?? c.what ?? c.target ?? e.type,
                specialist: e.specialist,
                timestamp: e.timestamp,
              };
            }),
          };
        } catch (err: unknown) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),

    // ── read_topology — wire existing topology-ops logic ──
    read_topology: tool({
      description:
        'Read the project topology: all agents and their handoff/delegate/escalate relationships as a graph of nodes and edges.',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const ProjectAgent = await getProjectAgentModel();
          const agents = await ProjectAgent.find({
            projectId,
            tenantId: ctx.tenantId,
          });

          if (agents.length === 0) {
            return { agents: [], edges: [], agentCount: 0, edgeCount: 0 };
          }

          const nodes: Array<{
            name: string;
            type: string;
            hasDsl: boolean;
            description: string | null;
            mode: 'reasoning' | 'scripted' | 'hybrid' | 'unknown';
            isEntryPoint: boolean;
            tools: string[];
          }> = [];
          const edges: Array<{ from: string; to: string; type: string }> = [];

          for (const agent of agents) {
            const a = agent as Record<string, unknown>;
            const dsl = a.dslContent as string | null;
            let parsedType = dsl?.includes('SUPERVISOR:') ? 'supervisor' : 'agent';
            let parsedTools = extractToolNames(dsl ?? null);
            const parsedEdges: AgentDependencyEdge[] = [];

            if (dsl) {
              const parsed = parseAgentBasedABL(dsl);
              if (parsed.document) {
                parsedType = getParsedDocumentType(
                  parsed.document,
                  dsl.includes('SUPERVISOR:') ? 'supervisor' : 'agent',
                );
                parsedTools = extractToolNamesFromParsedDocument(parsed.document);
                parsedEdges.push(
                  ...extractRoutingEdgesFromParsedDocument(parsed.document, a.name as string),
                );
              }
            }

            nodes.push({
              name: a.name as string,
              type: parsedType,
              hasDsl: Boolean(dsl),
              description: (a.description as string) ?? null,
              mode: extractMode(dsl ?? null),
              isEntryPoint: extractIsEntryPoint(dsl ?? null),
              tools: parsedTools,
            });
            edges.push(...parsedEdges);
          }

          return { agents: nodes, edges, agentCount: nodes.length, edgeCount: edges.length };
        } catch (err: unknown) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),

    read_blueprint: tool({
      description:
        'Read the current structured blueprint for this project. Use before architectural edits in canonical-blueprint mode.',
      inputSchema: z.object({
        version: z.number().int().positive().optional(),
        section: z.string().min(1).optional(),
      }),
      execute: async (input) => {
        try {
          const { ArchBlueprint } = await import('@agent-platform/database/models');
          const query = ArchBlueprint.findOne({
            tenantId: ctx.tenantId,
            projectId,
            ...(input.version ? { version: input.version } : {}),
          }).sort({ version: -1 });
          const blueprint = await query.lean();
          if (!blueprint) {
            return {
              success: false,
              error: {
                code: 'BLUEPRINT_NOT_FOUND',
                message: 'No blueprint is linked to this project yet.',
              },
            };
          }
          const output = blueprint.output as Record<string, unknown>;
          const section =
            input.section && Object.prototype.hasOwnProperty.call(output, input.section)
              ? output[input.section]
              : undefined;
          return {
            success: true,
            blueprint: {
              id: String(blueprint._id),
              version: blueprint.version,
              state: blueprint.state,
              lockedAt: blueprint.lockedAt ?? null,
              output: input.section ? section : output,
            },
          };
        } catch (err: unknown) {
          return {
            success: false,
            error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) },
          };
        }
      },
    }),

    propose_blueprint_edit: tool({
      description:
        'Propose a structured edit to a blueprint section. Use this for agent-affecting edits in canonical-blueprint mode.',
      inputSchema: z.object({
        sectionId: z.string().min(1),
        changes: z.unknown(),
        reason: z.string().min(1),
      }),
      execute: async (input) => {
        try {
          const { BlueprintService } = await import('@agent-platform/arch-ai/blueprint');
          const edited = await BlueprintService.appendEdit({
            tenantId: ctx.tenantId,
            projectId,
            sectionId: input.sectionId,
            changes: { reason: input.reason, patch: input.changes },
            updatedBy: ctx.userId,
          });
          return {
            success: true,
            blueprint: {
              id: edited.id,
              version: edited.version,
              state: edited.state,
              sectionId: input.sectionId,
            },
          };
        } catch (err: unknown) {
          return {
            success: false,
            error: {
              code: 'BLUEPRINT_EDIT_FAILED',
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      },
    }),

    lock_blueprint_version: tool({
      description: 'Validate and lock the latest draft blueprint for this project.',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { BlueprintService } = await import('@agent-platform/arch-ai/blueprint');
          const locked = await BlueprintService.lockLatest({
            tenantId: ctx.tenantId,
            projectId,
            userId: ctx.userId,
          });
          return { success: true, blueprint: locked };
        } catch (err: unknown) {
          return {
            success: false,
            error: {
              code: 'BLUEPRINT_LOCK_FAILED',
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      },
    }),

    fork_blueprint: tool({
      description: 'Fork the latest blueprint into a new editable draft.',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { BlueprintService } = await import('@agent-platform/arch-ai/blueprint');
          const forked = await BlueprintService.forkDraft({
            tenantId: ctx.tenantId,
            projectId,
            userId: ctx.userId,
          });
          return { success: true, blueprint: forked };
        } catch (err: unknown) {
          return {
            success: false,
            error: {
              code: 'BLUEPRINT_FORK_FAILED',
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      },
    }),

    rebuild_agents_from_blueprint: tool({
      description:
        'Regenerate project agents from a locked blueprint version. Requires explicit overwrite confirmation when local edits differ.',
      inputSchema: z.object({
        fromVersion: z.number().int().positive(),
        confirmOverwriteLocalEdits: z.boolean().optional().default(false),
      }),
      execute: async (input) => {
        try {
          const { ArchBlueprint, ArchSession } = await import('@agent-platform/database/models');
          const {
            getSourceArchitectureContractFromMetadata,
            renderArchManagedBehaviorProfiles,
            renderProjectFromBlueprint,
          } = await import('@agent-platform/arch-ai/blueprint');
          const blueprint = await ArchBlueprint.findOne({
            tenantId: ctx.tenantId,
            projectId,
            version: input.fromVersion,
            state: { $in: ['locked', 'linked'] },
          }).lean();
          if (!blueprint) {
            return {
              success: false,
              error: {
                code: 'BLUEPRINT_NOT_FOUND',
                message: `Locked blueprint version ${input.fromVersion} was not found.`,
              },
            };
          }

          const modelDefaults = await resolveArchModelPolicyDefaultsForProject({
            tenantId: ctx.tenantId,
            projectId,
          });
          const sourceSession =
            blueprint.sessionId != null
              ? await ArchSession.findOne({
                  tenantId: ctx.tenantId,
                  _id: blueprint.sessionId,
                  'metadata.projectId': projectId,
                })
                  .select({ metadata: 1 })
                  .lean()
              : null;
          const sourceContract = getSourceArchitectureContractFromMetadata(
            sourceSession?.metadata as Record<string, unknown> | undefined,
          );
          const rendered = renderProjectFromBlueprint(
            blueprint.output as Parameters<typeof renderProjectFromBlueprint>[0],
            { modelDefaults, sourceContract },
          );
          const ProjectAgent = await getProjectAgentModel();
          const existingAgents = await ProjectAgent.find({
            tenantId: ctx.tenantId,
            projectId,
          });
          const existingByName = new Map(
            existingAgents.map((agent) => [
              String(agent.name ?? ''),
              agent as Record<string, unknown>,
            ]),
          );
          const agentConflicts = rendered.agents
            .map((agent) => {
              const existing = existingByName.get(agent.name);
              if (!existing) return null;
              const currentDsl = typeof existing.dslContent === 'string' ? existing.dslContent : '';
              const currentHash = computeBeforeHash(currentDsl);
              return currentHash === computeBeforeHash(agent.dslContent)
                ? null
                : { agentName: agent.name, currentHash, blueprintHash: agent.sourceHash };
            })
            .filter(Boolean);
          const { ProjectConfigVariable } = await import('@agent-platform/database/models');
          const renderedProfileKeys = new Set(
            rendered.behaviorProfiles.map((profile) =>
              behaviorProfileNameToConfigKey(profile.name),
            ),
          );
          const managedProfiles = renderArchManagedBehaviorProfiles();
          const managedProfileByKey = new Map(
            managedProfiles.map((profile) => [
              behaviorProfileNameToConfigKey(profile.name),
              profile,
            ]),
          );
          const profileKeys = [...new Set([...renderedProfileKeys, ...managedProfileByKey.keys()])];
          const existingProfileDocs: Array<{ key?: unknown; value?: unknown }> =
            profileKeys.length > 0
              ? await ProjectConfigVariable.find({
                  tenantId: ctx.tenantId,
                  projectId,
                  key: { $in: profileKeys },
                })
                  .select('key value')
                  .lean()
              : [];
          const existingProfileByKey = new Map(
            existingProfileDocs.map((profile) => [
              String(profile.key ?? ''),
              String(profile.value ?? ''),
            ]),
          );
          const staleManagedProfileConflicts = [...managedProfileByKey.entries()]
            .filter(([key]) => !renderedProfileKeys.has(key))
            .map(([key, profile]) => {
              const currentDsl = existingProfileByKey.get(key);
              if (currentDsl === undefined) return null;
              const currentHash = computeBeforeHash(currentDsl);
              return currentHash === computeBeforeHash(profile.dslContent)
                ? null
                : {
                    agentName: `behavior_profile:${profile.name}`,
                    currentHash,
                    blueprintHash: computeBeforeHash(''),
                  };
            })
            .filter(Boolean);
          const staleManagedProfileKeys = [...managedProfileByKey.entries()]
            .filter(([key]) => !renderedProfileKeys.has(key))
            .filter(([key, profile]) => {
              const currentDsl = existingProfileByKey.get(key);
              if (currentDsl === undefined) return false;
              if (input.confirmOverwriteLocalEdits) return true;
              return computeBeforeHash(currentDsl) === computeBeforeHash(profile.dslContent);
            })
            .map(([key]) => key);
          const profileConflicts = rendered.behaviorProfiles
            .map((profile) => {
              const key = behaviorProfileNameToConfigKey(profile.name);
              const currentDsl = existingProfileByKey.get(key);
              if (currentDsl === undefined) return null;
              const currentHash = computeBeforeHash(currentDsl);
              return currentHash === computeBeforeHash(profile.dslContent)
                ? null
                : {
                    agentName: `behavior_profile:${profile.name}`,
                    currentHash,
                    blueprintHash: profile.sourceHash,
                  };
            })
            .filter(Boolean);
          const conflicts = [
            ...agentConflicts,
            ...profileConflicts,
            ...staleManagedProfileConflicts,
          ];

          if (conflicts.length > 0 && !input.confirmOverwriteLocalEdits) {
            return {
              success: false,
              needsConfirmation: true,
              conflicts,
              message:
                'Local agent edits differ from the blueprint render. Re-run with confirmOverwriteLocalEdits=true to overwrite.',
            };
          }

          const results = [];
          for (const profile of rendered.behaviorProfiles) {
            const key = behaviorProfileNameToConfigKey(profile.name);
            await ProjectConfigVariable.findOneAndUpdate(
              {
                tenantId: ctx.tenantId,
                projectId,
                key,
              },
              {
                $set: {
                  value: profile.dslContent,
                  updatedBy: ctx.userId,
                },
                $setOnInsert: {
                  tenantId: ctx.tenantId,
                  projectId,
                  key,
                  description: null,
                  createdBy: ctx.userId,
                },
              },
              { upsert: true },
            );
          }
          if (staleManagedProfileKeys.length > 0) {
            await ProjectConfigVariable.deleteMany({
              tenantId: ctx.tenantId,
              projectId,
              key: { $in: staleManagedProfileKeys },
            });
          }
          for (const agent of rendered.agents) {
            if (existingByName.has(agent.name)) {
              results.push(
                await applyProjectAgentModification(ctx, projectId, agent.name, agent.dslContent),
              );
            } else {
              results.push(
                await createNewProjectAgent(ctx, projectId, agent.name, agent.dslContent),
              );
            }
          }
          if (rendered.behaviorProfiles.length > 0 || staleManagedProfileKeys.length > 0) {
            await refreshProjectAgentDraftMetadataForConfigMutation({
              projectId,
              tenantId: ctx.tenantId,
            });
            invalidateProjectCaches(ctx.tenantId, projectId);
          }
          return { success: results.every((result) => result.success), results };
        } catch (err: unknown) {
          return {
            success: false,
            error: {
              code: 'BLUEPRINT_REBUILD_FAILED',
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      },
    }),

    tools_ops: tool({
      description:
        'Manage project tool configurations — create, read, update, test, or delete tools. ' +
        'Use action "list" to see all tools, "create" to add new HTTP/MCP/Sandbox/SearchAI tools, ' +
        '"test" to validate a tool works, "update" to modify config, "delete" to remove. ' +
        'Create/read/update returns agentToolBlock for the target agent TOOLS section. ' +
        'agentToolBlock is only the callable signature/description; implementation fields stay in ProjectTool.',
      inputSchema: z.object({
        action: z.enum(['read', 'list', 'create', 'update', 'test', 'delete']),
        toolId: z.string().optional().describe('Tool ID (for read/update/test/delete)'),
        toolName: z.string().optional().describe('Tool name (for create)'),
        config: z.record(z.unknown()).optional().describe('Tool config (for create/update)'),
        testInput: z.record(z.unknown()).optional().describe('Test input (for test)'),
        confirmed: z.boolean().optional().describe('Confirmation (for delete)'),
      }),
      execute: async (input) => {
        const { executeToolsOps } = await import('@/lib/arch-ai/tools/tools-ops');
        const result = await executeToolsOps(input, buildToolContext(), {
          pageContext: env?.pageContext,
        });
        return clearApprovedPlanAfterSuccessfulMutation('tools_ops', input, result);
      },
    }),

    agent_ops: tool({
      description:
        'Direct project agent CRUD. Actions: read, list, create, modify, compile, delete (requires confirmed: true), propose_modification. Use propose_modification + apply_modification for safe iterative edits; use create/modify only for trusted bulk authoring. Returns the agent record or compile diagnostics.',
      inputSchema: z.object({
        action: z.enum([
          'read',
          'list',
          'create',
          'modify',
          'compile',
          'delete',
          'propose_modification',
        ]),
        agentName: z.string().min(1).optional().describe('Agent name'),
        content: z.string().optional().describe('Full ABL content (for create)'),
        edits: z
          .array(
            z.object({
              section: z.string().min(1),
              content: z.string().nullable(),
            }),
          )
          .optional()
          .describe('Section edits (for modify)'),
        dryRun: z.boolean().optional().describe('Validate without writing'),
        confirmed: z.boolean().optional().describe('Confirmation flag (required for delete)'),
        changes: z
          .array(
            z.object({
              construct: z.string(),
              before: z.string().nullable(),
              after: z.string().nullable(),
              rationale: z.string(),
            }),
          )
          .optional()
          .describe('Structured proposal (for propose_modification)'),
      }),
      execute: async (input) => {
        const { executeAgentOps } = await import('@/lib/arch-ai/tools/agent-ops');
        const result = await executeAgentOps(input, buildToolContext());
        return clearApprovedPlanAfterSuccessfulMutation('agent_ops', input, result);
      },
    }),

    deployment_ops: tool({
      description:
        'Manage deployments and project-level channel config. Actions: list (deployments), deploy (promote ABL to env, requires confirmed: true), promote (move between envs, requires confirmed: true), list_channels, configure_channel (creates or updates SDK channel — requires confirmed: true since it touches production routing). Channel agent-binding is NOT in this tool; future channel_ops will own that.',
      inputSchema: z.object({
        action: z.enum(['list', 'deploy', 'promote', 'configure_channel', 'list_channels']),
        deploymentId: z.string().optional(),
        environment: z.string().optional().describe('Target environment (staging, production)'),
        channelType: z.string().optional().describe('Channel type (slack, voice, web, etc.)'),
        channelConfig: z.record(z.unknown()).optional().describe('Channel config payload'),
        confirmed: z
          .boolean()
          .optional()
          .describe('Confirmation flag (required for deploy/promote/configure_channel)'),
      }),
      execute: async (input) => {
        const { executeDeploymentOps } = await import('@/lib/arch-ai/tools/deployment-ops');
        return executeDeploymentOps(input, buildToolContext());
      },
    }),

    testing_ops: tool({
      description:
        'Test runs and eval CRUD (Phase 1: read + run + propose). Actions: run_test (live runtime call), list_evals (read eval sets), create_eval (persists name + description only — scenarios are saved via Studio UI in this phase). Phase 2 will add full eval-write surface when eval-quality validators land.',
      inputSchema: z.object({
        action: z.enum(['run_test', 'list_evals', 'create_eval']),
        agentName: z.string().min(1).optional().describe('Agent to test (for run_test)'),
        testMessage: z.string().min(1).optional().describe('Test message (for run_test)'),
        evalConfig: z
          .object({
            name: z.string().min(1),
            description: z.string().optional(),
            scenarios: z
              .array(z.object({ input: z.string(), expectedBehavior: z.string() }))
              .optional()
              .describe('Phase 1: scenarios are NOT persisted — save via Studio UI'),
          })
          .optional()
          .describe('Eval config (for create_eval)'),
      }),
      execute: async (input) => {
        const { executeTestingOps } = await import('@/lib/arch-ai/tools/testing-ops');
        const result = await executeTestingOps(input, buildToolContext());
        return clearApprovedPlanAfterSuccessfulMutation('testing_ops', input, result);
      },
    }),

    run_simulation: tool({
      description:
        'Run the current agent through the project-scoped Runtime simulation endpoint using optional dirty DSL and scripted user turns. Use this after proposing or editing DSL to verify behavior without writing messages, traces, memory, or session state to production stores.',
      inputSchema: z.object({
        agentName: z.string().min(1).describe('Agent to simulate'),
        dslOverride: z
          .string()
          .optional()
          .describe('Optional unsaved DSL content for this agent only'),
        scriptedUserTurns: z
          .array(z.string().min(1))
          .min(1)
          .max(10)
          .describe('Scripted user messages to replay through the runtime'),
        mockedToolResponses: z
          .record(
            z.object({
              success: z.boolean().optional(),
              response: z.unknown().optional(),
              data: z.unknown().optional(),
              error: z
                .object({
                  code: z.string().min(1),
                  message: z.string().min(1),
                })
                .optional(),
              delayMs: z.number().int().min(0).max(30_000).optional(),
            }),
          )
          .optional()
          .describe('Fail-closed tool mocks keyed by tool name'),
        options: z
          .object({
            maxTurns: z.number().int().min(1).max(10).optional(),
            scenarioId: z.string().min(1).max(128).optional(),
            intentTags: z.array(z.string().min(1).max(128)).max(10).optional(),
          })
          .strict()
          .optional(),
      }),
      execute: async (input) => {
        const { executeSimulationOps } = await import('@/lib/arch-ai/tools/simulation-ops');
        return executeSimulationOps(input, buildToolContext());
      },
    }),

    analytics_ops: tool({
      description:
        'Read-only session analytics. Actions: metrics (aggregate session counts/durations/errors over a time range), anomalies (detect unusual patterns — high error rate, empty sessions, escalation spikes). Optional agentName narrows results for both actions. Backed by direct DB read of Session collection (last 200 sessions in the time window; when timeRange is omitted the most recent 200 sessions are returned).',
      inputSchema: z.object({
        action: z.enum(['metrics', 'anomalies']),
        timeRange: z
          .enum(['1h', '24h', '7d', '30d'])
          .optional()
          .describe('Time window filter on Session.lastActivityAt'),
        agentName: z.string().optional().describe('Filter to a specific agent'),
      }),
      execute: async (input) => {
        const { executeAnalyticsOps } = await import('@/lib/arch-ai/tools/analytics-ops');
        return executeAnalyticsOps(input, buildToolContext());
      },
    }),

    mcp_server_ops: tool({
      description:
        'Manage project MCP server configs using existing Studio MCP APIs. Actions: list/read/create/update/delete, ' +
        'test_connection, discover_preview, import_tools, list_tools, and test_tool. For auth-backed MCP servers, ' +
        'call create/update without flowId first to get requiredSecrets, collect them via collect_secret, then retry ' +
        'with flowId. After import_tools, use tools_ops read/list to get agentToolBlock and link only signatures into agents.',
      inputSchema: mcpServerOpsInputSchema,
      execute: async (input) => {
        const { executeMcpServerOps } = await import('@/lib/arch-ai/tools/mcp-server-ops');
        const result = await executeMcpServerOps(input, buildToolContext());
        return clearApprovedPlanAfterSuccessfulMutation('mcp_server_ops', input, result);
      },
    }),

    external_agent_ops: tool({
      description:
        'Manage project external (A2A) agent configurations. Actions: list/read/create/update/delete, ' +
        'test_connection, and discover_preview. For authenticated agents (bearer/api_key), call create/update ' +
        'without flowId first to get requiredSecrets, collect them via collect_secret, then retry with flowId. ' +
        'discover_preview fetches /.well-known/agent-card.json and returns a parsed AgentCard plus a HANDOFF DSL preview. ' +
        'After create succeeds, integration-methodologist may emit a HANDOFF block routing handoffs to the new external agent.',
      inputSchema: externalAgentOpsInputSchema,
      execute: async (input) => {
        const { executeExternalAgentOps } = await import('@/lib/arch-ai/tools/external-agent-ops');
        const result = await executeExternalAgentOps(input, buildToolContext());
        // Emit ExternalAgentCard for successful read/create/update/test_connection
        // (mirrors kb_status_card emission pattern at lines 2803-2815).
        if (
          result.success &&
          (input.action === 'read' ||
            input.action === 'create' ||
            input.action === 'update' ||
            input.action === 'test_connection')
        ) {
          const data = result.data as Record<string, unknown> | undefined;
          if (data && typeof data.id === 'string') {
            emitCard({
              type: 'external_agent_card',
              id: String(data.id),
              name: String(data.name ?? ''),
              displayName: data.displayName ?? null,
              endpoint: String(data.endpoint ?? ''),
              protocol: String(data.protocol ?? 'a2a'),
              authType: String(data.authType ?? 'none'),
              authConfigured: Boolean(data.authConfigured ?? false),
              lastDiscoveredCard: (data.lastDiscoveredCard ?? null) as Record<
                string,
                unknown
              > | null,
              lastConnectionStatus: (data.lastConnectionStatus ?? null) as string | null,
              lastConnectionAt: (data.lastConnectionAt ?? null) as string | null,
              lastConnectionLatencyMs: (data.lastConnectionLatencyMs ?? null) as number | null,
              lastConnectionError: (data.lastConnectionError ?? null) as string | null,
            });
          }
        }
        return clearApprovedPlanAfterSuccessfulMutation('external_agent_ops', input, result);
      },
    }),

    project_config: tool({
      description:
        'Read or modify project configuration. Get/update project metadata (name, description, ' +
        'entry agent, retention, language) and thinking settings (enableThinking, thinkingBudget). ' +
        'Use get_config to see current project setup. Use update_config to change metadata. ' +
        'Use get_settings/update_settings for thinking configuration.',
      inputSchema: z.object({
        action: z.enum(['get_config', 'update_config', 'get_settings', 'update_settings']),
        name: z.string().min(1).max(100).optional(),
        description: z.string().nullable().optional(),
        entryAgentName: z.string().nullable().optional(),
        messageRetentionDays: z.number().int().positive().nullable().optional(),
        language: z.string().optional(),
        enableThinking: z.boolean().optional(),
        thinkingBudget: z.number().int().positive().nullable().optional(),
        thoughtDescription: z.string().nullable().optional(),
        confirmed: z.boolean().default(false),
      }),
      execute: async (input) => {
        const result = await executeProjectConfig(input, buildToolContext());
        return clearApprovedPlanAfterSuccessfulMutation('project_config', input, result);
      },
    }),

    auth_ops: tool({
      description:
        'Create, read, update, delete, list, or validate auth profiles for tool integrations. ' +
        'Supports api_key, bearer, oauth2_app, and oauth2_client_credentials. ' +
        'Secrets are collected via collect_secret — never pass secrets directly.',
      inputSchema: z.object({
        action: z.enum(['create', 'read', 'update', 'delete', 'list', 'validate']),
        profileId: z.string().optional().describe('Profile ID for read/update/delete/validate'),
        profileName: z.string().optional().describe('Profile name for create'),
        authType: z
          .string()
          .optional()
          .describe('Auth type: api_key, bearer, oauth2_app, oauth2_client_credentials'),
        config: z
          .record(z.unknown())
          .optional()
          .describe('Non-secret config (URLs, scopes, header names)'),
        flowId: z
          .string()
          .optional()
          .describe('Flow ID from needsSecrets response — references collected secrets'),
        confirmed: z.boolean().default(false).describe('Required true for delete'),
      }),
      execute: async (input) => {
        const { executeAuthOps } = await import('@/lib/arch-ai/tools/auth-ops');
        const result = await executeAuthOps(input, buildToolContext());
        return clearApprovedPlanAfterSuccessfulMutation('auth_ops', input, result);
      },
    }),

    variable_ops: tool({
      description:
        'Manage environment variables and config variables for tool integrations, including namespace membership. ' +
        'Use list_namespaces before wiring a new integration if you need available namespace IDs.',
      inputSchema: z.object({
        action: z.enum(['list', 'list_namespaces', 'create', 'update', 'delete', 'link_namespace']),
        variableType: z
          .enum(['env', 'config'])
          .optional()
          .describe('Variable type for CRUD actions'),
        variableId: z.string().optional().describe('Variable ID for update/delete/link_namespace'),
        key: z.string().optional().describe('Variable key for create'),
        value: z.string().optional().describe('Variable value for create/update'),
        description: z.string().nullable().optional().describe('Variable description'),
        isSecret: z.boolean().optional().describe('Whether an env var should be treated as secret'),
        environment: z
          .enum(['global', 'dev', 'staging', 'production'])
          .nullable()
          .optional()
          .describe('Environment for env-var create/list operations'),
        namespaceId: z.string().optional().describe('Optional namespace filter when listing'),
        variableNamespaceIds: z
          .array(z.string())
          .optional()
          .describe('Namespace IDs to assign to the variable'),
        confirmed: z.boolean().default(false).describe('Required true for delete'),
      }),
      execute: async (input) => {
        const { executeVariableOps } = await import('@/lib/arch-ai/tools/variable-ops');
        const result = await executeVariableOps(input, buildToolContext());
        return clearApprovedPlanAfterSuccessfulMutation('variable_ops', input, result);
      },
    }),

    connection_ops: tool({
      description:
        'Manage ConnectorConnection records that bind AuthProfiles to connectors. Used for resolving dynamic dropdowns (e.g., Slack channel list) and making integrations visible on the manual Connections page. Actions: list, create, delete, resolve_options, resolve_dynamic_props.',
      inputSchema: connectionOpsInputSchema,
      execute: async (input) => {
        const { executeConnectionOps } = await import('@/lib/arch-ai/tools/connection-ops');
        const result = await executeConnectionOps(input, buildToolContext());
        return clearApprovedPlanAfterSuccessfulMutation('connection_ops', input, result);
      },
    }),

    integration_ops: tool({
      description:
        'Manage durable integration drafts that span tool setup, auth, variables, and testing across multiple turns.',
      inputSchema: z.object({
        action: z.enum([
          'start',
          'get_active',
          'list',
          'update',
          'run_tool_test',
          'complete',
          'archive',
        ]),
        draftId: z.string().optional().describe('Draft ID for get_active/update/complete/archive'),
        title: z.string().optional().describe('Human-readable draft title'),
        providerKey: z.string().nullable().optional().describe('Integration/provider key'),
        source: z.enum(['onboarding', 'in_project']).optional().describe('Draft source'),
        targetAgentNames: z
          .array(z.string())
          .optional()
          .describe('Target agents for this integration'),
        pendingSteps: z.array(z.string()).optional().describe('Exact pending step list override'),
        addPendingSteps: z.array(z.string()).optional().describe('Pending steps to add'),
        removePendingSteps: z.array(z.string()).optional().describe('Pending steps to remove'),
        lastIntentSummary: z
          .string()
          .nullable()
          .optional()
          .describe('Short summary of current intent'),
        status: z
          .enum([
            'draft',
            'needs_input',
            'ready_to_test',
            'ready_to_apply',
            'complete',
            'archived',
            'failed',
          ])
          .optional()
          .describe('Optional explicit draft status'),
        includeCompleted: z.boolean().optional().describe('Include completed drafts when listing'),
        toolId: z.string().optional().describe('Tool ID for run_tool_test'),
        testInput: z.record(z.unknown()).optional().describe('Sample input for run_tool_test'),
        toolIds: z.array(z.string()).optional().describe('Tool IDs to merge into the draft'),
        authProfileIds: z.array(z.string()).optional().describe('Auth profile IDs to merge'),
        envVarKeys: z.array(z.string()).optional().describe('Env-var keys to merge'),
        configVarKeys: z.array(z.string()).optional().describe('Config-var keys to merge'),
        variableNamespaceIds: z.array(z.string()).optional().describe('Namespace IDs to merge'),
      }),
      execute: async (input) => {
        const { executeIntegrationOps } = await import('@/lib/arch-ai/tools/integration-ops');
        const result = await executeIntegrationOps(input, buildToolContext());
        return clearApprovedPlanAfterSuccessfulMutation('integration_ops', input, result);
      },
    }),

    collect_secret: tool({
      description:
        'Collect a sensitive credential from the user via a secure masked input. ' +
        'The value is NEVER sent to the model or stored in chat history. ' +
        'Use the flowId from auth_ops or mcp_server_ops needsSecrets response.',
      inputSchema: z.object({
        flowId: z
          .string()
          .describe('Flow ID from the auth_ops or mcp_server_ops needsSecrets response'),
        field: z.string().describe('Secret field name (e.g., clientSecret, apiKey, token)'),
        label: z
          .string()
          .describe('Human-readable label shown to the user (e.g., "Salesforce Client Secret")'),
      }),
      // NO execute — client-side tool, handled by WidgetRenderer
    }),

    platform_context: tool({
      description:
        'Fetch platform data — list agents, models, tools, channels, auth profiles, or get project summary. ' +
        'Use this to populate selection widgets with real data. ALWAYS call this before asking users to choose ' +
        'from platform values (models, tools, channels, agents).',
      inputSchema: z.object({
        action: z
          .enum([
            'get_summary',
            'list_agents',
            'list_models',
            'list_tools',
            'list_channels',
            'list_auth_profiles',
          ])
          .describe('Platform context action to perform'),
        agentName: z.string().optional().describe('Filter by agent name (for agent-specific data)'),
        toolType: z.string().optional().describe('Filter by tool type (for list_tools)'),
      }),
      execute: async (input) => {
        const { executePlatformContext } = await import('@/lib/arch-ai/tools/platform-context');
        return executePlatformContext(input, buildToolContext());
      },
    }),

    // generate_agent removed from IN_PROJECT — use propose_modification(isNew=true) instead.
    // BUILD phase keeps its own generate_agent in buildBuildTools (line ~1503).

    // ── KB tools: knowledge base lifecycle + search + health + ingestion ──
    kb_manage: tool({
      description:
        'Manage knowledge bases: list, create, get details, update, or delete. ' +
        'Use "list" to see all KBs, "create" to make a new one, "get" for details.',
      inputSchema: z.object({
        action: z.enum(['list', 'create', 'get', 'update', 'delete']),
        kbId: z.string().optional().describe('Knowledge base ID'),
        kbName: z.string().optional().describe('KB name (for create/update)'),
        description: z.string().optional().describe('KB description'),
        confirmed: z.boolean().optional().describe('Confirmation for destructive actions'),
      }),
      execute: async (input) => {
        const result = await executeKBManage(
          input,
          {
            projectId,
            user: {
              permissions: ctx.permissions ?? [],
              tenantId: ctx.tenantId,
              userId: ctx.userId,
            },
          },
          { pageContext: env?.pageContext, authToken: authToken ?? '' },
        );
        if (result.success && input.action === 'get' && result.data) {
          const kb = (result.data as { knowledgeBase?: Record<string, unknown> }).knowledgeBase;
          if (kb) {
            emitCard({
              type: 'kb_status_card',
              kbId: String(kb._id ?? ''),
              kbName: String(kb.name ?? ''),
              status: String(kb.status ?? 'unknown'),
              stats: {
                documentCount: Number(kb.documentCount ?? 0),
                chunkCount: Number(kb.chunkCount ?? 0),
                sourceCount: Number(kb.sourceCount ?? 0),
                connectorCount: Number(kb.connectorCount ?? 0),
              },
              actions: [],
            });
          }
        }
        return clearApprovedPlanAfterSuccessfulMutation('kb_manage', input, result);
      },
    }),
    kb_search: tool({
      description:
        'Search a knowledge base. Actions: query (semantic search), structured_query (filter-driven structured search), ' +
        'discover (capability manifest), resolve_vocab (term resolution).',
      inputSchema: z.object({
        action: z.enum(['query', 'structured_query', 'discover', 'resolve_vocab']),
        kbId: z.string().optional().describe('Knowledge base ID'),
        kbName: z.string().optional().describe('KB name'),
        query: z.string().optional().describe('Search query text'),
        filters: SearchFilterInputSchema.optional().describe(
          'Search filters as either a field/value record or [{ field, operator, value }]',
        ),
        limit: z.number().optional().describe('Max results'),
        mode: z.enum(['exact', 'alias', 'fuzzy']).optional().describe('Vocab resolution mode'),
      }),
      execute: async (input) => {
        const result = await executeKBSearch(
          input,
          {
            projectId,
            user: {
              permissions: ctx.permissions ?? [],
              tenantId: ctx.tenantId,
              userId: ctx.userId,
            },
          },
          { pageContext: env?.pageContext, authToken: authToken ?? '' },
        );
        if (result.success && (input.action === 'query' || input.action === 'structured_query')) {
          const data = result.data as Record<string, unknown> | undefined;
          const results = (data?.results ?? data?.hits ?? []) as Array<Record<string, unknown>>;
          const latency = (data?.latency ?? null) as Record<string, unknown> | null;
          emitCard({
            type: 'search_results_card',
            kbId: String(data?.kbId ?? input.kbId ?? ''),
            kbName: String(data?.kbName ?? input.kbName ?? ''),
            query: input.query ?? '',
            resultCount: results.length,
            latencyMs: Number(latency?.totalMs ?? data?.latencyMs ?? 0),
            results: results.slice(0, 5).map((r) => ({
              title: String(
                r.title ??
                  r.name ??
                  (r.metadata as Record<string, unknown> | undefined)?.title ??
                  'Untitled',
              ),
              score: Number(r.score ?? r._score ?? 0),
              content: r.content ? String(r.content).slice(0, 200) : undefined,
              source:
                typeof r.source === 'object' && r.source
                  ? String(
                      (r.source as Record<string, unknown>).sourceName ??
                        (r.source as Record<string, unknown>).reference ??
                        '',
                    ) || undefined
                  : r.source
                    ? String(r.source)
                    : undefined,
              sourceType:
                typeof r.source === 'object' && r.source
                  ? String((r.source as Record<string, unknown>).sourceType ?? '') || undefined
                  : r.sourceType
                    ? String(r.sourceType)
                    : undefined,
            })),
            actions: [],
          });
        }
        return clearApprovedPlanAfterSuccessfulMutation('kb_health', input, result);
      },
    }),
    kb_health: tool({
      description:
        'Check knowledge base health. Actions: summary (overall status), errors (error list), ' +
        'retry_failed (reprocess failed docs), sync_counters (doc counts), check_operation (job/sync status).',
      inputSchema: z.object({
        action: z.enum(['summary', 'errors', 'retry_failed', 'sync_counters', 'check_operation']),
        kbId: z.string().optional().describe('Knowledge base ID'),
        kbName: z.string().optional().describe('KB name'),
        connectorId: z.string().optional().describe('Connector ID for check_operation'),
        jobId: z.string().optional().describe('Job ID for check_operation'),
        documentIds: z.array(z.string()).optional().describe('Document IDs for retry_failed'),
      }),
      execute: async (input) => {
        const result = await executeKBHealth(
          input,
          {
            projectId,
            user: {
              permissions: ctx.permissions ?? [],
              tenantId: ctx.tenantId,
              userId: ctx.userId,
            },
          },
          { pageContext: env?.pageContext, authToken: authToken ?? '' },
        );
        if (result.success && input.action === 'summary' && result.data) {
          const d = result.data as Record<string, unknown>;
          emitCard({
            type: 'kb_health_card',
            kbId: input.kbId ?? '',
            kbName: input.kbName ?? '',
            overallStatus: String(d.overallStatus ?? d.status ?? 'healthy'),
            sections: {
              sources: {
                total: Number(d.sourceCount ?? 0),
                healthy: Number(d.healthySources ?? 0),
                syncing: Number(d.syncingSources ?? 0),
              },
              documents: {
                total: Number(d.documentCount ?? 0),
                errored: Number(d.erroredDocuments ?? 0),
                processing: Number(d.processingDocuments ?? 0),
              },
              pipeline: { status: String(d.pipelineStatus ?? 'idle') },
              llm: { configured: Boolean(d.llmConfigured ?? false) },
            },
            actions: [],
          });
        }
        return clearApprovedPlanAfterSuccessfulMutation('kb_ingest', input, result);
      },
    }),
    kb_ingest: tool({
      description:
        'Ingest content into a knowledge base. Actions: upload_file (pass fileContent directly as base64, or blobId from collect_file), ' +
        'add_url (queue URL crawl without link expansion), add_text (save inline text as a document), list_sources (existing sources). ' +
        'For upload_file: prefer passing fileContent (base64) + fileName + fileMimeType directly — this uploads straight to SearchAI for extraction via Docling.',
      inputSchema: z.object({
        action: z.enum(['upload_file', 'add_url', 'add_text', 'list_sources']),
        kbId: z.string().optional().describe('Knowledge base ID'),
        kbName: z.string().optional().describe('KB name'),
        sourceId: z.string().optional().describe('Source ID'),
        blobId: z.string().optional().describe('Blob ID from collect_file upload (fallback)'),
        fileContent: z
          .string()
          .optional()
          .describe('Base64-encoded file content for direct upload to SearchAI'),
        fileMimeType: z
          .string()
          .optional()
          .describe(
            'MIME type of the file (e.g. application/pdf, application/vnd.openxmlformats-officedocument.wordprocessingml.document)',
          ),
        fileName: z.string().optional().describe('File name for upload'),
        url: z.string().optional().describe('URL to crawl'),
        urls: z.array(z.string()).optional().describe('Multiple URLs to crawl'),
        text: z.string().optional().describe('Text content to ingest'),
        title: z.string().optional().describe('Title for text content'),
        metadata: z.record(z.unknown()).optional().describe('Document metadata'),
      }),
      execute: async (input) => {
        let lastCollectFileResult:
          | Array<{ name: string; type: string; content: string; size: number }>
          | undefined;
        if (input.action === 'upload_file' && !input.fileContent && !input.blobId) {
          try {
            const fileContent = await sessionService.getLastCollectFileContent(
              { tenantId: ctx.tenantId, userId: ctx.userId },
              sessionId,
            );
            if (fileContent && fileContent.length > 0 && fileContent[0]?.content) {
              lastCollectFileResult = fileContent;
            }
          } catch {
            /* non-fatal */
          }
        }
        const result = await executeKBIngest(
          input,
          {
            projectId,
            user: {
              permissions: ctx.permissions ?? [],
              tenantId: ctx.tenantId,
              userId: ctx.userId,
            },
          },
          {
            pageContext: env?.pageContext,
            authToken: authToken ?? '',
            sessionId,
            lastCollectFileResult,
          },
        );
        if (result.success && input.action !== 'list_sources') {
          const data = result.data as Record<string, unknown> | undefined;
          const status = String(
            data?.status ?? (input.action === 'add_url' ? 'queued' : 'pending'),
          );
          const files =
            input.action === 'add_url'
              ? (input.urls ?? (input.url ? [input.url] : [])).map((url) => ({
                  name: url,
                  status,
                  stage: 'crawl queued',
                }))
              : [
                  {
                    name: String(data?.fileName ?? input.fileName ?? input.title ?? 'Untitled'),
                    status,
                    stage: 'ingestion queued',
                  },
                ];

          emitCard({
            type: 'upload_progress_card',
            kbId: String(data?.kbId ?? input.kbId ?? ''),
            kbName: String(data?.kbName ?? input.kbName ?? ''),
            files,
            actions: [],
          });
        }
        return clearApprovedPlanAfterSuccessfulMutation('kb_connector', input, result);
      },
    }),
    kb_connector: tool({
      description:
        'Manage enterprise connectors (SharePoint, etc). Actions: list, create, auth (initiate OAuth), ' +
        'sync_start, sync_status, sync_pause (pause/resume with resume flag).',
      inputSchema: z.object({
        action: z.enum(['list', 'create', 'auth', 'sync_start', 'sync_status', 'sync_pause']),
        kbId: z.string().optional().describe('Knowledge base ID'),
        kbName: z.string().optional().describe('KB name'),
        connectorId: z.string().optional().describe('Connector ID'),
        connectorType: z.string().optional().describe('Connector type (e.g., sharepoint)'),
        connectorName: z.string().optional().describe('Display name for connector'),
        config: z.record(z.unknown()).optional().describe('Connector config'),
        resume: z.boolean().optional().describe('True to resume instead of pause'),
      }),
      execute: async (input) => {
        const result = await executeKBConnector(
          input,
          {
            projectId,
            user: {
              permissions: ctx.permissions ?? [],
              tenantId: ctx.tenantId,
              userId: ctx.userId,
            },
          },
          { pageContext: env?.pageContext, authToken: authToken ?? '' },
        );
        if (result.success && input.action === 'sync_status' && result.data) {
          const d = result.data as Record<string, unknown>;
          emitCard({
            type: 'connector_status_card',
            kbId: input.kbId ?? '',
            kbName: input.kbName ?? '',
            connectorId: input.connectorId ?? '',
            connectorType: String(d.type ?? d.connectorType ?? 'unknown'),
            authStatus: String(d.authStatus ?? 'unknown'),
            syncStatus: String(d.syncStatus ?? d.status ?? 'unknown'),
            syncProgress: d.progress
              ? {
                  processed: Number((d.progress as Record<string, unknown>).processed ?? 0),
                  total: Number((d.progress as Record<string, unknown>).total ?? 0),
                  failed: Number((d.progress as Record<string, unknown>).failed ?? 0),
                }
              : undefined,
            lastSyncAt: d.lastSyncAt ? String(d.lastSyncAt) : undefined,
            actions: [],
          });
        }
        return clearApprovedPlanAfterSuccessfulMutation('kb_documents', input, result);
      },
    }),
    kb_documents: tool({
      description:
        'Manage KB documents. Actions: list (with status/pagination), status_summary (counts by status), ' +
        'reprocess (retry failed docs), delete (remove a document).',
      inputSchema: z.object({
        action: z.enum(['list', 'status_summary', 'reprocess', 'delete']),
        kbId: z.string().optional().describe('Knowledge base ID'),
        kbName: z.string().optional().describe('KB name'),
        documentId: z.string().optional().describe('Document ID for delete'),
        documentIds: z.array(z.string()).optional().describe('Document IDs for reprocess'),
        status: z.string().optional().describe('Filter by status'),
        limit: z.number().optional().describe('Page size'),
        offset: z.number().optional().describe('Page offset'),
        confirmed: z.boolean().optional().describe('Confirmation for delete'),
      }),
      execute: async (input) => {
        const result = await executeKBDocuments(
          input,
          {
            projectId,
            user: {
              permissions: ctx.permissions ?? [],
              tenantId: ctx.tenantId,
              userId: ctx.userId,
            },
          },
          { pageContext: env?.pageContext, authToken: authToken ?? '' },
        );
        if (result.success && input.action === 'status_summary' && result.data) {
          const d = result.data as Record<string, unknown>;
          emitCard({
            type: 'doc_processing_card',
            kbId: input.kbId ?? '',
            kbName: input.kbName ?? '',
            statusBreakdown: {
              ready: Number(d.ready ?? d.completed ?? 0),
              processing: Number(d.processing ?? 0),
              extracting: Number(d.extracting ?? 0),
              errored: Number(d.errored ?? d.failed ?? 0),
              pending: Number(d.pending ?? d.queued ?? 0),
            },
            actions: [],
          });
        }
        return result;
      },
    }),

    // ── manage_memory: cross-session project memory management ──
    manage_memory: tool({
      description:
        'View, add, or delete project memories that persist across sessions. ' +
        'Use action "list" when the user asks "what do you remember?" or wants to see memories. ' +
        'Use action "add" when the user says "remember that..." to store a preference or decision. ' +
        'Use action "delete" when the user says "forget about..." to remove a memory.',
      inputSchema: z.object({
        action: z.enum(['list', 'add', 'delete']).describe('Memory action to perform'),
        content: z
          .string()
          .optional()
          .describe('Memory content for "add", or search text for "delete"'),
        type: z
          .enum(['decision', 'pattern', 'preference', 'constraint', 'learning'])
          .optional()
          .describe('Memory type — defaults to "preference" for user-added memories'),
        memoryId: z
          .string()
          .optional()
          .describe('Specific memory ID to delete (from a previous "list" result)'),
      }),
      execute: async (input) => {
        try {
          if (input.action === 'list') {
            const memories = await projectMemoryService.getProjectMemories(
              { tenantId: ctx.tenantId, userId: ctx.userId },
              projectId,
            );
            if (memories.length === 0) {
              return {
                success: true,
                memories: [],
                message: 'No project memories stored yet.',
              };
            }
            return {
              success: true,
              memories: memories.map((m) => ({
                id: m.id,
                type: m.type,
                content: m.content,
                source: m.source,
                phase: m.phase,
                relevance: m.relevance,
                createdAt: m.createdAt.toISOString(),
              })),
              count: memories.length,
            };
          }

          if (input.action === 'add') {
            if (!input.content) {
              return {
                success: false,
                error: {
                  code: 'MISSING_CONTENT',
                  message: 'Content is required for adding a memory',
                },
              };
            }
            const entry = await projectMemoryService.addMemory(
              { tenantId: ctx.tenantId, userId: ctx.userId },
              projectId,
              {
                type: input.type ?? 'preference',
                content: input.content,
                source: 'user',
                phase: 'IN_PROJECT',
                sessionId,
                relevance: 0.9, // User-provided memories get high relevance
              },
            );
            return clearApprovedPlanAfterSuccessfulMutation('manage_memory', input, {
              success: true,
              memory: {
                id: entry.id,
                type: entry.type,
                content: entry.content,
              },
              message: 'Memory saved.',
            });
          }

          if (input.action === 'delete') {
            if (input.memoryId) {
              const deleted = await projectMemoryService.deleteMemory(
                { tenantId: ctx.tenantId, userId: ctx.userId },
                projectId,
                input.memoryId,
              );
              return clearApprovedPlanAfterSuccessfulMutation('manage_memory', input, {
                success: true,
                deleted: deleted ? 1 : 0,
                message: deleted ? 'Memory deleted.' : 'Memory not found.',
              });
            }
            if (input.content) {
              const count = await projectMemoryService.deleteMemoriesByContent(
                { tenantId: ctx.tenantId, userId: ctx.userId },
                projectId,
                input.content,
              );
              return clearApprovedPlanAfterSuccessfulMutation('manage_memory', input, {
                success: true,
                deleted: count,
                message:
                  count > 0
                    ? `Deleted ${count} matching memor${count === 1 ? 'y' : 'ies'}.`
                    : 'No matching memories found.',
              });
            }
            return {
              success: false,
              error: {
                code: 'MISSING_IDENTIFIER',
                message: 'Provide either memoryId or content to identify memories to delete',
              },
            };
          }

          return {
            success: false,
            error: { code: 'INVALID_ACTION', message: `Unknown action: ${String(input.action)}` },
          };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            success: false,
            error: { code: 'MEMORY_ERROR', message },
          };
        }
      },
    }),

    search_docs: tool({
      description:
        'Search platform documentation for authoritative information about APIs, SDKs, features, ' +
        'configuration, channels, admin, deployment, and any platform topic. Returns relevant ' +
        'documentation sections grouped by source file. Use this when you need factual platform ' +
        'information that is not already in your context.',
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe(
            'Search query — use specific terms, API paths, or feature names for best results',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .default(5)
          .describe('Max document sections to return'),
      }),
      execute: async (input) => {
        try {
          const { searchDocsGrouped } = await import('@agent-platform/arch-ai');
          const results = searchDocsGrouped(input.query, input.limit ?? 5);

          if (results.length === 0) {
            return {
              success: true,
              results: [],
              message:
                'No documentation found matching that query. Try different search terms or a more specific query.',
            };
          }

          return {
            success: true,
            results: results.map((r) => ({
              file: r.file,
              relevanceScore: Math.round(r.bestScore * 100) / 100,
              sections: r.sections.map((s) => ({
                heading: s.heading,
                content: s.text,
              })),
            })),
            resultCount: results.length,
          };
        } catch (err: unknown) {
          return {
            success: false,
            error: {
              code: 'SEARCH_DOCS_ERROR',
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      },
    }),
  };
}
