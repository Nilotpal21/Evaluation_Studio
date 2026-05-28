/**
 * Stale Sandbox Cleanup
 *
 * Finds and deletes e2e-smoke tenants older than 1 hour.
 * Run via: pnpm e2e:cleanup-stale (or: npx tsx tools/agents/e2e-smoke/cleanup-stale.ts)
 *
 * Uses Mongoose directly against the same MongoDB instance as the platform.
 */

import {
  Tenant,
  TenantMember,
  User,
  Project,
  ProjectAgent,
  Session,
  ensureConnected,
} from '@agent-platform/database/models';
import mongoose from 'mongoose';

// ─── Constants ──────────────────────────────────────────────────────────────

const SANDBOX_SLUG_PATTERN = /^e2e-smoke-\d{13}$/;
const SANDBOX_EMAIL_DOMAIN = 'e2e-smoke.test';
const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

// ─── Main ───────────────────────────────────────────────────────────────────

export async function cleanupStaleSandboxes(): Promise<{
  found: number;
  deleted: number;
  errors: string[];
}> {
  await ensureConnected();

  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);

  // Find all e2e-smoke tenants created before the cutoff
  const staleTenants = await Tenant.find({
    slug: { $regex: SANDBOX_SLUG_PATTERN },
    createdAt: { $lt: cutoff },
  }).lean();

  const result = { found: staleTenants.length, deleted: 0, errors: [] as string[] };

  if (staleTenants.length === 0) {
    console.log('[Cleanup] No stale e2e-smoke tenants found.');
    return result;
  }

  console.log(`[Cleanup] Found ${staleTenants.length} stale e2e-smoke tenant(s).`);

  for (const tenant of staleTenants) {
    const tenantId = String(tenant._id);
    const label = `${tenant.slug} (${tenantId})`;

    try {
      console.log(`[Cleanup] Deleting tenant: ${label}`);

      // Delete in dependency order: sessions -> agents -> projects -> members -> tenant
      const sessionResult = await Session.deleteMany({ tenantId });
      console.log(`  Sessions deleted: ${sessionResult.deletedCount}`);

      const agentResult = await ProjectAgent.deleteMany({ tenantId });
      console.log(`  Agents deleted: ${agentResult.deletedCount}`);

      const projectResult = await Project.deleteMany({ tenantId });
      console.log(`  Projects deleted: ${projectResult.deletedCount}`);

      const memberResult = await TenantMember.deleteMany({ tenantId });
      console.log(`  Members deleted: ${memberResult.deletedCount}`);

      // Delete the user if it matches the e2e-smoke email pattern
      const ownerId = String(tenant.ownerId);
      if (ownerId && !ownerId.startsWith('e2e-placeholder-')) {
        const user = await User.findOne({ _id: ownerId }).lean();
        if (user && (user as { email?: string }).email?.endsWith(`@${SANDBOX_EMAIL_DOMAIN}`)) {
          await User.deleteOne({ _id: ownerId });
          console.log(`  User deleted: ${ownerId}`);
        }
      }

      // Delete the tenant itself
      await Tenant.deleteOne({ _id: tenantId });
      console.log(`  Tenant deleted: ${label}`);

      // Verify
      const check = await Tenant.findOne({ _id: tenantId }).lean();
      if (check) {
        const errMsg = `Tenant ${label} still exists after deletion`;
        console.warn(`  WARNING: ${errMsg}`);
        result.errors.push(errMsg);
      } else {
        result.deleted++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Cleanup] Error deleting tenant ${label}: ${msg}`);
      result.errors.push(`${label}: ${msg}`);
    }
  }

  // Also clean up any orphaned e2e-smoke users (no matching tenant).
  // Note: there is a small TOCTOU window between the Tenant.findOne check and
  // User.findOneAndDelete — a new tenant could reference this user in between.
  // Accepted risk: this is a best-effort CLI cleanup; orphans are caught next run.
  try {
    const orphanedUsers = await User.find({
      email: { $regex: `@${SANDBOX_EMAIL_DOMAIN.replace(/\./g, '\\.')}$` },
      createdAt: { $lt: cutoff },
    }).lean();

    for (const user of orphanedUsers) {
      const userId = String(user._id);
      // Atomically delete only if no tenant still references this user
      const hasActiveTenant = await Tenant.findOne({ ownerId: userId }).lean();
      if (!hasActiveTenant) {
        const deleted = await User.findOneAndDelete({ _id: userId });
        if (deleted) {
          console.log(`[Cleanup] Deleted orphaned user: ${(user as { email?: string }).email}`);
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Cleanup] Error cleaning orphaned users: ${msg}`);
  }

  console.log(
    `[Cleanup] Done. Deleted ${result.deleted}/${result.found} stale tenants.` +
      (result.errors.length > 0 ? ` Errors: ${result.errors.length}` : ''),
  );

  return result;
}

// ─── CLI Entry Point ────────────────────────────────────────────────────────

async function main() {
  try {
    const result = await cleanupStaleSandboxes();

    if (result.errors.length > 0) {
      console.error('\nErrors encountered:');
      for (const error of result.errors) {
        console.error(`  - ${error}`);
      }
      process.exitCode = 1;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[Cleanup] Fatal error: ${msg}`);
    process.exitCode = 1;
  } finally {
    // Disconnect Mongoose to allow the process to exit cleanly
    await mongoose.disconnect();
  }
}

main();
