#!/usr/bin/env node
/**
 * Migration CLI
 *
 * Usage:
 *   pnpm db:migrate:mongo          — Apply all pending migrations
 *   pnpm db:migrate:mongo:status   — Show migration status
 *   pnpm db:migrate:mongo:validate — Re-run validation checks for applied migrations
 *   pnpm db:migrate:mongo:rollback — Rollback last migration
 */

import mongoose from 'mongoose';
import { pathToFileURL } from 'node:url';
import { CHANGE_PHASES, type ChangePhase } from '../change-management/types.js';
import { MigrationRunner } from './runner.js';
import { mongoMigrations } from './registry.js';
import { resolveMongoCliConnection } from '../mongo/cli-connection.js';
import { getBlockingValidationResults } from './validation-exit.js';

interface CliOptions {
  phase?: ChangePhase;
}

function parsePhase(value: string): ChangePhase {
  const normalized = value.replace(/-/g, '_');
  if (!CHANGE_PHASES.includes(normalized as ChangePhase)) {
    throw new Error(`Invalid --phase value: ${value}`);
  }

  return normalized as ChangePhase;
}

export function parseCliOptions(args: string[]): CliOptions {
  const options: CliOptions = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--phase') {
      const phase = args[index + 1];
      if (!phase) {
        throw new Error('--phase requires a value');
      }
      options.phase = parsePhase(phase);
      index += 1;
      continue;
    }

    if (arg.startsWith('--phase=')) {
      const phase = arg.slice('--phase='.length);
      options.phase = parsePhase(phase);
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

export function parseRollbackSteps(value: string | undefined): number {
  const rawValue = value ?? '1';
  if (!/^[1-9]\d*$/.test(rawValue)) {
    throw new Error(`Invalid rollback steps value: ${rawValue}`);
  }

  return Number.parseInt(rawValue, 10);
}

// ─── CLI ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const command = process.argv[2] || 'migrate';
  const options =
    command === 'migrate' || command === 'validate' ? parseCliOptions(process.argv.slice(3)) : {};
  const requireManifestMetadata = Boolean(options.phase);
  const connection = resolveMongoCliConnection();

  console.log(`[Migration CLI] Connecting to ${connection.redactedTarget}...`);

  await mongoose.connect(connection.url, connection.options);
  console.log('[Migration CLI] Connected.');

  const runner = new MigrationRunner(mongoMigrations);

  try {
    switch (command) {
      case 'migrate': {
        const result = await runner.migrate({ ...options, requireManifestMetadata });
        console.log('\n─── Migration Result ───');
        if (options.phase) {
          console.log(`  Phase:   ${options.phase}`);
        }
        console.log(`  Applied: ${result.applied.length}`);
        if (result.applied.length > 0) {
          for (const v of result.applied) console.log(`    ✓ ${v}`);
        }
        if (result.failed) {
          console.log(`  Failed:  ${result.failed}`);
          process.exitCode = 1;
        }
        if (result.skipped.length > 0) {
          console.log(`  Skipped: ${result.skipped.join(', ')}`);
        }
        console.log(`  Duration: ${result.durationMs}ms`);
        break;
      }

      case 'status': {
        const statuses = await runner.status();
        console.log('\n─── Migration Status ───');
        for (const s of statuses) {
          const icon =
            s.status === 'applied'
              ? '✓'
              : s.status === 'rolled_back'
                ? '↩'
                : s.status === 'failed'
                  ? '✗'
                  : '○';
          const time = s.appliedAt ? ` (${s.appliedAt.toISOString()})` : '';
          const checksum =
            s.checksumStatus === 'mismatch'
              ? ' checksum:drift'
              : s.checksumStatus === 'missing'
                ? ' checksum:missing'
                : '';
          const validation =
            s.validationStatus && s.validationStatus !== 'never_run'
              ? ` validation:${s.validationStatus}`
              : s.validationStatus === 'never_run'
                ? ' validation:never_run'
                : '';
          const error = s.lastError ? ` error:${s.lastError}` : '';
          console.log(
            `  ${icon} ${s.version} — ${s.description}${time}${checksum}${validation}${error}`,
          );
        }
        break;
      }

      case 'validate': {
        const results = await runner.validate({ ...options, requireManifestMetadata });
        console.log('\n─── Migration Validation ───');
        if (options.phase) {
          console.log(`  Phase: ${options.phase}`);
        }
        for (const result of results) {
          const icon =
            result.status === 'passed'
              ? '✓'
              : result.status === 'failed'
                ? '✗'
                : result.status === 'not_configured'
                  ? '·'
                  : '○';
          const summary = result.summary ? ` — ${result.summary}` : '';
          console.log(`  ${icon} ${result.version}${summary}`);
        }
        const blockingResults = getBlockingValidationResults(results, options);
        if (blockingResults.length > 0) {
          console.error(
            `[Migration CLI] Validation failed for ${blockingResults.length} migration(s).`,
          );
          process.exitCode = 1;
        }
        break;
      }

      case 'rollback': {
        const steps = parseRollbackSteps(process.argv[3]);
        await runner.rollback(steps);
        console.log(`\n[Migration CLI] Rolled back ${steps} migration(s).`);
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        console.error(
          'Usage: migrate [--phase <phase>] | status | validate [--phase <phase>] | rollback [steps]',
        );
        process.exit(1);
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[Migration CLI] Fatal error:', error.message);
    process.exit(1);
  });
}
