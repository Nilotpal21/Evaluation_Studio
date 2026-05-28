#!/usr/bin/env npx tsx
/**
 * Coverage Threshold Checker
 *
 * Reads coverage-summary.json from each package and validates against
 * thresholds in coverage-thresholds.json. Exits with code 1 if any
 * package is below its threshold.
 *
 * Usage:
 *   pnpm coverage:check
 *   npx tsx scripts/coverage-check.ts
 */

import * as fs from 'fs';
import * as path from 'path';

interface CoverageMetric {
  total: number;
  covered: number;
  skipped: number;
  pct: number;
}

interface CoverageSummaryEntry {
  lines: CoverageMetric;
  statements: CoverageMetric;
  functions: CoverageMetric;
  branches: CoverageMetric;
}

interface CoverageSummary {
  total: CoverageSummaryEntry;
  [filePath: string]: CoverageSummaryEntry;
}

interface ThresholdEntry {
  lines: number;
  branches: number;
  functions: number;
}

type Thresholds = Record<string, ThresholdEntry>;
type ResultStatus = 'PASS' | 'FAIL' | 'SKIP' | 'MISSING';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const THRESHOLDS_PATH = path.join(ROOT, 'coverage-thresholds.json');

function loadThresholds(): Thresholds {
  const raw = fs.readFileSync(THRESHOLDS_PATH, 'utf-8');
  return JSON.parse(raw) as Thresholds;
}

function loadCoverageSummary(packagePath: string): CoverageSummary | null {
  const summaryPath = path.join(ROOT, packagePath, 'coverage', 'coverage-summary.json');
  if (!fs.existsSync(summaryPath)) {
    return null;
  }
  const raw = fs.readFileSync(summaryPath, 'utf-8');
  return JSON.parse(raw) as CoverageSummary;
}

function getPackagesToCheck(thresholds: Thresholds): {
  packages: string[];
  strictMissing: boolean;
} {
  const requestedPackages = process.argv.slice(2).filter((arg) => arg !== '--');
  if (requestedPackages.length === 0) {
    return {
      packages: Object.keys(thresholds),
      strictMissing: false,
    };
  }

  const unknownPackages = requestedPackages.filter((pkg) => !(pkg in thresholds));
  if (unknownPackages.length > 0) {
    console.error(`Unknown coverage package(s): ${unknownPackages.join(', ')}`);
    process.exit(1);
  }

  return {
    packages: requestedPackages,
    strictMissing: true,
  };
}

function main(): void {
  const thresholds = loadThresholds();
  const failures: string[] = [];
  const { packages, strictMissing } = getPackagesToCheck(thresholds);
  const results: Array<{
    package: string;
    lines: number;
    branches: number;
    functions: number;
    linesThreshold: number;
    branchesThreshold: number;
    functionsThreshold: number;
    status: ResultStatus;
  }> = [];

  for (const pkg of packages) {
    const threshold = thresholds[pkg];
    const summary = loadCoverageSummary(pkg);

    if (!summary) {
      console.warn(`  ⚠ ${pkg}: No coverage data found (coverage/coverage-summary.json missing)`);
      results.push({
        package: pkg,
        lines: 0,
        branches: 0,
        functions: 0,
        linesThreshold: threshold.lines,
        branchesThreshold: threshold.branches,
        functionsThreshold: threshold.functions,
        status: strictMissing ? 'MISSING' : 'SKIP',
      });
      if (strictMissing) {
        failures.push(`${pkg}: coverage/coverage-summary.json missing`);
      }
      continue;
    }

    const total = summary.total;
    const lines = total.lines.pct;
    const branches = total.branches.pct;
    const functions = total.functions.pct;

    const linesFail = lines < threshold.lines;
    const branchesFail = branches < threshold.branches;
    const functionsFail = functions < threshold.functions;
    const pass = !linesFail && !branchesFail && !functionsFail;

    results.push({
      package: pkg,
      lines,
      branches,
      functions,
      linesThreshold: threshold.lines,
      branchesThreshold: threshold.branches,
      functionsThreshold: threshold.functions,
      status: pass ? 'PASS' : 'FAIL',
    });

    if (linesFail) {
      failures.push(`${pkg}: lines ${lines.toFixed(1)}% < ${threshold.lines}%`);
    }
    if (branchesFail) {
      failures.push(`${pkg}: branches ${branches.toFixed(1)}% < ${threshold.branches}%`);
    }
    if (functionsFail) {
      failures.push(`${pkg}: functions ${functions.toFixed(1)}% < ${threshold.functions}%`);
    }
  }

  // Print table
  console.log('\n Coverage Threshold Check\n');
  console.log(
    '  Package'.padEnd(30) +
      'Lines'.padEnd(16) +
      'Branches'.padEnd(16) +
      'Functions'.padEnd(16) +
      'Status',
  );
  console.log('  ' + '-'.repeat(88));

  for (const r of results) {
    const linesStr = `${r.lines.toFixed(1)}/${r.linesThreshold}%`;
    const branchesStr = `${r.branches.toFixed(1)}/${r.branchesThreshold}%`;
    const functionsStr = `${r.functions.toFixed(1)}/${r.functionsThreshold}%`;
    const status = r.status;

    console.log(
      `  ${r.package.padEnd(28)}${linesStr.padEnd(16)}${branchesStr.padEnd(16)}${functionsStr.padEnd(16)}${status}`,
    );
  }

  console.log();

  if (failures.length > 0) {
    console.error(`\n  ${failures.length} threshold violation(s):\n`);
    for (const f of failures) {
      console.error(`    - ${f}`);
    }
    console.error();
    process.exit(1);
  } else {
    console.log('  All packages meet their coverage thresholds.\n');
  }
}

main();
