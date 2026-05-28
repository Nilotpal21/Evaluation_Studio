/**
 * Task 35 — Cleanup Week 4: Remove Legacy Environment Variables
 *
 * Scans Dockerfiles, docker-compose files, and helm chart values for legacy
 * credential environment variables and generates a removal report. Does NOT
 * modify any files — only produces a report of what to remove.
 *
 * Usage:
 *   npx tsx packages/database/src/migrations/cleanup/remove-legacy-env-vars.ts
 *   npx tsx packages/database/src/migrations/cleanup/remove-legacy-env-vars.ts --dry-run=false
 *
 * Prerequisites:
 * - Task 34 collection drop completed and baked for 7 days
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Configuration ──────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(import.meta.dirname ?? __dirname, '../../../../..');

/** Legacy env vars that should be removed */
const LEGACY_ENV_VARS = [
  // Studio OAuth providers
  'OAUTH_PROVIDER_GOOGLE_CLIENT_ID',
  'OAUTH_PROVIDER_GOOGLE_CLIENT_SECRET',
  'OAUTH_PROVIDER_MICROSOFT_CLIENT_ID',
  'OAUTH_PROVIDER_MICROSOFT_CLIENT_SECRET',
  'OAUTH_PROVIDER_GITHUB_CLIENT_ID',
  'OAUTH_PROVIDER_GITHUB_CLIENT_SECRET',
  // Runtime channel OAuth
  'CHANNEL_OAUTH_SLACK_CLIENT_ID',
  'CHANNEL_OAUTH_SLACK_CLIENT_SECRET',
  'CHANNEL_OAUTH_SLACK_SIGNING_SECRET',
  'CHANNEL_OAUTH_MSTEAMS_CLIENT_ID',
  'CHANNEL_OAUTH_MSTEAMS_CLIENT_SECRET',
  'CHANNEL_OAUTH_MSTEAMS_TENANT_ID',
  'CHANNEL_OAUTH_META_APP_ID',
  'CHANNEL_OAUTH_META_APP_SECRET',
  'CHANNEL_OAUTH_META_VERIFY_TOKEN',
  'CHANNEL_OAUTH_META_PAGE_ACCESS_TOKEN',
  'CHANNEL_OAUTH_META_WEBHOOK_SECRET',
  // Runtime LLM API keys
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_AI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_DEPLOYMENT',
] as const;

/** File patterns to scan */
const SCAN_PATTERNS = [
  { glob: 'Dockerfile', dirs: ['apps/runtime', 'apps/studio', 'apps/search-ai', 'apps/admin'] },
  { glob: 'docker-compose*.yml', dirs: ['.'] },
  { glob: '*.yaml', dirs: ['deploy', 'helm', 'charts'] },
  { glob: '*.env*', dirs: ['.'] },
  { glob: '*.ts', dirs: ['packages/config/src'] },
] as const;

// ─── Types ──────────────────────────────────────────────────────────────

interface EnvVarMatch {
  file: string;
  line: number;
  content: string;
  envVar: string;
}

interface EnvVarReport {
  timestamp: string;
  dryRun: boolean;
  matches: EnvVarMatch[];
  summary: {
    totalFiles: number;
    totalMatches: number;
    byEnvVar: Record<string, number>;
    byFile: Record<string, number>;
  };
  envVarsSearched: readonly string[];
}

// ─── Scanner ────────────────────────────────────────────────────────────

function scanForEnvVar(envVar: string): EnvVarMatch[] {
  const matches: EnvVarMatch[] = [];

  // Search the entire repo for the env var
  try {
    const result = execFileSync(
      'grep',
      [
        '-rn',
        envVar,
        REPO_ROOT,
        '--include=*.ts',
        '--include=*.yml',
        '--include=*.yaml',
        '--include=*.env*',
        '--include=Dockerfile*',
        '--include=*.json',
      ],
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

      // Skip node_modules, dist, and this script
      if (
        file.includes('node_modules') ||
        file.includes('/dist/') ||
        file.includes('remove-legacy-env-vars')
      ) {
        continue;
      }

      matches.push({
        file: path.relative(REPO_ROOT, file),
        line: lineNum,
        content: content.substring(0, 200),
        envVar,
      });
    }
  } catch {
    // grep returned non-zero (no matches) — expected
  }

  return matches;
}

function buildReport(dryRun: boolean): EnvVarReport {
  const allMatches: EnvVarMatch[] = [];

  for (const envVar of LEGACY_ENV_VARS) {
    const matches = scanForEnvVar(envVar);
    allMatches.push(...matches);
  }

  const byEnvVar: Record<string, number> = {};
  const byFile: Record<string, number> = {};

  for (const match of allMatches) {
    byEnvVar[match.envVar] = (byEnvVar[match.envVar] ?? 0) + 1;
    byFile[match.file] = (byFile[match.file] ?? 0) + 1;
  }

  const uniqueFiles = new Set(allMatches.map((m) => m.file));

  return {
    timestamp: new Date().toISOString(),
    dryRun,
    matches: allMatches,
    summary: {
      totalFiles: uniqueFiles.size,
      totalMatches: allMatches.length,
      byEnvVar,
      byFile,
    },
    envVarsSearched: LEGACY_ENV_VARS,
  };
}

// ─── Main ───────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--dry-run=false');

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Task 35: Remove Legacy Environment Variables — Report     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(
    `Mode: ${dryRun ? 'DRY RUN (default) — report only' : 'REPORT ONLY — no file changes'}`,
  );
  console.log('');

  const report = buildReport(dryRun);

  // Print matches grouped by file
  console.log('── Legacy Env Var References Found ────────────────────────────');
  if (report.matches.length === 0) {
    console.log('  No legacy env var references found. Cleanup may already be complete.');
  } else {
    const byFile = new Map<string, EnvVarMatch[]>();
    for (const match of report.matches) {
      const existing = byFile.get(match.file) ?? [];
      existing.push(match);
      byFile.set(match.file, existing);
    }

    for (const [file, matches] of byFile) {
      console.log(`  ${file}:`);
      for (const match of matches) {
        console.log(`    L${match.line}: ${match.envVar}`);
        console.log(`      ${match.content}`);
      }
      console.log('');
    }
  }

  // Print summary
  console.log('── Summary ───────────────────────────────────────────────────');
  console.log(`  Total files with legacy env vars: ${report.summary.totalFiles}`);
  console.log(`  Total references: ${report.summary.totalMatches}`);
  console.log('');
  console.log('  By env var:');
  for (const [envVar, count] of Object.entries(report.summary.byEnvVar)) {
    console.log(`    ${envVar}: ${count}`);
  }

  // Write report to file
  const reportPath = path.join(
    REPO_ROOT,
    'packages/database/src/migrations/cleanup',
    'remove-legacy-env-vars-report.json',
  );
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log('');
  console.log(`Report written to: ${reportPath}`);
}

main();
