import { REQUEST_TIMEOUT_MS } from './constants.mjs';
import {
  buildStaticAgentDsl,
  createAgent,
  createProject,
  loginBrowserViaDevApi,
  waitForIdle,
  waitForStudioAgentChatReady,
} from './studio-chat.mjs';
import { sanitizeFileName, sanitizeIdentifier, uniqueSuffix } from './utils.mjs';

const DEFAULT_LOGIN_NAME = 'Studio Video Evidence';
const DEFAULT_ASSISTANT_REPLY =
  'Acknowledged. The Studio video evidence fixture is ready for capture.';

function readFirstString(...values) {
  for (const value of values) {
    if (value == null) continue;
    const normalized = String(value).trim();
    if (normalized.length > 0) {
      return normalized;
    }
  }
  return '';
}

function buildAbsoluteRoute(baseUrl, routePath) {
  return `${baseUrl}${routePath}`;
}

async function waitForSurfaceRoute(page, route) {
  const targetPathname = new URL(route).pathname;
  await page
    .waitForURL((url) => url.pathname === targetPathname, { timeout: REQUEST_TIMEOUT_MS })
    .catch(() => {});
}

async function waitForGenericStudioSurface({ page, route }) {
  await waitForSurfaceRoute(page, route);
  await waitForIdle(page, 1_000);
  await page.locator('main').first().waitFor({ state: 'visible', timeout: REQUEST_TIMEOUT_MS });
}

async function waitForAgentChatSurface({ page, route }) {
  await waitForSurfaceRoute(page, route);
  await page.waitForLoadState('load').catch(() => {});
  await page.waitForTimeout(1_000);
  await waitForStudioAgentChatReady(page);
}

export const STUDIO_SURFACES = [
  {
    id: 'projects-dashboard',
    title: 'Projects Dashboard',
    description: 'Studio projects landing page after login.',
    requiresProject: false,
    requiresAgent: false,
    buildPath: () => '/projects',
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'project-home',
    title: 'Project Home',
    description: 'Project workspace landing page for a Studio project.',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId }) => `/projects/${encodeURIComponent(projectId)}`,
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'agents-list',
    title: 'Agents List',
    description: 'Project-scoped agent list and overview surface.',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId }) => `/projects/${encodeURIComponent(projectId)}/agents`,
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'agent-editor',
    title: 'Agent Editor',
    description: 'Dedicated agent editor surface for an existing Studio agent.',
    requiresProject: true,
    requiresAgent: true,
    buildPath: ({ projectId, agentName }) =>
      `/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentName)}`,
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'agent-chat',
    title: 'Agent Chat',
    description: 'Agent chat surface with a ready-to-type session.',
    requiresProject: true,
    requiresAgent: true,
    buildPath: ({ projectId, agentName }) =>
      `/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentName)}/chat`,
    waitForReady: waitForAgentChatSurface,
  },
  // ---- P0 list surfaces (added for populated-state audit) ----
  {
    id: 'sessions',
    title: 'Sessions List',
    description: 'Project-scoped session list (Operate > Sessions).',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId }) => `/projects/${encodeURIComponent(projectId)}/sessions`,
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'deployments',
    title: 'Deployments',
    description: 'Deployment environments and channels (Operate > Deployments).',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId }) => `/projects/${encodeURIComponent(projectId)}/deployments`,
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'workflows',
    title: 'Workflows',
    description: 'Workflow list (Build > Workflows).',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId }) => `/projects/${encodeURIComponent(projectId)}/workflows`,
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'tools',
    title: 'Tools',
    description: 'Project tools list (Resources > Tools).',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId }) => `/projects/${encodeURIComponent(projectId)}/tools`,
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'search-ai',
    title: 'Knowledge Bases',
    description: 'Search AI knowledge bases list (Resources > Knowledge Bases).',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId }) => `/projects/${encodeURIComponent(projectId)}/search-ai`,
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'evals',
    title: 'Evaluations',
    description: 'Eval runs, personas, scenarios (Evaluate > Evals).',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId }) => `/projects/${encodeURIComponent(projectId)}/evals`,
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'inbox',
    title: 'Inbox',
    description: 'Workflow approvals inbox (Operate > Inbox).',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId }) => `/projects/${encodeURIComponent(projectId)}/inbox`,
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'connections',
    title: 'Integrations',
    description: 'External integrations and connections.',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId }) => `/projects/${encodeURIComponent(projectId)}/connections`,
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'templates',
    title: 'Templates',
    description: 'Rich content templates catalog.',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId }) => `/projects/${encodeURIComponent(projectId)}/templates`,
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'module-dependencies',
    title: 'Module Dependencies',
    description: 'Project module dependency graph.',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId }) => `/projects/${encodeURIComponent(projectId)}/module-dependencies`,
    waitForReady: waitForGenericStudioSurface,
  },
  // ---- Insights surfaces ----
  {
    id: 'insights-dashboard',
    title: 'Insights Dashboard',
    description: 'Executive KPI dashboard (Insights > Dashboard).',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId }) => `/projects/${encodeURIComponent(projectId)}/dashboard`,
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'insights-analytics',
    title: 'Analytics',
    description: 'Sessions, Traces, Generations explorers (Insights > Analytics).',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId }) => `/projects/${encodeURIComponent(projectId)}/analytics`,
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'insights-billing',
    title: 'Billing',
    description: 'Project billing units and usage (Insights > Billing).',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId }) => `/projects/${encodeURIComponent(projectId)}/billing`,
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'insights-agent-performance',
    title: 'Agent Performance',
    description: 'Per-agent diagnostics (Insights > Agent Performance).',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId }) => `/projects/${encodeURIComponent(projectId)}/agent-performance`,
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'insights-quality-monitor',
    title: 'Quality Monitor',
    description: 'Watchtower: flagged conversations (Insights > Quality Monitor).',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId }) => `/projects/${encodeURIComponent(projectId)}/quality-monitor`,
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'insights-customer-insights',
    title: 'Customer Insights',
    description: 'Intents, VoC, sentiment (Insights > Customer Insights).',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId }) => `/projects/${encodeURIComponent(projectId)}/customer-insights`,
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'insights-voice-analytics',
    title: 'Voice Analytics',
    description: 'Aggregated voice metrics and quality (Insights > Voice Analytics).',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId }) => `/projects/${encodeURIComponent(projectId)}/voice-analytics`,
    waitForReady: waitForGenericStudioSurface,
  },
  // ---- Settings surfaces ----
  {
    id: 'settings-members',
    title: 'Members',
    description: 'Project members and roles (Settings > Members).',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId }) => `/projects/${encodeURIComponent(projectId)}/settings/members`,
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'settings-api-keys',
    title: 'API Keys',
    description: 'Project API keys (Settings > API Keys).',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId }) => `/projects/${encodeURIComponent(projectId)}/settings/api-keys`,
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'settings-models',
    title: 'Models',
    description: 'Model configuration (Settings > Models).',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId }) => `/projects/${encodeURIComponent(projectId)}/settings/models`,
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'settings-runtime-config',
    title: 'Runtime Config',
    description: 'Runtime configuration (Settings > Runtime Config).',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId }) =>
      `/projects/${encodeURIComponent(projectId)}/settings/runtime-config`,
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'settings-config-vars',
    title: 'Config Variables',
    description: 'Project configuration variables (Settings > Config Variables).',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId }) => `/projects/${encodeURIComponent(projectId)}/settings/config-vars`,
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'settings-auth-profiles',
    title: 'Auth Profiles',
    description: 'OAuth and auth profiles (Settings > Auth Profiles).',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId }) =>
      `/projects/${encodeURIComponent(projectId)}/settings/auth-profiles`,
    waitForReady: waitForGenericStudioSurface,
  },
  // ---- Govern surfaces ----
  {
    id: 'guardrails-config',
    title: 'Guardrails',
    description: 'Guardrail policies configuration (Govern > Guardrails).',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId }) => `/projects/${encodeURIComponent(projectId)}/guardrails-config`,
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'governance',
    title: 'Governance',
    description: 'Agent registry, compliance (Govern > Governance).',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId }) => `/projects/${encodeURIComponent(projectId)}/governance`,
    waitForReady: waitForGenericStudioSurface,
  },
  // ---- Detail surfaces ----
  {
    id: 'session-detail',
    title: 'Session Detail',
    description: 'Full session detail with messages, traces, metadata.',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId, sessionId }) =>
      `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId || '8a376dd9-9299-4227-a094-12343100b2f0')}`,
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'agent-detail-overview',
    title: 'Agent Detail Overview',
    description: 'Agent detail page with overview, versions, metrics tabs.',
    requiresProject: true,
    requiresAgent: true,
    buildPath: ({ projectId, agentName }) =>
      `/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentName)}`,
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'tool-detail',
    title: 'Tool Detail',
    description: 'Tool editor with request/response panes.',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId, toolName }) =>
      `/projects/${encodeURIComponent(projectId)}/tools/${encodeURIComponent(toolName || 'validate_user_id')}`,
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'workflow-detail',
    title: 'Workflow Detail',
    description: 'Workflow canvas with nodes and execution detail.',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId, workflowId }) =>
      `/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId || '019db90b-0c98-7822-90bb-ecc35fdc3503')}`,
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'deployment-channel-detail',
    title: 'Deployment Channel Detail',
    description: 'Deployment detail with channel configuration.',
    requiresProject: true,
    requiresAgent: false,
    buildPath: ({ projectId, deploymentId }) =>
      `/projects/${encodeURIComponent(projectId)}/deployments`,
    waitForReady: waitForGenericStudioSurface,
  },
  // ---- Org-level surfaces ----
  {
    id: 'org-settings',
    title: 'Organization Settings',
    description: 'Organization-level settings page.',
    requiresProject: false,
    requiresAgent: false,
    buildPath: () => '/settings/organization',
    waitForReady: waitForGenericStudioSurface,
  },
  {
    id: 'org-members',
    title: 'Organization Members',
    description: 'Organization members admin page.',
    requiresProject: false,
    requiresAgent: false,
    buildPath: () => '/admin/members',
    waitForReady: waitForGenericStudioSurface,
  },
];

export function getStudioSurface(id) {
  const normalizedId = String(id ?? '').trim();
  return STUDIO_SURFACES.find((surface) => surface.id === normalizedId) ?? null;
}

function resolveSurfaceParams(context, surface, fixture = null, overrides = {}) {
  const projectId = readFirstString(
    overrides.projectId,
    fixture?.projectId,
    context.options.projectId,
  );
  const agentName = readFirstString(
    overrides.agentName,
    fixture?.agentName,
    context.options.agentName,
  );

  if (surface.requiresProject && projectId.length === 0) {
    throw new Error(`Studio surface "${surface.id}" requires a project id.`);
  }
  if (surface.requiresAgent && agentName.length === 0) {
    throw new Error(`Studio surface "${surface.id}" requires an agent name.`);
  }

  return {
    projectId: projectId || null,
    agentName: agentName || null,
  };
}

export async function openStudioSurface(context, surfaceInput, fixture = null, overrides = {}) {
  const surface =
    typeof surfaceInput === 'string' ? getStudioSurface(surfaceInput) : (surfaceInput ?? null);
  if (!surface) {
    throw new Error(`Unknown Studio surface "${String(surfaceInput)}".`);
  }

  const params = resolveSurfaceParams(context, surface, fixture, overrides);
  const routePath = surface.buildPath(params);
  const route = buildAbsoluteRoute(context.baseUrl, routePath);

  await context.page.goto(route, { waitUntil: 'domcontentloaded' });
  await surface.waitForReady({
    ...context,
    surface,
    fixture,
    params,
    route,
  });

  return {
    surface,
    route,
    routePath,
    params,
  };
}

export async function createStudioFixture(context, overrides = {}) {
  const suffix = uniqueSuffix();
  const requireProject = Boolean(overrides.requireProject);
  const requireAgent = Boolean(overrides.requireAgent);
  const explicitEmail = readFirstString(overrides.email, context.options.email);
  const emailPrefix = readFirstString(
    overrides.emailPrefix,
    context.options.emailPrefix,
    'studio-video-evidence',
  );
  const projectNamePrefix = readFirstString(
    overrides.projectNamePrefix,
    context.options.projectNamePrefix,
    'Studio Video Evidence',
  );
  const projectSlugPrefix = readFirstString(
    overrides.projectSlugPrefix,
    context.options.projectSlugPrefix,
    'studio-video-evidence',
  );
  const agentNamePrefix = sanitizeIdentifier(
    readFirstString(
      overrides.agentNamePrefix,
      context.options.agentNamePrefix,
      'studio-video-evidence-agent',
    ),
  );
  const assistantReply = readFirstString(
    overrides.assistantReply,
    context.options.assistantReply,
    DEFAULT_ASSISTANT_REPLY,
  );
  const agentDslContent = readFirstString(
    overrides.agentDslContent,
    context.options.agentDslContent,
  );
  const loginName = readFirstString(
    overrides.loginName,
    context.options.name,
    context.options.loginName,
    DEFAULT_LOGIN_NAME,
  );
  const email = explicitEmail || `${sanitizeFileName(emailPrefix)}-${suffix}@e2e-smoke.test`;
  const login = await context.helpers.devLogin(email, loginName);
  const accessToken = login.accessToken;

  let projectId = readFirstString(overrides.projectId, context.options.projectId) || null;
  let projectName = readFirstString(overrides.projectName, context.options.projectName) || null;
  let createdProject = false;

  if (!projectId && (requireProject || requireAgent)) {
    const project = await createProject(context.baseUrl, accessToken, {
      name: `${projectNamePrefix} ${suffix}`,
      slug: `${sanitizeFileName(projectSlugPrefix)}-${sanitizeFileName(suffix)}`,
    });
    projectId = project.id;
    projectName = project.name;
    createdProject = true;
  }

  let agentName = readFirstString(overrides.agentName, context.options.agentName) || null;
  let createdAgent = false;

  if (!agentName && requireAgent) {
    if (!projectId) {
      throw new Error('Cannot create a Studio fixture agent without a project id.');
    }

    agentName = sanitizeIdentifier(`${agentNamePrefix}_${suffix}`).slice(0, 64);
    await createAgent(context.baseUrl, accessToken, projectId, {
      name: agentName,
      description: 'Reusable Studio video evidence agent',
      dslContent: agentDslContent || buildStaticAgentDsl(agentName, assistantReply),
    });
    createdAgent = true;
  }

  const landingPath = projectId ? `/projects/${encodeURIComponent(projectId)}` : '/projects';
  await loginBrowserViaDevApi(context.page, context.baseUrl, {
    email,
    name: loginName,
    landingPath,
  });

  const targetLabel = projectId ? ` for project ${projectId}` : '';
  context.log?.(`Opened authenticated Studio session${targetLabel}`);

  return {
    accessToken,
    agentName,
    assistantReply,
    createdAgent,
    createdProject,
    email,
    loginName,
    projectId,
    projectName,
    suffix,
  };
}
