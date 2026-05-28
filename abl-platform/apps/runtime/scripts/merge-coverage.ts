#!/usr/bin/env npx tsx

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireFromRuntime = createRequire(import.meta.url);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, '..');
const PNPM_ROOT = path.join(PACKAGE_ROOT, '..', '..', 'node_modules', '.pnpm');
const COVERAGE_ROOT = path.join(PACKAGE_ROOT, 'coverage');
const UNIT_COVERAGE_PATH = path.join(COVERAGE_ROOT, 'unit', 'coverage-final.json');
const HOTSPOT_COVERAGE_PATH = path.join(COVERAGE_ROOT, 'hotspots', 'coverage-final.json');
const CONTRACT_COVERAGE_PATH = path.join(COVERAGE_ROOT, 'contracts', 'coverage-final.json');
const MERGED_COVERAGE_PATH = path.join(COVERAGE_ROOT, 'coverage-final.json');
const COVERAGE_TEST_FILE_SUFFIXES = [
  '.test.ts',
  '.spec.ts',
  '.integration.test.ts',
  '.e2e.test.ts',
  '.live.e2e.test.ts',
] as const;

function resolvePnpmPackage(packageName: string): string {
  const normalizedPrefix = packageName.startsWith('@')
    ? `${packageName.replace('/', '+')}@`
    : `${packageName}@`;
  const entry = fs
    .readdirSync(PNPM_ROOT)
    .sort()
    .find((candidate) => candidate.startsWith(normalizedPrefix));

  if (!entry) {
    throw new Error(`Unable to resolve transitive dependency "${packageName}" from ${PNPM_ROOT}`);
  }

  return path.join(PNPM_ROOT, entry, 'node_modules', packageName);
}

const { createCoverageMap } = requireFromRuntime(
  resolvePnpmPackage('istanbul-lib-coverage'),
) as typeof import('istanbul-lib-coverage');
const libReport = requireFromRuntime(
  resolvePnpmPackage('istanbul-lib-report'),
) as typeof import('istanbul-lib-report');
const reports = requireFromRuntime(
  resolvePnpmPackage('istanbul-reports'),
) as typeof import('istanbul-reports');

function readCoverageMap(filePath: string) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Coverage file not found: ${filePath}`);
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
}

function ensureDirectory(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function isExcludedCoverageFile(filePath: string): boolean {
  const normalizedPath = filePath.split(path.sep).join('/');

  return (
    normalizedPath.includes('/__tests__/') ||
    COVERAGE_TEST_FILE_SUFFIXES.some((suffix) => normalizedPath.endsWith(suffix))
  );
}

function main(): void {
  const mergedCoverage = createCoverageMap({});

  for (const coveragePath of [UNIT_COVERAGE_PATH, HOTSPOT_COVERAGE_PATH, CONTRACT_COVERAGE_PATH]) {
    mergedCoverage.merge(readCoverageMap(coveragePath));
  }

  mergedCoverage.filter((filePath) => !isExcludedCoverageFile(filePath));

  ensureDirectory(COVERAGE_ROOT);
  fs.writeFileSync(MERGED_COVERAGE_PATH, JSON.stringify(mergedCoverage), 'utf-8');

  const context = libReport.createContext({
    dir: COVERAGE_ROOT,
    coverageMap: mergedCoverage,
  });

  reports.create('json-summary', { file: 'coverage-summary.json' }).execute(context);
  reports.create('html').execute(context);
  reports.create('text').execute(context);

  const summary = JSON.parse(
    fs.readFileSync(path.join(COVERAGE_ROOT, 'coverage-summary.json'), 'utf-8'),
  ) as {
    total: {
      lines: { pct: number };
      branches: { pct: number };
      functions: { pct: number };
    };
  };

  console.log('\n Runtime Coverage Merge\n');
  console.log(`  lines:     ${summary.total.lines.pct.toFixed(1)}%`);
  console.log(`  branches:  ${summary.total.branches.pct.toFixed(1)}%`);
  console.log(`  functions: ${summary.total.functions.pct.toFixed(1)}%\n`);
}

main();
