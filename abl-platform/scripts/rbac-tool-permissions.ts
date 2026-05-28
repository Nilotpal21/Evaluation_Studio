/**
 * Migration: Align tool/MCP RBAC permissions
 *
 * Date: 2026-02-28
 * Design: docs/plans/2026-02-28-tool-permissions-alignment-design.md
 *
 * Purpose:
 * 1. Update ResourceType 'tool' operations: remove create/update/manage_secrets, add write
 * 2. Deprecate ResourceType 'mcp' (mark inactive, do NOT delete — preserves audit trail)
 * 3. Update all RoleDefinition records: remove mcp:* permissions, add tool:write/tool:delete/tool:execute
 *
 * Safety:
 * - Idempotent: Safe to run multiple times (deterministic operation IDs, skip-if-current checks)
 * - Non-destructive: No deletes — mcp ResourceType is deprecated, not removed
 * - Dry-run mode: Test without making changes
 * - Pre-flight snapshot: Logs current state before any writes
 */

import mongoose from 'mongoose';
import crypto from 'crypto';
import { pathToFileURL } from 'node:url';

// =============================================================================
// TYPES
// =============================================================================

interface MigrationStats {
  resourceTypesUpdated: number;
  resourceTypesDeprecated: number;
  roleDefinitionsUpdated: number;
  roleDefinitionsSkipped: number;
  errors: number;
}

interface MigrationOptions {
  dryRun?: boolean;
  verbose?: boolean;
}

export interface ValidationResult {
  ok: boolean;
  summary: string;
  details?: Record<string, unknown>;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Deterministic operation IDs — derived from a stable namespace so repeated
 * runs produce the same IDs. Uses UUID v5 (name-based SHA-1).
 *
 * Namespace: arbitrary fixed UUID for this migration.
 */
const MIGRATION_NAMESPACE = '7a3e8f1c-2d4b-5e6f-8a9b-0c1d2e3f4a5b';

function deterministicId(name: string): string {
  // Use a simple hash-based approach for deterministic IDs
  const hash = crypto
    .createHash('sha256')
    .update(`${MIGRATION_NAMESPACE}:tool:${name}`)
    .digest('hex');
  // Format as UUID-like string
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-');
}

/** New tool operations (replaces create/update/manage_secrets with write) */
const TARGET_TOOL_OPERATIONS = [
  { name: 'read', displayName: 'Read', id: deterministicId('read') },
  {
    name: 'write',
    displayName: 'Write',
    description: 'Create or update tools and MCP servers',
    id: deterministicId('write'),
  },
  { name: 'delete', displayName: 'Delete', id: deterministicId('delete') },
  {
    name: 'execute',
    displayName: 'Execute',
    description: 'Test or invoke a tool',
    id: deterministicId('execute'),
  },
];

/** Check if tool ResourceType operations already match the target */
function toolOpsAlreadyCurrent(currentOps: string[]): boolean {
  const targetOps = TARGET_TOOL_OPERATIONS.map((o) => o.name).sort();
  const sorted = [...currentOps].sort();
  return sorted.length === targetOps.length && sorted.every((op, i) => op === targetOps[i]);
}

/**
 * Per-role permission updates.
 * - remove: permissions to strip (mcp:* and old tool ops that no longer exist)
 * - add: permissions to ensure are present
 *
 * OWNER uses *:* (no changes needed).
 * ADMIN uses tool:* (wildcard covers write/delete/execute; only mcp removal needed).
 */
const ROLE_PERMISSION_UPDATES: Record<string, { remove: string[]; add: string[] }> = {
  ADMIN: {
    remove: ['mcp:*'],
    add: [],
  },
  OPERATOR: {
    remove: [
      'mcp:read',
      'mcp:write',
      'mcp:delete',
      'mcp:execute',
      'mcp:*',
      'mcp:create',
      'mcp:update',
      'tool:create',
      'tool:update',
      'tool:manage_secrets',
    ],
    add: ['tool:read', 'tool:execute'],
  },
  MEMBER: {
    remove: [
      'mcp:read',
      'mcp:write',
      'mcp:delete',
      'mcp:execute',
      'mcp:*',
      'mcp:create',
      'mcp:update',
      'tool:create',
      'tool:update',
      'tool:manage_secrets',
    ],
    add: ['tool:read', 'tool:write', 'tool:execute'],
  },
  VIEWER: {
    remove: [
      'mcp:read',
      'mcp:write',
      'mcp:delete',
      'mcp:execute',
      'mcp:*',
      'mcp:create',
      'mcp:update',
      'tool:create',
      'tool:update',
      'tool:manage_secrets',
    ],
    add: ['tool:read'],
  },
};

function getDb(explicitDb?: mongoose.mongo.Db): mongoose.mongo.Db {
  const db = explicitDb ?? mongoose.connection.db;
  if (!db) {
    throw new Error('Database connection not established');
  }
  return db;
}

function summarizeValidation(
  issues: Record<string, unknown>,
  details: Record<string, unknown>,
): ValidationResult {
  const hasIssues = Object.values(issues).some((value) => {
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return Boolean(value);
  });

  return hasIssues
    ? {
        ok: false,
        summary: 'RBAC tool permissions are not aligned with the seeded target state.',
        details: {
          ...details,
          issues,
        },
      }
    : {
        ok: true,
        summary: 'RBAC tool permissions match the seeded target state.',
        details,
      };
}

export async function validateRbacToolPermissions(
  db?: mongoose.mongo.Db,
): Promise<ValidationResult> {
  const database = getDb(db);
  const resourceTypes = database.collection('resource_types');
  const roleDefinitions = database.collection('role_definitions');

  const [toolRT, mcpRT, rolesWithMcp] = await Promise.all([
    resourceTypes.findOne({ name: 'tool' }),
    resourceTypes.findOne({ name: 'mcp' }),
    roleDefinitions
      .find({
        permissions: { $elemMatch: { $regex: /^mcp:/ } },
      })
      .project({ _id: 1, name: 1, tenantId: 1 })
      .toArray(),
  ]);

  const toolOperations = Array.isArray(toolRT?.operations)
    ? toolRT.operations.map((operation: any) => String(operation.name))
    : [];
  const missingToolResourceType = !toolRT;
  const toolOperationsMisaligned =
    !missingToolResourceType && !toolOpsAlreadyCurrent(toolOperations);
  const mcpStillActive = Boolean(mcpRT && !mcpRT.isDeprecated);

  return summarizeValidation(
    {
      missingToolResourceType,
      toolOperationsMisaligned,
      mcpStillActive,
      rolesWithLegacyMcpPermissions: rolesWithMcp.map((role) => ({
        id: String(role._id),
        name: String(role.name),
        tenantId: String(role.tenantId),
      })),
    },
    {
      toolOperations,
      expectedToolOperations: TARGET_TOOL_OPERATIONS.map((operation) => operation.name),
      mcpDeprecated: mcpRT ? Boolean(mcpRT.isDeprecated) : null,
      legacyMcpRoleCount: rolesWithMcp.length,
    },
  );
}

// =============================================================================
// MIGRATION LOGIC
// =============================================================================

export async function migrateRbacToolPermissions(
  options: MigrationOptions = {},
): Promise<MigrationStats> {
  const { dryRun = false, verbose = false } = options;

  const stats: MigrationStats = {
    resourceTypesUpdated: 0,
    resourceTypesDeprecated: 0,
    roleDefinitionsUpdated: 0,
    roleDefinitionsSkipped: 0,
    errors: 0,
  };

  console.log('========================================');
  console.log('Migration: Align tool/MCP RBAC permissions');
  console.log('========================================');
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE (will modify data)'}`);
  console.log('');

  const db = getDb();

  // ─── Pre-flight: Snapshot current state ─────────────────────────────

  console.log('Pre-flight snapshot:');
  const resourceTypes = db.collection('resource_types');
  const roleDefinitions = db.collection('role_definitions');

  const toolRT = await resourceTypes.findOne({ name: 'tool' });
  const mcpRT = await resourceTypes.findOne({ name: 'mcp' });
  const totalRoleDefs = await roleDefinitions.countDocuments();

  console.log(
    `  ResourceType "tool": ${toolRT ? `found (ops: ${(toolRT.operations || []).map((o: any) => o.name).join(', ')})` : 'NOT FOUND'}`,
  );
  console.log(
    `  ResourceType "mcp":  ${mcpRT ? (mcpRT.isDeprecated ? 'found (already deprecated)' : 'found (active)') : 'NOT FOUND'}`,
  );
  console.log(`  Total RoleDefinitions: ${totalRoleDefs}`);
  console.log('');

  // ─── Step 1: Update ResourceType 'tool' operations ──────────────────

  console.log('Step 1: Update ResourceType "tool" operations');
  try {
    if (!toolRT) {
      console.log('  ⚠ ResourceType "tool" not found — will be created on next seed run');
    } else {
      const currentOps = (toolRT.operations || []).map((o: any) => o.name);

      if (toolOpsAlreadyCurrent(currentOps)) {
        console.log('  ✓ ResourceType "tool" already up to date');
      } else {
        if (verbose) {
          console.log(`  Current ops: ${currentOps.join(', ')}`);
          console.log(`  Target ops:  ${TARGET_TOOL_OPERATIONS.map((o) => o.name).join(', ')}`);
        }

        if (!dryRun) {
          const now = new Date();
          const operations = TARGET_TOOL_OPERATIONS.map((op) => ({
            id: op.id,
            name: op.name,
            displayName: op.displayName,
            description: op.description ?? null,
            isSystem: true,
            createdAt: now,
          }));

          await resourceTypes.updateOne(
            { name: 'tool' },
            {
              $set: {
                operations,
                description: 'Service node / external tool integration (includes MCP servers)',
              },
            },
          );
        }
        stats.resourceTypesUpdated++;
        console.log('  ✓ Updated ResourceType "tool" operations');
      }
    }
  } catch (error) {
    stats.errors++;
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`  ✗ Error updating ResourceType "tool": ${msg}`);
  }

  // ─── Step 2: Deprecate ResourceType 'mcp' (soft — no delete) ────────

  console.log('');
  console.log('Step 2: Deprecate ResourceType "mcp" (soft — no delete)');
  try {
    if (!mcpRT) {
      console.log('  ✓ ResourceType "mcp" does not exist — nothing to deprecate');
    } else if (mcpRT.isDeprecated) {
      console.log('  ✓ ResourceType "mcp" already deprecated');
    } else {
      if (!dryRun) {
        await resourceTypes.updateOne(
          { name: 'mcp' },
          {
            $set: {
              isDeprecated: true,
              deprecatedAt: new Date(),
              deprecationNote: 'MCP servers now use tool:* permissions. See migration 2026-02-28.',
            },
          },
        );
      }
      stats.resourceTypesDeprecated++;
      console.log('  ✓ Marked ResourceType "mcp" as deprecated (preserved for audit trail)');
    }
  } catch (error) {
    stats.errors++;
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`  ✗ Error deprecating ResourceType "mcp": ${msg}`);
  }

  // ─── Step 3: Update system RoleDefinition permissions ───────────────

  console.log('');
  console.log('Step 3: Update system RoleDefinition permissions (all tenants)');
  try {
    for (const [roleName, updates] of Object.entries(ROLE_PERMISSION_UPDATES)) {
      const roles = await roleDefinitions.find({ name: roleName }).toArray();

      if (roles.length === 0) {
        if (verbose) console.log(`  - No RoleDefinitions found for ${roleName}`);
        continue;
      }

      console.log(`  Processing ${roleName} (${roles.length} tenant(s))...`);

      for (const role of roles) {
        try {
          const currentPerms: string[] = role.permissions || [];

          // Remove old permissions
          const newPerms = currentPerms.filter((p: string) => !updates.remove.includes(p));

          // Add new permissions (only if not already present)
          for (const perm of updates.add) {
            if (!newPerms.includes(perm)) {
              newPerms.push(perm);
            }
          }

          // Check if anything actually changed (set comparison, order-insensitive)
          const currentSet = new Set(currentPerms);
          const newSet = new Set(newPerms);
          const changed =
            currentSet.size !== newSet.size ||
            [...currentSet].some((p) => !newSet.has(p)) ||
            [...newSet].some((p) => !currentSet.has(p));

          if (!changed) {
            stats.roleDefinitionsSkipped++;
            if (verbose)
              console.log(`    - ${roleName} (tenant: ${role.tenantId}) — already correct`);
            continue;
          }

          if (verbose) {
            const removed = currentPerms.filter((p: string) => !newSet.has(p));
            const added = [...newSet].filter((p: string) => !currentSet.has(p));
            if (removed.length) console.log(`    Removing: ${removed.join(', ')}`);
            if (added.length) console.log(`    Adding:   ${added.join(', ')}`);
          }

          if (!dryRun) {
            await roleDefinitions.updateOne({ _id: role._id }, { $set: { permissions: newPerms } });
          }

          stats.roleDefinitionsUpdated++;
          if (verbose) {
            console.log(`    ✓ Updated ${roleName} (tenant: ${role.tenantId})`);
          }
        } catch (error) {
          stats.errors++;
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`    ✗ Error updating ${roleName} (tenant: ${role.tenantId}): ${msg}`);
        }
      }
    }

    // Handle custom roles that have mcp:* permissions
    console.log('');
    console.log('  Checking custom roles for stale mcp:* permissions...');
    const systemRoleNames = Object.keys(ROLE_PERMISSION_UPDATES).concat(['OWNER']);
    const customRolesWithMcp = await roleDefinitions
      .find({
        name: { $nin: systemRoleNames },
        permissions: { $elemMatch: { $regex: /^mcp:/ } },
      })
      .toArray();

    if (customRolesWithMcp.length === 0) {
      console.log('  ✓ No custom roles with mcp:* permissions found');
    } else {
      console.log(`  Found ${customRolesWithMcp.length} custom role(s) with mcp:* permissions`);

      for (const role of customRolesWithMcp) {
        try {
          const currentPerms: string[] = role.permissions || [];

          // Check if any mcp: permissions remain (idempotency check)
          const hasMcpPerms = currentPerms.some((p: string) => p.startsWith('mcp:'));
          if (!hasMcpPerms) {
            stats.roleDefinitionsSkipped++;
            if (verbose)
              console.log(
                `    - ${role.name} (tenant: ${role.tenantId}) — no mcp: perms remaining`,
              );
            continue;
          }

          // Replace mcp:X → tool:X, mapping coarsely
          const newPerms = currentPerms.map((p: string) => {
            if (!p.startsWith('mcp:')) return p;
            const op = p.split(':')[1];
            // Map mcp operations to tool equivalents
            switch (op) {
              case 'create':
              case 'update':
                return 'tool:write';
              case 'read':
                return 'tool:read';
              case 'delete':
                return 'tool:delete';
              case 'execute':
                return 'tool:execute';
              case '*':
                // mcp:* → tool:read + tool:write + tool:delete + tool:execute
                // NOT tool:* — that would be privilege escalation
                return null; // handled below
              default:
                return `tool:${op}`;
            }
          });

          // Handle mcp:* wildcard expansion (no escalation to tool:*)
          let finalPerms: string[];
          if (currentPerms.includes('mcp:*')) {
            const withoutNull = newPerms.filter((p): p is string => p !== null);
            // Add the expanded set instead of tool:*
            const mcpWildcardExpansion = ['tool:read', 'tool:write', 'tool:delete', 'tool:execute'];
            finalPerms = [...new Set([...withoutNull, ...mcpWildcardExpansion])];
          } else {
            finalPerms = [...new Set(newPerms.filter((p): p is string => p !== null))];
          }

          if (verbose) {
            console.log(`    Custom role: ${role.name} (tenant: ${role.tenantId})`);
            console.log(`      Before: ${currentPerms.join(', ')}`);
            console.log(`      After:  ${finalPerms.join(', ')}`);
          }

          if (!dryRun) {
            await roleDefinitions.updateOne(
              { _id: role._id },
              { $set: { permissions: finalPerms } },
            );
          }

          stats.roleDefinitionsUpdated++;
        } catch (error) {
          stats.errors++;
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`    ✗ Error updating custom role ${role.name}: ${msg}`);
        }
      }
    }
  } catch (error) {
    stats.errors++;
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`  ✗ Error updating RoleDefinitions: ${msg}`);
  }

  // ─── Post-flight: Verify final state ────────────────────────────────

  console.log('');
  console.log('Post-flight verification:');
  const toolRTAfter = await resourceTypes.findOne({ name: 'tool' });
  const mcpRTAfter = await resourceTypes.findOne({ name: 'mcp' });
  const rolesWithMcpAfter = await roleDefinitions.countDocuments({
    permissions: { $elemMatch: { $regex: /^mcp:/ } },
  });

  if (toolRTAfter) {
    const ops = (toolRTAfter.operations || []).map((o: any) => o.name);
    const isCorrect = toolOpsAlreadyCurrent(ops);
    console.log(`  ResourceType "tool" ops: ${ops.join(', ')} ${isCorrect ? '✓' : '⚠ UNEXPECTED'}`);
  }
  if (mcpRTAfter) {
    console.log(
      `  ResourceType "mcp": ${mcpRTAfter.isDeprecated ? 'deprecated ✓' : 'still active ⚠'}`,
    );
  }
  console.log(
    `  RoleDefinitions with mcp:* perms: ${rolesWithMcpAfter}${rolesWithMcpAfter === 0 || dryRun ? ' ✓' : ' ⚠ UNEXPECTED'}`,
  );

  // ─── Summary ────────────────────────────────────────────────────────

  console.log('');
  console.log('========================================');
  console.log('Migration Summary');
  console.log('========================================');
  console.log(`ResourceTypes updated:      ${stats.resourceTypesUpdated}`);
  console.log(`ResourceTypes deprecated:   ${stats.resourceTypesDeprecated}`);
  console.log(`RoleDefinitions updated:    ${stats.roleDefinitionsUpdated}`);
  console.log(`RoleDefinitions skipped:    ${stats.roleDefinitionsSkipped}`);
  console.log(`Errors:                     ${stats.errors}`);
  console.log('');

  if (dryRun) {
    console.log('✓ DRY RUN COMPLETE — No changes made');
    console.log('  Run without --dry-run flag to apply changes');
  } else if (stats.errors === 0) {
    console.log('✅ MIGRATION COMPLETE');
  } else {
    console.log(`⚠️  MIGRATION COMPLETE WITH ${stats.errors} ERROR(S)`);
  }

  return stats;
}

// =============================================================================
// CLI RUNNER
// =============================================================================

/**
 * Run migration from command line
 *
 * Usage (from repository root):
 *
 *   # Dry run (no changes) — RECOMMENDED FIRST
 *   pnpm tsx scripts/migrate-rbac-tool-permissions.ts --dry-run
 *
 *   # Dry run + verbose (shows each role being updated)
 *   pnpm tsx scripts/migrate-rbac-tool-permissions.ts --dry-run --verbose
 *
 *   # Live run (applies changes)
 *   pnpm tsx scripts/migrate-rbac-tool-permissions.ts
 *
 *   # Custom MongoDB URL
 *   MONGODB_URL=mongodb://user:pass@host:port/abl_platform?authSource=admin \
 *     pnpm tsx scripts/migrate-rbac-tool-permissions.ts
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verbose = args.includes('--verbose');

  const mongoUrl =
    process.env.MONGODB_URL ||
    process.env.MONGO_URL ||
    'mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform?authSource=admin&directConnection=true';

  try {
    console.log(`Connecting to MongoDB: ${mongoUrl.replace(/\/\/[^@]+@/, '//<credentials>@')}`);
    await mongoose.connect(mongoUrl);
    console.log('✓ Connected to MongoDB');
    console.log('');

    await migrateRbacToolPermissions({ dryRun, verbose });

    await mongoose.disconnect();
    console.log('');
    console.log('✓ Disconnected from MongoDB');

    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }
}

function isMainModule(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  void main();
}
