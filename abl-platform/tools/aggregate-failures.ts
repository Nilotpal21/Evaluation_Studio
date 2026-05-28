#!/usr/bin/env npx tsx
/**
 * aggregate-failures.ts — Read per-package vitest JSON reports and produce
 * a single consolidated failure log.
 *
 * Outputs:
 *   test-reports/failures.json  — machine-readable, feed to agents
 *   test-reports/SUMMARY.md     — human-readable, scan quickly
 *
 * Usage:
 *   npx tsx tools/aggregate-failures.ts
 *   npx tsx tools/aggregate-failures.ts --report-dir ./test-reports
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DEFAULT_REPORT_DIR = join(ROOT, 'test-reports');

// ── Vitest JSON report types (subset we care about) ──────────────────────────

interface VitestJsonReport {
  numTotalTestSuites: number;
  numPassedTestSuites: number;
  numFailedTestSuites: number;
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numSkippedTests?: number;
  startTime: number;
  success: boolean;
  testResults: VitestTestResult[];
}

interface VitestTestResult {
  name: string; // file path
  status: 'passed' | 'failed' | 'skipped';
  message?: string;
  assertionResults: VitestAssertion[];
  startTime: number;
  endTime: number;
}

interface VitestAssertion {
  ancestorTitles: string[];
  fullName: string;
  status: 'passed' | 'failed' | 'skipped' | 'pending' | 'todo';
  title: string;
  failureMessages?: string[];
  duration?: number;
}

// ── Failure extraction ───────────────────────────────────────────────────────

interface FailureEntry {
  package: string; // label from test-capture, e.g. "apps-studio--light"
  file: string; // test file path
  testName: string; // full test name
  ancestorTitles: string[];
  error: string; // first failure message, truncated
  duration: number | null;
}

function extractFailures(label: string, report: VitestJsonReport): FailureEntry[] {
  const failures: FailureEntry[] = [];

  for (const suite of report.testResults) {
    for (const assertion of suite.assertionResults) {
      if (assertion.status !== 'failed') continue;

      const errorMsg = (assertion.failureMessages || [])
        .join('\n')
        .replace(/\x1b\[[0-9;]*m/g, '') // strip ANSI
        .slice(0, 2000); // cap at 2000 chars

      failures.push({
        package: label,
        file: suite.name,
        testName: assertion.fullName,
        ancestorTitles: assertion.ancestorTitles,
        error: errorMsg,
        duration: assertion.duration ?? null,
      });
    }
  }

  return failures;
}

// ── Summary generation ───────────────────────────────────────────────────────

interface PackageSummary {
  label: string;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  totalSuites: number;
  failedSuites: number;
  durationMs: number;
}

function buildPackageSummary(label: string, report: VitestJsonReport): PackageSummary {
  return {
    label,
    totalTests: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    skipped: report.numSkippedTests ?? 0,
    totalSuites: report.numTotalTestSuites,
    failedSuites: report.numFailedTestSuites,
    durationMs: report.testResults.reduce((sum, r) => sum + (r.endTime - r.startTime), 0),
  };
}

function generateMarkdown(
  summaries: PackageSummary[],
  failures: FailureEntry[],
  runSummary: Record<string, unknown> | null,
): string {
  const totalTests = summaries.reduce((s, p) => s + p.totalTests, 0);
  const totalPassed = summaries.reduce((s, p) => s + p.passed, 0);
  const totalFailed = summaries.reduce((s, p) => s + p.failed, 0);
  const totalSkipped = summaries.reduce((s, p) => s + p.skipped, 0);

  const lines: string[] = [];
  lines.push('# Test Failure Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Overview');
  lines.push('');
  lines.push(`| Metric | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total tests | ${totalTests} |`);
  lines.push(`| Passed | ${totalPassed} |`);
  lines.push(`| **Failed** | **${totalFailed}** |`);
  lines.push(`| Skipped | ${totalSkipped} |`);
  lines.push(`| Packages tested | ${summaries.length} |`);
  lines.push('');

  // Package-level summary table
  const failedPkgs = summaries.filter((s) => s.failed > 0);
  if (failedPkgs.length > 0) {
    lines.push('## Failing Packages');
    lines.push('');
    lines.push('| Package | Failed | Total | Duration |');
    lines.push('|---------|--------|-------|----------|');
    for (const pkg of failedPkgs.sort((a, b) => b.failed - a.failed)) {
      lines.push(
        `| ${pkg.label} | ${pkg.failed} | ${pkg.totalTests} | ${(pkg.durationMs / 1000).toFixed(1)}s |`,
      );
    }
    lines.push('');
  }

  // Detailed failures grouped by package
  if (failures.length > 0) {
    lines.push('## Failure Details');
    lines.push('');

    const byPackage = new Map<string, FailureEntry[]>();
    for (const f of failures) {
      const list = byPackage.get(f.package) || [];
      list.push(f);
      byPackage.set(f.package, list);
    }

    for (const [pkg, entries] of byPackage) {
      lines.push(`### ${pkg} (${entries.length} failures)`);
      lines.push('');

      // Group by file
      const byFile = new Map<string, FailureEntry[]>();
      for (const e of entries) {
        const list = byFile.get(e.file) || [];
        list.push(e);
        byFile.set(e.file, list);
      }

      for (const [file, fileEntries] of byFile) {
        // Show relative path
        const relFile = file.includes('/src/') ? file.slice(file.indexOf('/src/') + 1) : file;
        lines.push(`#### ${relFile}`);
        lines.push('');

        for (const entry of fileEntries) {
          lines.push(`- **${entry.testName}**`);
          // Show first 5 lines of error
          const errorLines = entry.error.split('\n').slice(0, 5);
          lines.push('  ```');
          for (const l of errorLines) {
            lines.push(`  ${l}`);
          }
          if (entry.error.split('\n').length > 5) {
            lines.push('  ... (truncated)');
          }
          lines.push('  ```');
          lines.push('');
        }
      }
    }
  } else {
    lines.push('## All tests passed!');
    lines.push('');
  }

  // Packages that had no JSON report (crashed/timed out)
  if (runSummary && Array.isArray((runSummary as { results?: unknown[] }).results)) {
    const results = (
      runSummary as { results: Array<{ label: string; status: string; hasJsonReport: boolean }> }
    ).results;
    const noReport = results.filter((r) => r.status !== 'pass' && !r.hasJsonReport);
    if (noReport.length > 0) {
      lines.push('## Packages with no report (crashed/timed out)');
      lines.push('');
      for (const r of noReport) {
        lines.push(`- **${r.label}** — ${r.status}`);
      }
      lines.push('');
      lines.push(
        '> These packages failed without producing a JSON report. Check console output or run them individually.',
      );
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const reportDir = process.argv.includes('--report-dir')
    ? resolve(process.argv[process.argv.indexOf('--report-dir') + 1])
    : DEFAULT_REPORT_DIR;

  if (!existsSync(reportDir)) {
    console.error(`Report directory not found: ${reportDir}`);
    console.error('Run tools/test-capture.ts first to generate reports.');
    process.exit(1);
  }

  // Read run summary if available
  const runSummaryPath = join(reportDir, 'run-summary.json');
  const runSummary = existsSync(runSummaryPath)
    ? JSON.parse(readFileSync(runSummaryPath, 'utf-8'))
    : null;

  // Find all vitest JSON reports
  const jsonFiles = readdirSync(reportDir).filter(
    (f) => f.endsWith('.json') && f !== 'run-summary.json' && f !== 'failures.json',
  );

  if (jsonFiles.length === 0) {
    console.log('No JSON report files found in', reportDir);
    process.exit(0);
  }

  console.log(`Found ${jsonFiles.length} report file(s):`);

  const allFailures: FailureEntry[] = [];
  const allSummaries: PackageSummary[] = [];

  for (const file of jsonFiles.sort()) {
    const label = file.replace('.json', '');
    const content = readFileSync(join(reportDir, file), 'utf-8');

    let report: VitestJsonReport;
    try {
      report = JSON.parse(content);
    } catch {
      console.warn(`  ⚠ ${file}: invalid JSON, skipping`);
      continue;
    }

    const failures = extractFailures(label, report);
    const summary = buildPackageSummary(label, report);

    console.log(
      `  ${summary.failed > 0 ? '✗' : '✓'} ${label}: ${summary.passed}/${summary.totalTests} passed` +
        (summary.failed > 0 ? ` (${summary.failed} failed)` : ''),
    );

    allFailures.push(...failures);
    allSummaries.push(summary);
  }

  // Write failures.json
  const failuresOutput = {
    timestamp: new Date().toISOString(),
    totalFailures: allFailures.length,
    failures: allFailures,
    packageSummaries: allSummaries,
  };
  writeFileSync(join(reportDir, 'failures.json'), JSON.stringify(failuresOutput, null, 2));

  // Write SUMMARY.md
  const markdown = generateMarkdown(allSummaries, allFailures, runSummary);
  writeFileSync(join(reportDir, 'SUMMARY.md'), markdown);

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Total: ${allFailures.length} failure(s) across ${allSummaries.length} package(s)`);
  console.log(`\nOutputs:`);
  console.log(`  test-reports/failures.json  — structured data (feed to agents)`);
  console.log(`  test-reports/SUMMARY.md     — human-readable report`);
  console.log(`${'─'.repeat(60)}`);
}

main();
