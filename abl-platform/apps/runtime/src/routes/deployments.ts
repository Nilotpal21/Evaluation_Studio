/**
 * Deployment API Routes
 *
 * Deployment lifecycle management: create, list, get, retire, rollback, promote.
 * Mounted at /api/projects/:projectId/deployments
 *
 * POST /                       Create deployment
 * GET  /                       List deployments
 * GET  /:deploymentId          Get deployment detail
 * POST /:deploymentId/retire   Retire deployment
 * POST /:deploymentId/rollback Rollback to previous deployment
 * POST /:deploymentId/promote  Promote deployment to another environment
 */

import crypto from 'crypto';
import { Router, type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { findProjectAgentsForProject, findAgentVersion } from '../repos/project-repo.js';
import {
  findActiveDeployment,
  findDeploymentById,
  listDeployments,
  createDeployment,
  updateDeploymentStatus,
  countLinkedChannels,
  retirePreviousActiveDeployment,
  findDeploymentVariableSnapshot,
} from '../repos/deployment-repo.js';
import { findWorkflowByNameAndProject, findWorkflowVersion } from '../repos/workflow-repo.js';
import { bulkUpdateChannelDeployment } from '../repos/channel-repo.js';
import { createLogger } from '@abl/compiler/platform';
import { VALID_ENVIRONMENTS, type Environment } from '@agent-platform/config';
import { runPreflightValidation } from '../services/preflight-validation-service.js';
import { getRedisClient } from '../services/redis/redis-client.js';
import { resolveRuntimeConfigKeysInAgentIR } from '../services/tool-runtime-config-resolution.js';
import {
  buildProjectDslReadinessError,
  evaluateProjectExecutionReadiness,
} from '../services/session/project-agent-dsl-readiness.js';

const log = createLogger('deployments-route');

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/deployments',
  tags: ['Deployments'],
});
const router: RouterType = openapi.router;

// All deployment routes require authentication
router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

// =============================================================================
// HELPERS
// =============================================================================

function generateEndpointSlug(projectId: string, environment: string): string {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(3).toString('hex');
  return `${projectId.substring(0, 8)}-${environment}-${ts}-${rand}`;
}

async function loadProjectModuleDependencyVersion(
  projectId: string,
  tenantId: string,
): Promise<number> {
  const { Project } = await import('@agent-platform/database/models');
  const project = await Project.findOne({ _id: projectId, tenantId }).lean();
  return Number((project as Record<string, unknown> | null)?.moduleDependencyVersion ?? 0);
}

async function loadProjectLocalSymbolSet(
  projectId: string,
  tenantId: string,
): Promise<Set<string>> {
  const symbols = new Set<string>();
  const projectAgents = await findProjectAgentsForProject(projectId, { tenantId });
  for (const agent of projectAgents as Array<Record<string, unknown>>) {
    if (typeof agent.name === 'string') {
      symbols.add(agent.name);
    }
  }

  const { ProjectTool } = await import('@agent-platform/database/models');
  const projectTools = await ProjectTool.find({ projectId, tenantId }).select('name').lean();
  for (const tool of projectTools as Array<Record<string, unknown>>) {
    if (typeof tool.name === 'string') {
      symbols.add(tool.name);
    }
  }

  return symbols;
}

function isConfigResolvableAgentIR(value: unknown): value is import('@abl/compiler').AgentIR {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.metadata === 'object' && record.metadata !== null && Array.isArray(record.tools)
  );
}

async function cleanupFailedDeploymentArtifacts(
  tenantId: string,
  deploymentId: string,
): Promise<void> {
  const { Deployment, DeploymentModuleSnapshot, DeploymentVariableSnapshot } =
    await import('@agent-platform/database/models');

  const cleanupResults = await Promise.allSettled([
    DeploymentModuleSnapshot.deleteOne({ tenantId, deploymentId }),
    DeploymentVariableSnapshot.deleteOne({ tenantId, deploymentId }),
    Deployment.deleteOne({ _id: deploymentId, tenantId }),
  ]);

  for (const [index, result] of cleanupResults.entries()) {
    if (result.status === 'rejected') {
      const resource =
        index === 0 ? 'module snapshot' : index === 1 ? 'variable snapshot' : 'deployment record';
      log.error('Failed to clean up deployment artifact after deployment failure', {
        deploymentId,
        resource,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }
}

async function restoreRetiredDeploymentToActive(
  tenantId: string,
  deploymentId: string,
): Promise<void> {
  const { Deployment } = await import('@agent-platform/database/models');
  await Deployment.updateOne(
    { _id: deploymentId, tenantId, status: 'retired' },
    { $set: { status: 'active', retiredAt: null } },
  );
}

async function restoreDrainingDeploymentToActive(
  tenantId: string,
  deploymentId: string,
): Promise<void> {
  const { Deployment } = await import('@agent-platform/database/models');
  await Deployment.updateOne(
    { _id: deploymentId, tenantId, status: 'draining' },
    { $set: { status: 'active', drainingStartedAt: null } },
  );
}

// =============================================================================
// SCHEMAS
// =============================================================================

const createDeploymentSchema = z.object({
  environment: z.enum(VALID_ENVIRONMENTS).describe('Target environment'),
  agentVersionManifest: z
    .record(z.string())
    .describe('Mapping of agent names to versions (or "auto" for auto-versioning)'),
  entryAgentName: z.string().describe('Name of the entry agent'),
  label: z.string().optional().describe('Human-readable label for the deployment'),
  description: z.string().optional().describe('Deployment description'),
  modelOverrides: z
    .record(z.record(z.unknown()))
    .optional()
    .describe('Optional model configuration overrides per agent'),
  settingsVersionId: z
    .string()
    .optional()
    .describe('Optional ProjectSettingsVersion ID to pin for this deployment'),
  workflowVersionManifest: z
    .record(z.string())
    .optional()
    .default({})
    .describe('Mapping of workflow names to versions (or "auto" for auto-versioning)'),
  force: z
    .boolean()
    .optional()
    .default(false)
    .describe('Skip preflight validation checks (escape hatch)'),
});

const deploymentResponseSchema = z.object({
  success: z.boolean(),
  deployment: z.object({
    id: z.string(),
    projectId: z.string(),
    environment: z.string(),
    status: z.string(),
    label: z.string().nullable(),
    description: z.string().nullable(),
    endpointSlug: z.string(),
    entryAgentName: z.string(),
    agentVersionManifest: z.record(z.string()),
    workflowVersionManifest: z.record(z.string()).optional(),
    createdAt: z.string().optional(),
    createdBy: z.string().optional(),
  }),
});

const listDeploymentsResponseSchema = z.object({
  success: z.boolean(),
  deployments: z.array(
    z.object({
      id: z.string(),
      projectId: z.string(),
      environment: z.string(),
      status: z.string(),
      label: z.string().nullable(),
      endpointSlug: z.string(),
      createdAt: z.string().optional(),
    }),
  ),
});

const deploymentDetailResponseSchema = z.object({
  success: z.boolean(),
  deployment: z.object({
    id: z.string(),
    projectId: z.string(),
    environment: z.string(),
    status: z.string(),
    label: z.string().nullable(),
    description: z.string().nullable(),
    endpointSlug: z.string(),
    entryAgentName: z.string(),
    agentVersionManifest: z.record(z.string()),
    workflowVersionManifest: z.record(z.string()).optional(),
    channelCount: z.number(),
    createdAt: z.string().optional(),
    createdBy: z.string().optional(),
  }),
});

const retireResponseSchema = z.object({
  success: z.boolean(),
  deployment: z.object({
    id: z.string(),
    status: z.string(),
    drainingStartedAt: z.string().nullable().optional(),
    retiredAt: z.string().nullable().optional(),
  }),
});

const rollbackResponseSchema = z.object({
  success: z.boolean(),
  deployment: z.object({
    id: z.string(),
    status: z.string(),
    retiredAt: z.string().nullable().optional(),
  }),
});

// =============================================================================
// ENDPOINTS
// =============================================================================

/**
 * POST /api/projects/:projectId/deployments
 * Create a new deployment.
 */
openapi.route(
  'post',
  '/',
  {
    summary: 'Create a new deployment',
    description: 'Create a new deployment with specified agent versions and configuration',
    body: createDeploymentSchema,
    response: deploymentResponseSchema,
    successStatus: 201,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'deployment:create'))) return;

      const { projectId } = req.params;
      const tenantId = req.tenantContext!.tenantId;
      const userId = req.tenantContext!.userId!;

      const {
        environment,
        agentVersionManifest,
        entryAgentName,
        label,
        description,
        modelOverrides,
        settingsVersionId,
        workflowVersionManifest = {},
        force = false,
      } = req.body;

      // Validate environment
      if (!VALID_ENVIRONMENTS.includes(environment)) {
        res.status(400).json({
          success: false,
          error: `Invalid environment "${environment}". Must be one of: ${VALID_ENVIRONMENTS.join(', ')}`,
        });
        return;
      }

      // Validate manifest non-empty
      if (Object.keys(agentVersionManifest).length === 0) {
        res.status(400).json({
          success: false,
          error: 'agentVersionManifest must be a non-empty object mapping agent names to versions',
        });
        return;
      }

      if (!agentVersionManifest[entryAgentName]) {
        res.status(400).json({
          success: false,
          error: `entryAgentName "${entryAgentName}" must be included in agentVersionManifest`,
        });
        return;
      }

      // Validate modelOverrides structure (optional)
      if (modelOverrides !== undefined && modelOverrides !== null) {
        for (const [name, override] of Object.entries(modelOverrides)) {
          if (!agentVersionManifest[name]) {
            res.status(400).json({
              success: false,
              error: `modelOverrides agent "${name}" must exist in agentVersionManifest`,
            });
            return;
          }
          if (typeof override !== 'object' || override === null) {
            res
              .status(400)
              .json({ success: false, error: `modelOverrides["${name}"] must be an object` });
            return;
          }
        }
      }

      // Validate settingsVersionId if provided
      if (settingsVersionId) {
        const { findSettingsVersionById } = await import('../repos/project-settings-repo.js');
        const settingsVersion = await findSettingsVersionById(settingsVersionId, tenantId);
        if (!settingsVersion || settingsVersion.projectId !== projectId) {
          res.status(400).json({
            success: false,
            error: `Settings version "${settingsVersionId}" not found for this project`,
          });
          return;
        }
      }

      // Validate all agent versions exist and collect IR for compilation caching
      // Batch: load all project agents in one query, then load versions in parallel
      const allProjectAgents = await findProjectAgentsForProject(projectId, {
        includeDSLContent: true,
        tenantId,
      });
      const { ProjectRuntimeConfig, ProjectLLMConfig } =
        await import('@agent-platform/database/models');
      const [runtimeConfig, llmConfig] = await Promise.all([
        ProjectRuntimeConfig.findOne({ projectId, tenantId }).lean(),
        ProjectLLMConfig.findOne({ projectId, tenantId }).lean(),
      ]);
      const autoVersionAgentNames = new Set(
        Object.entries(agentVersionManifest)
          .filter(([, version]) => version === 'auto')
          .map(([agentName]) => agentName),
      );
      const readinessAgents = (
        allProjectAgents as Array<{
          name?: string | null;
          dslContent?: string | null;
          dslValidationStatus?: string | null;
          dslDiagnostics?: Array<{ severity?: string; message?: string; source?: string }> | null;
        }>
      ).filter((agent) => agent.name && autoVersionAgentNames.has(agent.name));
      const readiness = await evaluateProjectExecutionReadiness({
        agents: readinessAgents,
        tenantId,
        projectId,
        runtimeConfig: runtimeConfig ?? null,
        llmConfig: llmConfig ?? null,
        lazyBackfill: true,
      });
      if (readiness.hasBlockingErrors) {
        log.warn('Refusing deployment creation for project with readiness errors', {
          tenantId,
          projectId,
          issueKinds: readiness.issues.map((issue) => issue.kind),
          blockedAgents: readiness.blockedAgents,
        });
        res.status(422).json({
          success: false,
          error: buildProjectDslReadinessError(),
          issues: readiness.issues,
        });
        return;
      }
      const agentsByName = new Map<string, any>(
        (allProjectAgents as any[]).map((a: any) => [a.name, a]),
      );

      const agentIRs: Record<string, import('@abl/compiler').AgentIR> = {};
      const versionLookups: Array<{ agentName: string; agentId: string; version: string }> = [];

      for (const [agentName, version] of Object.entries(agentVersionManifest)) {
        const agent = agentsByName.get(agentName);
        if (!agent) {
          res.status(400).json({
            success: false,
            error: `Agent "${agentName}" not found`,
          });
          return;
        }
        versionLookups.push({
          agentName,
          agentId: agent.id ?? agent._id,
          version: version as string,
        });
      }

      // --- Auto-version: for agents with 'auto' version, create from working copy ---
      const autoVersionLookups = versionLookups.filter((l) => l.version === 'auto');
      if (autoVersionLookups.length > 0) {
        const { getVersionService } = await import('../services/version-service.js');
        const versionService = getVersionService();

        // Collect all project agent DSLs for batch compilation context
        const allDslsForAuto = (allProjectAgents as any[])
          .filter((a: any) => a.dslContent)
          .map((a: any) => a.dslContent as string);

        for (const lookup of autoVersionLookups) {
          const agent = agentsByName.get(lookup.agentName);
          if (!agent?.dslContent) {
            res.status(400).json({
              success: false,
              error: `Agent "${lookup.agentName}" has no DSL content to auto-version`,
            });
            return;
          }

          const peerDsls = allDslsForAuto.filter((dsl) => dsl !== agent.dslContent);
          const nextVer = await versionService.nextVersion(projectId, lookup.agentName, tenantId);
          const result = await versionService.createVersion({
            projectId,
            agentName: lookup.agentName,
            dslContent: agent.dslContent,
            version: nextVer,
            createdBy: userId,
            tenantId,
            changelog: 'Auto-created for deployment',
            peerDsls,
            libraryRef: agent.systemPromptLibraryRef,
          });

          if (result.compileErrors) {
            res.status(422).json({
              success: false,
              error: `Auto-version failed for "${lookup.agentName}": ${result.compileErrors.join(', ')}`,
            });
            return;
          }

          // Update the lookup and manifest with the actual version
          lookup.version = result.version;
          agentVersionManifest[lookup.agentName] = result.version;
        }
      }

      // Parallel version lookups (composite key lookup not supported as batch)
      const versionResults = await Promise.all(
        versionLookups.map(({ agentId, version }) => findAgentVersion(agentId, version)),
      );

      // Explicit pins must stay reproducible for rollback and deploy-by-version workflows.
      // Only manifest entries explicitly set to "auto" above are allowed to create new versions
      // from the current working copy during deployment creation.

      for (let i = 0; i < versionLookups.length; i++) {
        const { agentName, version } = versionLookups[i];
        const agentVersion = versionResults[i];

        if (!agentVersion) {
          res.status(400).json({
            success: false,
            error: `Version ${version} of agent "${agentName}" not found`,
          });
          return;
        }

        // Collect IR content for compilation caching
        if (agentVersion.irContent) {
          try {
            const parsed = JSON.parse(agentVersion.irContent);
            // irContent stores CompilationOutput (with agents map), not bare AgentIR.
            // Unwrap to extract the actual AgentIR.
            let ir = parsed;
            if (parsed.agents && typeof parsed.agents === 'object' && !parsed.identity) {
              const innerNames = Object.keys(parsed.agents);
              ir = parsed.agents[agentName] || parsed.agents[innerNames[0]];
              if (!ir) {
                log.warn('No matching agent IR found inside CompilationOutput', {
                  agentName,
                  innerNames,
                });
              }
            }
            if (ir) {
              agentIRs[agentName] = ir;
            }
          } catch {
            log.warn('Failed to parse irContent for agent version', { agentName, version });
          }
        }
      }

      // Resolve {{config.KEY}} placeholders in loaded IRs (deployment-time resolution)
      if (Object.keys(agentIRs).length > 0) {
        try {
          const { loadConfigVariablesMap } = await import('../repos/project-repo.js');
          const configVars = await loadConfigVariablesMap(projectId, tenantId);
          const { resolveConfigVariables } = await import('@abl/compiler');
          for (const [agentName, ir] of Object.entries(agentIRs)) {
            if (!isConfigResolvableAgentIR(ir)) {
              log.warn('Skipping deployment config resolution for legacy agent IR shape', {
                agentName,
              });
              continue;
            }

            const result = resolveConfigVariables(ir, configVars);
            const runtimeKeyResult = resolveRuntimeConfigKeysInAgentIR(
              ir,
              configVars,
              `deployment agent "${agentName}"`,
            );
            const errors = [...result.errors, ...runtimeKeyResult.errors];
            if (errors.length > 0) {
              log.warn('Unresolved config variables during deployment', {
                agentName,
                errors,
              });
              res.status(400).json({
                success: false,
                error: 'Deployment config validation failed',
                details: errors,
              });
              return;
            }
            agentIRs[agentName] = runtimeKeyResult.ir;
          }
          log.info('Resolved config variables for deployment', {
            projectId,
            variableCount: Object.keys(configVars).length,
          });
        } catch (err) {
          log.error('Failed to resolve config variables during deployment', {
            projectId,
            error: err instanceof Error ? err.message : String(err),
          });
          res.status(500).json({
            success: false,
            error: 'Failed to validate deployment config',
          });
          return;
        }
      }

      // Build and cache compilation output
      let compilationHash: string | null = null;
      if (Object.keys(agentIRs).length > 0) {
        try {
          const { getSessionService } = await import('../services/session/session-service.js');
          const sessionService = getSessionService();

          const compilationOutput: import('@abl/compiler').CompilationOutput = {
            version: '1.0',
            compiled_at: new Date().toISOString(),
            agents: agentIRs,
            entry_agent: entryAgentName,
            deployment: {
              runtime_recommendations: {},
              parallel_safe: [],
              stateful: [],
              hitl_capable: [],
            },
          };

          compilationHash = await sessionService.cacheCompilationOutput(compilationOutput);

          // Also cache individual agent IRs
          for (const ir of Object.values(agentIRs)) {
            await sessionService.cacheAgentIR(ir);
          }

          log.info('Cached compilation output for deployment', {
            compilationHash,
            agentCount: Object.keys(agentIRs).length,
          });
        } catch (err) {
          log.warn('Failed to cache compilation output', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Check for missing {{env.KEY}} references (non-blocking warnings)
      const deploymentWarnings: string[] = [];
      if (Object.keys(agentIRs).length > 0) {
        try {
          const envVarPattern = /\{\{env\.(\w+)\}\}/g;
          const referencedKeys = new Set<string>();
          for (const [, ir] of Object.entries(agentIRs)) {
            const irStr = JSON.stringify(ir);
            let match;
            while ((match = envVarPattern.exec(irStr)) !== null) {
              referencedKeys.add(match[1]);
            }
          }

          if (referencedKeys.size > 0) {
            const { findEnvironmentVariables } = await import('../repos/security-repo.js');
            const definedVars = await findEnvironmentVariables(
              { tenantId, projectId, environment },
              { select: { key: true } },
            );
            const definedKeys = new Set(definedVars.map((v: any) => v.key));
            for (const key of referencedKeys) {
              if (!definedKeys.has(key)) {
                deploymentWarnings.push(
                  `Missing environment variable {{env.${key}}} for ${environment} environment`,
                );
              }
            }
          }
        } catch (err) {
          log.warn('Failed to check env var references', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Validate workflow version manifest
      if (Object.keys(workflowVersionManifest).length > 0) {
        for (const [workflowName, version] of Object.entries(
          workflowVersionManifest as Record<string, string>,
        )) {
          const workflow = await findWorkflowByNameAndProject(workflowName, tenantId, projectId);
          if (!workflow) {
            res.status(400).json({
              success: false,
              error: `Workflow "${workflowName}" not found`,
            });
            return;
          }

          if (version === 'auto') {
            // Auto-version: create from working copy
            const { getWorkflowVersionService } =
              await import('../services/workflow-version-service.js');
            const svc = getWorkflowVersionService();
            const result = await svc.createVersion({
              workflowId: (workflow as any)._id,
              projectId,
              tenantId,
              createdBy: userId,
              changelog: 'Auto-created for deployment',
            });

            // Activate the newly created version
            await svc.activate({
              tenantId,
              projectId,
              workflowId: (workflow as any)._id,
              version: result.version,
              activatedBy: userId,
            });

            workflowVersionManifest[workflowName] = result.version;
          } else {
            const wfVersion = await findWorkflowVersion(
              (workflow as any)._id,
              version,
              tenantId,
              projectId,
            );
            if (!wfVersion) {
              res.status(400).json({
                success: false,
                error: `Version ${version} of workflow "${workflowName}" not found`,
              });
              return;
            }
          }
        }
      }

      // Preflight validation gate (skip if force=true)
      let preflightReport;
      if (!force) {
        const agentNamesForPreflight = Object.keys(agentVersionManifest);
        preflightReport = await runPreflightValidation({
          tenantId,
          projectId,
          agentNames: agentNamesForPreflight,
        });

        if (preflightReport.status === 'errors') {
          res.status(422).json({
            success: false,
            error: {
              code: 'PREFLIGHT_FAILED',
              message: `Preflight validation found ${preflightReport.summary.errors} error(s). Use force=true to override.`,
            },
            preflightReport,
          });
          return;
        }

        if (preflightReport.status === 'warnings') {
          deploymentWarnings.push(
            `Preflight validation found ${preflightReport.summary.warnings} warning(s)`,
          );
        }
      }

      const expectedDependencyVersion = await loadProjectModuleDependencyVersion(
        projectId,
        tenantId,
      );

      // Retire previous active deployment for this environment
      const previousDeployment = await retirePreviousActiveDeployment(
        projectId,
        tenantId,
        environment,
      );

      const endpointSlug = generateEndpointSlug(projectId, environment);

      try {
        let deployment;
        try {
          deployment = await createDeployment({
            projectId,
            tenantId,
            environment,
            label,
            description,
            agentVersionManifest,
            workflowVersionManifest,
            entryAgentName,
            endpointSlug,
            compilationHash,
            previousDeploymentId: (previousDeployment?.id as string) ?? null,
            createdBy: userId,
            modelOverrides: modelOverrides ?? null,
            settingsVersionId: settingsVersionId ?? null,
          });
        } catch (createErr) {
          if (previousDeployment?.id) {
            await restoreRetiredDeploymentToActive(tenantId, previousDeployment.id as string);
          }
          throw createErr;
        }

        // Build frozen module snapshot for this deployment before variable snapshot/channel cutover
        try {
          const { buildDeploymentModuleSnapshot } =
            await import('../services/modules/deployment-build-service.js');
          const redisLockClient = getRedisClient() as unknown as
            | import('../services/modules/deployment-build-service.js').RedisLockClient
            | undefined;
          const existingSymbols = await loadProjectLocalSymbolSet(projectId, tenantId);
          const moduleBuild = await buildDeploymentModuleSnapshot(
            tenantId,
            projectId,
            deployment.id,
            expectedDependencyVersion,
            existingSymbols,
            { redis: redisLockClient, environment, userId },
          );

          if (moduleBuild && !moduleBuild.success) {
            await cleanupFailedDeploymentArtifacts(tenantId, deployment.id);
            if (previousDeployment?.id) {
              await restoreRetiredDeploymentToActive(tenantId, previousDeployment.id as string);
            }

            res.status(422).json({
              success: false,
              error: {
                code: 'MODULE_BUILD_FAILED',
                message:
                  'Module dependency resolution failed for this deployment. Fix the reported issues and retry.',
              },
              moduleBuild,
            });
            return;
          }

          if (moduleBuild?.diagnostics.length) {
            deploymentWarnings.push(
              ...moduleBuild.diagnostics.map((diagnostic) => diagnostic.message),
            );
          }
        } catch (moduleErr) {
          await cleanupFailedDeploymentArtifacts(tenantId, deployment.id);
          if (previousDeployment?.id) {
            await restoreRetiredDeploymentToActive(tenantId, previousDeployment.id as string);
          }
          throw moduleErr;
        }

        // Create deployment variable snapshot
        try {
          const { createDeploymentSnapshot } = await import('../services/snapshot-service.js');
          const snapshot = await createDeploymentSnapshot({
            tenantId,
            projectId,
            deploymentId: deployment.id,
            environment,
            createdBy: userId,
          });

          const { Deployment } = await import('@agent-platform/database/models');
          await Deployment.updateOne(
            { _id: deployment.id, tenantId },
            { $set: { variableSnapshotId: String(snapshot._id) } },
          );
        } catch (snapshotErr) {
          log.error('Failed to create deployment variable snapshot', {
            deploymentId: deployment.id,
            error: snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr),
          });
          // Snapshot failure should NOT block deployment creation
        }

        // Auto-follow: update channels scoped to this environment that opt in
        let channelsUpdated = 0;
        try {
          channelsUpdated = await bulkUpdateChannelDeployment(
            tenantId,
            projectId,
            environment,
            deployment.id,
          );
          if (channelsUpdated > 0) {
            log.info('Auto-follow updated channels', {
              projectId,
              environment,
              channelsUpdated,
              deploymentId: deployment.id,
            });
          }
        } catch (err) {
          log.warn('Auto-follow channel update failed (non-fatal)', {
            error: err instanceof Error ? err.message : String(err),
          });
        }

        res.status(201).json({
          success: true,
          deployment,
          channelsUpdated,
          ...(deploymentWarnings.length > 0 ? { warnings: deploymentWarnings } : {}),
          ...(preflightReport ? { preflightReport } : {}),
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('E11000')) {
          res.status(409).json({
            success: false,
            error: 'Another deployment to this environment is already in progress. Please retry.',
          });
          return;
        }
        throw err;
      }
    } catch (err) {
      log.error('Failed to create deployment', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ success: false, error: 'Failed to create deployment' });
    }
  },
);

/**
 * GET /api/projects/:projectId/deployments
 * List deployments with optional filters.
 */
openapi.route(
  'get',
  '/',
  {
    summary: 'List deployments',
    description:
      'List deployments for a project with optional filtering (query params: environment, status)',
    response: listDeploymentsResponseSchema,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'deployment:read'))) return;

      const { projectId } = req.params;
      const tenantId = req.tenantContext!.tenantId;

      const { environment, status } = req.query;

      const deployments = await listDeployments(projectId, tenantId, {
        environment: environment as string | undefined,
        status: status as string | undefined,
      });

      res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=120');
      res.json({
        success: true,
        deployments,
      });
    } catch (err) {
      log.error('Failed to list deployments', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ success: false, error: 'Failed to list deployments' });
    }
  },
);

/**
 * GET /api/projects/:projectId/deployments/:deploymentId
 * Get deployment detail with channel count.
 */
openapi.route(
  'get',
  '/:deploymentId',
  {
    summary: 'Get deployment detail',
    description: 'Get full deployment details including channel count and configuration',
    response: deploymentDetailResponseSchema,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'deployment:read'))) return;

      const { projectId, deploymentId } = req.params;
      const tenantId = req.tenantContext!.tenantId;

      const deployment = await findDeploymentById(deploymentId, projectId, tenantId);

      if (!deployment) {
        res.status(404).json({ success: false, error: 'Deployment not found' });
        return;
      }

      // Count linked channels
      const channelCount = await countLinkedChannels(deployment.id, tenantId);

      res.json({
        success: true,
        deployment: {
          ...deployment,
          channelCount,
        },
      });
    } catch (err) {
      log.error('Failed to get deployment', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ success: false, error: 'Failed to get deployment' });
    }
  },
);

/**
 * POST /api/projects/:projectId/deployments/:deploymentId/retire
 * Retire a deployment.
 */
openapi.route(
  'post',
  '/:deploymentId/retire',
  {
    summary: 'Retire a deployment',
    description:
      'Retire an active or draining deployment. Active deployments transition to draining first unless force=true',
    body: z.object({
      force: z.boolean().optional().describe('If true, force immediate retirement (skip draining)'),
    }),
    response: retireResponseSchema,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'deployment:retire'))) return;

      const { projectId, deploymentId } = req.params;
      const tenantId = req.tenantContext!.tenantId;

      const deployment = await findDeploymentById(deploymentId, projectId, tenantId);

      if (!deployment) {
        res.status(404).json({ success: false, error: 'Deployment not found' });
        return;
      }

      if (deployment.status !== 'active' && deployment.status !== 'draining') {
        res.status(422).json({
          success: false,
          error: `Cannot retire deployment with status "${deployment.status}". Only active or draining deployments can be retired.`,
        });
        return;
      }

      // If active, transition to draining first; if already draining, go to retired
      const { force } = req.body || {};
      const newStatus = deployment.status === 'active' && !force ? 'draining' : 'retired';

      const updateData: Record<string, unknown> = { status: newStatus };
      if (newStatus === 'draining') {
        updateData.drainingStartedAt = new Date();
      } else {
        updateData.retiredAt = new Date();
      }

      const updated = await updateDeploymentStatus(deploymentId, tenantId, updateData as any);

      // Cascade delete snapshot when deployment is fully retired
      if (newStatus === 'retired') {
        try {
          const { DeploymentVariableSnapshot } = await import('@agent-platform/database/models');
          await DeploymentVariableSnapshot.deleteOne({
            deploymentId: deployment.id ?? (deployment as any)._id,
          });
        } catch (cascadeErr) {
          log.error('Failed to cascade-delete deployment snapshot', {
            deploymentId,
            error: cascadeErr instanceof Error ? cascadeErr.message : String(cascadeErr),
          });
        }
      }

      res.json({
        success: true,
        deployment: updated,
      });
    } catch (err) {
      log.error('Failed to retire deployment', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ success: false, error: 'Failed to retire deployment' });
    }
  },
);

/**
 * POST /api/projects/:projectId/deployments/:deploymentId/rollback
 * Rollback to previous deployment.
 */
openapi.route(
  'post',
  '/:deploymentId/rollback',
  {
    summary: 'Rollback to previous deployment',
    description: 'Retire the current deployment and reactivate the previous one',
    response: rollbackResponseSchema,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'deployment:create'))) return;

      const { projectId, deploymentId } = req.params;
      const tenantId = req.tenantContext!.tenantId;

      const deployment = await findDeploymentById(deploymentId, projectId, tenantId);

      if (!deployment) {
        res.status(404).json({ success: false, error: 'Deployment not found' });
        return;
      }

      if (!deployment.previousDeploymentId) {
        res.status(422).json({ success: false, error: 'No previous deployment to rollback to' });
        return;
      }

      const previousDeployment = await findDeploymentById(
        deployment.previousDeploymentId,
        projectId,
        tenantId,
      );

      if (!previousDeployment) {
        res.status(404).json({ success: false, error: 'Previous deployment not found' });
        return;
      }

      // Retire current deployment
      await updateDeploymentStatus(deploymentId, tenantId, {
        status: 'retired',
        retiredAt: new Date(),
      });

      // Re-activate previous deployment
      const reactivated = await updateDeploymentStatus(previousDeployment.id, tenantId, {
        status: 'active',
        retiredAt: null,
      });

      res.json({
        success: true,
        deployment: reactivated,
      });
    } catch (err) {
      log.error('Failed to rollback deployment', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ success: false, error: 'Failed to rollback deployment' });
    }
  },
);

// =============================================================================
// PROMOTE
// =============================================================================

const promoteDeploymentSchema = z.object({
  targetEnvironment: z.enum(VALID_ENVIRONMENTS).describe('Target environment to promote into'),
  label: z.string().optional().describe('Label for the promoted deployment'),
  description: z.string().optional().describe('Description for the promoted deployment'),
  modelOverrides: z
    .record(z.record(z.unknown()))
    .optional()
    .describe('Model overrides to layer on top of source overrides'),
});

const promoteResponseSchema = z.object({
  success: z.boolean(),
  deployment: z.object({
    id: z.string(),
    projectId: z.string(),
    environment: z.string(),
    status: z.string(),
    label: z.string().nullable(),
    description: z.string().nullable(),
    endpointSlug: z.string(),
    entryAgentName: z.string(),
    agentVersionManifest: z.record(z.string()),
    workflowVersionManifest: z.record(z.string()).optional(),
    promotedFromDeploymentId: z.string().nullable(),
    createdAt: z.string().optional(),
    createdBy: z.string().optional(),
  }),
  channelsUpdated: z.number(),
});

/**
 * POST /api/projects/:projectId/deployments/:deploymentId/promote
 * Promote a deployment to another environment.
 */
openapi.route(
  'post',
  '/:deploymentId/promote',
  {
    summary: 'Promote deployment to another environment',
    description:
      'Clone a deployment into a different environment, optionally layering model overrides. Auto-follow channels in the target environment are updated.',
    body: promoteDeploymentSchema,
    response: promoteResponseSchema,
    successStatus: 201,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'deployment:create'))) return;

      const { projectId, deploymentId } = req.params;
      const tenantId = req.tenantContext!.tenantId;
      const userId = req.tenantContext!.userId!;

      const { targetEnvironment, label, description, modelOverrides } = req.body;

      // Load source deployment
      const source = await findDeploymentById(deploymentId, projectId, tenantId);
      if (!source) {
        res.status(404).json({ success: false, error: 'Source deployment not found' });
        return;
      }

      // Reject retired source
      if (source.status === 'retired') {
        res.status(422).json({
          success: false,
          error: { code: 'DEPLOYMENT_RETIRED', message: 'Cannot promote a retired deployment' },
        });
        return;
      }

      // Reject same environment
      if (targetEnvironment === source.environment) {
        res.status(422).json({
          success: false,
          error: {
            code: 'SAME_ENVIRONMENT',
            message: `Deployment is already in "${targetEnvironment}" environment`,
          },
        });
        return;
      }

      // Merge model overrides: source base + request overrides layered on top
      let mergedOverrides: Record<string, unknown> | null = source.modelOverrides ?? null;
      if (modelOverrides) {
        mergedOverrides = { ...(source.modelOverrides ?? {}), ...modelOverrides };
      }

      const expectedDependencyVersion = await loadProjectModuleDependencyVersion(
        projectId,
        tenantId,
      );

      // Drain current active in target environment
      const previousActive = await findActiveDeployment(projectId, tenantId, targetEnvironment);
      if (previousActive) {
        await updateDeploymentStatus(previousActive.id, tenantId, {
          status: 'draining',
          drainingStartedAt: new Date(),
        });
      }

      const endpointSlug = generateEndpointSlug(projectId, targetEnvironment);

      let deployment;
      try {
        deployment = await createDeployment({
          projectId,
          tenantId,
          environment: targetEnvironment,
          label: label ?? source.label,
          description: description ?? source.description,
          agentVersionManifest: source.agentVersionManifest,
          workflowVersionManifest: source.workflowVersionManifest || {},
          entryAgentName: source.entryAgentName,
          endpointSlug,
          compilationHash: source.compilationHash,
          previousDeploymentId: previousActive?.id || null,
          promotedFromDeploymentId: source.id,
          createdBy: userId,
          modelOverrides: mergedOverrides,
          settingsVersionId: source.settingsVersionId ?? null,
        });
      } catch (createErr) {
        if (previousActive?.id) {
          await restoreDrainingDeploymentToActive(tenantId, previousActive.id as string);
        }
        throw createErr;
      }

      try {
        const { buildDeploymentModuleSnapshot, cloneDeploymentModuleSnapshot } =
          await import('../services/modules/deployment-build-service.js');
        const redisLockClient = getRedisClient() as unknown as
          | import('../services/modules/deployment-build-service.js').RedisLockClient
          | undefined;
        const existingSymbols = await loadProjectLocalSymbolSet(projectId, tenantId);

        const clonedSnapshot = await cloneDeploymentModuleSnapshot(
          tenantId,
          projectId,
          source.id,
          deployment.id,
          { sourceEnvironment: source.environment, targetEnvironment: deployment.environment },
        );

        const moduleBuild =
          clonedSnapshot ??
          (await buildDeploymentModuleSnapshot(
            tenantId,
            projectId,
            deployment.id,
            expectedDependencyVersion,
            existingSymbols,
            { redis: redisLockClient, environment: deployment.environment, userId },
          ));

        if (moduleBuild && !moduleBuild.success) {
          await cleanupFailedDeploymentArtifacts(tenantId, deployment.id);
          if (previousActive?.id) {
            await restoreDrainingDeploymentToActive(tenantId, previousActive.id as string);
          }

          res.status(422).json({
            success: false,
            error: {
              code: 'MODULE_BUILD_FAILED',
              message:
                'The promoted deployment could not materialize its module snapshot. Fix the reported issues and retry the promotion.',
            },
            moduleBuild,
          });
          return;
        }
      } catch (moduleErr) {
        await cleanupFailedDeploymentArtifacts(tenantId, deployment.id);
        if (previousActive?.id) {
          await restoreDrainingDeploymentToActive(tenantId, previousActive.id as string);
        }
        throw moduleErr;
      }

      // Create deployment variable snapshot for promoted deployment
      try {
        const { createDeploymentSnapshot } = await import('../services/snapshot-service.js');
        const snapshot = await createDeploymentSnapshot({
          tenantId,
          projectId,
          deploymentId: deployment.id,
          environment: targetEnvironment,
          createdBy: userId,
        });

        const { Deployment } = await import('@agent-platform/database/models');
        await Deployment.updateOne(
          { _id: deployment.id, tenantId },
          { $set: { variableSnapshotId: String(snapshot._id) } },
        );
      } catch (snapshotErr) {
        log.error('Failed to create deployment variable snapshot for promotion', {
          deploymentId: deployment.id,
          error: snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr),
        });
        // Snapshot failure should NOT block promotion
      }

      // Auto-follow: update channels scoped to the target environment
      let channelsUpdated = 0;
      try {
        channelsUpdated = await bulkUpdateChannelDeployment(
          tenantId,
          projectId,
          targetEnvironment,
          deployment.id,
        );
        if (channelsUpdated > 0) {
          log.info('Promotion auto-follow updated channels', {
            projectId,
            targetEnvironment,
            channelsUpdated,
            deploymentId: deployment.id,
          });
        }
      } catch (err) {
        log.warn('Promotion auto-follow channel update failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      res.status(201).json({
        success: true,
        deployment,
        channelsUpdated,
      });
    } catch (err) {
      log.error('Failed to promote deployment', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ success: false, error: 'Failed to promote deployment' });
    }
  },
);

// =============================================================================
// SNAPSHOT ROUTES
// =============================================================================

const snapshotResponseSchema = z.object({
  success: z.boolean(),
  snapshot: z.object({
    id: z.string(),
    deploymentId: z.string(),
    environment: z.string(),
    snapshotVersion: z.number(),
    snapshotHash: z.string(),
    envVars: z.array(
      z.object({
        key: z.string(),
        isSecret: z.boolean(),
        description: z.string().nullable(),
        namespaces: z.array(z.string()),
      }),
    ),
    configVars: z.array(
      z.object({
        key: z.string(),
        value: z.string(),
        description: z.string().nullable(),
        namespaces: z.array(z.string()),
      }),
    ),
    createdBy: z.string(),
    createdAt: z.string().optional(),
  }),
});

/**
 * GET /api/projects/:projectId/deployments/:deploymentId/snapshot
 * Get the variable snapshot for a deployment.
 */
openapi.route(
  'get',
  '/:deploymentId/snapshot',
  {
    summary: 'Get deployment variable snapshot',
    description:
      'Get the immutable variable snapshot captured at deployment creation time. Env var values are masked.',
    response: snapshotResponseSchema,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'deployment:read'))) return;
      if (!(await requireProjectPermission(req, res, 'env_var:read'))) return;

      const { projectId, deploymentId } = req.params;
      const tenantId = req.tenantContext!.tenantId;

      // Verify deployment exists and belongs to this project
      const deployment = await findDeploymentById(deploymentId, projectId, tenantId);
      if (!deployment) {
        res.status(404).json({ success: false, error: 'Deployment not found' });
        return;
      }

      const snapshot = await findDeploymentVariableSnapshot(deploymentId, tenantId, projectId);

      if (!snapshot) {
        res.status(404).json({
          success: false,
          error: 'No variable snapshot found for this deployment (pre-migration deployment)',
        });
        return;
      }

      const snap = snapshot as any;

      res.json({
        success: true,
        snapshot: {
          id: String(snap._id),
          deploymentId: snap.deploymentId,
          environment: snap.environment,
          snapshotVersion: snap.snapshotVersion,
          snapshotHash: snap.snapshotHash,
          envVars: (snap.envVars ?? []).map((v: any) => ({
            key: v.key,
            isSecret: v.isSecret,
            description: v.description ?? null,
            namespaces: v.namespaces ?? [],
            // encryptedValue is intentionally omitted — masked
          })),
          configVars: (snap.configVars ?? []).map((v: any) => ({
            key: v.key,
            value: v.value,
            description: v.description ?? null,
            namespaces: v.namespaces ?? [],
          })),
          createdBy: snap.createdBy,
          createdAt: snap.createdAt?.toISOString?.() ?? snap.createdAt,
        },
      });
    } catch (err) {
      log.error('Failed to get deployment snapshot', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ success: false, error: 'Failed to get deployment snapshot' });
    }
  },
);

const snapshotValueResponseSchema = z.object({
  success: z.boolean(),
  key: z.string(),
  value: z.string(),
});

/**
 * GET /api/projects/:projectId/deployments/:deploymentId/snapshot/value/:key
 * Decrypt and return a single env var value from the snapshot.
 */
openapi.route(
  'get',
  '/:deploymentId/snapshot/value/:key',
  {
    summary: 'Get decrypted snapshot env var value',
    description:
      'Decrypt and return a single environment variable value from the deployment snapshot.',
    response: snapshotValueResponseSchema,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'deployment:read'))) return;
      if (!(await requireProjectPermission(req, res, 'env_var:read'))) return;

      const { projectId, deploymentId, key } = req.params;
      const tenantId = req.tenantContext!.tenantId;

      // Verify deployment exists and belongs to this project
      const deployment = await findDeploymentById(deploymentId, projectId, tenantId);
      if (!deployment) {
        res.status(404).json({ success: false, error: 'Deployment not found' });
        return;
      }

      const snapshot = await findDeploymentVariableSnapshot(deploymentId, tenantId, projectId);

      if (!snapshot) {
        res.status(404).json({
          success: false,
          error: 'No variable snapshot found for this deployment',
        });
        return;
      }

      const snap = snapshot as any;
      const envVar = (snap.envVars ?? []).find((v: any) => v.key === key);
      if (!envVar) {
        res.status(404).json({
          success: false,
          error: `Environment variable "${key}" not found in snapshot`,
        });
        return;
      }

      const { isTenantEncryptionReady, decryptForTenantAuto } =
        await import('@agent-platform/shared/encryption');
      if (!isTenantEncryptionReady()) {
        res.status(503).json({
          success: false,
          error: 'Tenant DEK encryption is not initialized',
        });
        return;
      }

      const decryptedValue = await decryptForTenantAuto(envVar.encryptedValue, tenantId);

      res.json({
        success: true,
        key,
        value: decryptedValue,
      });
    } catch (err) {
      log.error('Failed to decrypt snapshot value', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ success: false, error: 'Failed to decrypt snapshot value' });
    }
  },
);

const snapshotDiffResponseSchema = z.object({
  success: z.boolean(),
  identical: z.boolean(),
  sourceHash: z.string(),
  targetHash: z.string(),
  diff: z
    .object({
      added: z.array(
        z.object({
          key: z.string(),
          type: z.enum(['env', 'config']),
          namespaces: z.array(z.string()),
        }),
      ),
      removed: z.array(
        z.object({
          key: z.string(),
          type: z.enum(['env', 'config']),
          namespaces: z.array(z.string()),
        }),
      ),
      changed: z.array(
        z.object({
          key: z.string(),
          type: z.enum(['env', 'config']),
          valueChanged: z.boolean(),
          namespaces: z.array(z.string()),
        }),
      ),
    })
    .optional(),
});

/**
 * GET /api/projects/:projectId/deployments/:deploymentId/snapshot/diff
 * Compare variable snapshots between two deployments.
 */
openapi.route(
  'get',
  '/:deploymentId/snapshot/diff',
  {
    summary: 'Diff deployment variable snapshots',
    description:
      'Compare variable snapshots between two deployments. Pass compareWith query param with the other deployment ID.',
    response: snapshotDiffResponseSchema,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'deployment:read'))) return;

      const { projectId, deploymentId } = req.params;
      const tenantId = req.tenantContext!.tenantId;
      const compareWith = req.query.compareWith as string;

      if (!compareWith) {
        res.status(400).json({
          success: false,
          error: 'Query parameter "compareWith" is required (deployment ID to compare against)',
        });
        return;
      }

      // Verify both deployments exist and belong to this project
      const [deployment, otherDeployment] = await Promise.all([
        findDeploymentById(deploymentId, projectId, tenantId),
        findDeploymentById(compareWith, projectId, tenantId),
      ]);

      if (!deployment) {
        res.status(404).json({ success: false, error: 'Source deployment not found' });
        return;
      }
      if (!otherDeployment) {
        res.status(404).json({ success: false, error: 'Comparison deployment not found' });
        return;
      }

      const [sourceSnapshot, targetSnapshot] = await Promise.all([
        findDeploymentVariableSnapshot(deploymentId, tenantId, projectId),
        findDeploymentVariableSnapshot(compareWith, tenantId, projectId),
      ]);

      if (!sourceSnapshot) {
        res.status(404).json({
          success: false,
          error: 'No variable snapshot found for source deployment',
        });
        return;
      }
      if (!targetSnapshot) {
        res.status(404).json({
          success: false,
          error: 'No variable snapshot found for comparison deployment',
        });
        return;
      }

      const source = sourceSnapshot as any;
      const target = targetSnapshot as any;

      // Fast path: if hashes match, snapshots are identical
      if (source.snapshotHash === target.snapshotHash) {
        res.json({
          success: true,
          identical: true,
          sourceHash: source.snapshotHash,
          targetHash: target.snapshotHash,
        });
        return;
      }

      // Compute per-variable diff
      const { computeSnapshotDiff } = await import('../services/snapshot-service.js');
      const diff = computeSnapshotDiff(
        { envVars: source.envVars ?? [], configVars: source.configVars ?? [] },
        { envVars: target.envVars ?? [], configVars: target.configVars ?? [] },
      );

      res.json({
        success: true,
        identical: false,
        sourceHash: source.snapshotHash,
        targetHash: target.snapshotHash,
        diff,
      });
    } catch (err) {
      log.error('Failed to compute snapshot diff', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ success: false, error: 'Failed to compute snapshot diff' });
    }
  },
);

export default router;
