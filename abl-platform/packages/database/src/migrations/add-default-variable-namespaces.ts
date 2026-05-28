/**
 * Migration: Create default namespace and memberships for all existing projects.
 *
 * Idempotent: skips projects that already have a default namespace.
 * Batched: processes 100 projects at a time.
 * Reversible: drop variable_namespaces and variable_namespace_memberships collections.
 */

import {
  VariableNamespace,
  VariableNamespaceMembership,
  EnvironmentVariable,
  ProjectConfigVariable,
} from '../models/index.js';

// Constants for default variable namespace (duplicated from @abl/compiler/platform to avoid circular dependency)
const DEFAULT_VARIABLE_NAMESPACE_NAME = 'default';
const DEFAULT_VARIABLE_NAMESPACE_DISPLAY_NAME = 'Default';

const BATCH_SIZE = 100;

function log(level: string, message: string, context?: Record<string, unknown>) {
  console.log(`[${level.toUpperCase()}] [migration:default-namespaces] ${message}`, context || '');
}

export async function migrateDefaultVariableNamespaces() {
  // Import Project dynamically to avoid circular dependency issues
  const { Project } = await import('@agent-platform/database/models');

  let processed = 0;
  let skip = 0;

  while (true) {
    const projects = await Project.find({}).skip(skip).limit(BATCH_SIZE).lean();
    if (projects.length === 0) break;

    for (const project of projects as any[]) {
      const tenantId = project.tenantId;
      const projectId = String(project._id);

      // Check if default namespace already exists (idempotent)
      let defaultNs: any = await VariableNamespace.findOne({
        tenantId,
        projectId,
        isDefault: true,
      }).lean();

      if (!defaultNs) {
        defaultNs = await VariableNamespace.create({
          tenantId,
          projectId,
          name: DEFAULT_VARIABLE_NAMESPACE_NAME,
          displayName: DEFAULT_VARIABLE_NAMESPACE_DISPLAY_NAME,
          isDefault: true,
          order: 0,
          createdBy: 'system:migration',
        });
        log('info', 'Created default namespace', {
          projectId,
          namespaceId: String(defaultNs._id),
        });
      }

      const nsId = String(defaultNs._id);

      // Find all env vars and config vars for this project
      const envVars = await EnvironmentVariable.find({ tenantId, projectId }).select('_id').lean();
      const configVars = await ProjectConfigVariable.find({ tenantId, projectId })
        .select('_id')
        .lean();
      const allVarIds = [
        ...envVars.map((v: any) => String(v._id)),
        ...configVars.map((v: any) => String(v._id)),
      ];

      if (allVarIds.length === 0) {
        processed++;
        continue;
      }

      // Find which vars already have memberships
      const existingMemberships = await VariableNamespaceMembership.find({
        variableId: { $in: allVarIds },
      }).lean();
      const varsWithMembership = new Set(
        (existingMemberships as any[]).map((m: any) => String(m.variableId)),
      );

      // Create memberships for orphaned variables
      const newMemberships: Array<{
        tenantId: string;
        projectId: string;
        namespaceId: string;
        variableId: string;
        variableType: 'env' | 'config';
      }> = [];

      for (const ev of envVars as any[]) {
        if (!varsWithMembership.has(String(ev._id))) {
          newMemberships.push({
            tenantId,
            projectId,
            namespaceId: nsId,
            variableId: String(ev._id),
            variableType: 'env',
          });
        }
      }

      for (const cv of configVars as any[]) {
        if (!varsWithMembership.has(String(cv._id))) {
          newMemberships.push({
            tenantId,
            projectId,
            namespaceId: nsId,
            variableId: String(cv._id),
            variableType: 'config',
          });
        }
      }

      if (newMemberships.length > 0) {
        try {
          await VariableNamespaceMembership.insertMany(newMemberships, { ordered: false });
        } catch (err: unknown) {
          // Duplicate key errors are expected (idempotent)
          if (err && typeof err === 'object' && 'code' in err && (err as any).code === 11000) {
            // Some already exist, that's fine
          } else {
            throw err;
          }
        }
        log('info', 'Created memberships', {
          projectId,
          count: newMemberships.length,
        });
      }

      processed++;
    }

    skip += BATCH_SIZE;
    log('info', 'Migration progress', { processed, batch: skip / BATCH_SIZE });
  }

  log('info', 'Migration complete', { totalProjects: processed });
}
