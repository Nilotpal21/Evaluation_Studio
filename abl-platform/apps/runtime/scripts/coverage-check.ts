#!/usr/bin/env npx tsx

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

interface CoverageMetric {
  pct: number;
}

interface CoverageSummaryEntry {
  lines: CoverageMetric;
  functions: CoverageMetric;
  branches: CoverageMetric;
}

interface CoverageSummary {
  total: CoverageSummaryEntry;
}

interface ThresholdEntry {
  lines: number;
  branches: number;
  functions: number;
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const COVERAGE_SUMMARY_PATH = path.join(PACKAGE_ROOT, 'coverage', 'coverage-summary.json');
const THRESHOLDS_PATH = path.join(REPO_ROOT, 'coverage-thresholds.json');
const THRESHOLD_KEY = 'apps/runtime';

function loadCoverageSummary(): CoverageSummary {
  if (!fs.existsSync(COVERAGE_SUMMARY_PATH)) {
    throw new Error(`Coverage summary not found at ${COVERAGE_SUMMARY_PATH}`);
  }

  return JSON.parse(fs.readFileSync(COVERAGE_SUMMARY_PATH, 'utf-8')) as CoverageSummary;
}

function loadThreshold(): ThresholdEntry {
  const thresholds = JSON.parse(fs.readFileSync(THRESHOLDS_PATH, 'utf-8')) as Record<
    string,
    ThresholdEntry
  >;
  const threshold = thresholds[THRESHOLD_KEY];
  if (!threshold) {
    throw new Error(`Threshold entry "${THRESHOLD_KEY}" not found in ${THRESHOLDS_PATH}`);
  }

  return threshold;
}

function main(): void {
  const summary = loadCoverageSummary();
  const threshold = loadThreshold();

  const lines = summary.total.lines.pct;
  const branches = summary.total.branches.pct;
  const functions = summary.total.functions.pct;

  const failures: string[] = [];

  if (lines < threshold.lines) {
    failures.push(`lines ${lines.toFixed(1)}% < ${threshold.lines}%`);
  }
  if (branches < threshold.branches) {
    failures.push(`branches ${branches.toFixed(1)}% < ${threshold.branches}%`);
  }
  if (functions < threshold.functions) {
    failures.push(`functions ${functions.toFixed(1)}% < ${threshold.functions}%`);
  }

  console.log('\n Runtime Coverage Check\n');
  console.log(`  lines:     ${lines.toFixed(1)}% / ${threshold.lines}%`);
  console.log(`  branches:  ${branches.toFixed(1)}% / ${threshold.branches}%`);
  console.log(`  functions: ${functions.toFixed(1)}% / ${threshold.functions}%`);

  if (failures.length > 0) {
    console.error('\n  Threshold failures:');
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    console.error();
    process.exit(1);
  }

  console.log('\n  Runtime coverage meets thresholds.\n');
}

main();
