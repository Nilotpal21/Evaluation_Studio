#!/usr/bin/env tsx
/**
 * MongoDB seed entrypoint.
 *
 * Default behavior is platform-safe:
 *   - resource types
 *   - prompt template rows
 *   - pipeline definitions
 *   - ClickHouse schema / analytics tables when configured
 *
 * Dev-only fixtures are explicit via `--dev`.
 * Tenant-scoped operational defaults are explicit via `--tenant` or
 * `--workspace-email`.
 *
 * Usage:
 *   pnpm tsx packages/database/seed-mongo.ts
 *   pnpm tsx packages/database/seed-mongo.ts --fresh
 *   pnpm tsx packages/database/seed-mongo.ts --tenant tenant-123
 *   pnpm tsx packages/database/seed-mongo.ts --workspace-email owner@example.com
 *   pnpm tsx packages/database/seed-mongo.ts --dev
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import mongoose from 'mongoose';
import { User } from './src/models/user.model.js';
import { Tenant } from './src/models/tenant.model.js';
import { TenantMember } from './src/models/tenant-member.model.js';
import { ResourceType } from './src/models/resource-type.model.js';
import { DebugToken } from './src/models/debug-token.model.js';
import { seedExamples } from './seed-examples.js';
import { getPromptTemplateSeedEntries, seedPromptTemplates } from './seed-prompt-templates.js';
import { seedPipelines } from './seed-pipelines.js';
import {
  SeedRunner,
  type SeedTask,
  type SeedTaskStatus,
  type SeedValidationResult,
  type SeedValidationRunResult,
} from './src/seed/runner.js';
import {
  DEV_WORKSPACE_TASK_ID,
  E2E_WORKSPACE_TASK_ID,
  PLATFORM_CORE_TASK_ID,
  RBAC_ALIGNMENT_TASK_ID,
  SEED_TASK_CATALOG,
  TARGET_DEFAULTS_TASK_ID,
} from './src/seed/catalog.js';
import { upsertOne } from './src/seed/upsert-helpers.js';
import { SYSTEM_ROLES } from './src/constants/system-roles.js';
import { CURATED_EXAMPLE_PROJECTS } from './src/seed/example-projects.js';
import { seedTenantBootstrapDefaults } from './src/seed/tenant-bootstrap.js';
import { seedTenantPipelineConfigs } from '../pipeline-engine/src/pipeline/seed-defaults.js';
import { BUILTIN_DEFINITIONS } from '../pipeline-engine/src/pipeline/definitions/index.js';
import { isFacadeEncryptionAvailable } from './src/mongo/plugins/encryption.plugin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPaths = [
  path.resolve(__dirname, '../../apps/studio/.env'),
  path.resolve(__dirname, '../../apps/studio/.env.local'),
  path.resolve(__dirname, '../../apps/runtime/.env'),
  path.resolve(__dirname, '../../apps/runtime/.env.local'),
];

for (const envPath of envPaths) {
  if (!fs.existsSync(envPath)) continue;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed
      .slice(eqIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined && val) {
      process.env[key] = val;
    }
  }
}

const EXAMPLES_DIR = fs.existsSync(path.resolve(__dirname, '../../examples'))
  ? path.resolve(__dirname, '../../examples')
  : path.resolve(__dirname, './examples');

const RESOURCE_OPERATION_CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const RESOURCE_OPERATION_ID_NAMESPACE = 'abl-platform-resource-type';
const DEV_WORKSPACE_TENANT_ID = 'tenant-dev-001';
const DEV_WORKSPACE_OWNER_ID = 'user-dev-001';
const DEV_WORKSPACE_OWNER_EMAIL = 'dev@kore.ai';
const DEV_DEBUG_USER_ID = '019c5260-d8a4-7551-9207-8d28dcc50530';
const DEV_DEBUG_TOKEN_ID = 'debug-dev-001';
const E2E_WORKSPACE_TENANT_ID = 'tenant-e2e-001';
const E2E_WORKSPACE_OWNER_ID = 'user-e2e-owner-001';
const E2E_WORKSPACE_OWNER_EMAIL = 'e2e-owner@kore.ai';

const RESOURCE_TYPES: Array<{
  name: string;
  displayName: string;
  description: string;
  operations: Array<{ name: string; displayName: string; description?: string }>;
}> = [
  {
    name: 'tenant',
    displayName: 'Tenant',
    description: 'Workspace/tenant boundary',
    operations: [
      { name: 'read', displayName: 'Read', description: 'View tenant settings' },
      { name: 'update', displayName: 'Update', description: 'Modify tenant settings' },
      { name: 'delete', displayName: 'Delete', description: 'Delete entire tenant' },
      {
        name: 'manage_settings',
        displayName: 'Manage Settings',
        description: 'Configure tenant settings, feature flags',
      },
      {
        name: 'manage_members',
        displayName: 'Manage Members',
        description: 'Add/remove tenant members, change roles',
      },
    ],
  },
  {
    name: 'project',
    displayName: 'Project',
    description: 'Agent project container',
    operations: [
      { name: 'create', displayName: 'Create' },
      { name: 'read', displayName: 'Read' },
      { name: 'update', displayName: 'Update' },
      { name: 'delete', displayName: 'Delete' },
      { name: 'manage_members', displayName: 'Manage Members' },
    ],
  },
  {
    name: 'agent',
    displayName: 'Agent',
    description: 'AI agent within a project',
    operations: [
      { name: 'create', displayName: 'Create' },
      { name: 'read', displayName: 'Read' },
      { name: 'update', displayName: 'Update' },
      { name: 'delete', displayName: 'Delete' },
      { name: 'execute', displayName: 'Execute', description: 'Run agent in session' },
      { name: 'deploy', displayName: 'Deploy', description: 'Promote agent version' },
    ],
  },
  {
    name: 'tool',
    displayName: 'Tool',
    description: 'Service node / external tool integration (includes MCP servers)',
    operations: [
      { name: 'read', displayName: 'Read' },
      {
        name: 'write',
        displayName: 'Write',
        description: 'Create or update tools and MCP servers',
      },
      { name: 'delete', displayName: 'Delete' },
      { name: 'execute', displayName: 'Execute', description: 'Test or invoke a tool' },
    ],
  },
  {
    name: 'environment',
    displayName: 'Environment',
    description: 'Deployment environment (dev, staging, prod)',
    operations: [
      { name: 'read', displayName: 'Read' },
      { name: 'deploy', displayName: 'Deploy', description: 'Deploy to this environment' },
    ],
  },
  {
    name: 'knowledge_base',
    displayName: 'Knowledge Base',
    description: 'RAG knowledge source',
    operations: [
      { name: 'create', displayName: 'Create' },
      { name: 'read', displayName: 'Read' },
      { name: 'update', displayName: 'Update' },
      { name: 'delete', displayName: 'Delete' },
    ],
  },
  {
    name: 'workflow',
    displayName: 'Workflow',
    description: 'Workflow definition',
    operations: [
      { name: 'create', displayName: 'Create' },
      { name: 'read', displayName: 'Read' },
      { name: 'update', displayName: 'Update' },
      { name: 'delete', displayName: 'Delete' },
      { name: 'execute', displayName: 'Execute' },
    ],
  },
  {
    name: 'deployment',
    displayName: 'Deployment',
    description: 'Immutable deployment snapshot',
    operations: [
      { name: 'create', displayName: 'Create' },
      { name: 'read', displayName: 'Read' },
      { name: 'retire', displayName: 'Retire', description: 'Mark deployment as retired' },
    ],
  },
  {
    name: 'api_key',
    displayName: 'API Key',
    description: 'Server-to-server API key',
    operations: [
      { name: 'create', displayName: 'Create' },
      { name: 'read', displayName: 'Read' },
      { name: 'revoke', displayName: 'Revoke' },
    ],
  },
  {
    name: 'secret',
    displayName: 'Secret',
    description: 'Encrypted secret/credential',
    operations: [
      { name: 'create', displayName: 'Create' },
      { name: 'read', displayName: 'Read' },
      { name: 'update', displayName: 'Update' },
      { name: 'delete', displayName: 'Delete' },
    ],
  },
];

type SeedMode = 'run' | 'status' | 'validate';

interface SeedArgs {
  mode: SeedMode;
  fresh: boolean;
  dev: boolean;
  tenantId?: string;
  workspaceEmail?: string;
  seedVersion?: string;
}

interface TenantSeedTarget {
  tenantId: string;
  createdBy: string;
  label: string;
}

interface SeedTaskContext {
  args: SeedArgs;
  db: mongoose.mongo.Db;
  target: TenantSeedTarget | null;
}

interface RbacToolPermissionsModule {
  migrateRbacToolPermissions: () => Promise<unknown>;
  validateRbacToolPermissions: (db?: mongoose.mongo.Db) => Promise<{
    ok: boolean;
    summary: string;
    details?: Record<string, unknown>;
  }>;
}

let rbacToolPermissionsModulePromise: Promise<RbacToolPermissionsModule> | null = null;

async function loadRbacToolPermissionsModule(): Promise<RbacToolPermissionsModule> {
  if (!rbacToolPermissionsModulePromise) {
    const moduleUrl = pathToFileURL(
      path.resolve(__dirname, '../../scripts/rbac-tool-permissions.ts'),
    ).href;

    rbacToolPermissionsModulePromise = import(moduleUrl).then((module) => {
      const migrateRbacToolPermissions = (module as Partial<RbacToolPermissionsModule>)
        .migrateRbacToolPermissions;
      const validateRbacToolPermissions = (module as Partial<RbacToolPermissionsModule>)
        .validateRbacToolPermissions;

      if (
        typeof migrateRbacToolPermissions !== 'function' ||
        typeof validateRbacToolPermissions !== 'function'
      ) {
        throw new Error('RBAC tool permissions module does not export the expected functions');
      }

      return {
        migrateRbacToolPermissions,
        validateRbacToolPermissions,
      };
    });
  }

  return rbacToolPermissionsModulePromise;
}

function getArgValue(flag: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseArgs(): SeedArgs {
  const args = process.argv.slice(2);
  const status = args.includes('--status');
  const validate = args.includes('--validate');

  if (status && validate) {
    throw new Error('Use either --status or --validate, not both.');
  }

  const fresh = args.includes('--fresh');
  const dev = args.includes('--dev');
  const tenantId = getArgValue('--tenant');
  const workspaceEmailFlag = getArgValue('--workspace-email') ?? getArgValue('--seed-email');
  const workspaceEmail = workspaceEmailFlag ?? process.env.SEED_EMAIL;
  const mode: SeedMode = validate ? 'validate' : status ? 'status' : 'run';

  if (args.includes('--core-only')) {
    console.warn('--core-only is deprecated. Core-only is now the default behavior.');
  }

  if (args.includes('--examples') || args.includes('--with-examples')) {
    throw new Error('Example project seeding is now dev-only. Use --dev.');
  }

  if (args.includes('--llm-defaults') || args.includes('--with-llm-defaults')) {
    throw new Error('LLM credential/model fixture seeding is now dev-only. Use --dev.');
  }

  if (dev && (tenantId || workspaceEmail)) {
    throw new Error('Use either --dev or --tenant/--workspace-email, not both.');
  }

  if (mode !== 'run' && fresh) {
    throw new Error('--fresh is only supported during a live seed run.');
  }

  if (workspaceEmail && !workspaceEmailFlag && process.env.SEED_EMAIL) {
    console.warn(
      'SEED_EMAIL is deprecated. Prefer --workspace-email <email> for targeted workspace seeding.',
    );
  }

  return {
    mode,
    fresh,
    dev,
    tenantId,
    workspaceEmail,
    seedVersion: process.env.SEED_VERSION,
  };
}

function deterministicSeedId(scope: string, name: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${RESOURCE_OPERATION_ID_NAMESPACE}:${scope}:${name}`)
    .digest('hex');

  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-');
}

function seedValidationPassed(
  summary: string,
  details?: Record<string, unknown>,
): SeedValidationResult {
  return { ok: true, summary, details };
}

function seedValidationFailed(
  summary: string,
  details?: Record<string, unknown>,
): SeedValidationResult {
  return { ok: false, summary, details };
}

function buildResourceTypeOperations(
  resourceTypeName: string,
  operations: Array<{ name: string; displayName: string; description?: string }>,
) {
  return operations.map((operation) => ({
    id: deterministicSeedId(resourceTypeName, operation.name),
    name: operation.name,
    displayName: operation.displayName,
    description: operation.description ?? null,
    isSystem: true,
    createdAt: RESOURCE_OPERATION_CREATED_AT,
  }));
}

async function ensureUserRecord(data: {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  googleId: string;
  authProvider: string;
}): Promise<string> {
  const existing = await User.findOne({ email: data.email }).lean();
  if (existing) {
    return String((existing as { _id: unknown })._id);
  }

  await upsertOne(
    User,
    { email: data.email },
    {
      _id: data.id,
      email: data.email,
      name: data.name,
      avatarUrl: data.avatarUrl,
      googleId: data.googleId,
      authProvider: data.authProvider,
    },
  );

  return data.id;
}

async function ensureTenantRecord(data: {
  tenantId: string;
  name: string;
  slug: string;
  ownerId: string;
  retentionDays: number;
  settings: Record<string, unknown>;
  status: string;
}): Promise<string> {
  await upsertOne(
    Tenant,
    { _id: data.tenantId },
    {
      _id: data.tenantId,
      name: data.name,
      slug: data.slug,
      ownerId: data.ownerId,
      retentionDays: data.retentionDays,
      settings: data.settings,
      status: data.status,
    },
  );

  return data.tenantId;
}

async function ensureTenantMemberRecord(
  tenantId: string,
  userId: string,
  role: string,
): Promise<void> {
  await upsertOne(TenantMember, { tenantId, userId }, { tenantId, userId, role });
}

async function seedResourceTypes(): Promise<void> {
  console.log('--- Seeding ResourceTypes ---');
  for (const resourceType of RESOURCE_TYPES) {
    const operations = buildResourceTypeOperations(resourceType.name, resourceType.operations);

    await upsertOne(
      ResourceType,
      { name: resourceType.name },
      {
        name: resourceType.name,
        displayName: resourceType.displayName,
        description: resourceType.description,
        isSystem: true,
        operations,
      },
      {
        displayName: resourceType.displayName,
        description: resourceType.description,
        operations,
      },
    );

    console.log(`  ResourceType: ${resourceType.name}`);
  }
}

async function seedPlatformCoreData(): Promise<void> {
  console.log('Seeding platform core data...\n');
  await seedResourceTypes();

  console.log('\n--- Seeding Prompt Templates ---');
  const promptTemplateCount = await seedPromptTemplates();
  console.log(`  Seeded ${promptTemplateCount} prompt templates`);

  console.log('\n--- Seeding Pipeline Definitions ---');
  const pipelineCount = await seedPipelines();
  console.log(`  Seeded ${pipelineCount} pipeline records`);
}

async function resolveTenantTargetByEmail(email: string): Promise<TenantSeedTarget> {
  const existingUser = await User.findOne({ email }).lean();
  if (!existingUser) {
    throw new Error(`No user found with email ${email}. Sign up first or use --tenant <tenantId>.`);
  }

  const userId = String((existingUser as { _id: unknown })._id);
  const memberships = await TenantMember.find({ userId }).lean();
  if (memberships.length === 0) {
    throw new Error(`User ${email} has no workspace membership.`);
  }
  if (memberships.length > 1) {
    throw new Error(
      `User ${email} belongs to multiple workspaces. Use --tenant <tenantId> instead of email-based targeting.`,
    );
  }

  return {
    tenantId: String((memberships[0] as { tenantId: unknown }).tenantId),
    createdBy: userId,
    label: `workspace for ${email}`,
  };
}

async function resolveExplicitTenantTarget(tenantId: string): Promise<TenantSeedTarget> {
  const tenant = await Tenant.findOne({ _id: tenantId }).lean();
  if (!tenant) {
    throw new Error(`No tenant found with id ${tenantId}.`);
  }

  return {
    tenantId,
    createdBy: String((tenant as { ownerId?: unknown }).ownerId ?? 'platform'),
    label: `tenant ${tenantId}`,
  };
}

async function resolveTenantSeedTarget(args: SeedArgs): Promise<TenantSeedTarget | null> {
  if (args.dev) return null;
  if (args.tenantId) return resolveExplicitTenantTarget(args.tenantId);
  if (args.workspaceEmail) return resolveTenantTargetByEmail(args.workspaceEmail);
  return null;
}

async function seedTenantOperationalDefaults(target: TenantSeedTarget): Promise<void> {
  console.log(`\n--- Seeding Tenant Defaults for ${target.label} ---`);
  const bootstrap = await seedTenantBootstrapDefaults({
    tenantId: target.tenantId,
    createdBy: target.createdBy,
  });
  console.log(`  Seeded ${bootstrap.roleCount} role definitions`);

  const pipelineConfigCount = await seedTenantPipelineConfigs({
    tenantId: target.tenantId,
    createdBy: target.createdBy,
  });
  console.log(`  Ensured ${pipelineConfigCount} tenant pipeline configs`);
}

async function seedTenantLlmFixtures(
  _tenantId: string,
  _createdBy: string,
  workspaceLabel: string,
): Promise<void> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const configuredProviderEnvVars = [
    anthropicKey ? 'ANTHROPIC_API_KEY' : null,
    openaiKey ? 'OPENAI_API_KEY' : null,
  ].filter((value): value is string => Boolean(value));

  if (configuredProviderEnvVars.length === 0) {
    console.log(
      `\n--- Skipping ${workspaceLabel} LLM Fixtures (provider keys are vault-managed) ---`,
    );
    return;
  }

  console.log(
    `\n--- Skipping ${workspaceLabel} LLM Fixtures (provider keys are vault-managed, not seeded into MongoDB) ---`,
  );
  console.log(
    `  Detected ${configuredProviderEnvVars.join(', ')} in process env; no DB credentials were created.`,
  );
}

async function seedDevWorkspaceFixtures(): Promise<void> {
  const userId = await ensureUserRecord({
    id: 'user-dev-001',
    email: 'dev@kore.ai',
    name: 'Developer',
    avatarUrl: null,
    googleId: 'dev-google-id-001',
    authProvider: 'google',
  });
  const tenantId = await ensureTenantRecord({
    tenantId: 'tenant-dev-001',
    name: 'Dev Workspace',
    slug: 'dev-workspace',
    ownerId: userId,
    retentionDays: 30,
    settings: { features: { voice: true, sso: false } },
    status: 'active',
  });
  await ensureTenantMemberRecord(tenantId, userId, 'OWNER');

  const debugUserId = await ensureUserRecord({
    id: '019c5260-d8a4-7551-9207-8d28dcc50530',
    email: 'mcp-debug@kore.ai',
    name: 'MCP Debug',
    avatarUrl: null,
    googleId: 'dev-mcp-debug',
    authProvider: 'google',
  });
  await ensureTenantMemberRecord(tenantId, debugUserId, 'OWNER');

  try {
    const seedLocalUsersModulePath = './seed-local-users.js';
    const localUsersModule = await import(seedLocalUsersModulePath).catch(() => null);
    if (localUsersModule?.seedLocalUsers) {
      await localUsersModule.seedLocalUsers(upsertOne, { User, TenantMember }, tenantId);
    }
  } catch {
    // Optional local-only personal fixtures.
  }

  await seedTenantOperationalDefaults({
    tenantId,
    createdBy: userId,
    label: 'dev workspace',
  });
  await seedTenantLlmFixtures(tenantId, userId, 'Dev Workspace');

  const tokenValue = crypto.randomBytes(32).toString('hex');
  await upsertOne(
    DebugToken,
    { _id: 'debug-dev-001' },
    {
      _id: 'debug-dev-001',
      token: tokenValue,
      userId,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    },
    {
      token: tokenValue,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    },
  );
  console.log(`\nDebug Token: ${tokenValue.substring(0, 8)}...`);

  console.log('\n--- Seeding Dev Example Projects ---');
  await seedExamples(tenantId, userId);
}

async function seedE2EWorkspaceFixtures(): Promise<void> {
  const ownerId = await ensureUserRecord({
    id: 'user-e2e-owner-001',
    email: 'e2e-owner@kore.ai',
    name: 'E2E Owner',
    avatarUrl: null,
    googleId: 'dev-e2e-owner',
    authProvider: 'google',
  });
  const tenantId = await ensureTenantRecord({
    tenantId: 'tenant-e2e-001',
    name: 'E2E Workspace',
    slug: 'e2e-workspace',
    ownerId,
    retentionDays: 30,
    settings: { features: { voice: true, sso: false } },
    status: 'active',
  });
  await ensureTenantMemberRecord(tenantId, ownerId, 'OWNER');

  await seedTenantOperationalDefaults({
    tenantId,
    createdBy: ownerId,
    label: 'E2E workspace',
  });
  await seedTenantLlmFixtures(tenantId, ownerId, 'E2E Workspace');
}

function getAvailableExampleProjectIds(): string[] {
  return CURATED_EXAMPLE_PROJECTS.filter((example) =>
    fs.existsSync(path.join(EXAMPLES_DIR, example.dir)),
  ).map((example) => `proj-${example.dir}`);
}

function getExpectedTenantPipelineConfigCount(): number {
  return new Set(
    BUILTIN_DEFINITIONS.map((definition) => definition.definition.pipelineType).filter(Boolean),
  ).size;
}

async function validatePlatformCoreTask(context: SeedTaskContext): Promise<SeedValidationResult> {
  const resourceTypeDocs = await context.db
    .collection('resource_types')
    .find({ name: { $in: RESOURCE_TYPES.map((resourceType) => resourceType.name) } })
    .project({ name: 1, operations: 1 })
    .toArray();

  const resourceTypeMap = new Map(resourceTypeDocs.map((doc) => [String(doc.name), doc]));
  const missingResourceTypes = RESOURCE_TYPES.map((resourceType) => resourceType.name).filter(
    (name) => !resourceTypeMap.has(name),
  );
  const missingResourceOperations = RESOURCE_TYPES.flatMap((resourceType) => {
    const doc = resourceTypeMap.get(resourceType.name);
    if (!doc) {
      return [];
    }
    const currentOperations = Array.isArray(doc.operations)
      ? doc.operations.map((operation: any) => String(operation.name))
      : [];
    const missingOperations = resourceType.operations
      .map((operation) => operation.name)
      .filter((name) => !currentOperations.includes(name));
    return missingOperations.length > 0
      ? [{ resourceType: resourceType.name, missingOperations }]
      : [];
  });

  const expectedPromptKeys = getPromptTemplateSeedEntries().map((entry) => entry.key);
  const promptTemplateDocs = await context.db
    .collection('prompt_templates')
    .find({ key: { $in: expectedPromptKeys } })
    .project({ key: 1 })
    .toArray();
  const promptTemplateKeys = new Set(promptTemplateDocs.map((doc) => String(doc.key)));
  const missingPromptTemplates = expectedPromptKeys.filter((key) => !promptTemplateKeys.has(key));

  const expectedPipelineIds = BUILTIN_DEFINITIONS.map((definition) => definition.id);
  const pipelineDefinitionDocs = await context.db
    .collection('pipeline_definitions')
    .find({ _id: { $in: expectedPipelineIds as string[] } })
    .project({ _id: 1 })
    .toArray();
  const pipelineDefinitionIds = new Set(pipelineDefinitionDocs.map((doc) => String(doc._id)));
  const missingPipelineDefinitions = expectedPipelineIds.filter(
    (id) => !pipelineDefinitionIds.has(id),
  );

  if (
    missingResourceTypes.length > 0 ||
    missingResourceOperations.length > 0 ||
    missingPromptTemplates.length > 0 ||
    missingPipelineDefinitions.length > 0
  ) {
    return seedValidationFailed('Platform core seed state is incomplete', {
      missingResourceTypes,
      missingResourceOperations,
      missingPromptTemplates,
      missingPipelineDefinitions,
      clickhouseConfigured: Boolean(process.env.CLICKHOUSE_URL),
    });
  }

  return seedValidationPassed('Platform core seed state is present', {
    resourceTypeCount: resourceTypeDocs.length,
    promptTemplateCount: promptTemplateDocs.length,
    pipelineDefinitionCount: pipelineDefinitionDocs.length,
    clickhouseConfigured: Boolean(process.env.CLICKHOUSE_URL),
  });
}

async function validateTenantOperationalDefaultsState(
  db: mongoose.mongo.Db,
  target: TenantSeedTarget,
): Promise<SeedValidationResult> {
  const roleDocs = await db
    .collection('role_definitions')
    .find({
      tenantId: target.tenantId,
      name: { $in: SYSTEM_ROLES.map((role) => role.name) },
    })
    .project({ name: 1, permissions: 1 })
    .toArray();

  const roleMap = new Map(roleDocs.map((doc) => [String(doc.name), doc]));
  const missingRoles = SYSTEM_ROLES.map((role) => role.name).filter((name) => !roleMap.has(name));
  const rolePermissionGaps = SYSTEM_ROLES.flatMap((role) => {
    const doc = roleMap.get(role.name);
    if (!doc) {
      return [];
    }
    const currentPermissions = Array.isArray(doc.permissions)
      ? doc.permissions.map((permission: any) => String(permission))
      : [];
    const missingPermissions = role.permissions.filter(
      (permission) => !currentPermissions.includes(permission),
    );
    return missingPermissions.length > 0 ? [{ roleName: role.name, missingPermissions }] : [];
  });

  const [tenantPolicyCount, tenantPipelineConfigCount] = await Promise.all([
    db.collection('tenant_llm_policies').countDocuments({ tenantId: target.tenantId }),
    db.collection('pipeline_configs').countDocuments({
      tenantId: target.tenantId,
      projectId: null,
    }),
  ]);

  const expectedPipelineConfigCount = getExpectedTenantPipelineConfigCount();
  if (
    missingRoles.length > 0 ||
    rolePermissionGaps.length > 0 ||
    tenantPolicyCount === 0 ||
    tenantPipelineConfigCount < expectedPipelineConfigCount
  ) {
    return seedValidationFailed(`Tenant defaults are incomplete for ${target.label}`, {
      tenantId: target.tenantId,
      missingRoles,
      rolePermissionGaps,
      tenantPolicyCount,
      tenantPipelineConfigCount,
      expectedPipelineConfigCount,
    });
  }

  return seedValidationPassed(`Tenant defaults are present for ${target.label}`, {
    tenantId: target.tenantId,
    roleCount: roleDocs.length,
    tenantPolicyCount,
    tenantPipelineConfigCount,
  });
}

async function validateTenantLlmFixturesState(
  _db: mongoose.mongo.Db,
  _tenantId: string,
  workspaceLabel: string,
): Promise<SeedValidationResult> {
  const anthropicConfigured = Boolean(process.env.ANTHROPIC_API_KEY);
  const openaiConfigured = Boolean(process.env.OPENAI_API_KEY);
  const configuredProviderEnvVars = [
    anthropicConfigured ? 'ANTHROPIC_API_KEY' : null,
    openaiConfigured ? 'OPENAI_API_KEY' : null,
  ].filter((value): value is string => Boolean(value));

  return seedValidationPassed(`LLM fixtures were intentionally skipped for ${workspaceLabel}`, {
    reason:
      configuredProviderEnvVars.length > 0
        ? 'Provider keys are vault-managed and are not seeded into MongoDB'
        : 'No provider API keys configured',
    configuredEnvVars: configuredProviderEnvVars,
  });
}

async function validateDevWorkspaceTask(context: SeedTaskContext): Promise<SeedValidationResult> {
  const [
    ownerCount,
    debugUserCount,
    tenantCount,
    ownerMembershipCount,
    debugMembershipCount,
    debugTokenCount,
  ] = await Promise.all([
    context.db.collection('users').countDocuments({
      _id: DEV_WORKSPACE_OWNER_ID,
      email: DEV_WORKSPACE_OWNER_EMAIL,
    }),
    context.db.collection('users').countDocuments({
      _id: DEV_DEBUG_USER_ID,
    }),
    context.db.collection('tenants').countDocuments({
      _id: DEV_WORKSPACE_TENANT_ID,
    }),
    context.db.collection('tenant_members').countDocuments({
      tenantId: DEV_WORKSPACE_TENANT_ID,
      userId: DEV_WORKSPACE_OWNER_ID,
    }),
    context.db.collection('tenant_members').countDocuments({
      tenantId: DEV_WORKSPACE_TENANT_ID,
      userId: DEV_DEBUG_USER_ID,
    }),
    context.db.collection('debug_tokens').countDocuments({
      _id: DEV_DEBUG_TOKEN_ID,
      userId: DEV_WORKSPACE_OWNER_ID,
    }),
  ]);

  const expectedExampleProjectIds = getAvailableExampleProjectIds();
  const exampleProjectDocs = await context.db
    .collection('projects')
    .find({
      tenantId: DEV_WORKSPACE_TENANT_ID,
      _id: { $in: expectedExampleProjectIds as string[] },
    })
    .project({ _id: 1 })
    .toArray();
  const actualExampleProjectIds = new Set(exampleProjectDocs.map((doc) => String(doc._id)));
  const missingExampleProjects = expectedExampleProjectIds.filter(
    (projectId) => !actualExampleProjectIds.has(projectId),
  );

  const defaultsValidation = await validateTenantOperationalDefaultsState(context.db, {
    tenantId: DEV_WORKSPACE_TENANT_ID,
    createdBy: DEV_WORKSPACE_OWNER_ID,
    label: 'dev workspace',
  });
  const llmValidation = await validateTenantLlmFixturesState(
    context.db,
    DEV_WORKSPACE_TENANT_ID,
    'Dev Workspace',
  );

  const missingBaseState = [
    ownerCount === 0 ? 'owner-user' : null,
    debugUserCount === 0 ? 'debug-user' : null,
    tenantCount === 0 ? 'tenant' : null,
    ownerMembershipCount === 0 ? 'owner-membership' : null,
    debugMembershipCount === 0 ? 'debug-membership' : null,
    debugTokenCount === 0 ? 'debug-token' : null,
  ].filter(Boolean);

  if (
    missingBaseState.length > 0 ||
    missingExampleProjects.length > 0 ||
    !defaultsValidation.ok ||
    !llmValidation.ok
  ) {
    return seedValidationFailed('Dev workspace fixtures are incomplete', {
      missingBaseState,
      missingExampleProjects,
      tenantDefaults: defaultsValidation,
      llmFixtures: llmValidation,
    });
  }

  return seedValidationPassed('Dev workspace fixtures are present', {
    exampleProjectCount: exampleProjectDocs.length,
    tenantDefaults: defaultsValidation.summary,
    llmFixtures: llmValidation.summary,
  });
}

async function validateE2EWorkspaceTask(context: SeedTaskContext): Promise<SeedValidationResult> {
  const [ownerCount, tenantCount, membershipCount] = await Promise.all([
    context.db.collection('users').countDocuments({
      _id: E2E_WORKSPACE_OWNER_ID,
      email: E2E_WORKSPACE_OWNER_EMAIL,
    }),
    context.db.collection('tenants').countDocuments({
      _id: E2E_WORKSPACE_TENANT_ID,
    }),
    context.db.collection('tenant_members').countDocuments({
      tenantId: E2E_WORKSPACE_TENANT_ID,
      userId: E2E_WORKSPACE_OWNER_ID,
    }),
  ]);

  const defaultsValidation = await validateTenantOperationalDefaultsState(context.db, {
    tenantId: E2E_WORKSPACE_TENANT_ID,
    createdBy: E2E_WORKSPACE_OWNER_ID,
    label: 'E2E workspace',
  });
  const llmValidation = await validateTenantLlmFixturesState(
    context.db,
    E2E_WORKSPACE_TENANT_ID,
    'E2E Workspace',
  );

  const missingBaseState = [
    ownerCount === 0 ? 'owner-user' : null,
    tenantCount === 0 ? 'tenant' : null,
    membershipCount === 0 ? 'owner-membership' : null,
  ].filter(Boolean);

  if (missingBaseState.length > 0 || !defaultsValidation.ok || !llmValidation.ok) {
    return seedValidationFailed('E2E workspace fixtures are incomplete', {
      missingBaseState,
      tenantDefaults: defaultsValidation,
      llmFixtures: llmValidation,
    });
  }

  return seedValidationPassed('E2E workspace fixtures are present', {
    tenantDefaults: defaultsValidation.summary,
    llmFixtures: llmValidation.summary,
  });
}

function buildSeedTasks(context: SeedTaskContext): Array<SeedTask<SeedTaskContext>> {
  const tasks: Array<SeedTask<SeedTaskContext>> = [
    {
      id: PLATFORM_CORE_TASK_ID,
      description: SEED_TASK_CATALOG[PLATFORM_CORE_TASK_ID].description,
      idempotent: true,
      compensation: 'manual',
      targetKey: () => 'global:platform-core',
      targetLabel: () => 'platform core',
      run: async () => {
        await seedPlatformCoreData();
      },
      validate: validatePlatformCoreTask,
    },
    {
      id: RBAC_ALIGNMENT_TASK_ID,
      description: SEED_TASK_CATALOG[RBAC_ALIGNMENT_TASK_ID].description,
      idempotent: true,
      compensation: 'manual',
      targetKey: () => 'global:rbac-tool-permissions',
      targetLabel: () => 'platform RBAC',
      run: async () => {
        const { migrateRbacToolPermissions } = await loadRbacToolPermissionsModule();
        await migrateRbacToolPermissions();
      },
      validate: async (taskContext) => {
        const { validateRbacToolPermissions } = await loadRbacToolPermissionsModule();
        return validateRbacToolPermissions(taskContext.db);
      },
    },
  ];

  if (context.args.dev) {
    tasks.push(
      {
        id: DEV_WORKSPACE_TASK_ID,
        description: SEED_TASK_CATALOG[DEV_WORKSPACE_TASK_ID].description,
        idempotent: true,
        compensation: 'manual',
        targetKey: () => `tenant:${DEV_WORKSPACE_TENANT_ID}`,
        targetLabel: () => 'dev workspace',
        run: async () => {
          await seedDevWorkspaceFixtures();
        },
        validate: validateDevWorkspaceTask,
      },
      {
        id: E2E_WORKSPACE_TASK_ID,
        description: SEED_TASK_CATALOG[E2E_WORKSPACE_TASK_ID].description,
        idempotent: true,
        compensation: 'manual',
        targetKey: () => `tenant:${E2E_WORKSPACE_TENANT_ID}`,
        targetLabel: () => 'e2e workspace',
        run: async () => {
          await seedE2EWorkspaceFixtures();
        },
        validate: validateE2EWorkspaceTask,
      },
    );
    return tasks;
  }

  if (context.target) {
    tasks.push({
      id: TARGET_DEFAULTS_TASK_ID,
      description: SEED_TASK_CATALOG[TARGET_DEFAULTS_TASK_ID].description,
      idempotent: true,
      compensation: 'manual',
      targetKey: () => `tenant:${context.target!.tenantId}`,
      targetLabel: () => context.target!.label,
      run: async () => {
        await seedTenantOperationalDefaults(context.target!);
      },
      validate: async () => validateTenantOperationalDefaultsState(context.db, context.target!),
    });
  }

  return tasks;
}

function printSeedStatuses(statuses: SeedTaskStatus[], seedVersion?: string | null): void {
  console.log('\n─── Seed Status ───');
  console.log(`  Seed version: ${seedVersion ?? 'untracked'}`);
  for (const status of statuses) {
    const icon =
      status.status === 'applied'
        ? '✓'
        : status.status === 'verified'
          ? '≈'
          : status.status === 'failed'
            ? '✗'
            : '○';
    const tracking = status.tracked ? '' : ' (untracked)';
    const checksum =
      status.tracked && status.checksumStatus && status.checksumStatus !== 'match'
        ? ` checksum:${status.checksumStatus}`
        : '';
    const validation = status.validationStatus ? ` validation:${status.validationStatus}` : '';
    const error = status.lastError ? ` error:${status.lastError}` : '';
    console.log(
      `  ${icon} ${status.taskId} [${status.targetLabel}]${tracking}${checksum}${validation}${error}`,
    );
  }
}

function printSeedValidationResults(
  results: SeedValidationRunResult[],
  seedVersion?: string | null,
): void {
  console.log('\n─── Seed Validation ───');
  console.log(`  Seed version: ${seedVersion ?? 'untracked'}`);
  for (const result of results) {
    const icon =
      result.status === 'passed'
        ? '✓'
        : result.status === 'verified'
          ? '≈'
          : result.status === 'failed'
            ? '✗'
            : result.status === 'not_configured'
              ? '·'
              : '○';
    const tracking = result.tracked ? '' : ' (untracked)';
    const summary = result.summary ? ` — ${result.summary}` : '';
    console.log(`  ${icon} ${result.taskId} [${result.targetKey}]${tracking}${summary}`);
  }
}

async function connectMongo(preferRootConnection: boolean): Promise<void> {
  const mongoUrl = preferRootConnection
    ? process.env.MONGODB_ROOT_URL ||
      process.env.MONGODB_URL ||
      process.env.MONGO_URL ||
      'mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform?authSource=admin&directConnection=true'
    : process.env.MONGODB_URL ||
      process.env.MONGO_URL ||
      'mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform?authSource=admin&directConnection=true';

  console.log(`Connecting to MongoDB: ${mongoUrl.replace(/\/\/[^@]+@/, '//<credentials>@')}`);
  await mongoose.connect(mongoUrl);
  console.log('Connected.\n');
}

async function maybeWipeDatastores(fresh: boolean, seedVersion?: string): Promise<void> {
  let shouldWipe = fresh;

  if (seedVersion && !fresh) {
    const db = mongoose.connection.db!;
    try {
      const meta = await db.collection('_seed_meta').findOne({ key: 'seed_version' });
      if (!meta) {
        shouldWipe = true;
      } else if (meta.value !== seedVersion) {
        console.log(`Seed version changed: ${meta.value} -> ${seedVersion}`);
        shouldWipe = true;
      } else {
        console.log(`Seed version ${seedVersion} already applied, skipping wipe.`);
      }
    } catch {
      shouldWipe = true;
    }
  }

  if (shouldWipe && process.env.NODE_ENV === 'production') {
    throw new Error('FATAL: database wipe is not allowed in production');
  }

  if (!shouldWipe) {
    return;
  }

  console.log('=== WIPE MODE: dropping databases ===\n');

  const db = mongoose.connection.db;
  if (db) {
    console.log('Dropping MongoDB database...');
    await db.dropDatabase();
    console.log('MongoDB database dropped.\n');
  }

  const clickhouseUrl = process.env.CLICKHOUSE_URL;
  if (!clickhouseUrl) {
    return;
  }

  console.log('Dropping ClickHouse database (abl_platform)...');
  const { createClient } = await import('@clickhouse/client');
  const clickhouse = createClient({ url: clickhouseUrl });
  try {
    await clickhouse.command({ query: 'DROP DATABASE IF EXISTS abl_platform' });
    console.log('ClickHouse database dropped.\n');
  } finally {
    await clickhouse.close();
  }
}

async function maybeInitEncryption(): Promise<void> {
  const masterKey = process.env.ENCRYPTION_MASTER_KEY;
  if (!masterKey) {
    return;
  }

  const [{ setMasterKey }, { initDEKFacade }] = await Promise.all([
    import('./src/mongo/plugins/encryption.plugin.js'),
    import('./src/kms/dek-facade-factory.js'),
  ]);

  setMasterKey(masterKey);
  console.log('Encryption master key set.');

  if (!isFacadeEncryptionAvailable()) {
    await initDEKFacade({ masterKeyHex: masterKey });
    console.log('DEK facade initialized.\n');
    return;
  }

  console.log('DEK facade already initialized.\n');
}

async function readSeedVersion(): Promise<string | null> {
  const db = mongoose.connection.db!;
  const meta = await db.collection('_seed_meta').findOne({ key: 'seed_version' });
  return typeof meta?.value === 'string' ? meta.value : null;
}

async function recordSeedVersion(seedVersion?: string): Promise<void> {
  if (!seedVersion) {
    return;
  }

  const db = mongoose.connection.db!;
  await db
    .collection('_seed_meta')
    .updateOne(
      { key: 'seed_version' },
      { $set: { value: seedVersion, appliedAt: new Date() } },
      { upsert: true },
    );
  console.log(`Recorded seed version: ${seedVersion}`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  await connectMongo(args.mode === 'run' && (args.fresh || Boolean(args.seedVersion)));

  const target = await resolveTenantSeedTarget(args);
  const context: SeedTaskContext = {
    args,
    db: mongoose.connection.db!,
    target,
  };
  const tasks = buildSeedTasks(context);
  const runner = new SeedRunner<SeedTaskContext>(context.db);

  if (args.mode === 'status') {
    const [statuses, seedVersion] = await Promise.all([
      runner.status(tasks, context),
      readSeedVersion(),
    ]);
    printSeedStatuses(statuses, seedVersion);
    return;
  }

  if (args.mode === 'validate') {
    const [results, seedVersion] = await Promise.all([
      runner.validate(tasks, context),
      readSeedVersion(),
    ]);
    printSeedValidationResults(results, seedVersion);
    return;
  }

  await maybeWipeDatastores(args.fresh, args.seedVersion);
  await maybeInitEncryption();

  const result = await runner.run(tasks, context);
  if (result.failed) {
    throw new Error(`Seed task failed: ${result.failed}`);
  }

  await recordSeedVersion(args.seedVersion);
  console.log('\nSeed complete!');
}

function isMainModule(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  void main()
    .catch((error) => {
      console.error('Seed error:', error);
      process.exit(1);
    })
    .finally(async () => {
      await mongoose.disconnect();
    });
}
