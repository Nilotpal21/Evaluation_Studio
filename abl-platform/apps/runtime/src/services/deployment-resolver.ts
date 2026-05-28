/**
 * Deployment Resolver Service
 *
 * Central service that resolves agents through the deployment pipeline.
 * Every serving channel calls this to get pre-compiled IR for a session.
 *
 * Resolution strategies (strict fallback chain):
 * 1. deploymentId  → Deployment.agentVersionManifest → AgentVersion[].irContent
 * 2. environment   → ProjectAgent.activeVersions[env] → AgentVersion.irContent
 * 3. (none)        → ProjectAgent.dslContent → fresh compile (dev/debug only)
 *
 * Enterprise guarantees:
 * - Tenant isolation enforced on all paths (including falsy tenantId)
 * - Cache writes are graceful (failures don't crash resolution)
 * - Batch queries eliminate N+1 patterns
 * - Deterministic hashing (excludes volatile fields like compiled_at)
 * - Structured logging with timing for observability
 * - Error messages sanitized to prevent information leakage
 */

import { createLogger } from '@abl/compiler/platform';
import { createHash } from 'crypto';
import zlib from 'node:zlib';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';
import type { AgentIR, CompilationOutput } from '@abl/compiler';
import type { SessionService } from './session/session-service.js';
import { promptTemplateLoader } from './execution/prompt-template-loader.js';
import {
  buildProjectDslReadinessError,
  evaluateProjectExecutionReadiness,
} from './session/project-agent-dsl-readiness.js';
import {
  buildProjectWorkingCopyAgentSources,
  compileProjectWorkingCopy,
} from './project-working-copy-compiler.js';
import type {
  ResolvedAgentIR,
  ResolvedToolDefinition,
  DeploymentModuleSnapshotPayload,
} from './modules/types.js';

const log = createLogger('deployment-resolver');

// =============================================================================
// TYPES
// =============================================================================

export interface ResolveContext {
  projectId: string;
  tenantId: string;
  agentName?: string;
  deploymentId?: string;
  environment?: string;
  allowWorkingCopy?: boolean;
}

export interface VersionInfo {
  deploymentId?: string;
  environment: string;
  versions: Record<string, number>;
  /** Raw version strings from the deployment manifest (e.g. "0.1.0") */
  rawVersions?: Record<string, string>;
  /** Workflow version pins from the deployment manifest, keyed by workflow name. */
  workflowVersionManifest?: Record<string, string>;
}

export interface DeploymentModelOverride {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ResolvedAgent {
  agents: Record<string, AgentIR>;
  entryAgent: string;
  compilationOutput: CompilationOutput;
  sourceHash: string;
  versionInfo: VersionInfo;
  modelOverrides?: Record<string, DeploymentModelOverride>;
  /** Pinned ProjectSettingsVersion ID from deployment (for enableThinking/thinkingBudget resolution). */
  settingsVersionId?: string;
  /** Tools merged from module snapshots, keyed by alias-rewritten name. */
  resolvedTools?: Record<string, ResolvedToolDefinition>;
}

// Custom error with HTTP status code for channel handlers
export class DeploymentError extends AppError {
  constructor(message: string, statusCode: number = 500) {
    const entry = mapStatusToDeploymentEntry(statusCode);
    super(message, {
      ...entry,
      statusCode, // caller-provided statusCode wins for unmapped codes
    });
  }
}

function mapStatusToDeploymentEntry(status: number): (typeof ErrorCodes)[keyof typeof ErrorCodes] {
  switch (status) {
    case 400:
      return ErrorCodes.BAD_REQUEST;
    case 403:
      return ErrorCodes.FORBIDDEN;
    case 404:
      return ErrorCodes.NOT_FOUND;
    case 410:
      return ErrorCodes.GONE;
    case 422:
      return ErrorCodes.UNPROCESSABLE_ENTITY;
    default:
      return ErrorCodes.INTERNAL_ERROR;
  }
}

// =============================================================================
// IR EXTRACTION
// =============================================================================

/**
 * Extract an individual AgentIR from a parsed irContent blob.
 *
 * irContent is stored as a CompilationOutput wrapper: `{ agents: { DeclaredName: AgentIR } }`.
 * The key inside `agents` uses the ABL-declared name (PascalSnake, e.g. "Contract_Data_Assistant"),
 * but the caller typically has the DB/manifest name (lowercase, e.g. "contract_data_assistant").
 *
 * Resolution order:
 *   1. Exact key match — `parsed.agents[agentName]`
 *   2. Case-insensitive match — handles filename vs declaration casing mismatch
 *   3. First (and usually only) entry — each version stores a single agent
 *   4. Fallback to `parsed` itself — for bare AgentIR irContent (legacy)
 */
function extractAgentIRFromCompilationOutput(parsed: any, agentName: string): AgentIR {
  if (!parsed.agents || typeof parsed.agents !== 'object') {
    return parsed;
  }

  // 1. Exact match
  if (parsed.agents[agentName]) {
    return parsed.agents[agentName];
  }

  // 2. Case-insensitive match
  const lowerName = agentName.toLowerCase();
  for (const key of Object.keys(parsed.agents)) {
    if (key.toLowerCase() === lowerName) {
      return parsed.agents[key];
    }
  }

  // 3. First entry (single-agent version — the common case)
  const entries = Object.values(parsed.agents);
  if (entries.length > 0) {
    return entries[0] as AgentIR;
  }

  // 4. Legacy fallback — irContent is the AgentIR itself
  return parsed;
}

function cloneCompilationOutput(compilation: CompilationOutput): CompilationOutput {
  return JSON.parse(JSON.stringify(compilation)) as CompilationOutput;
}

function normalizeCompressedPayload(rawPayload: unknown): Buffer {
  if (Buffer.isBuffer(rawPayload)) {
    return Buffer.from(rawPayload);
  }

  if (rawPayload instanceof Uint8Array) {
    return Buffer.from(rawPayload);
  }

  if (rawPayload && typeof rawPayload === 'object' && 'buffer' in rawPayload) {
    const record = rawPayload as {
      buffer: ArrayBufferLike | Uint8Array;
      byteOffset?: number;
      byteLength?: number;
    };

    if (Buffer.isBuffer(record.buffer)) {
      return Buffer.from(record.buffer);
    }

    if (record.buffer instanceof Uint8Array) {
      return Buffer.from(record.buffer);
    }

    return Buffer.from(new Uint8Array(record.buffer, record.byteOffset ?? 0, record.byteLength));
  }

  throw new Error('Unsupported compressed module snapshot payload');
}

// =============================================================================
// DEPLOYMENT RESOLVER
// =============================================================================

/** Default grace period before a draining deployment is auto-retired (30 minutes) */
const DRAINING_GRACE_MS = 30 * 60 * 1000;

/** Maximum decompressed size for module snapshots (50 MB) — prevents decompression bombs */
const MAX_DECOMPRESSED_SIZE = 50 * 1024 * 1024;

export class DeploymentResolver {
  constructor(
    private readonly sessionService: SessionService,
    private readonly drainingGraceMs: number = DRAINING_GRACE_MS,
  ) {}

  /**
   * Resolve agents through the deployment pipeline.
   * Returns pre-compiled IR ready for session creation.
   */
  async resolve(ctx: ResolveContext): Promise<ResolvedAgent> {
    const startTime = Date.now();
    let strategy = 'none';

    // Warm prompt template cache on first resolution (once per process lifetime).
    // DB is hit once; subsequent calls read from in-memory cache.
    if (!promptTemplateLoader.isLoaded) {
      try {
        const { PromptTemplate } = await import('@agent-platform/database/models');
        await promptTemplateLoader.loadFromDB(PromptTemplate);
      } catch {
        // Graceful fallback: PromptCatalog defaults are used if DB is unavailable
      }
    }

    try {
      // Strategy 1: Resolve by deploymentId
      if (ctx.deploymentId) {
        strategy = 'deployment';
        const result = await this.resolveByDeployment(ctx);
        log.info('Resolved agents', {
          strategy,
          deploymentId: ctx.deploymentId,
          agentCount: Object.keys(result.agents).length,
          entryAgent: result.entryAgent,
          durationMs: Date.now() - startTime,
        });
        return result;
      }

      // Strategy 2: Resolve by environment
      if (ctx.environment) {
        strategy = 'environment';
        const result = await this.resolveByEnvironment(ctx);
        log.info('Resolved agents', {
          strategy,
          environment: ctx.environment,
          agentCount: Object.keys(result.agents).length,
          entryAgent: result.entryAgent,
          durationMs: Date.now() - startTime,
        });
        return result;
      }

      // Strategy 3: Fallback to working copy (dev/debug only)
      if (ctx.allowWorkingCopy) {
        strategy = 'working_copy';
        const result = await this.resolveWorkingCopy(ctx);
        log.info('Resolved agents', {
          strategy,
          agentCount: Object.keys(result.agents).length,
          entryAgent: result.entryAgent,
          durationMs: Date.now() - startTime,
        });
        return result;
      }

      throw new DeploymentError('No resolution strategy available', 400);
    } catch (err) {
      if (err instanceof DeploymentError) throw err;
      log.error('Resolution failed', {
        strategy,
        projectId: ctx.projectId,
        durationMs: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  // ===========================================================================
  // STRATEGY 1: Resolve by deploymentId
  // ===========================================================================

  private async resolveByDeployment(ctx: ResolveContext): Promise<ResolvedAgent> {
    const { Deployment, ProjectAgent, AgentVersion, ProjectRuntimeConfig, ProjectLLMConfig } =
      await import('@agent-platform/database/models');

    const deployment = await Deployment.findOne({
      _id: ctx.deploymentId,
      tenantId: ctx.tenantId,
    }).lean();

    if (!deployment) {
      throw new DeploymentError('Deployment not found', 404);
    }

    // Reject retired deployments
    if (deployment.status === 'retired') {
      throw new DeploymentError('Deployment is retired', 410);
    }

    // Auto-retire draining deployments past grace period (fire-and-forget)
    if (deployment.status === 'draining' && deployment.drainingStartedAt) {
      const drainingAge = Date.now() - new Date(deployment.drainingStartedAt).getTime();
      if (drainingAge > this.drainingGraceMs) {
        log.info('Auto-retiring draining deployment past grace period', {
          deploymentId: deployment._id,
          drainingAgeMs: drainingAge,
          graceMs: this.drainingGraceMs,
        });
        Deployment.updateOne(
          { _id: deployment._id },
          { $set: { status: 'retired', retiredAt: new Date() } },
        ).catch((err: unknown) => {
          log.warn('Auto-retire failed', {
            deploymentId: deployment._id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        throw new DeploymentError('Deployment is retired', 410);
      }
    }

    // Verify project matches
    if (deployment.projectId !== ctx.projectId) {
      throw new DeploymentError('Deployment does not belong to this project', 403);
    }

    const [allAgents, runtimeConfig, llmConfig] = await Promise.all([
      ProjectAgent.find({
        projectId: ctx.projectId,
        tenantId: ctx.tenantId,
      }).lean(),
      ProjectRuntimeConfig.findOne({
        projectId: ctx.projectId,
        tenantId: ctx.tenantId,
      }).lean(),
      ProjectLLMConfig.findOne({
        projectId: ctx.projectId,
        tenantId: ctx.tenantId,
      }).lean(),
    ]);
    const readiness = await evaluateProjectExecutionReadiness({
      agents: allAgents as Array<{
        name?: string | null;
        dslContent?: string | null;
        dslValidationStatus?: string | null;
        dslDiagnostics?: Array<{ severity?: string; message?: string; source?: string }> | null;
      }>,
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      runtimeConfig: runtimeConfig ?? null,
      llmConfig: llmConfig ?? null,
      lazyBackfill: true,
    });
    if (readiness.hasBlockingErrors) {
      log.warn('Refusing deployment resolution for project with readiness errors', {
        projectId: ctx.projectId,
        tenantId: ctx.tenantId,
        deploymentId: deployment._id,
        blockedAgents: readiness.blockedAgents,
        issueKinds: readiness.issues.map((issue) => issue.kind),
      });
      throw new DeploymentError(buildProjectDslReadinessError(), 422);
    }

    // Parse model overrides from deployment record
    let parsedModelOverrides: Record<string, DeploymentModelOverride> | undefined;
    const rawOverrides = deployment.modelOverrides;
    if (rawOverrides) {
      try {
        parsedModelOverrides =
          typeof rawOverrides === 'string' ? JSON.parse(rawOverrides) : rawOverrides;
      } catch {
        log.warn('Invalid modelOverrides JSON in deployment', { deploymentId: deployment._id });
      }
    }

    // Check L1/L2 compilation cache first
    if (deployment.compilationHash) {
      const cached = await this.resolveCompilationFromCache(deployment.compilationHash);
      if (cached) {
        const rawManifest = this.parseRawManifest(deployment.agentVersionManifest);
        const result = this.buildFromCompilation(
          cached,
          deployment.entryAgentName,
          deployment.compilationHash,
          {
            deploymentId: deployment._id as string,
            environment: deployment.environment,
            versions: this.parseManifestVersions(deployment.agentVersionManifest),
            rawVersions: rawManifest,
          },
        );
        if (parsedModelOverrides) result.modelOverrides = parsedModelOverrides;
        if (deployment.settingsVersionId) result.settingsVersionId = deployment.settingsVersionId;
        // Merge module snapshot even on cache hit — snapshots are stored separately
        await this.mergeModuleSnapshot(result, ctx.tenantId, deployment._id as string);
        return result;
      }
    }

    // Cache miss — load from DB
    let manifest: Record<string, string>;
    try {
      const rawManifest = deployment.agentVersionManifest;
      manifest = typeof rawManifest === 'string' ? JSON.parse(rawManifest) : rawManifest;
    } catch {
      throw new DeploymentError('Deployment has invalid version manifest', 500);
    }

    // Batch load: get all project agents in one tenant-scoped query. AgentVersion
    // rows are only reachable through these tenant-scoped ProjectAgent ids.
    const agentsByName = new Map<string, any>(allAgents.map((a: any) => [a.name, a]));

    const agents: Record<string, AgentIR> = {};
    const versionNumbers: Record<string, number> = {};
    const remoteAgents: NonNullable<CompilationOutput['remote_agents']> = {};
    let coordinationDefaults: CompilationOutput['coordination_defaults'];

    // Collect agent IDs and versions for batch version lookup
    const versionLookups: Array<{ agentName: string; agentId: string; version: string }> = [];
    for (const [agentName, version] of Object.entries(manifest)) {
      const agent = agentsByName.get(agentName);
      if (!agent) {
        throw new DeploymentError(`Agent not found in project`, 404);
      }
      versionLookups.push({ agentName, agentId: (agent._id ?? agent.id) as string, version });
    }

    // Load all versions in parallel
    // Note: AgentVersion has no tenantId field — tenant isolation is enforced
    // via the Deployment query (which verifies tenantId + projectId).
    const versionResults = await Promise.all(
      versionLookups.map(({ agentId, version }) =>
        AgentVersion.findOne({ agentId, version }).lean(),
      ),
    );

    for (let i = 0; i < versionLookups.length; i++) {
      const { agentName, version } = versionLookups[i];
      const agentVersion = versionResults[i];

      if (!agentVersion) {
        throw new DeploymentError(`Agent version not found`, 404);
      }

      if (!agentVersion.irContent) {
        throw new DeploymentError(`Agent version has no compiled IR`, 500);
      }

      let parsed: any;
      try {
        parsed = JSON.parse(agentVersion.irContent);
      } catch {
        throw new DeploymentError(`Agent version has corrupt IR content`, 500);
      }

      // irContent stores the full CompilationOutput — extract AgentIR for the agents map.
      // The agents map key uses the ABL-declared name (PascalSnake, e.g. "Contract_Data_Assistant")
      // while agentName comes from the deployment manifest (lowercase, e.g. "contract_data_assistant").
      // Try exact match first, then case-insensitive fallback, then first entry.
      const ir: AgentIR = extractAgentIRFromCompilationOutput(parsed, agentName);
      agents[agentName] = ir;
      versionNumbers[agentName] = this.parseVersionNumber(version);
      Object.assign(remoteAgents, parsed.remote_agents ?? {});
      coordinationDefaults ??= parsed.coordination_defaults;

      // Log tool version snapshot if present (audit trail)
      if (parsed.tool_snapshot?.length) {
        log.info('Deployment includes tool snapshot', {
          agentName,
          snapshotCount: parsed.tool_snapshot.length,
          tools: parsed.tool_snapshot.map((s: any) => `${s.name}:${s.toolType}`),
        });
      }
    }

    const compilationOutput = this.buildCompilationOutput(agents, deployment.entryAgentName, {
      remoteAgents,
      coordinationDefaults,
    });
    const sourceHash = this.computeContentHash(agents);

    // Cache gracefully (failures don't fail resolution)
    await this.cacheGracefully(agents, compilationOutput);

    // Update deployment compilationHash (fire-and-forget with logging)
    if (!deployment.compilationHash) {
      Deployment.updateOne(
        { _id: deployment._id },
        { $set: { compilationHash: sourceHash } },
      ).catch((err: unknown) => {
        log.warn('Failed to update deployment compilationHash', {
          deploymentId: deployment._id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    const resolutionCompilationOutput = cloneCompilationOutput(compilationOutput);
    const result: ResolvedAgent = {
      agents: resolutionCompilationOutput.agents,
      entryAgent: deployment.entryAgentName,
      compilationOutput: resolutionCompilationOutput,
      sourceHash,
      versionInfo: {
        deploymentId: deployment._id as string,
        environment: deployment.environment,
        versions: versionNumbers,
        rawVersions: manifest,
        workflowVersionManifest:
          (deployment.workflowVersionManifest as Record<string, string> | undefined) ?? {},
      },
      modelOverrides: parsedModelOverrides,
      settingsVersionId: deployment.settingsVersionId ?? undefined,
    };

    // Merge module snapshot (mounted agents + tools) if present
    await this.mergeModuleSnapshot(result, ctx.tenantId, deployment._id as string);

    return result;
  }

  // ===========================================================================
  // STRATEGY 2: Resolve by environment
  // ===========================================================================

  private async resolveByEnvironment(ctx: ResolveContext): Promise<ResolvedAgent> {
    // First, check for a Deployment record with this environment.
    // Deployments created via the API store versions in Deployment.agentVersionManifest,
    // not in ProjectAgent.activeVersions. Prefer deployment-based resolution when available.
    const { Deployment } = await import('@agent-platform/database/models');
    const deployment = await Deployment.findOne({
      projectId: ctx.projectId,
      tenantId: ctx.tenantId,
      environment: ctx.environment,
      status: 'active',
    })
      .sort({ createdAt: -1 })
      .lean();

    if (deployment) {
      log.info('Environment resolved via Deployment record', {
        environment: ctx.environment,
        deploymentId: (deployment as any)._id,
      });
      return this.resolveByDeployment({ ...ctx, deploymentId: (deployment as any)._id });
    }

    // Fallback: resolve via per-agent activeVersions map
    const { ProjectAgent, AgentVersion, Project } = await import('@agent-platform/database/models');

    // Validate the project boundary before reading draft agents. Mutable
    // ProjectAgent rows are tenant-scoped and must not leak through fallback
    // errors before the tenant boundary is established.
    const project = await Project.findOne(
      { _id: ctx.projectId, tenantId: ctx.tenantId },
      { tenantId: 1 },
    ).lean();
    this.assertTenantMatch((project as any)?.tenantId, ctx.tenantId);

    const projectAgents = await ProjectAgent.find({
      projectId: ctx.projectId,
      tenantId: ctx.tenantId,
    })
      .sort({ createdAt: 1 })
      .lean();

    if (projectAgents.length === 0) {
      throw new DeploymentError('No agents found for project', 404);
    }

    const agents: Record<string, AgentIR> = {};
    const versionNumbers: Record<string, number> = {};
    const rawVersions: Record<string, string> = {};
    const supervisors: string[] = [];
    const remoteAgents: NonNullable<CompilationOutput['remote_agents']> = {};
    let coordinationDefaults: CompilationOutput['coordination_defaults'];

    // Phase 1: Determine which versions to load
    const versionLookups: Array<{ agent: any; version: string }> = [];
    for (const agent of projectAgents) {
      let activeVersions: Record<string, string>;
      try {
        const raw = (agent as any).activeVersions;
        activeVersions = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {};
      } catch {
        log.warn('Invalid activeVersions JSON', { agentName: (agent as any).name });
        continue;
      }

      const version = activeVersions[ctx.environment!] || activeVersions['default'];
      if (!version) continue;

      versionLookups.push({ agent, version });
    }

    // Phase 2: Batch-load all versions in parallel
    // Note: AgentVersion has no tenantId field — tenant isolation is enforced
    // via Project.tenantId join + assertTenantMatch above.
    const versionResults = await Promise.all(
      versionLookups.map(({ agent, version }) =>
        AgentVersion.findOne({
          agentId: (agent as any)._id ?? (agent as any).id,
          version,
        }).lean(),
      ),
    );

    // Phase 3: Parse IR and detect supervisors
    for (let i = 0; i < versionLookups.length; i++) {
      const { agent, version } = versionLookups[i];
      const agentVersion = versionResults[i];

      if (!agentVersion?.irContent) {
        log.warn('Active version has no IR content', {
          agentName: (agent as any).name,
          version,
          environment: ctx.environment,
        });
        continue;
      }

      let parsed: any;
      try {
        parsed = JSON.parse(agentVersion.irContent);
      } catch {
        log.warn('Agent version has corrupt IR', { agentName: (agent as any).name, version });
        continue;
      }

      // irContent stores the full CompilationOutput — extract AgentIR.
      // See extractAgentIRFromCompilationOutput for name mismatch handling.
      const agentName = (agent as any).name;
      const ir: AgentIR = extractAgentIRFromCompilationOutput(parsed, agentName);
      agents[agentName] = ir;
      versionNumbers[agentName] = this.parseVersionNumber(version);
      rawVersions[agentName] = version;
      Object.assign(remoteAgents, parsed.remote_agents ?? {});
      coordinationDefaults ??= parsed.coordination_defaults;

      // Log tool version snapshot if present (audit trail)
      if (parsed.tool_snapshot?.length) {
        log.info('Environment deployment includes tool snapshot', {
          agentName,
          snapshotCount: parsed.tool_snapshot.length,
          tools: parsed.tool_snapshot.map((s: any) => `${s.name}:${s.toolType}`),
        });
      }

      // Track supervisors for deterministic entry agent selection
      if (ir.routing?.rules && ir.routing.rules.length > 0) {
        supervisors.push(agentName);
      }
    }

    if (Object.keys(agents).length === 0) {
      throw new DeploymentError(
        `No active versions found for environment "${ctx.environment}"`,
        404,
      );
    }

    // Deterministic entry agent: explicit agentName > first supervisor > first agent (by createdAt order)
    let entryAgent: string;
    if (ctx.agentName && agents[ctx.agentName]) {
      entryAgent = ctx.agentName;
    } else if (supervisors.length > 0) {
      if (supervisors.length > 1) {
        log.warn('Multiple supervisors detected, using first by creation order', {
          supervisors,
          selected: supervisors[0],
        });
      }
      entryAgent = supervisors[0];
    } else {
      // First agent by creation order (guaranteed by orderBy above)
      entryAgent = Object.keys(agents)[0];
    }

    const compilationOutput = this.buildCompilationOutput(agents, entryAgent, {
      remoteAgents,
      coordinationDefaults,
    });
    const sourceHash = this.computeContentHash(agents);

    await this.cacheGracefully(agents, compilationOutput);

    const result: ResolvedAgent = {
      agents,
      entryAgent,
      compilationOutput,
      sourceHash,
      versionInfo: {
        environment: ctx.environment || 'dev',
        versions: versionNumbers,
        rawVersions,
      },
    };

    // Merge module dependencies for per-agent activeVersions fallback path
    await this.mergeWorkingCopyModules(result, ctx.tenantId, ctx.projectId);

    return result;
  }

  // ===========================================================================
  // STRATEGY 3: Resolve working copy (fallback for dev/debug)
  // ===========================================================================

  private async resolveWorkingCopy(ctx: ResolveContext): Promise<ResolvedAgent> {
    const { ProjectAgent, Project, ProjectRuntimeConfig, ProjectLLMConfig } =
      await import('@agent-platform/database/models');

    // Validate the project boundary before reading draft agents. Mutable
    // ProjectAgent rows are tenant-scoped and must not leak through fallback
    // errors before the tenant boundary is established.
    const project = await Project.findOne(
      { _id: ctx.projectId, tenantId: ctx.tenantId },
      { tenantId: 1 },
    ).lean();
    this.assertTenantMatch((project as any)?.tenantId, ctx.tenantId);

    const projectAgents = await ProjectAgent.find({
      projectId: ctx.projectId,
      tenantId: ctx.tenantId,
    })
      .sort({ createdAt: 1 })
      .lean();

    if (projectAgents.length === 0) {
      throw new DeploymentError('No agents found for project', 404);
    }
    const [runtimeConfig, llmConfig] = await Promise.all([
      ProjectRuntimeConfig.findOne({
        projectId: ctx.projectId,
        tenantId: ctx.tenantId,
      }).lean(),
      ProjectLLMConfig.findOne({
        projectId: ctx.projectId,
        tenantId: ctx.tenantId,
      }).lean(),
    ]);
    const readiness = await evaluateProjectExecutionReadiness({
      agents: projectAgents,
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      runtimeConfig: runtimeConfig ?? null,
      llmConfig: llmConfig ?? null,
      lazyBackfill: true,
    });
    if (readiness.hasBlockingErrors) {
      log.warn('Refusing working-copy deployment resolution for project with invalid DSL', {
        projectId: ctx.projectId,
        tenantId: ctx.tenantId,
        blockedAgents: readiness.blockedAgents,
        issueKinds: readiness.issues.map((issue) => issue.kind),
      });
      throw new DeploymentError(buildProjectDslReadinessError(), 422);
    }

    const agentsWithDSL = readiness.executableAgents;
    if (agentsWithDSL.length === 0) {
      throw new DeploymentError('No agents with DSL content in project', 404);
    }

    let compileResult;
    try {
      compileResult = await compileProjectWorkingCopy({
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        entryAgentName: ctx.agentName || (agentsWithDSL[0] as any).name,
        environment: ctx.environment || 'dev',
        agents: buildProjectWorkingCopyAgentSources(
          agentsWithDSL as Array<{
            name?: unknown;
            dslContent?: unknown;
            systemPromptLibraryRef?: unknown;
          }>,
        ),
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error('Compilation failed', { error: errorMessage });
      throw new DeploymentError('Agent compilation failed', 422);
    }

    if (compileResult.warnings.length > 0) {
      log.warn('Some agents had working-copy compile warnings', {
        projectId: ctx.projectId,
        tenantId: ctx.tenantId,
        warnings: compileResult.warnings,
      });
    }

    const compilationOutput = compileResult.resolved.compilationOutput;
    if (compilationOutput.compilation_errors?.length) {
      log.error('Compilation produced errors', {
        projectId: ctx.projectId,
        errors: compilationOutput.compilation_errors.map((error) => ({
          agent: error.agent,
          code: error.code,
          path: error.path,
          message: error.message,
        })),
      });
      throw new DeploymentError('Agent compilation failed', 422);
    }

    const entryAgent = compileResult.resolved.entryAgent;
    const sourceHash = this.computeContentHash(compilationOutput.agents);

    // Cache gracefully
    await this.cacheGracefully(compilationOutput.agents, compilationOutput);

    const result: ResolvedAgent = {
      agents: compilationOutput.agents,
      entryAgent,
      compilationOutput,
      sourceHash,
      versionInfo: {
        environment: ctx.environment || 'dev',
        versions: {},
      },
    };

    // Merge module dependencies for working-copy preview
    await this.mergeWorkingCopyModules(result, ctx.tenantId, ctx.projectId);

    return result;
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  /**
   * Resolve and merge module dependencies for working-copy (preview/dev) sessions.
   * Delegates to the standalone `mergeWorkingCopyModules` utility so that
   * non-resolver callers (e.g. the WS handler) can reuse the same logic.
   */
  private async mergeWorkingCopyModules(
    result: ResolvedAgent,
    tenantId: string,
    projectId: string,
  ): Promise<void> {
    await mergeWorkingCopyModules(result, tenantId, projectId);
  }

  /**
   * Load and merge a deployment module snapshot into a resolved result.
   * No-ops gracefully when no snapshot exists or decompression fails.
   */
  private async mergeModuleSnapshot(
    result: ResolvedAgent,
    tenantId: string,
    deploymentId: string,
  ): Promise<void> {
    const { DeploymentModuleSnapshot } = await import('@agent-platform/database/models');
    const moduleSnapshot = await DeploymentModuleSnapshot.findOne({
      tenantId,
      deploymentId,
    }).lean();

    if (!moduleSnapshot) return;

    try {
      const compressedPayload = normalizeCompressedPayload(
        (moduleSnapshot as Record<string, unknown>).compressedPayload,
      );
      const decompressed = zlib.gunzipSync(compressedPayload, {
        maxOutputLength: MAX_DECOMPRESSED_SIZE,
      });
      const payload: DeploymentModuleSnapshotPayload = JSON.parse(decompressed.toString());

      // Merge mounted agents
      for (const [mountedName, entry] of Object.entries(payload.mountedAgents)) {
        const mountedAgent = {
          ...entry.ir,
          _moduleProvenance: {
            alias: entry.alias,
            moduleProjectId: entry.moduleProjectId,
            moduleReleaseId: entry.moduleReleaseId,
            sourceAgentName: entry.sourceAgentName,
          },
        } as ResolvedAgentIR;
        result.agents[mountedName] = mountedAgent;
        result.compilationOutput.agents[mountedName] = mountedAgent;
      }

      // Merge mounted tools
      if (Object.keys(payload.mountedTools).length > 0) {
        result.resolvedTools = result.resolvedTools ?? {};
        for (const [mountedName, entry] of Object.entries(payload.mountedTools)) {
          result.resolvedTools[mountedName] = {
            ...entry.definition,
            _moduleProvenance: {
              alias: entry.alias,
              moduleProjectId: entry.moduleProjectId,
              moduleReleaseId: entry.moduleReleaseId,
              sourceToolName: entry.sourceToolName,
            },
          } as ResolvedToolDefinition;
        }
      }

      log.info('Merged module snapshot', {
        deploymentId,
        mountedAgents: Object.keys(payload.mountedAgents).length,
        mountedTools: Object.keys(payload.mountedTools).length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Failed to decompress module snapshot', { deploymentId, error: message });
      throw new DeploymentError('Deployment module snapshot could not be loaded', 500);
    }
  }

  /**
   * Assert tenant isolation. Always checks — never skips when tenantId is falsy.
   */
  private assertTenantMatch(
    projectTenantId: string | null | undefined,
    requestTenantId: string,
  ): void {
    if (!projectTenantId) {
      log.warn('Project has no tenantId — blocking access', { requestTenantId });
      throw new DeploymentError('Project has no tenant assignment — access denied', 403);
    }
    if (projectTenantId !== requestTenantId) {
      throw new DeploymentError('Tenant mismatch: project does not belong to this tenant', 403);
    }
  }

  /**
   * Resolve a CompilationOutput from L1 → L2 cache using the public API.
   */
  private async resolveCompilationFromCache(hash: string): Promise<CompilationOutput | null> {
    try {
      return await this.sessionService.resolveCompilationOutput(hash);
    } catch (err) {
      log.warn('Cache resolution failed — treating as miss', {
        hash,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Cache agents and compilation output gracefully — failures don't fail resolution.
   */
  private async cacheGracefully(
    agents: Record<string, AgentIR>,
    compilationOutput: CompilationOutput,
  ): Promise<void> {
    try {
      await Promise.all([
        this.sessionService.cacheCompilationOutput(compilationOutput),
        ...Object.values(agents).map((ir) => this.sessionService.cacheAgentIR(ir)),
      ]);
    } catch (err) {
      log.warn('Cache write failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private buildCompilationOutput(
    agents: Record<string, AgentIR>,
    entryAgent: string,
    options: {
      remoteAgents?: CompilationOutput['remote_agents'];
      coordinationDefaults?: CompilationOutput['coordination_defaults'];
    } = {},
  ): CompilationOutput {
    const output: CompilationOutput = {
      version: '1.0',
      compiled_at: new Date().toISOString(),
      agents,
      entry_agent: entryAgent,
      deployment: {
        runtime_recommendations: {},
        parallel_safe: [],
        stateful: [],
        hitl_capable: [],
      },
    };

    const remoteAgents = {
      ...collectRemoteAgentsFromResolvedAgents(agents),
      ...(options.remoteAgents ?? {}),
    };
    if (Object.keys(remoteAgents).length > 0) {
      output.remote_agents = remoteAgents;
    }

    if (options.coordinationDefaults) {
      output.coordination_defaults = options.coordinationDefaults;
    }

    return output;
  }

  private buildFromCompilation(
    compilation: CompilationOutput,
    entryAgent: string,
    sourceHash: string,
    versionInfo: VersionInfo,
  ): ResolvedAgent {
    const clonedCompilation = cloneCompilationOutput(compilation);
    return {
      agents: clonedCompilation.agents,
      entryAgent: clonedCompilation.entry_agent || entryAgent,
      compilationOutput: clonedCompilation,
      sourceHash,
      versionInfo,
    };
  }

  /**
   * Deterministic content hash — based on sorted agent IR content only,
   * not volatile fields like compiled_at. This ensures the same logical
   * deployment produces the same hash across requests and pods.
   */
  private computeContentHash(agents: Record<string, AgentIR>): string {
    const sortedKeys = Object.keys(agents).sort();
    const content = sortedKeys.map((k) => `${k}:${JSON.stringify(agents[k])}`).join('|');
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  /**
   * Parse semver to a comparable integer. Strips pre-release suffixes.
   * "1.2.3" → 1002003, "0.1.0" → 1000, "0.2.0" → 2000
   * Uses wide spacing (major*1000000 + minor*1000 + patch) to avoid overflow.
   */
  parseVersionNumber(version: string): number {
    // Strip pre-release suffix (e.g., "1.2.3-beta" → "1.2.3")
    const clean = version.replace(/^v/i, '').split('-')[0];
    const parts = clean.split('.');
    if (parts.length === 3) {
      const [major, minor, patch] = parts.map((p) => parseInt(p, 10) || 0);
      return major * 1000000 + minor * 1000 + patch;
    }
    return parseInt(clean, 10) || 0;
  }

  parseRawManifest(manifestJson: string | Record<string, string>): Record<string, string> {
    try {
      return typeof manifestJson === 'string'
        ? (JSON.parse(manifestJson) as Record<string, string>)
        : manifestJson;
    } catch {
      return {};
    }
  }

  parseManifestVersions(manifestJson: string | Record<string, string>): Record<string, number> {
    try {
      const manifest =
        typeof manifestJson === 'string'
          ? (JSON.parse(manifestJson) as Record<string, string>)
          : manifestJson;
      const result: Record<string, number> = {};
      for (const [name, version] of Object.entries(manifest)) {
        result[name] = this.parseVersionNumber(version);
      }
      return result;
    } catch {
      return {};
    }
  }
}

// =============================================================================
// STANDALONE MODULE MERGE — shared by DeploymentResolver and WS handler
// =============================================================================

/**
 * Resolve and merge module dependencies for working-copy (preview/dev) sessions.
 * Queries live ProjectModuleDependency records and loads the resolved release IR
 * for each, alias-rewriting and merging into the result. Failures are logged but
 * do not block the session — local agents still work without modules.
 */
export async function mergeWorkingCopyModules(
  result: ResolvedAgent,
  tenantId: string,
  projectId: string,
): Promise<void> {
  try {
    const { ModuleRelease } = await import('@agent-platform/database/models');
    const { loadModuleDependencies } = await import('./modules/module-dependency-cache.js');

    const dependencies = (await loadModuleDependencies(projectId, tenantId)) as Array<{
      alias: string;
      moduleProjectId: string;
      resolvedReleaseId: string;
      [key: string]: unknown;
    }>;

    if (dependencies.length === 0) return;

    const { rewriteModuleIR } = await import('./modules/module-alias-rewriter.js');
    const releaseIds = [...new Set(dependencies.map((dep) => dep.resolvedReleaseId))];
    const moduleProjectIds = [...new Set(dependencies.map((dep) => dep.moduleProjectId))];
    const releases = (await ModuleRelease.find({
      _id: { $in: releaseIds },
      tenantId,
      moduleProjectId: { $in: moduleProjectIds },
      archivedAt: { $in: [null, undefined] },
    }).lean()) as Array<Record<string, unknown>>;
    const releasesById = new Map(releases.map((release) => [String(release._id), release]));

    for (const dep of dependencies) {
      const release = releasesById.get(dep.resolvedReleaseId);

      if (!release) {
        log.warn('Module release not found for working-copy resolution', {
          projectId,
          tenantId,
          moduleProjectId: dep.moduleProjectId,
          resolvedReleaseId: dep.resolvedReleaseId,
        });
        continue;
      }

      const artifact = (release as Record<string, unknown>).artifact as
        | Record<string, unknown>
        | undefined;
      if (!artifact?.agents) continue;

      const alias = dep.alias;

      // Use pre-compiled IR if available, keyed by agent name
      const compiledIR =
        ((release as Record<string, unknown>).compiledIR as Record<string, unknown>) ?? {};
      const agentIRs: Record<string, AgentIR> = {};
      for (const [agentName, irData] of Object.entries(compiledIR)) {
        if (irData && typeof irData === 'object') {
          agentIRs[agentName] = irData as AgentIR;
        }
      }

      // Collect tool definitions from artifact
      const artifactTools = (artifact.tools ?? {}) as Record<string, Record<string, unknown>>;
      const toolEntries: Record<string, { definition: unknown; toolType: string }> = {};
      for (const [toolName, toolData] of Object.entries(artifactTools)) {
        toolEntries[toolName] = {
          definition: toolData.definition ?? { name: toolName, tool_type: toolData.toolType },
          toolType: String(toolData.toolType ?? ''),
        };
      }

      // Build existing symbol set for collision detection.
      // Filter out module stub agents (names containing '__') that were added
      // during compilation for cross-agent validation — these are expected to
      // be overwritten by real module agents and should not trigger warnings.
      const existingSymbols = new Set<string>([
        ...Object.keys(result.agents).filter((name) => !name.includes('__')),
        ...Object.keys(result.resolvedTools ?? {}).filter((name) => !name.includes('__')),
      ]);

      const rewriteResult = rewriteModuleIR(alias, agentIRs, toolEntries, existingSymbols);

      if (rewriteResult.collisions.length > 0) {
        log.warn('Module alias collisions in working-copy resolution', {
          projectId,
          alias,
          collisions: rewriteResult.collisions,
        });
      }

      // Merge mounted agents with provenance
      for (const [mountedName, agentIR] of Object.entries(rewriteResult.agents)) {
        const originalName =
          Object.entries(rewriteResult.renameMap).find(([, v]) => v === mountedName)?.[0] ??
          mountedName;
        const mountedAgent: ResolvedAgentIR = {
          ...agentIR,
          _moduleProvenance: {
            alias,
            moduleProjectId: dep.moduleProjectId,
            moduleReleaseId: dep.resolvedReleaseId,
            sourceAgentName: originalName,
          },
        };
        result.agents[mountedName] = mountedAgent;
        result.compilationOutput.agents[mountedName] = mountedAgent;
      }

      // Merge mounted tools
      result.resolvedTools = result.resolvedTools ?? {};
      for (const [mountedName, toolDef] of Object.entries(rewriteResult.tools)) {
        const originalName =
          Object.entries(rewriteResult.renameMap).find(([, v]) => v === mountedName)?.[0] ??
          mountedName;
        result.resolvedTools[mountedName] = {
          ...toolDef,
          _moduleProvenance: {
            alias,
            moduleProjectId: dep.moduleProjectId,
            moduleReleaseId: dep.resolvedReleaseId,
            sourceToolName: originalName,
          },
        } as ResolvedToolDefinition;
      }
    }

    log.info('Merged working-copy module dependencies', {
      projectId,
      dependencyCount: dependencies.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('Failed to merge working-copy modules — continuing without', {
      projectId,
      error: message,
    });
  }
}

function collectRemoteAgentsFromResolvedAgents(
  agents: Record<string, AgentIR>,
): NonNullable<CompilationOutput['remote_agents']> {
  const registry: NonNullable<CompilationOutput['remote_agents']> = {};

  for (const ir of Object.values(agents)) {
    for (const handoff of ir.coordination?.handoffs ?? []) {
      if (handoff.remote?.location === 'remote') {
        registry[handoff.to] = handoff.remote;
      }
    }

    for (const delegate of ir.coordination?.delegates ?? []) {
      if (delegate.remote?.location === 'remote') {
        registry[delegate.agent] = delegate.remote;
      }
    }
  }

  return registry;
}
