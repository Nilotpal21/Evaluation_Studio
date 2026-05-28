/**
 * Test Sandbox Manager
 *
 * Creates and destroys an isolated tenant workspace for E2E smoke testing.
 * Uses Mongoose models directly for tenant creation (no public tenant CRUD API)
 * and HTTP calls for user/project/agent/session creation.
 *
 * Prerequisite: ENABLE_DEV_LOGIN=true must be set for the Studio server.
 */

import {
  Tenant,
  TenantMember,
  User,
  Session,
  ProjectAgent,
  Project,
  Subscription,
  Deal,
  ensureConnected,
} from '@agent-platform/database/models';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface SandboxConfig {
  studioUrl: string; // default: http://localhost:5173
  runtimeUrl: string; // default: http://localhost:3112
  adminToken: string; // platform admin JWT
  mockLlmUrl?: string; // When provided, creates credential + model + connection pointing here
  realLlm?: boolean; // When true, uses real API key from env
}

export interface Sandbox {
  tenantId: string;
  projectId: string;
  agentId: string;
  sessionId: string;
  authToken: string; // tenant-scoped JWT
  email: string; // dev-login email for token refresh
  cleanup: () => Promise<void>;
  tenantCredentialId?: string;
  tenantModelId?: string;
  tenantModelConnectionId?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const SANDBOX_SLUG_PREFIX = 'e2e-smoke-';
const SANDBOX_EMAIL_DOMAIN = 'e2e-smoke.test';
const MINIMAL_DSL = `AGENT: e2e_smoke_agent

GOAL: "Respond to test messages"
`;

// ─── Helpers ────────────────────────────────────────────────────────────────

async function httpJson<T>(
  url: string,
  options: {
    method: string;
    body?: unknown;
    token?: string;
  },
): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }

  const response = await fetch(url, {
    method: options.method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data = (await response.json().catch(() => null)) as T;
  return { status: response.status, data };
}

function assertOk(
  context: string,
  status: number,
  data: unknown,
  ...expectedStatuses: number[]
): void {
  const acceptable = expectedStatuses.length > 0 ? expectedStatuses : [200, 201];
  if (!acceptable.includes(status)) {
    throw new Error(`[Sandbox] ${context} failed with status ${status}: ${JSON.stringify(data)}`);
  }
}

// ─── Sandbox Creation ───────────────────────────────────────────────────────

export async function createSandbox(config: Partial<SandboxConfig> = {}): Promise<Sandbox> {
  const studioUrl = config.studioUrl ?? 'http://localhost:5173';
  const runtimeUrl = config.runtimeUrl ?? 'http://localhost:3112';
  const adminToken = config.adminToken ?? process.env.ADMIN_TOKEN ?? '';

  const timestamp = Date.now();
  const slug = `${SANDBOX_SLUG_PREFIX}${timestamp}`;
  const email = `smoke-${timestamp}@${SANDBOX_EMAIL_DOMAIN}`;

  // Ensure Mongoose is connected before direct DB operations
  await ensureConnected();

  // ── Step 1: Create tenant directly via MongoDB ────────────────────────

  // We need a temporary ownerId for the tenant; we'll create the user next
  // and then update the tenant. Use a placeholder first.
  const placeholderOwnerId = `e2e-placeholder-${timestamp}`;

  const tenantDoc = await Tenant.create({
    name: `E2E Smoke ${timestamp}`,
    slug,
    ownerId: placeholderOwnerId,
    status: 'active',
    retentionDays: 1,
    settings: { enableAuditLogging: false },
  });
  const tenantId: string = String(tenantDoc._id);

  let userId: string | undefined;
  let authToken: string | undefined;
  let projectId: string | undefined;
  let agentId: string | undefined;
  let sessionId: string | undefined;
  let tenantCredentialId: string | undefined;
  let tenantModelId: string | undefined;
  let tenantModelConnectionId: string | undefined;

  try {
    // ── Step 2: Create user + get auth token via dev-login ────────────

    const loginRes = await httpJson<{
      user: { id: string; email: string; name: string | null };
      accessToken: string;
    }>(`${studioUrl}/api/auth/dev-login`, {
      method: 'POST',
      body: { email, name: `E2E Smoke User ${timestamp}` },
    });
    assertOk('Dev login', loginRes.status, loginRes.data, 200);
    userId = loginRes.data.user.id;
    authToken = loginRes.data.accessToken;

    // Update tenant with real ownerId
    const updatedTenant = await Tenant.findOneAndUpdate({ _id: tenantId }, { ownerId: userId });
    if (!updatedTenant) {
      throw new Error(`[Sandbox] Failed to update tenant ${tenantId} with real ownerId`);
    }

    // Create tenant membership so the user has access to this tenant.
    // dev-login may have auto-assigned the user to a different tenant,
    // so we ensure membership exists for OUR sandbox tenant.
    try {
      await TenantMember.create({
        tenantId,
        userId,
        role: 'OWNER',
      });
    } catch (err: unknown) {
      // Ignore duplicate key (code 11000) — membership already exists.
      // Re-throw everything else (including errors without a `code` field).
      const isDuplicate =
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: number }).code === 11000;
      if (!isDuplicate) {
        throw err;
      }
    }

    // Delete any non-sandbox tenant memberships so re-login resolves to OUR tenant.
    // findDefaultTenantMembership returns the oldest membership (sort createdAt:1),
    // and dev-login may have auto-assigned the user to an existing tenant first.
    await TenantMember.deleteMany({ userId, tenantId: { $ne: tenantId } });

    // Re-login so the token now includes our sandbox tenant context
    const reLoginRes = await httpJson<{
      user: { id: string };
      accessToken: string;
    }>(`${studioUrl}/api/auth/dev-login`, {
      method: 'POST',
      body: { email },
    });
    assertOk('Re-login for tenant context', reLoginRes.status, reLoginRes.data, 200);
    authToken = reLoginRes.data.accessToken;

    // Verify JWT is scoped to our sandbox tenant
    const jwtPayload = JSON.parse(Buffer.from(authToken.split('.')[1], 'base64url').toString());
    if (jwtPayload.tenantId !== tenantId) {
      throw new Error(
        `[Sandbox] Token tenant mismatch: JWT has ${jwtPayload.tenantId}, expected ${tenantId}. ` +
          `This means findDefaultTenantMembership returned the wrong membership.`,
      );
    }

    // ── Step 2b: Seed ENTERPRISE subscription + deal ────────────────────
    // This unlocks all feature-gated routes (KMS, voice, SSO, etc.)

    const seedNow = new Date();
    const oneYearFromNow = new Date(seedNow.getTime() + 365 * 24 * 60 * 60 * 1000);

    await Subscription.create({
      tenantId,
      organizationId: tenantId,
      planTier: 'ENTERPRISE',
      billingCycle: 'annual',
      billingStartDate: seedNow,
      billingEndDate: oneYearFromNow,
      status: 'active',
      entitlements: [
        'advanced_analytics',
        'guardrails',
        'connectors',
        'custom_models',
        'audit_export',
        'sso',
        'kms_byok',
        'voice_channels',
      ],
    });

    await Deal.create({
      organizationId: tenantId,
      name: `E2E Smoke Deal ${timestamp}`,
      status: 'active',
      scope: 'organization',
      aggregationMode: 'additive',
      overagePolicy: 'soft_cap',
      overageAlertThresholds: [80, 90],
      creditAllotment: {
        totalCredits: 1_000_000,
        sharedPoolCredits: 1_000_000,
        featureCredits: {},
        rolloverPolicy: 'none',
      },
      features: [
        'advanced_analytics',
        'guardrails',
        'connectors',
        'custom_models',
        'audit_export',
        'sso',
        'kms_byok',
        'voice_channels',
      ],
      phases: [
        {
          name: 'E2E Phase',
          startDate: seedNow,
          endDate: oneYearFromNow,
          environments: {
            dev: {
              maxConcurrentSessions: 100,
              maxTokensPerMinute: 100000,
              maxRequestsPerMinute: 1000,
              maxStorageGB: 10,
            },
            staging: {
              maxConcurrentSessions: 100,
              maxTokensPerMinute: 100000,
              maxRequestsPerMinute: 1000,
              maxStorageGB: 10,
            },
            production: {
              maxConcurrentSessions: 100,
              maxTokensPerMinute: 100000,
              maxRequestsPerMinute: 1000,
              maxStorageGB: 10,
            },
          },
        },
      ],
    });

    // ── Step 3: Create project via Studio API ───────────────────────────

    const projectSlug = `e2e-proj-${timestamp}`;
    // POST /api/projects → { success: true, project: { id, name, slug, ... } }
    const projectRes = await httpJson<{
      success: boolean;
      project: { id: string; name: string; slug: string };
    }>(`${studioUrl}/api/projects`, {
      method: 'POST',
      body: { name: `E2E Project ${timestamp}`, slug: projectSlug },
      token: authToken,
    });
    assertOk('Create project', projectRes.status, projectRes.data, 200, 201);
    projectId = projectRes.data.project?.id;
    if (!projectId) {
      throw new Error(
        `[Sandbox] Create project returned no id: ${JSON.stringify(projectRes.data)}`,
      );
    }

    // ── Step 4: Create minimal agent ────────────────────────────────────

    // POST /api/projects/:id/agents → flat { id, name, ... }
    const agentRes = await httpJson<{ id?: string; _id?: string; name?: string }>(
      `${studioUrl}/api/projects/${projectId}/agents`,
      {
        method: 'POST',
        body: {
          name: 'e2e_smoke_agent',
          agentPath: `agents/e2e_smoke_agent`,
          description: 'E2E smoke test agent',
        },
        token: authToken,
      },
    );
    assertOk('Create agent', agentRes.status, agentRes.data, 200, 201);
    agentId = agentRes.data.id ?? agentRes.data._id;
    if (!agentId) {
      throw new Error(`[Sandbox] Create agent returned no id: ${JSON.stringify(agentRes.data)}`);
    }

    // Save DSL content via Studio API (uses JWT tenant context, avoids tenant mismatch)
    const dslRes = await httpJson(
      `${studioUrl}/api/projects/${projectId}/agents/e2e_smoke_agent/dsl`,
      {
        method: 'PUT',
        body: { dslContent: MINIMAL_DSL },
        token: authToken,
      },
    );
    assertOk('Save agent DSL', dslRes.status, dslRes.data, 200);

    // Set entry agent so runtime knows which agent to route to
    await httpJson(`${studioUrl}/api/projects/${projectId}`, {
      method: 'PATCH',
      body: { entryAgentName: 'e2e_smoke_agent' },
      token: authToken,
    });

    // ── Step 5: Create session directly via MongoDB ─────────────────────
    // No public "create session" API exists in Studio; runtime creates
    // sessions via chat. For test infrastructure, direct DB is acceptable.

    const now = new Date();
    const sessionDoc = await Session.create({
      tenantId,
      projectId,
      currentAgent: 'e2e_smoke_agent',
      environment: 'dev',
      channel: 'api',
      status: 'active',
      isTest: true,
      tags: ['e2e-smoke'],
      startedAt: now,
      lastActivityAt: now,
      messageCount: 0,
      tokenCount: 0,
      estimatedCost: 0,
      errorCount: 0,
      handoffCount: 0,
      traceEventCount: 0,
    });
    sessionId = String(sessionDoc._id);

    // ── Step 6: Create LLM infrastructure (optional) ────────────────────
    if (config.mockLlmUrl || config.realLlm) {
      // 6a. Create tenant credential
      const apiKey = config.realLlm
        ? (process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? '')
        : 'sk-mock-e2e-functional';

      if (!apiKey) {
        throw new Error(
          '[Sandbox] --real-llm requires OPENAI_API_KEY or ANTHROPIC_API_KEY env var',
        );
      }

      const provider = config.realLlm
        ? process.env.OPENAI_API_KEY
          ? 'openai'
          : 'anthropic'
        : 'openai';

      // POST /api/tenant-credentials → flat { id, name, provider, ... }
      // The runtime reads credential.endpoint (not TenantModel.endpointUrl) for baseURL,
      // so the mock LLM URL must be on the credential, not just the model.
      const credBody: Record<string, unknown> = {
        name: `e2e-functional-${timestamp}`,
        provider,
        apiKey,
        authType: 'api_key',
      };
      if (config.mockLlmUrl) {
        credBody.endpoint = config.mockLlmUrl;
      }
      const credRes = await httpJson<{ id?: string; name?: string; provider?: string }>(
        `${studioUrl}/api/tenant-credentials`,
        {
          method: 'POST',
          body: credBody,
          token: authToken,
        },
      );
      assertOk('Create tenant credential', credRes.status, credRes.data, 200, 201);
      tenantCredentialId = credRes.data.id;
      if (!tenantCredentialId) {
        throw new Error(
          `[Sandbox] Create tenant credential returned no id: ${JSON.stringify(credRes.data)}`,
        );
      }

      // 6b. Create tenant model
      const modelBody: Record<string, unknown> = {
        displayName: `e2e-model-${timestamp}`,
        modelId: provider === 'openai' ? 'gpt-4o-mini' : 'claude-sonnet-4-6',
        provider,
        isDefault: true,
        tier: 'balanced',
      };
      if (config.mockLlmUrl) {
        modelBody.endpointUrl = config.mockLlmUrl;
        // Force Chat Completions API — mock LLM only implements /v1/chat/completions,
        // not the newer /v1/responses endpoint that gpt-4o-mini auto-selects.
        modelBody.useResponsesApi = false;
      }

      // POST /api/tenant-models → proxied to runtime → { success: true, model: { id, ... } }
      const modelRes = await httpJson<{ success?: boolean; model?: { id?: string } }>(
        `${studioUrl}/api/tenant-models`,
        {
          method: 'POST',
          body: modelBody,
          token: authToken,
        },
      );
      assertOk('Create tenant model', modelRes.status, modelRes.data, 200, 201);
      tenantModelId = modelRes.data.model?.id;
      if (!tenantModelId) {
        throw new Error(
          `[Sandbox] Create tenant model returned no id: ${JSON.stringify(modelRes.data)}`,
        );
      }

      // 6c. Create tenant model connection
      // POST /api/tenant-models/:id/connections → proxied to runtime → { success: true, connection: { id, ... } }
      const connRes = await httpJson<{
        success?: boolean;
        connection?: { id?: string };
      }>(`${studioUrl}/api/tenant-models/${tenantModelId}/connections`, {
        method: 'POST',
        body: {
          credentialId: tenantCredentialId,
          isPrimary: true,
          isActive: true,
          connectionType: 'http',
        },
        token: authToken,
      });
      assertOk('Create tenant model connection', connRes.status, connRes.data, 200, 201);
      tenantModelConnectionId = connRes.data.connection?.id;
    }

    // ── Build cleanup function ──────────────────────────────────────────

    const cleanup = buildCleanup({
      studioUrl,
      runtimeUrl,
      authToken: authToken!,
      tenantId,
      projectId: projectId!,
      agentId: agentId!,
      sessionId: sessionId!,
      userId: userId!,
      email,
      tenantCredentialId,
      tenantModelId,
      tenantModelConnectionId,
    });

    return {
      tenantId,
      projectId: projectId!,
      agentId: agentId!,
      sessionId: sessionId!,
      authToken: authToken!,
      email,
      cleanup,
      tenantCredentialId,
      tenantModelId,
      tenantModelConnectionId,
    };
  } catch (error) {
    // If setup fails partway through, clean up whatever was created
    await cleanupPartial({
      tenantId,
      projectId,
      agentId,
      sessionId,
      userId,
      email,
      tenantCredentialId,
      tenantModelId,
      tenantModelConnectionId,
      studioUrl,
      authToken,
    });
    throw error;
  }
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

interface CleanupContext {
  studioUrl: string;
  runtimeUrl: string;
  authToken: string;
  tenantId: string;
  projectId: string;
  agentId: string;
  sessionId: string;
  userId: string;
  email: string;
  tenantCredentialId?: string;
  tenantModelId?: string;
  tenantModelConnectionId?: string;
}

function buildCleanup(ctx: CleanupContext): () => Promise<void> {
  return async () => {
    await ensureConnected();

    // Delete in reverse dependency order: LLM infra -> session -> agent -> project -> tenant member -> tenant -> user

    // 0a. Delete tenant model connection
    if (ctx.tenantModelConnectionId && ctx.tenantModelId) {
      try {
        await httpJson(
          `${ctx.studioUrl}/api/tenant-models/${ctx.tenantModelId}/connections/${ctx.tenantModelConnectionId}`,
          { method: 'DELETE', token: ctx.authToken },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Sandbox Cleanup] Failed to delete tenant model connection: ${msg}`);
      }
    }

    // 0b. Delete tenant model
    if (ctx.tenantModelId) {
      try {
        await httpJson(`${ctx.studioUrl}/api/tenant-models/${ctx.tenantModelId}`, {
          method: 'DELETE',
          token: ctx.authToken,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Sandbox Cleanup] Failed to delete tenant model: ${msg}`);
      }
    }

    // 0c. Delete tenant credential
    if (ctx.tenantCredentialId) {
      try {
        await httpJson(`${ctx.studioUrl}/api/tenant-credentials/${ctx.tenantCredentialId}`, {
          method: 'DELETE',
          token: ctx.authToken,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Sandbox Cleanup] Failed to delete tenant credential: ${msg}`);
      }
    }

    // 1. Delete session
    try {
      await Session.deleteOne({ _id: ctx.sessionId, tenantId: ctx.tenantId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Sandbox Cleanup] Failed to delete session: ${msg}`);
    }

    // 2. Delete agent
    try {
      await ProjectAgent.deleteOne({ _id: ctx.agentId, tenantId: ctx.tenantId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Sandbox Cleanup] Failed to delete agent: ${msg}`);
    }

    // 3. Delete project
    try {
      await Project.deleteOne({ _id: ctx.projectId, tenantId: ctx.tenantId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Sandbox Cleanup] Failed to delete project: ${msg}`);
    }

    // 4. Delete subscription + deal
    try {
      await Subscription.deleteMany({ tenantId: ctx.tenantId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Sandbox Cleanup] Failed to delete subscription: ${msg}`);
    }
    try {
      await Deal.deleteMany({ organizationId: ctx.tenantId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Sandbox Cleanup] Failed to delete deal: ${msg}`);
    }

    // 5. Delete tenant member
    try {
      await TenantMember.deleteMany({ tenantId: ctx.tenantId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Sandbox Cleanup] Failed to delete tenant members: ${msg}`);
    }

    // 6. Delete tenant
    try {
      await Tenant.deleteOne({ _id: ctx.tenantId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Sandbox Cleanup] Failed to delete tenant: ${msg}`);
    }

    // 7. Delete user — scope to sandbox email domain as safety guard
    try {
      await User.deleteOne({ _id: ctx.userId, email: /@e2e-smoke\.test$/ });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Sandbox Cleanup] Failed to delete user: ${msg}`);
    }

    // 7. Verify deletion — each GET should return null
    const verifyDeleted = async (
      label: string,
      model: { findOne(filter: Record<string, unknown>): { lean(): Promise<unknown> } },
      id: string,
    ) => {
      const doc = await model.findOne({ _id: id }).lean();
      if (doc) {
        console.warn(`[Sandbox Cleanup] ${label} ${id} still exists after deletion`);
      }
    };

    await verifyDeleted('Session', Session, ctx.sessionId);
    await verifyDeleted('Agent', ProjectAgent, ctx.agentId);
    await verifyDeleted('Project', Project, ctx.projectId);
    await verifyDeleted('Tenant', Tenant, ctx.tenantId);
  };
}

/**
 * Partial cleanup for when sandbox creation fails midway.
 * Best-effort — logs warnings instead of throwing.
 */
async function cleanupPartial(ctx: {
  tenantId: string;
  projectId?: string;
  agentId?: string;
  sessionId?: string;
  userId?: string;
  email?: string;
  tenantCredentialId?: string;
  tenantModelId?: string;
  tenantModelConnectionId?: string;
  studioUrl?: string;
  authToken?: string;
}): Promise<void> {
  await ensureConnected();

  // Delete LLM infrastructure via API (requires studioUrl + authToken)
  if (ctx.studioUrl && ctx.authToken) {
    if (ctx.tenantModelConnectionId && ctx.tenantModelId) {
      try {
        await httpJson(
          `${ctx.studioUrl}/api/tenant-models/${ctx.tenantModelId}/connections/${ctx.tenantModelConnectionId}`,
          { method: 'DELETE', token: ctx.authToken },
        );
      } catch {
        /* best effort */
      }
    }
    if (ctx.tenantModelId) {
      try {
        await httpJson(`${ctx.studioUrl}/api/tenant-models/${ctx.tenantModelId}`, {
          method: 'DELETE',
          token: ctx.authToken,
        });
      } catch {
        /* best effort */
      }
    }
    if (ctx.tenantCredentialId) {
      try {
        await httpJson(`${ctx.studioUrl}/api/tenant-credentials/${ctx.tenantCredentialId}`, {
          method: 'DELETE',
          token: ctx.authToken,
        });
      } catch {
        /* best effort */
      }
    }
  }

  if (ctx.sessionId) {
    try {
      await Session.deleteOne({ _id: ctx.sessionId, tenantId: ctx.tenantId });
    } catch {
      /* best effort */
    }
  }
  if (ctx.agentId) {
    try {
      await ProjectAgent.deleteOne({ _id: ctx.agentId, tenantId: ctx.tenantId });
    } catch {
      /* best effort */
    }
  }
  if (ctx.projectId) {
    try {
      await Project.deleteOne({ _id: ctx.projectId, tenantId: ctx.tenantId });
    } catch {
      /* best effort */
    }
  }
  try {
    await Subscription.deleteMany({ tenantId: ctx.tenantId });
  } catch {
    /* best effort */
  }
  try {
    await Deal.deleteMany({ organizationId: ctx.tenantId });
  } catch {
    /* best effort */
  }
  try {
    await TenantMember.deleteMany({ tenantId: ctx.tenantId });
  } catch {
    /* best effort */
  }
  try {
    await Tenant.deleteOne({ _id: ctx.tenantId });
  } catch {
    /* best effort */
  }
  if (ctx.userId) {
    try {
      await User.deleteOne({ _id: ctx.userId, email: /@e2e-smoke\.test$/ });
    } catch {
      /* best effort */
    }
  }
}

// ─── withSandbox ────────────────────────────────────────────────────────────

/**
 * Wraps a test function in sandbox setup/teardown with guaranteed cleanup.
 *
 * @example
 * await withSandbox({ studioUrl: 'http://localhost:5173' }, async (sandbox) => {
 *   // sandbox.tenantId, sandbox.projectId, etc. are available
 *   // cleanup happens automatically, even on error
 * });
 */
export async function withSandbox(
  config: Partial<SandboxConfig>,
  fn: (sandbox: Sandbox) => Promise<void>,
): Promise<void> {
  const sandbox = await createSandbox(config);
  try {
    await fn(sandbox);
  } finally {
    await sandbox.cleanup();
  }
}
