#!/usr/bin/env npx tsx
/**
 * Test Migration Script — Remove MODE from DSL strings in test files
 *
 * Handles:
 * 1. Remove `MODE: scripted` and `MODE: reasoning` lines from DSL template literals
 * 2. Remove expect(doc.mode) and expect(ir.execution.mode) assertions
 * 3. Clean up resulting blank lines
 *
 * Usage:
 *   npx tsx scripts/migrate-test-mode.ts [--dry-run]
 */

import * as fs from 'fs';
import * as path from 'path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

function findTestFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.llm-cache' ||
        entry.name === '.worktrees'
      )
        continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...findTestFiles(fullPath));
      } else if (
        entry.name.endsWith('.test.ts') ||
        entry.name.endsWith('.test.tsx') ||
        entry.name.endsWith('.spec.ts')
      ) {
        files.push(fullPath);
      }
    }
  } catch {
    // ignore permission errors
  }
  return files;
}

interface MigrationResult {
  file: string;
  modeLineRemovals: number;
  assertionRemovals: number;
  unchanged: boolean;
}

function migrateTestFile(filePath: string): MigrationResult {
  const original = fs.readFileSync(filePath, 'utf-8');
  let content = original;
  const result: MigrationResult = {
    file: filePath,
    modeLineRemovals: 0,
    assertionRemovals: 0,
    unchanged: true,
  };

  // 1. Remove MODE: lines from DSL strings (inside template literals and regular strings)
  // Pattern: a line that is just `MODE: scripted` or `MODE: reasoning` possibly with whitespace
  // In template literals, these appear as literal lines
  const modeLinePattern = /^[ \t]*MODE:\s*(?:scripted|reasoning)\s*$/gm;
  const matches = content.match(modeLinePattern);
  if (matches) {
    result.modeLineRemovals = matches.length;
    content = content.replace(modeLinePattern, '');
  }

  // Also handle single-line strings like: 'MODE: scripted\n'
  const modeInStringPattern = /MODE:\s*(?:scripted|reasoning)\\n/g;
  const stringMatches = content.match(modeInStringPattern);
  if (stringMatches) {
    result.modeLineRemovals += stringMatches.length;
    content = content.replace(modeInStringPattern, '');
  }

  // 2. Remove assertions on doc.mode and execution.mode
  // Pattern: expect(doc.mode).toBe('scripted')  or similar
  // Pattern: expect(ir.execution.mode).toBe('reasoning')
  // These are full lines that should be removed
  const assertionPatterns = [
    /^[ \t]*expect\([^)]*\.mode\)\.toBe\([^)]*\);?\s*$/gm,
    /^[ \t]*expect\([^)]*\.mode\)\.toEqual\([^)]*\);?\s*$/gm,
    /^[ \t]*expect\([^)]*execution\.mode[^)]*\).*$/gm,
    /^[ \t]*expect\([^)]*\.mode\)\.toBeDefined\(\);?\s*$/gm,
  ];

  for (const pattern of assertionPatterns) {
    const assertMatches = content.match(pattern);
    if (assertMatches) {
      result.assertionRemovals += assertMatches.length;
      content = content.replace(pattern, '');
    }
  }

  // 3. Clean up triple+ blank lines to double blank lines
  content = content.replace(/\n{3,}/g, '\n\n');

  if (content !== original) {
    result.unchanged = false;
    if (!dryRun) {
      fs.writeFileSync(filePath, content, 'utf-8');
    }
  }

  return result;
}

// Main
const dirs = ['packages', 'apps'];
let allFiles: string[] = [];
for (const dir of dirs) {
  const resolvedDir = path.resolve(dir);
  if (fs.existsSync(resolvedDir)) {
    allFiles.push(...findTestFiles(resolvedDir));
  }
}

console.log(`\nMigrating ${allFiles.length} test files${dryRun ? ' (DRY RUN)' : ''}...\n`);

const results: MigrationResult[] = [];
let totalModeRemovals = 0;
let totalAssertionRemovals = 0;

for (const file of allFiles) {
  const result = migrateTestFile(file);
  results.push(result);

  if (!result.unchanged) {
    const changes: string[] = [];
    if (result.modeLineRemovals > 0) changes.push(`${result.modeLineRemovals} MODE lines`);
    if (result.assertionRemovals > 0) changes.push(`${result.assertionRemovals} assertions`);
    console.log(`  ${path.relative(process.cwd(), file)}: removed ${changes.join(', ')}`);
    totalModeRemovals += result.modeLineRemovals;
    totalAssertionRemovals += result.assertionRemovals;
  }
}

const changed = results.filter((r) => !r.unchanged);
console.log(`\nSummary:`);
console.log(`  Files processed: ${allFiles.length}`);
console.log(`  Files changed: ${changed.length}`);
console.log(`  MODE lines removed: ${totalModeRemovals}`);
console.log(`  Assertions removed: ${totalAssertionRemovals}`);
if (dryRun) {
  console.log(`\n  (DRY RUN — no files were modified)`);
}
console.log('');
