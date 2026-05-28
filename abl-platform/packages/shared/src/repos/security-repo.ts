/**
 * Security Repository
 *
 * MongoDB tool secret, proxy config, and OAuth token operations.
 * Used by: Studio (secrets/proxy CRUD), Runtime (secrets read at execution time)
 */

import type {
  IToolSecret,
  IOrgProxyConfig,
  IEndUserOAuthToken,
  IEnvironmentVariable,
} from '@agent-platform/database/models';
import { normalizeDocument } from '../utils/normalize.js';
import type {
  NormalizedToolSecret,
  NormalizedOrgProxyConfig,
  NormalizedEndUserOAuthToken,
  NormalizedEnvironmentVariable,
} from '../types/security.js';

function normalizeToolSecret(doc: IToolSecret | null): NormalizedToolSecret | null {
  return normalizeDocument(doc) as NormalizedToolSecret | null;
}

function normalizeProxyConfig(doc: IOrgProxyConfig | null): NormalizedOrgProxyConfig | null {
  return normalizeDocument(doc) as NormalizedOrgProxyConfig | null;
}

function normalizeOAuthToken(doc: IEndUserOAuthToken | null): NormalizedEndUserOAuthToken | null {
  return normalizeDocument(doc) as NormalizedEndUserOAuthToken | null;
}

function normalizeEnvVar(doc: IEnvironmentVariable | null): NormalizedEnvironmentVariable | null {
  return normalizeDocument(doc) as NormalizedEnvironmentVariable | null;
}

// ─── Tool Secrets ─────────────────────────────────────────────────────────

export async function createToolSecret(data: {
  tenantId: string;
  projectId?: string | null;
  toolName: string;
  secretKey: string;
  encryptedValue: string;
  environment?: string;
  expiresAt?: Date | null;
  createdBy: string;
}): Promise<NormalizedToolSecret> {
  const { ToolSecret } = await import('@agent-platform/database/models');
  const doc = await ToolSecret.create(data);
  const normalized = normalizeToolSecret(doc.toObject());
  /* v8 ignore start */
  if (!normalized) {
    throw new Error('Failed to normalize newly created tool secret - data integrity error');
  }
  /* v8 ignore stop */
  return normalized;
}

export interface ToolSecretFilter {
  tenantId: string;
  toolName?: string;
  environment?: string;
  projectId?: string | null;
}

export async function findToolSecrets(
  where: ToolSecretFilter,
  opts?: { select?: Record<string, boolean>; skip?: number; take?: number },
): Promise<NormalizedToolSecret[]> {
  const { ToolSecret } = await import('@agent-platform/database/models');
  let query = ToolSecret.find(where);
  if (opts?.select) {
    const projection: Record<string, 1> = {};
    for (const k of Object.keys(opts.select)) projection[k] = 1;
    query = query.select(projection);
  }
  query = query.sort({ createdAt: -1 });
  if (opts?.skip) query = query.skip(opts.skip);
  if (opts?.take) query = query.limit(opts.take);
  const docs = await query.lean();
  return docs.map((doc: IToolSecret) => {
    const normalized = normalizeToolSecret(doc);
    /* v8 ignore start */
    if (!normalized) {
      throw new Error('Failed to normalize tool secret - data integrity error');
    }
    /* v8 ignore stop */
    return normalized;
  });
}

export async function countToolSecrets(where: ToolSecretFilter): Promise<number> {
  const { ToolSecret } = await import('@agent-platform/database/models');
  return ToolSecret.countDocuments(where);
}

// TODO(isolation): make projectId required after all callers updated
// Callers that need updating:
//   - apps/runtime/src/routes/tool-secrets.ts (findToolSecretById — GET by ID)
//   - apps/runtime/src/routes/tool-secrets.ts (updateToolSecret — PATCH)
//   - apps/runtime/src/routes/tool-secrets.ts (findToolSecretById — DELETE pre-check)
//   - apps/runtime/src/routes/tool-secrets.ts (deleteToolSecret — DELETE)
export async function findToolSecretById(
  id: string,
  tenantId: string,
  projectId?: string,
): Promise<NormalizedToolSecret | null> {
  const { ToolSecret } = await import('@agent-platform/database/models');
  const query: Record<string, unknown> = { _id: id, tenantId };
  if (projectId) query.projectId = projectId;
  const doc = await ToolSecret.findOne(query).lean();
  return normalizeToolSecret(doc);
}

export interface ToolSecretUpdateData {
  encryptedValue?: string;
  version?: number;
  rotatedAt?: Date;
  expiresAt?: Date | null;
}

export async function updateToolSecret(
  id: string,
  tenantId: string,
  data: ToolSecretUpdateData,
  projectId?: string,
): Promise<NormalizedToolSecret | null> {
  const { ToolSecret } = await import('@agent-platform/database/models');
  const query: Record<string, unknown> = { _id: id, tenantId };
  if (projectId) query.projectId = projectId;
  // Use findOne + save() so the encryption plugin's pre-save hook fires
  const doc = await ToolSecret.findOne(query);
  if (!doc) return null;
  for (const [key, value] of Object.entries(data)) {
    doc.set(key, value);
  }
  await doc.save();
  return normalizeToolSecret(doc.toObject());
}

export async function deleteToolSecret(
  id: string,
  tenantId: string,
  projectId?: string,
): Promise<void> {
  const { ToolSecret } = await import('@agent-platform/database/models');
  const query: Record<string, unknown> = { _id: id, tenantId };
  if (projectId) query.projectId = projectId;
  await ToolSecret.deleteOne(query);
}

// ─── Org Proxy Configs ────────────────────────────────────────────────────

export interface OrgProxyConfigCreateData {
  tenantId: string;
  name: string;
  proxyUrl: string;
  proxyAuthType: string;
  encryptedProxyUsername?: string | null;
  encryptedProxyPassword?: string | null;
  encryptedProxyToken?: string | null;
  encryptedCaCertificate?: string | null;
  encryptedClientCert?: string | null;
  encryptedClientKey?: string | null;
  urlPatterns: string;
  bypassPatterns?: string | null;
  environment?: string;
  priority?: number;
  enabled?: boolean;
  createdBy: string;
}

export async function createOrgProxyConfig(
  data: OrgProxyConfigCreateData,
): Promise<NormalizedOrgProxyConfig> {
  const { OrgProxyConfig } = await import('@agent-platform/database/models');
  const doc = await OrgProxyConfig.create(data);
  const normalized = normalizeProxyConfig(doc.toObject());
  /* v8 ignore start */
  if (!normalized) {
    throw new Error('Failed to normalize newly created proxy config - data integrity error');
  }
  /* v8 ignore stop */
  return normalized;
}

export interface OrgProxyConfigFilter {
  tenantId: string;
  environment?: string;
  enabled?: boolean;
}

export async function findOrgProxyConfigs(
  where: OrgProxyConfigFilter,
  opts?: { select?: Record<string, boolean>; skip?: number; take?: number },
): Promise<NormalizedOrgProxyConfig[]> {
  const { OrgProxyConfig } = await import('@agent-platform/database/models');
  let query = OrgProxyConfig.find(where);
  if (opts?.select) {
    const projection: Record<string, 1> = {};
    for (const k of Object.keys(opts.select)) projection[k] = 1;
    query = query.select(projection);
  }
  query = query.sort({ priority: -1, createdAt: -1 });
  if (opts?.skip) query = query.skip(opts.skip);
  if (opts?.take) query = query.limit(opts.take);
  const docs = await query.lean();
  return docs.map((doc: IOrgProxyConfig) => {
    const normalized = normalizeProxyConfig(doc);
    /* v8 ignore start */
    if (!normalized) {
      throw new Error('Failed to normalize proxy config - data integrity error');
    }
    /* v8 ignore stop */
    return normalized;
  });
}

export async function countOrgProxyConfigs(where: OrgProxyConfigFilter): Promise<number> {
  const { OrgProxyConfig } = await import('@agent-platform/database/models');
  return OrgProxyConfig.countDocuments(where);
}

export async function findOrgProxyConfigById(
  id: string,
  tenantId: string,
): Promise<NormalizedOrgProxyConfig | null> {
  const { OrgProxyConfig } = await import('@agent-platform/database/models');
  const doc = await OrgProxyConfig.findOne({ _id: id, tenantId }).lean();
  return normalizeProxyConfig(doc);
}

export async function updateOrgProxyConfig(
  id: string,
  tenantId: string,
  data: Record<string, unknown>,
): Promise<NormalizedOrgProxyConfig | null> {
  const { OrgProxyConfig } = await import('@agent-platform/database/models');
  // Use findOne + save() so the encryption plugin's pre-save hook fires
  const doc = await OrgProxyConfig.findOne({ _id: id, tenantId });
  if (!doc) return null;
  for (const [key, value] of Object.entries(data)) {
    doc.set(key, value);
  }
  await doc.save();
  return normalizeProxyConfig(doc.toObject());
}

export async function deleteOrgProxyConfig(id: string, tenantId: string): Promise<void> {
  const { OrgProxyConfig } = await import('@agent-platform/database/models');
  await OrgProxyConfig.deleteOne({ _id: id, tenantId });
}

// ─── End User OAuth Tokens ────────────────────────────────────────────────

export async function findEndUserOAuthTokens(
  where: { tenantId: string; userId: string },
  opts?: { skip?: number; take?: number },
): Promise<NormalizedEndUserOAuthToken[]> {
  const { EndUserOAuthToken } = await import('@agent-platform/database/models');
  let query = EndUserOAuthToken.find({ ...where, revokedAt: null })
    .select({ encryptedAccessToken: 0, encryptedRefreshToken: 0 })
    .sort({ consentedAt: -1 });
  if (opts?.skip) query = query.skip(opts.skip);
  if (opts?.take) query = query.limit(opts.take);
  const docs = await query.lean();
  return docs.map((doc: IEndUserOAuthToken) => {
    const normalized = normalizeOAuthToken(doc);
    /* v8 ignore start */
    if (!normalized) {
      throw new Error('Failed to normalize OAuth token - data integrity error');
    }
    /* v8 ignore stop */
    return normalized;
  });
}

export async function countEndUserOAuthTokens(where: {
  tenantId: string;
  userId: string;
}): Promise<number> {
  const { EndUserOAuthToken } = await import('@agent-platform/database/models');
  return EndUserOAuthToken.countDocuments({ ...where, revokedAt: null });
}

// ─── Environment Variables ───────────────────────────────────────────────

export interface EnvironmentVariableCreateData {
  tenantId: string;
  projectId: string;
  environment: string;
  key: string;
  encryptedValue: string;
  isSecret: boolean;
  description: string | null;
  createdBy: string;
}

export async function createEnvironmentVariable(
  data: EnvironmentVariableCreateData,
): Promise<NormalizedEnvironmentVariable> {
  const { EnvironmentVariable } = await import('@agent-platform/database/models');
  const doc = await EnvironmentVariable.create(data);
  const normalized = normalizeEnvVar(doc.toObject());
  /* v8 ignore start */
  if (!normalized) {
    throw new Error(
      'Failed to normalize newly created environment variable - data integrity error',
    );
  }
  /* v8 ignore stop */
  return normalized;
}

export interface EnvironmentVariableFilter {
  tenantId: string;
  projectId: string;
  environment?: string;
}

export async function findEnvironmentVariables(
  where: EnvironmentVariableFilter,
  opts?: { select?: Record<string, number | boolean>; skip?: number; take?: number },
): Promise<NormalizedEnvironmentVariable[]> {
  const { EnvironmentVariable } = await import('@agent-platform/database/models');
  let query = EnvironmentVariable.find(where);
  if (opts?.select) {
    query = query.select(opts.select);
  }
  query = query.sort({ key: 1 });
  if (opts?.skip) query = query.skip(opts.skip);
  if (opts?.take) query = query.limit(opts.take);
  const docs = await query.lean();
  return docs.map((doc: IEnvironmentVariable) => {
    const normalized = normalizeEnvVar(doc);
    /* v8 ignore start */
    if (!normalized) {
      throw new Error('Failed to normalize environment variable - data integrity error');
    }
    /* v8 ignore stop */
    return normalized;
  });
}

export async function countEnvironmentVariables(where: EnvironmentVariableFilter): Promise<number> {
  const { EnvironmentVariable } = await import('@agent-platform/database/models');
  return EnvironmentVariable.countDocuments(where);
}

export async function findEnvironmentVariableById(
  id: string,
  tenantId: string,
  projectId: string,
): Promise<NormalizedEnvironmentVariable | null> {
  const { EnvironmentVariable } = await import('@agent-platform/database/models');
  const doc = await EnvironmentVariable.findOne({ _id: id, tenantId, projectId }).lean();
  return normalizeEnvVar(doc);
}

export async function findEnvironmentVariableByKey(
  tenantId: string,
  projectId: string,
  environment: string,
  key: string,
): Promise<NormalizedEnvironmentVariable | null> {
  const { EnvironmentVariable } = await import('@agent-platform/database/models');
  const doc = await EnvironmentVariable.findOne({
    tenantId,
    projectId,
    environment,
    key,
  }).lean();
  return normalizeEnvVar(doc);
}

export interface EnvironmentVariableUpdateData {
  encryptedValue?: string;
  isSecret?: boolean;
  description?: string | null;
  updatedBy?: string;
}

export async function updateEnvironmentVariable(
  id: string,
  tenantId: string,
  projectId: string,
  data: EnvironmentVariableUpdateData,
): Promise<NormalizedEnvironmentVariable | null> {
  const { EnvironmentVariable } = await import('@agent-platform/database/models');
  // Use findOne + save() so the encryption plugin's pre-save hook fires
  const doc = await EnvironmentVariable.findOne({ _id: id, tenantId, projectId });
  if (!doc) return null;
  // Repair legacy docs with null/missing environment before validation
  if (!doc.get('environment')) {
    doc.set('environment', 'global');
  }
  for (const [key, value] of Object.entries(data)) {
    doc.set(key, value);
  }
  await doc.save();
  return normalizeEnvVar(doc.toObject());
}

export async function deleteEnvironmentVariable(
  id: string,
  tenantId: string,
  projectId: string,
): Promise<void> {
  const { EnvironmentVariable } = await import('@agent-platform/database/models');
  await EnvironmentVariable.deleteOne({ _id: id, tenantId, projectId });
}

export async function bulkUpsertEnvironmentVariables(
  tenantId: string,
  projectId: string,
  targetEnvironment: string,
  variables: Array<{
    key: string;
    encryptedValue: string;
    isSecret: boolean;
    description: string | null;
  }>,
  userId: string,
  overwrite: boolean,
): Promise<{ upserted: number; matched: number }> {
  const { EnvironmentVariable } = await import('@agent-platform/database/models');

  // Use findOne + save/create so the encryption plugin's pre-save hook fires.
  // bulkWrite bypasses Mongoose middleware, storing plaintext in DB.
  // Process in parallel batches of 10 to limit DB connection pressure while
  // avoiding the O(2N) sequential round-trip penalty of the naive loop.
  let upserted = 0;
  let matched = 0;

  const BATCH_SIZE = 10;
  for (let i = 0; i < variables.length; i += BATCH_SIZE) {
    const batch = variables.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (v) => {
        const existing = await EnvironmentVariable.findOne({
          tenantId,
          projectId,
          environment: targetEnvironment,
          key: v.key,
        });

        if (existing) {
          if (overwrite) {
            existing.set('encryptedValue', v.encryptedValue);
            existing.set('isSecret', v.isSecret);
            existing.set('description', v.description);
            existing.set('updatedBy', userId);
            await existing.save();
          }
          return 'matched' as const;
        } else {
          await EnvironmentVariable.create({
            tenantId,
            projectId,
            environment: targetEnvironment,
            key: v.key,
            encryptedValue: v.encryptedValue,
            isSecret: v.isSecret,
            description: v.description,
            createdBy: userId,
          });
          return 'upserted' as const;
        }
      }),
    );

    for (const r of results) {
      if (r === 'matched') matched++;
      else upserted++;
    }
  }

  return { upserted, matched };
}
