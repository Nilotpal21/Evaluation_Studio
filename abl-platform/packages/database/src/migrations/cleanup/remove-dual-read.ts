/**
 * Task 32 — Cleanup Week 1: Remove Dual-Read Code Paths
 *
 * This script does NOT delete code. It identifies all dual-read credential
 * fallback patterns in the codebase and generates a report of files/lines
 * to update. The actual removal should be done via code review + PR.
 *
 * Usage:
 *   npx tsx packages/database/src/migrations/cleanup/remove-dual-read.ts
 *   npx tsx packages/database/src/migrations/cleanup/remove-dual-read.ts --dry-run=false
 *
 * Prerequisites (validated automatically):
 * - All consumers reading from authProfileId for 30+ days
 * - Zero dual-read fallback exercised for 14+ days
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Configuration ──────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(import.meta.dirname ?? __dirname, '../../../../..');

/** Patterns indicating dual-read code that should be removed */
const DUAL_READ_PATTERNS = [
  // Direct legacy credential lookups
  { pattern: 'credentialId', description: 'Legacy credentialId reference' },
  { pattern: 'encryptedCredentials', description: 'Legacy encryptedCredentials field' },
  {
    pattern: 'LLMCredential\\.find',
    description: 'Direct LLMCredential model query',
  },
  {
    pattern: 'EndUserOAuthToken\\.find',
    description: 'Direct EndUserOAuthToken model query',
  },
  {
    pattern: 'ToolSecret\\.find',
    description: 'Direct ToolSecret model query',
  },
  // Dual-read fallback branches
  {
    pattern: 'legacyCredential',
    description: 'Legacy credential variable reference',
  },
  {
    pattern: 'fallbackToLegacy',
    description: 'Fallback-to-legacy function/flag',
  },
] as const;

/** Directories to scan */
const SCAN_DIRS = [
  'apps/runtime/src/services',
  'apps/runtime/src/channels',
  'apps/search-ai/src',
  'packages/connectors/src',
  'packages/shared/src/services',
] as const;

/** Files to exclude (migration scripts, model files, tests) */
const EXCLUDE_PATTERNS = [
  'migrations/cleanup/',
  '__tests__/',
  '.test.ts',
  '.spec.ts',
  'models/llm-credential.model.ts',
  'models/end-user-oauth-token.model.ts',
  'models/tool-secret.model.ts',
];

// ─── Types ──────────────────────────────────────────────────────────────

interface DualReadMatch {
  file: string;
  line: number;
  content: string;
  pattern: string;
  description: string;
}

interface ValidationResult {
  passed: boolean;
  check: string;
  detail: string;
}

interface DualReadReport {
  timestamp: string;
  dryRun: boolean;
  validations: ValidationResult[];
  matches: DualReadMatch[];
  summary: {
    totalFiles: number;
    totalMatches: number;
    byPattern: Record<string, number>;
  };
}

// ─── Validation ─────────────────────────────────────────────────────────

/**
 * Validates that all prerequisites are met before dual-read removal.
 * Checks environment configuration and usage metrics.
 */
export function validateDualReadRemoval(): ValidationResult[] {
  const results: ValidationResult[] = [];

  // Check 1: Verify no recent dual-read fallback usage
  // In production, this would query metrics/logging. Here we check for the env var marker.
  const dualReadFallbackRate = process.env.DUAL_READ_FALLBACK_RATE;
  results.push({
    passed: dualReadFallbackRate === '0' || dualReadFallbackRate === '0.0',
    check: 'Dual-read fallback rate is 0% for 14+ days',
    detail: dualReadFallbackRate
      ? `Rate: ${dualReadFallbackRate}%`
      : 'DUAL_READ_FALLBACK_RATE env var not set — verify from production metrics',
  });

  // Check 2: Verify legacy models have zero new writes for 30+ days
  const legacyWriteAge = process.env.LEGACY_CREDENTIAL_LAST_WRITE_DAYS;
  const days = legacyWriteAge ? parseInt(legacyWriteAge, 10) : 0;
  results.push({
    passed: days >= 30,
    check: 'Legacy credential collections have zero writes for 30+ days',
    detail: legacyWriteAge
      ? `Last write: ${days} days ago`
      : 'LEGACY_CREDENTIAL_LAST_WRITE_DAYS env var not set — verify from production metrics',
  });

  // Check 3: MongoDB snapshot confirmed
  const snapshotConfirmed = process.env.MONGODB_SNAPSHOT_CONFIRMED;
  results.push({
    passed: snapshotConfirmed === 'true',
    check: 'MongoDB snapshot confirmed with 90-day retention',
    detail: snapshotConfirmed
      ? 'Snapshot confirmed'
      : 'MONGODB_SNAPSHOT_CONFIRMED env var not set — ensure backup exists before proceeding',
  });

  // Check 4: All consumers migrated to authProfileId
  const consumersMigrated = process.env.ALL_CONSUMERS_ON_AUTH_PROFILE;
  results.push({
    passed: consumersMigrated === 'true',
    check: 'All consumers reading from authProfileId for 30+ days',
    detail: consumersMigrated
      ? 'All consumers confirmed migrated'
      : 'ALL_CONSUMERS_ON_AUTH_PROFILE env var not set — verify from production metrics',
  });

  return results;
}

// ─── Scanner ────────────────────────────────────────────────────────────

function isExcluded(filePath: string): boolean {
  return EXCLUDE_PATTERNS.some((pattern) => filePath.includes(pattern));
}

function scanForDualReads(): DualReadMatch[] {
  const matches: DualReadMatch[] = [];

  for (const scanDir of SCAN_DIRS) {
    const fullDir = path.join(REPO_ROOT, scanDir);
    if (!fs.existsSync(fullDir)) {
      continue;
    }

    for (const dualPattern of DUAL_READ_PATTERNS) {
      try {
        const result = execFileSync(
          'grep',
          ['-rn', dualPattern.pattern, fullDir, '--include=*.ts'],
          { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
        );

        for (const line of result.split('\n').filter(Boolean)) {
          const colonIdx = line.indexOf(':');
          if (colonIdx === -1) continue;

          const afterFirst = line.indexOf(':', colonIdx + 1);
          if (afterFirst === -1) continue;

          const file = line.substring(0, colonIdx);
          const lineNum = parseInt(line.substring(colonIdx + 1, afterFirst), 10);
          const content = line.substring(afterFirst + 1).trim();

          if (isExcluded(file)) continue;

          matches.push({
            file: path.relative(REPO_ROOT, file),
            line: lineNum,
            content: content.substring(0, 200),
            pattern: dualPattern.pattern,
            description: dualPattern.description,
          });
        }
      } catch {
        // grep returned non-zero (no matches) — this is expected
      }
    }
  }

  return matches;
}

function buildReport(dryRun: boolean): DualReadReport {
  const validations = validateDualReadRemoval();
  const matches = scanForDualReads();

  const byPattern: Record<string, number> = {};
  for (const match of matches) {
    byPattern[match.pattern] = (byPattern[match.pattern] ?? 0) + 1;
  }

  const uniqueFiles = new Set(matches.map((m) => m.file));

  return {
    timestamp: new Date().toISOString(),
    dryRun,
    validations,
    matches,
    summary: {
      totalFiles: uniqueFiles.size,
      totalMatches: matches.length,
      byPattern,
    },
  };
}

// ─── Main ───────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--dry-run=false');

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Task 32: Remove Dual-Read Code Paths — Analysis Report    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`Mode: ${dryRun ? 'DRY RUN (default)' : 'REPORT ONLY — no code changes'}`);
  console.log('');

  const report = buildReport(dryRun);

  // Print validations
  console.log('── Prerequisites ─────────────────────────────────────────────');
  for (const v of report.validations) {
    const icon = v.passed ? 'PASS' : 'FAIL';
    console.log(`  [${icon}] ${v.check}`);
    console.log(`         ${v.detail}`);
  }

  const allPassed = report.validations.every((v) => v.passed);
  console.log('');

  if (!allPassed) {
    console.log('WARNING: Not all prerequisites passed. Review before proceeding.');
    console.log('');
  }

  // Print matches
  console.log('── Dual-Read Code Paths Found ────────────────────────────────');
  if (report.matches.length === 0) {
    console.log('  No dual-read code paths found. Cleanup may already be complete.');
  } else {
    for (const match of report.matches) {
      console.log(`  ${match.file}:${match.line}`);
      console.log(`    Pattern: ${match.description}`);
      console.log(`    Content: ${match.content}`);
      console.log('');
    }
  }

  // Print summary
  console.log('── Summary ───────────────────────────────────────────────────');
  console.log(`  Total files with dual-read patterns: ${report.summary.totalFiles}`);
  console.log(`  Total matches: ${report.summary.totalMatches}`);
  console.log('  By pattern:');
  for (const [pattern, count] of Object.entries(report.summary.byPattern)) {
    console.log(`    ${pattern}: ${count}`);
  }

  // Write report to file
  const reportPath = path.join(
    REPO_ROOT,
    'packages/database/src/migrations/cleanup',
    'remove-dual-read-report.json',
  );
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log('');
  console.log(`Report written to: ${reportPath}`);
}

// Only run when executed directly (not when imported by tests)
if (process.argv[1]?.includes('remove-dual-read')) {
  main();
}
