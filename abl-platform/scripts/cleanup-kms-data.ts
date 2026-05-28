#!/usr/bin/env npx tsx
/**
 * KMS data cleanup and normalization script.
 *
 * Dry run by default. Use --apply to persist changes.
 *
 * What it does:
 * - removes legacy tier metadata from tenant_kms_configs and materialized_kms_configs
 * - merges duplicate tenant/project environment overrides inside tenant_kms_configs
 * - backfills missing local wrappingProvider metadata in dek_registry
 * - reports stale decrypt_only DEKs and scope-level active-key anomalies
 *
 * Usage:
 *   npx tsx scripts/cleanup-kms-data.ts
 *   npx tsx scripts/cleanup-kms-data.ts --tenant <tenantId>
 *   npx tsx scripts/cleanup-kms-data.ts --apply
 */

import mongoose, { type Document } from 'mongoose';
import { config as loadEnv } from 'dotenv';

loadEnv();

const MONGODB_URI =
  process.env.MONGODB_URI ||
  process.env.MONGODB_URL ||
  process.env.DATABASE_URL ||
  process.env.MONGO_URL;

if (!MONGODB_URI) {
  console.error('ERROR: Set MONGODB_URI, MONGODB_URL, DATABASE_URL, or MONGO_URL.');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const tenantIndex = process.argv.indexOf('--tenant');
const TENANT_ID = tenantIndex >= 0 ? process.argv[tenantIndex + 1] : undefined;

type EnvironmentOverride = {
  environment: string;
  provider: Record<string, unknown> | null;
};

type ProjectOverride = {
  projectId: string;
  defaultProvider?: Record<string, unknown> | null;
  environments?: EnvironmentOverride[];
};

type TenantKMSDoc = Document & {
  tenantId: string;
  environments?: EnvironmentOverride[];
  projects?: ProjectOverride[];
};

function normalizeEnvironmentOverrides(overrides: EnvironmentOverride[] | null | undefined): {
  overrides: EnvironmentOverride[];
  changed: boolean;
} {
  const map = new Map<string, EnvironmentOverride>();
  let changed = false;

  for (const entry of overrides ?? []) {
    if (!entry?.environment) {
      changed = true;
      continue;
    }

    const normalized: EnvironmentOverride = {
      environment: entry.environment,
      provider: entry.provider ?? null,
    };

    if ('tier' in entry) {
      changed = true;
    }
    if (map.has(entry.environment)) {
      changed = true;
    }

    map.set(entry.environment, normalized);
  }

  return { overrides: Array.from(map.values()), changed };
}

function normalizeProjectOverrides(projects: ProjectOverride[] | null | undefined): {
  projects: ProjectOverride[];
  changed: boolean;
} {
  const map = new Map<string, ProjectOverride>();
  let changed = false;

  for (const project of projects ?? []) {
    if (!project?.projectId) {
      changed = true;
      continue;
    }

    const existing = map.get(project.projectId);
    const normalizedEnvironments = normalizeEnvironmentOverrides(project.environments);
    const nextProject: ProjectOverride = {
      projectId: project.projectId,
      defaultProvider: project.defaultProvider ?? existing?.defaultProvider ?? null,
      environments: normalizedEnvironments.overrides,
    };

    if (normalizedEnvironments.changed) {
      changed = true;
    }
    if (existing) {
      changed = true;
      nextProject.defaultProvider = project.defaultProvider ?? existing.defaultProvider ?? null;
      nextProject.environments = normalizeEnvironmentOverrides([
        ...(existing.environments ?? []),
        ...(normalizedEnvironments.overrides ?? []),
      ]).overrides;
    }

    map.set(project.projectId, nextProject);
  }

  return { projects: Array.from(map.values()), changed };
}

async function main() {
  console.log(`Connecting to MongoDB (${APPLY ? 'apply mode' : 'dry run'})...`);
  await mongoose.connect(MONGODB_URI);
  console.log('Connected.');

  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('MongoDB connection did not expose a database handle');
  }

  const tenantFilter = TENANT_ID ? { tenantId: TENANT_ID } : {};
  const tenantConfigs = db.collection<TenantKMSDoc>('tenant_kms_configs');
  const materializedConfigs = db.collection('materialized_kms_configs');
  const dekRegistry = db.collection('dek_registry');

  let tenantConfigUpdated = 0;
  let materializedUpdated = 0;
  let dekMetadataBackfilled = 0;

  const tenantDocs = await tenantConfigs.find(tenantFilter).toArray();
  for (const doc of tenantDocs) {
    const normalizedTenantEnvironments = normalizeEnvironmentOverrides(doc.environments);
    const normalizedProjects = normalizeProjectOverrides(doc.projects);
    const changed = normalizedTenantEnvironments.changed || normalizedProjects.changed;

    if (!changed) {
      continue;
    }

    tenantConfigUpdated += 1;
    console.log(`Tenant config normalization needed: ${doc.tenantId}`);

    if (APPLY) {
      await tenantConfigs.updateOne(
        { _id: doc._id },
        {
          $set: {
            environments: normalizedTenantEnvironments.overrides,
            projects: normalizedProjects.projects,
          },
          $inc: { _v: 1 },
        },
      );
    }
  }

  const materializedCursor = materializedConfigs.find({
    ...tenantFilter,
    resolvedTier: { $exists: true },
  });
  for await (const doc of materializedCursor) {
    materializedUpdated += 1;
    console.log(
      `Materialized config legacy cleanup needed: ${(doc as { tenantId?: string }).tenantId ?? 'unknown'}`,
    );

    if (APPLY) {
      await materializedConfigs.updateOne({ _id: doc._id }, { $unset: { resolvedTier: '' } });
    }
  }

  const missingWrappingProviderFilter = {
    ...tenantFilter,
    $or: [{ wrappingProvider: { $exists: false } }, { wrappingProvider: null }],
    kekKeyId: { $exists: true, $ne: null },
  };
  const missingWrappingProviderCount = await dekRegistry.countDocuments(
    missingWrappingProviderFilter,
  );

  if (missingWrappingProviderCount > 0) {
    console.log(`DEKs missing wrappingProvider metadata: ${missingWrappingProviderCount}`);
    if (APPLY) {
      const updateResult = await dekRegistry.updateMany(missingWrappingProviderFilter, [
        {
          $set: {
            wrappingProvider: {
              providerType: 'local',
              keyId: '$kekKeyId',
            },
          },
        },
      ]);
      dekMetadataBackfilled = updateResult.modifiedCount;
    }
  }

  const staleDecryptOnly = await dekRegistry.countDocuments({
    ...tenantFilter,
    status: 'decrypt_only',
    retiredAt: {
      $lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
    },
  });

  const duplicateActiveScopes = await dekRegistry
    .aggregate([
      {
        $match: {
          ...tenantFilter,
          status: 'active',
        },
      },
      {
        $group: {
          _id: {
            tenantId: '$tenantId',
            projectId: '$projectId',
            environment: '$environment',
          },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 20 },
    ])
    .toArray();

  console.log('\nSummary');
  console.log(`  Tenant KMS configs needing normalization: ${tenantConfigUpdated}`);
  console.log(`  Materialized KMS configs needing normalization: ${materializedUpdated}`);
  console.log(`  DEKs missing wrappingProvider metadata: ${missingWrappingProviderCount}`);
  console.log(`  Decrypt-only DEKs older than 90 days: ${staleDecryptOnly}`);
  console.log(`  Scope anomalies with >1 active DEK: ${duplicateActiveScopes.length}`);

  if (duplicateActiveScopes.length > 0) {
    console.log('\nSample duplicate active scopes:');
    for (const entry of duplicateActiveScopes) {
      console.log(
        `  tenant=${entry._id.tenantId} project=${entry._id.projectId} environment=${entry._id.environment} active=${entry.count}`,
      );
    }
  }

  if (APPLY) {
    console.log('\nApplied changes');
    console.log(`  Tenant KMS configs updated: ${tenantConfigUpdated}`);
    console.log(`  Materialized KMS configs updated: ${materializedUpdated}`);
    console.log(`  DEK wrappingProvider backfills: ${dekMetadataBackfilled}`);
  } else {
    console.log('\nDry run only. Re-run with --apply to persist normalization changes.');
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('KMS cleanup failed:', error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
