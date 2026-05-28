/**
 * Migration Script: Workflow Versions Backfill
 *
 * Ensures every Workflow has a draft WorkflowVersion, and every
 * TriggerRegistration is linked to a version via workflowVersionId.
 *
 * Usage:
 *   pnpm migrate:workflow-versions [--dry-run] [--tenant-id <id>] [--batch-size <n>]
 */

import mongoose from 'mongoose';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('migrate-workflow-versions');

// ─── CLI Args ────────────────────────────────────────────────────────────

function parseArgs(): { dryRun: boolean; tenantId?: string; batchSize: number } {
  const args = process.argv.slice(2);
  let dryRun = false;
  let tenantId: string | undefined;
  let batchSize = 100;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--tenant-id' && args[i + 1]) {
      tenantId = args[++i];
    } else if (args[i] === '--batch-size' && args[i + 1]) {
      batchSize = parseInt(args[++i], 10);
    }
  }

  return { dryRun, tenantId, batchSize };
}

// ─── Migration ───────────────────────────────────────────────────────────

interface MigrationStats {
  workflowsScanned: number;
  draftsCreated: number;
  triggersUpdated: number;
  errors: string[];
}

async function migrate(options: {
  dryRun: boolean;
  tenantId?: string;
  batchSize: number;
}): Promise<MigrationStats> {
  const { dryRun, tenantId, batchSize } = options;
  const stats: MigrationStats = {
    workflowsScanned: 0,
    draftsCreated: 0,
    triggersUpdated: 0,
    errors: [],
  };

  const { Workflow, WorkflowVersion, TriggerRegistration } =
    await import('@agent-platform/database/models');

  // Build workflow filter
  const workflowFilter: Record<string, unknown> = { deleted: { $ne: true } };
  if (tenantId) workflowFilter.tenantId = tenantId;

  // Process workflows in batches
  let skip = 0;
  let hasMore = true;

  while (hasMore) {
    const workflows = await Workflow.find(workflowFilter).skip(skip).limit(batchSize).lean();

    if (workflows.length === 0) {
      hasMore = false;
      break;
    }

    for (const wf of workflows) {
      stats.workflowsScanned++;
      const wfId = String(wf._id);

      try {
        // (a) Ensure draft version exists
        const existingDraft = await WorkflowVersion.findOne({
          workflowId: wfId,
          version: 'draft',
          tenantId: wf.tenantId,
          projectId: wf.projectId,
        }).lean();

        if (!existingDraft) {
          if (dryRun) {
            log.info('Would create draft version', { workflowId: wfId });
          } else {
            const definition = {
              nodes: (wf as Record<string, unknown>).nodes ?? [],
              edges: (wf as Record<string, unknown>).edges ?? [],
              envVars: (wf as Record<string, unknown>).envVars ?? {},
              inputSchema: (wf as Record<string, unknown>).inputSchema ?? null,
              outputSchema: (wf as Record<string, unknown>).outputSchema ?? null,
            };
            const { createHash } = await import('crypto');
            // Use deepSortKeys for canonical JSON to match the service's computeSourceHash
            const deepSortKeys = (obj: unknown): unknown => {
              if (Array.isArray(obj)) return obj.map(deepSortKeys);
              if (obj !== null && typeof obj === 'object') {
                return Object.keys(obj as Record<string, unknown>)
                  .sort()
                  .reduce<Record<string, unknown>>((acc, k) => {
                    acc[k] = deepSortKeys((obj as Record<string, unknown>)[k]);
                    return acc;
                  }, {});
              }
              return obj;
            };
            const sourceHash = createHash('sha256')
              .update(JSON.stringify(deepSortKeys(definition)))
              .digest('hex')
              .slice(0, 16);

            await WorkflowVersion.create({
              workflowId: wfId,
              tenantId: wf.tenantId,
              projectId: wf.projectId,
              version: 'draft',
              // state is intentionally omitted for drafts (per LD-13)
              definition,
              triggers: [],
              sourceHash,
              createdBy: 'system-migration',
              _v: 0,
            });
          }
          stats.draftsCreated++;
        }

        // (b) Update trigger registrations without workflowVersionId
        const draftVersion =
          existingDraft ??
          (await WorkflowVersion.findOne({
            workflowId: wfId,
            version: 'draft',
            tenantId: wf.tenantId,
            projectId: wf.projectId,
          }).lean());

        if (draftVersion) {
          const draftId = String(draftVersion._id);
          const triggersToUpdate = await TriggerRegistration.find({
            workflowId: wfId,
            tenantId: wf.tenantId,
            workflowVersionId: { $exists: false },
          }).lean();

          for (const trigger of triggersToUpdate) {
            if (dryRun) {
              log.info('Would update trigger registration', {
                triggerId: String(trigger._id),
                workflowVersionId: draftId,
              });
            } else {
              await TriggerRegistration.updateOne(
                { _id: trigger._id },
                { $set: { workflowVersionId: draftId, workflowVersion: 'draft' } },
              );
            }
            stats.triggersUpdated++;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        stats.errors.push(`Workflow ${wfId}: ${message}`);
        log.error('Migration error for workflow', { workflowId: wfId, error: message });
      }
    }

    skip += batchSize;
    if (workflows.length < batchSize) hasMore = false;
  }

  return stats;
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseArgs();

  log.info('Starting workflow versions migration', {
    dryRun: options.dryRun,
    tenantId: options.tenantId ?? 'all',
    batchSize: options.batchSize,
  });

  const mongoUri =
    process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/abl';
  await mongoose.connect(mongoUri);
  log.info('Connected to MongoDB', { uri: mongoUri.replace(/\/\/[^@]+@/, '//***@') });

  try {
    const stats = await migrate(options);

    log.info('Migration complete', {
      ...stats,
      dryRun: options.dryRun,
      errorCount: stats.errors.length,
    });

    if (stats.errors.length > 0) {
      log.warn('Migration had errors', { errors: stats.errors });
    }

    if (options.dryRun) {
      log.info('DRY RUN — no changes were made');
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  log.error('Migration failed', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
