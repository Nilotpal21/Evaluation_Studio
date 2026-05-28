/**
 * Deployment Variable Snapshot Service
 *
 * Creates immutable point-in-time snapshots of all variable values at deployment time.
 * Snapshots store raw ciphertext for env vars (no decryption) and plaintext for config vars.
 * Also provides diff computation between two snapshots.
 */

import { createHash } from 'crypto';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('snapshot-service');

export async function createDeploymentSnapshot(params: {
  tenantId: string;
  projectId: string;
  deploymentId: string;
  environment: string;
  createdBy: string;
}) {
  const { tenantId, projectId, deploymentId, environment, createdBy } = params;

  // Use dynamic imports like other repos in this codebase
  const {
    DeploymentVariableSnapshot,
    EnvironmentVariable,
    ProjectConfigVariable,
    VariableNamespaceMembership,
    VariableNamespace,
  } = await import('@agent-platform/database/models');

  // 1. Load all env vars for this project + environment
  // CRITICAL: Use .select() WITHOUT encryption metadata fields (ire, iv, cek, fieldsToEncrypt, tenantId).
  // This causes the Mongoose encryption plugin's post-find hook to SKIP decryption,
  // returning raw AES-256-GCM ciphertext. We store this ciphertext as-is in the snapshot.
  // If you select ire/tenantId, the plugin decrypts and you store PLAINTEXT — security bug.
  // Fetch env-specific AND base (null) variables, then deduplicate
  const rawEnvVars = await EnvironmentVariable.find({
    tenantId,
    projectId,
    environment: { $in: [environment, null] },
  })
    .select('_id key encryptedValue isSecret description environment')
    .lean();

  // Deduplicate: environment-specific override wins over base (null)
  const envVarMap = new Map<string, any>();
  for (const v of rawEnvVars as any[]) {
    const existing = envVarMap.get(v.key);
    if (!existing || (v.environment !== null && existing.environment === null)) {
      envVarMap.set(v.key, v);
    }
  }
  const envVars = [...envVarMap.values()];

  // 2. Load all config vars for this project (plaintext, no encryption plugin)
  const configVars = await ProjectConfigVariable.find({
    tenantId,
    projectId,
  }).lean();

  // 3. Load all memberships for these variables
  const allVarIds = [
    ...envVars.map((v: any) => String(v._id)),
    ...configVars.map((v: any) => String(v._id)),
  ];

  const memberships =
    allVarIds.length > 0
      ? await VariableNamespaceMembership.find({
          tenantId,
          variableId: { $in: allVarIds },
        }).lean()
      : [];

  // 4. Load namespace names for denormalization
  const nsIds = [...new Set((memberships as any[]).map((m: any) => String(m.namespaceId)))];
  const namespaces =
    nsIds.length > 0
      ? await VariableNamespace.find({
          _id: { $in: nsIds },
          tenantId,
        }).lean()
      : [];
  const nsNameMap = new Map((namespaces as any[]).map((ns: any) => [String(ns._id), ns.name]));

  // 5. Build variable-to-namespace-names map
  const varNsMap = new Map<string, string[]>();
  for (const m of memberships as any[]) {
    const vid = String(m.variableId);
    const names = varNsMap.get(vid) ?? [];
    const nsName = nsNameMap.get(String(m.namespaceId));
    if (nsName) names.push(nsName);
    varNsMap.set(vid, names);
  }

  // 6. Build snapshot arrays
  const snapshotEnvVars = envVars
    .map((v: any) => ({
      key: v.key,
      encryptedValue: v.encryptedValue,
      isSecret: v.isSecret ?? false,
      description: v.description ?? null,
      sourceId: String(v._id),
      namespaces: (varNsMap.get(String(v._id)) ?? []).sort(),
    }))
    .sort((a: any, b: any) => a.key.localeCompare(b.key));

  const snapshotConfigVars = configVars
    .map((v: any) => ({
      key: v.key,
      value: v.value,
      description: v.description ?? null,
      sourceId: String(v._id),
      namespaces: (varNsMap.get(String(v._id)) ?? []).sort(),
    }))
    .sort((a: any, b: any) => a.key.localeCompare(b.key));

  // 7. Compute snapshot hash
  const hashInput = [
    ...snapshotEnvVars.map((v: any) => `env:${v.key}=${v.encryptedValue}`),
    ...snapshotConfigVars.map((v: any) => `config:${v.key}=${v.value}`),
  ].join('\n');
  const snapshotHash = createHash('sha256').update(hashInput).digest('hex');

  // 8. Create snapshot document
  const snapshot = await DeploymentVariableSnapshot.create({
    tenantId,
    projectId,
    deploymentId,
    environment,
    snapshotVersion: 1,
    snapshotHash,
    envVars: snapshotEnvVars,
    configVars: snapshotConfigVars,
    createdBy,
  });

  log.debug('Deployment snapshot created', {
    deploymentId,
    snapshotHash,
    envVarCount: snapshotEnvVars.length,
    configVarCount: snapshotConfigVars.length,
  });

  return snapshot;
}

export function computeSnapshotDiff(
  source: {
    envVars: Array<{ key: string; encryptedValue: string; namespaces?: string[] }>;
    configVars: Array<{ key: string; value: string; namespaces?: string[] }>;
  },
  target: {
    envVars: Array<{ key: string; encryptedValue: string; namespaces?: string[] }>;
    configVars: Array<{ key: string; value: string; namespaces?: string[] }>;
  },
) {
  const added: Array<{ key: string; type: 'env' | 'config'; namespaces: string[] }> = [];
  const removed: Array<{ key: string; type: 'env' | 'config'; namespaces: string[] }> = [];
  const changed: Array<{
    key: string;
    type: 'env' | 'config';
    valueChanged: boolean;
    namespaces: string[];
  }> = [];

  const sourceEnvMap = new Map(source.envVars.map((v) => [v.key, v]));
  const sourceConfigMap = new Map(source.configVars.map((v) => [v.key, v]));
  const targetEnvMap = new Map(target.envVars.map((v) => [v.key, v]));
  const targetConfigMap = new Map(target.configVars.map((v) => [v.key, v]));

  for (const [key, tv] of targetEnvMap) {
    const sv = sourceEnvMap.get(key);
    if (!sv) {
      added.push({ key, type: 'env', namespaces: tv.namespaces ?? [] });
    } else if (sv.encryptedValue !== tv.encryptedValue) {
      changed.push({ key, type: 'env', valueChanged: true, namespaces: tv.namespaces ?? [] });
    }
  }
  for (const [key, sv] of sourceEnvMap) {
    if (!targetEnvMap.has(key)) {
      removed.push({ key, type: 'env', namespaces: sv.namespaces ?? [] });
    }
  }

  for (const [key, tv] of targetConfigMap) {
    const sv = sourceConfigMap.get(key);
    if (!sv) {
      added.push({ key, type: 'config', namespaces: tv.namespaces ?? [] });
    } else if (sv.value !== tv.value) {
      changed.push({ key, type: 'config', valueChanged: true, namespaces: tv.namespaces ?? [] });
    }
  }
  for (const [key, sv] of sourceConfigMap) {
    if (!targetConfigMap.has(key)) {
      removed.push({ key, type: 'config', namespaces: sv.namespaces ?? [] });
    }
  }

  return { added, removed, changed };
}
