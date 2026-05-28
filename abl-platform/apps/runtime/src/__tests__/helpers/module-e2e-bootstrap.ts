/**
 * Module E2E Bootstrap Helper
 *
 * Wraps RuntimeApiHarness with module-specific helpers for E2E testing of
 * the Reusable Agent Modules feature. Provides convenience methods for the
 * full module lifecycle: project creation, module mode, agent/tool import,
 * release publishing, dependency wiring, deployment, and session execution.
 *
 * Module-specific operations (releases, dependencies, env pointers) are
 * Studio-only API routes and cannot be accessed via Runtime routes. These
 * are seeded directly via Mongoose models in the bootstrap setup. All test
 * assertions should still go through the HTTP API.
 */

import authRouter from '../../routes/auth.js';
import authProfilesRouter from '../../routes/auth-profiles.js';
import platformAdminTenantsRouter from '../../routes/platform-admin-tenants.js';
import platformAdminModelsRouter from '../../routes/platform-admin-models.js';
import sdkPublicKeysRouter from '../../routes/sdk-public-keys.js';
import sdkChannelsRouter from '../../routes/sdk-channels.js';
import sdkInitRouter from '../../routes/sdk-init.js';
import projectIoRouter from '../../routes/project-io.js';
import chatRouter from '../../routes/chat.js';
import sessionsRouter from '../../routes/sessions.js';
import projectAgentsRouter from '../../routes/project-agents.js';
import deploymentsRouter from '../../routes/deployments.js';
import versionsRouter from '../../routes/versions.js';
import { startRuntimeApiHarness, type RuntimeApiHarness } from './runtime-api-harness.js';
import {
  authHeaders,
  bootstrapProject,
  createSdkBootstrapChannel,
  importProjectFiles,
  provisionTenantModel,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
  createSdkPublicKey,
  initSdkSession,
  type BootstrapProjectResult,
} from './channel-e2e-bootstrap.js';
import {
  Project,
  ModuleRelease,
  ModuleEnvironmentPointer,
  ProjectModuleDependency,
  type ModuleReleaseContract,
  type ProjectToolType,
} from '@agent-platform/database/models';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '@abl/compiler';
import {
  buildModuleRelease,
  extractModuleContract,
  validatePublishSafety,
  type CompileFn,
} from '@agent-platform/project-io';

// ─── DSL Fixtures ─────────────────────────────────────────────────────────────

export const SIMPLE_MODULE_AGENT_DSL = `
AGENT: payment_processor

GOAL: "Process payments for customers"
`;

export const SIMPLE_MODULE_TOOL_DSL = `TOOLS:
  base_url: "https://api.example.com/v1"

  validate_card(card_number: string) -> object
    type: http
    endpoint: "/validate"
    method: POST
    description: "Validate a credit card number"
`;

export const MULTI_AGENT_MODULE_DSL = {
  entry: `
AGENT: order_supervisor

GOAL: "Coordinate order processing"

`,
  worker: `
AGENT: order_worker

GOAL: "Process individual order items"

`,
};

export const CONSUMER_AGENT_DSL = `
AGENT: store_agent

GOAL: "Handle store operations using payment module"

`;

// ─── Types ────────────────────────────────────────────────────────────────────

interface PublishReleaseOpts {
  releaseNotes?: string;
  promoteToEnvironment?: 'dev' | 'staging' | 'production';
  /** Override contract fields (e.g., requiredAuthProfiles) for testing purposes. */
  contractOverrides?: Partial<ModuleReleaseContract>;
}

interface ImportModuleOpts {
  selector: { type: 'version' | 'environment'; value: string };
  configOverrides?: Record<string, string>;
}

// ─── ModuleE2EBootstrap ───────────────────────────────────────────────────────

export class ModuleE2EBootstrap {
  harness: RuntimeApiHarness;
  private _bootstrapResult: BootstrapProjectResult;

  private constructor(harness: RuntimeApiHarness, bootstrapResult: BootstrapProjectResult) {
    this.harness = harness;
    this._bootstrapResult = bootstrapResult;
  }

  /**
   * Create a new ModuleE2EBootstrap instance.
   * Starts a real Runtime API server with MongoMemoryServer and provisions
   * a super-admin tenant with one initial project.
   */
  static async create(): Promise<ModuleE2EBootstrap> {
    const harness = await startRuntimeApiHarness((app) => {
      app.use('/api/auth', authRouter);
      app.use('/api/auth-profiles', authProfilesRouter);
      app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
      app.use('/api/platform/admin/tenant-models', platformAdminModelsRouter);
      app.use('/api/projects/:projectId/sdk-public-keys', sdkPublicKeysRouter);
      app.use('/api/projects/:projectId/sdk-channels', sdkChannelsRouter);
      app.use('/api/v1/sdk', sdkInitRouter);
      app.use('/api/projects/:projectId/project-io', projectIoRouter);
      app.use('/api/v1/chat', chatRouter);
      app.use('/api/projects/:projectId/sessions', sessionsRouter);
      app.use('/api/projects/:projectId/agents', projectAgentsRouter);
      app.use('/api/projects/:projectId/deployments', deploymentsRouter);
      app.use('/api/projects/:projectId/agents/:agentName/versions', versionsRouter);
    });

    const bootstrapResult = await bootstrapProject(
      harness,
      uniqueEmail('module-e2e-admin'),
      uniqueSlug('tenant-modules'),
      uniqueSlug('project-modules'),
    );

    return new ModuleE2EBootstrap(harness, bootstrapResult);
  }

  /**
   * Tear down the harness: close the HTTP server, stop MongoMemoryServer,
   * restore environment variables.
   */
  async teardown(): Promise<void> {
    await this.harness.close();
  }

  // ─── Auth helpers ─────────────────────────────────────────────────────────

  get authToken(): string {
    return this._bootstrapResult.token;
  }

  get tenantId(): string {
    return this._bootstrapResult.tenantId;
  }

  get userId(): string {
    return this._bootstrapResult.userId;
  }

  get defaultProjectId(): string {
    return this._bootstrapResult.projectId;
  }

  // ─── Request helpers ──────────────────────────────────────────────────────

  async get(path: string): Promise<{ status: number; body: unknown }> {
    return requestJson(this.harness, path, {
      method: 'GET',
      headers: authHeaders(this.authToken),
    });
  }

  async post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    return requestJson(this.harness, path, {
      method: 'POST',
      headers: authHeaders(this.authToken),
      body,
    });
  }

  async put(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    return requestJson(this.harness, path, {
      method: 'PUT',
      headers: authHeaders(this.authToken),
      body,
    });
  }

  async del(path: string): Promise<{ status: number; body: unknown }> {
    return requestJson(this.harness, path, {
      method: 'DELETE',
      headers: authHeaders(this.authToken),
    });
  }

  async patch(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    return requestJson(this.harness, path, {
      method: 'PATCH',
      headers: authHeaders(this.authToken),
      body,
    });
  }

  // ─── Project lifecycle ────────────────────────────────────────────────────

  /**
   * Create a new project within the tenant.
   * Uses the platform admin API (Runtime route).
   */
  async createProject(
    name: string,
    kind: 'application' | 'module' = 'application',
  ): Promise<{ projectId: string }> {
    const slug = uniqueSlug(name.toLowerCase().replace(/\s+/g, '-'));
    const result = await requestJson<{ success: boolean; project: { _id: string } }>(
      this.harness,
      `/api/platform/admin/tenants/${this.tenantId}/projects`,
      {
        method: 'POST',
        headers: authHeaders(this.authToken),
        body: { name, slug },
      },
    );

    if (result.status !== 201) {
      throw new Error(`Failed to create project "${name}": ${JSON.stringify(result.body)}`);
    }

    const projectId = result.body.project._id;

    // If kind=module, update the project via DB (Studio-only operation)
    if (kind === 'module') {
      await Project.findOneAndUpdate(
        { _id: projectId, tenantId: this.tenantId },
        { $set: { kind: 'module', moduleVisibility: 'tenant' } },
      );
    }

    return { projectId };
  }

  /**
   * Enable module mode on an existing project.
   * This is a Studio-only operation — seeded via direct DB update.
   */
  async enableModuleMode(
    projectId: string,
    visibility: 'tenant' | 'private' = 'tenant',
  ): Promise<void> {
    const updated = await Project.findOneAndUpdate(
      { _id: projectId, tenantId: this.tenantId },
      { $set: { kind: 'module', moduleVisibility: visibility } },
      { new: true },
    );

    if (!updated) {
      throw new Error(`Project ${projectId} not found for tenant ${this.tenantId}`);
    }
  }

  /**
   * Create an agent in a project via the project-io import route.
   */
  async createAgent(projectId: string, name: string, dslContent: string): Promise<void> {
    const { ProjectAgent } = await import('@agent-platform/database/models');
    const existingAgents = await ProjectAgent.find({
      projectId,
      tenantId: this.tenantId,
    }).lean();

    const files: Record<string, string> = {
      [`agents/${name}.agent.abl`]: dslContent,
    };
    for (const agent of existingAgents) {
      if (agent.name === name) {
        continue;
      }
      if (agent.dslContent) {
        files[`agents/${agent.name}.agent.abl`] = agent.dslContent;
      }
    }

    await importProjectFiles(this.harness, this.authToken, projectId, files);
  }

  /**
   * Create multiple agents in a project via a single project-io import call.
   * This avoids the diff-based deletion that occurs when importing agents
   * one at a time (each single-agent import deletes agents not in the payload).
   */
  async createAgents(
    projectId: string,
    agents: Array<{ name: string; dslContent: string }>,
  ): Promise<void> {
    const files: Record<string, string> = {};
    for (const agent of agents) {
      files[`agents/${agent.name}.agent.abl`] = agent.dslContent;
    }
    await importProjectFiles(this.harness, this.authToken, projectId, files);
  }

  /**
   * Create a tool in a project via the project-io import route.
   */
  async createTool(
    projectId: string,
    name: string,
    dslContent: string,
    _toolType: string,
  ): Promise<void> {
    // The import endpoint requires at least one agent file in the payload.
    // Fetch existing agents from the project and include them alongside the
    // new tool file so the folder validation passes.
    const { ProjectAgent } = await import('@agent-platform/database/models');
    const existingAgents = await ProjectAgent.find({
      projectId,
      tenantId: this.tenantId,
    }).lean();

    const files: Record<string, string> = {
      [`tools/${name}.tools.abl`]: dslContent,
    };
    for (const agent of existingAgents) {
      if (agent.dslContent) {
        files[`agents/${agent.name}.agent.abl`] = agent.dslContent;
      }
    }

    await importProjectFiles(this.harness, this.authToken, projectId, files);
  }

  /**
   * Set the entry agent name on a project.
   * This is typically a Studio/project-settings operation — seeded via DB.
   */
  async setEntryAgent(projectId: string, entryAgentName: string): Promise<void> {
    const updated = await Project.findOneAndUpdate(
      { _id: projectId, tenantId: this.tenantId },
      { $set: { entryAgentName } },
      { new: true },
    );

    if (!updated) {
      throw new Error(`Project ${projectId} not found for tenant ${this.tenantId}`);
    }
  }

  // ─── Module release lifecycle ─────────────────────────────────────────────

  /**
   * Publish a module release.
   *
   * This is a Studio-only operation. In E2E bootstrap we still seed the
   * release directly, but we now use the real module release builder so
   * artifact materialization, contract extraction, and safety validation
   * match the production publish path.
   */
  async publishRelease(
    projectId: string,
    version: string,
    opts?: PublishReleaseOpts,
  ): Promise<{ releaseId: string; version: string }> {
    // Fetch agents and tools from the project
    const { ProjectAgent, ProjectTool } = await import('@agent-platform/database/models');

    const agents = await ProjectAgent.find({
      projectId,
      tenantId: this.tenantId,
    }).lean();

    const tools = await ProjectTool.find({
      projectId,
      tenantId: this.tenantId,
    }).lean();

    const project = await Project.findOne({
      _id: projectId,
      tenantId: this.tenantId,
    }).lean();

    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    const entryAgentName = (project as Record<string, unknown>).entryAgentName as string | null;
    const compileFn: CompileFn = (dsl: string) => {
      const parseResult = parseAgentBasedABL(dsl);
      if (!parseResult.document) {
        return null;
      }

      const output = compileABLtoIR([parseResult.document]);
      if ((output.compilation_errors?.length ?? 0) > 0) {
        return null;
      }

      const agentEntries = Object.entries(output.agents ?? {});
      if (agentEntries.length === 0) {
        return null;
      }

      return agentEntries[0][1] as unknown as Record<string, unknown>;
    };

    const buildResult = buildModuleRelease(
      {
        entryAgentName:
          entryAgentName ?? ((agents[0] as Record<string, unknown>)?.name as string) ?? null,
        agents: Object.fromEntries(
          agents.map((agent) => {
            const record = agent as Record<string, unknown>;
            return [record.name as string, ((record.dslContent as string) ?? '').trim()];
          }),
        ),
        tools: Object.fromEntries(
          tools.map((tool) => {
            const record = tool as Record<string, unknown>;
            return [
              record.name as string,
              {
                dslContent: ((record.dslContent as string) ?? '').trim(),
                toolType: ((record.toolType as ProjectToolType) ?? 'http') as ProjectToolType,
              },
            ];
          }),
        ),
        dslFormat: 'legacy',
        hasModelConfigs: false,
      },
      compileFn,
      extractModuleContract,
      validatePublishSafety,
    );

    if (!buildResult.success) {
      throw new Error(`Failed to build module release: ${buildResult.errors.join('; ')}`);
    }

    const contract: ModuleReleaseContract = {
      ...buildResult.contract,
      ...opts?.contractOverrides,
    };

    // Create the release document
    const release = await ModuleRelease.create({
      tenantId: this.tenantId,
      moduleProjectId: projectId,
      version,
      releaseNotes: opts?.releaseNotes ?? null,
      artifact: buildResult.artifact,
      compiledIR: buildResult.compiledIR,
      contract,
      sourceHash: buildResult.sourceHash,
      createdBy: this.userId,
    });

    const releaseId = String(release._id);

    // If promoteToEnvironment specified, create/update the environment pointer
    if (opts?.promoteToEnvironment) {
      await ModuleEnvironmentPointer.findOneAndUpdate(
        {
          tenantId: this.tenantId,
          moduleProjectId: projectId,
          environment: opts.promoteToEnvironment,
        },
        {
          tenantId: this.tenantId,
          moduleProjectId: projectId,
          environment: opts.promoteToEnvironment,
          moduleReleaseId: releaseId,
          updatedBy: this.userId,
          $inc: { revision: 1 },
        },
        { upsert: true, new: true },
      );
    }

    return { releaseId, version };
  }

  // ─── Module dependency wiring ─────────────────────────────────────────────

  /**
   * Import a module into a consumer project.
   *
   * This is a Studio-only operation. Seeded via ProjectModuleDependency model.
   * Resolves the release based on the selector and creates the dependency record.
   */
  async importModule(
    consumerProjectId: string,
    moduleProjectId: string,
    alias: string,
    selector: ImportModuleOpts['selector'],
    configOverrides?: Record<string, string>,
  ): Promise<{ dependencyId: string }> {
    // Resolve the release based on selector
    let resolvedRelease;

    if (selector.type === 'version') {
      resolvedRelease = await ModuleRelease.findOne({
        tenantId: this.tenantId,
        moduleProjectId,
        version: selector.value,
      }).lean();

      if (!resolvedRelease) {
        throw new Error(
          `Module release version ${selector.value} not found for project ${moduleProjectId}`,
        );
      }
    } else {
      // Environment selector — look up the pointer
      const pointer = await ModuleEnvironmentPointer.findOne({
        tenantId: this.tenantId,
        moduleProjectId,
        environment: selector.value,
      }).lean();

      if (!pointer) {
        throw new Error(
          `No environment pointer for ${selector.value} on module ${moduleProjectId}`,
        );
      }

      const pointerId = (pointer as Record<string, unknown>).moduleReleaseId as string;
      resolvedRelease = await ModuleRelease.findOne({
        _id: pointerId,
        tenantId: this.tenantId,
      }).lean();

      if (!resolvedRelease) {
        throw new Error(`Module release ${pointerId} not found`);
      }
    }

    const rel = resolvedRelease as Record<string, unknown>;

    // Fetch module project name
    const moduleProject = await Project.findOne({
      _id: moduleProjectId,
      tenantId: this.tenantId,
    }).lean();
    const moduleProjectName =
      ((moduleProject as Record<string, unknown> | null)?.name as string) ?? 'unknown-module';

    // Create the dependency
    const dependency = await ProjectModuleDependency.create({
      tenantId: this.tenantId,
      projectId: consumerProjectId,
      moduleProjectId,
      moduleProjectName,
      alias,
      selector,
      resolvedReleaseId: String(rel._id),
      resolvedVersion: rel.version as string,
      configOverrides: configOverrides ?? {},
      contractSnapshot: rel.contract,
      createdBy: this.userId,
    });

    return { dependencyId: String(dependency._id) };
  }

  // ─── Module upgrade ──────────────────────────────────────────────────────

  /**
   * Upgrade (or downgrade) a module dependency to a different release version.
   *
   * This is a Studio-only operation. Updates the dependency record via Mongoose
   * to point to the target release, refreshing the resolved version, selector,
   * contract snapshot, and optional config overrides.
   */
  async upgradeModule(
    consumerProjectId: string,
    dependencyId: string,
    targetReleaseId: string,
    configOverrides?: Record<string, string>,
  ): Promise<{ status: number; body: unknown }> {
    // Fetch the target release
    const targetRelease = await ModuleRelease.findOne({
      _id: targetReleaseId,
      tenantId: this.tenantId,
    }).lean();

    if (!targetRelease) {
      return {
        status: 404,
        body: { success: false, error: `Release ${targetReleaseId} not found` },
      };
    }

    const rel = targetRelease as Record<string, unknown>;
    const targetVersion = rel.version as string;
    const contract = rel.contract as Record<string, unknown>;

    // Build the update payload
    const updateFields: Record<string, unknown> = {
      resolvedReleaseId: targetReleaseId,
      resolvedVersion: targetVersion,
      selector: { type: 'version', value: targetVersion },
      contractSnapshot: contract,
    };

    if (configOverrides !== undefined) {
      updateFields.configOverrides = configOverrides;
    }

    const updated = await ProjectModuleDependency.findOneAndUpdate(
      {
        _id: dependencyId,
        tenantId: this.tenantId,
        projectId: consumerProjectId,
      },
      { $set: updateFields },
      { new: true },
    );

    if (!updated) {
      return {
        status: 404,
        body: {
          success: false,
          error: `Dependency ${dependencyId} not found in project ${consumerProjectId}`,
        },
      };
    }

    return {
      status: 200,
      body: {
        success: true,
        dependency: {
          id: String(updated._id),
          resolvedVersion: targetVersion,
          resolvedReleaseId: targetReleaseId,
        },
      },
    };
  }

  // ─── Deployment ───────────────────────────────────────────────────────────

  /**
   * Deploy a project via the Runtime deployment API.
   * Auto-versions all agents and deploys to the 'dev' environment.
   */
  async deploy(
    projectId: string,
    opts?: {
      environment?: string;
      entryAgentName?: string;
    },
  ): Promise<{ deploymentId: string }> {
    // List agents to build the version manifest
    const agentsResult = await requestJson<{
      success: boolean;
      agents: Array<{ name: string }>;
    }>(this.harness, `/api/projects/${projectId}/agents`, {
      method: 'GET',
      headers: authHeaders(this.authToken),
    });

    if (agentsResult.status !== 200 || !agentsResult.body.success) {
      throw new Error(
        `Failed to list agents for project ${projectId}: ${JSON.stringify(agentsResult.body)}`,
      );
    }

    const agents = agentsResult.body.agents;
    if (agents.length === 0) {
      throw new Error(`Project ${projectId} has no agents to deploy`);
    }

    const entryAgentName = opts?.entryAgentName ?? agents[0].name;
    const agentVersionManifest: Record<string, string> = {};
    for (const agent of agents) {
      agentVersionManifest[agent.name] = 'auto';
    }

    const result = await requestJson<{
      success: boolean;
      deployment: { id: string };
    }>(this.harness, `/api/projects/${projectId}/deployments`, {
      method: 'POST',
      headers: authHeaders(this.authToken),
      body: {
        environment: opts?.environment ?? 'dev',
        agentVersionManifest,
        entryAgentName,
        label: 'E2E test deployment',
        force: true,
      },
    });

    if (result.status !== 201) {
      throw new Error(`Failed to deploy project ${projectId}: ${JSON.stringify(result.body)}`);
    }

    return { deploymentId: result.body.deployment.id };
  }

  // ─── Session execution ────────────────────────────────────────────────────

  /**
   * Start a chat session with a project via the SDK flow.
   * Creates an SDK public key, initializes the session, and sends a message.
   */
  async startSession(
    projectId: string,
    message: string,
  ): Promise<{ sessionId: string; response: unknown }> {
    const publicKey = await createSdkPublicKey(this.harness, this.authToken, projectId, {
      name: `E2E Module Key ${Date.now()}`,
    });
    await createSdkBootstrapChannel(this.harness, this.authToken, projectId, publicKey.id);

    const sdkSession = await initSdkSession(this.harness, {
      publicKey: publicKey.key!,
      userContext: { userId: `e2e-user-${Date.now()}` },
    });

    const result = await requestJson<{ sessionId: string; response: string }>(
      this.harness,
      '/api/v1/chat/agent',
      {
        method: 'POST',
        headers: { 'X-SDK-Token': sdkSession.token },
        body: {
          projectId,
          message,
        },
      },
    );

    return {
      sessionId: result.body.sessionId ?? '',
      response: result.body,
    };
  }

  // ─── Provision helpers ────────────────────────────────────────────────────

  /**
   * Provision a mock LLM model for the tenant.
   * Required before any chat/deploy that needs model resolution.
   */
  async provisionMockModel(mockLlmUrl: string, credentialName?: string): Promise<void> {
    const cred = credentialName ?? `mock-module-model-${Date.now()}`;
    await provisionTenantModel(this.harness, this.authToken, {
      targetTenantId: this.tenantId,
      displayName: `Mock Module Model ${cred}`,
      integrationType: 'api',
      provider: 'openai_compatible',
      modelId: 'mock-model',
      endpointUrl: mockLlmUrl,
      supportsStreaming: false,
      supportsTools: true,
      capabilities: ['text', 'tools'],
      tier: 'balanced',
      isDefault: true,
      connection: { credentialName: cred, apiKey: 'test-api-key' },
    });
  }

  /**
   * Reset runtime state (sessions, provider cache) between tests.
   */
  async reset(): Promise<void> {
    await setSuperAdmins([this.userId]);
    await this.harness.resetRuntimeState();
  }
}
