#!/usr/bin/env npx tsx
/**
 * Test DSL Migration Script — Fix DSL strings in test files
 *
 * More comprehensive than migrate-test-mode.ts:
 * 1. Remove remaining MODE: lines from DSL strings
 * 2. Add GOAL: to AGENT: declarations that lack it
 * 3. Add REASONING: false to flow step definitions in DSL strings
 *
 * Usage:
 *   npx tsx scripts/migrate-test-dsl.ts [--dry-run]
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
        entry.name === '.worktrees' ||
        entry.name === 'dist'
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
    // ignore
  }
  return files;
}

interface Stats {
  modeRemoved: number;
  goalAdded: number;
  reasoningAdded: number;
}

function migrateDslContent(dslContent: string): { content: string; stats: Stats } {
  const stats: Stats = { modeRemoved: 0, goalAdded: 0, reasoningAdded: 0 };
  let content = dslContent;

  // 1. Remove MODE: lines
  const modeRegex = /\n?[ \t]*MODE:\s*(?:scripted|reasoning)\s*\n?/g;
  const modeMatches = content.match(modeRegex);
  if (modeMatches) {
    stats.modeRemoved = modeMatches.length;
    content = content.replace(modeRegex, '\n');
  }

  // 2. Add GOAL if AGENT: or SUPERVISOR: exists but GOAL: doesn't
  if (/(?:^|\n)\s*AGENT:/m.test(content) && !/(?:^|\n)\s*GOAL:/m.test(content)) {
    // Add GOAL: after AGENT: line
    content = content.replace(/((?:^|\n)\s*AGENT:\s*[^\n]+)/, '$1\nGOAL: "Handle agent tasks"');
    stats.goalAdded++;
  }
  if (/(?:^|\n)\s*SUPERVISOR:/m.test(content) && !/(?:^|\n)\s*GOAL:/m.test(content)) {
    content = content.replace(
      /((?:^|\n)\s*SUPERVISOR:\s*[^\n]+)/,
      '$1\nGOAL: "Route requests to appropriate agents"',
    );
    stats.goalAdded++;
  }

  // 3. Add REASONING: false to flow step definitions in the DSL
  // This is complex because we need to identify step definitions in DSL text
  // Step definitions are: `  stepname:\n    <content>` inside a FLOW: section
  if (/(?:^|\n)\s*FLOW:/m.test(content)) {
    const lines = content.split('\n');
    const newLines: string[] = [];
    let inFlow = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trimStart();
      const indent = line.length - trimmed.length;

      // Detect FLOW: section
      if (/^FLOW:/.test(trimmed) && indent < 4) {
        inFlow = true;
        newLines.push(line);
        continue;
      }

      // Detect leaving FLOW section
      if (
        inFlow &&
        trimmed.length > 0 &&
        indent === 0 &&
        !trimmed.startsWith('#') &&
        !trimmed.startsWith('FLOW')
      ) {
        if (/^[A-Z]/.test(trimmed) && !trimmed.startsWith('FLOW')) {
          inFlow = false;
        }
      }

      if (inFlow) {
        // Check for step definition: 2-space indent + word + colon
        const stepDefMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*):$/);
        if (indent === 2 && stepDefMatch) {
          const stepName = stepDefMatch[1];
          if (stepName !== 'steps' && stepName !== 'entry_point') {
            // Check if next content line has REASONING:
            let hasReasoning = false;
            for (let j = i + 1; j < lines.length; j++) {
              const nextTrimmed = lines[j].trimStart();
              if (nextTrimmed.length === 0) continue;
              const nextIndent = lines[j].length - nextTrimmed.length;
              if (nextIndent <= indent) break;
              if (nextTrimmed.startsWith('REASONING:')) {
                hasReasoning = true;
                break;
              }
              break;
            }

            newLines.push(line);
            if (!hasReasoning) {
              newLines.push('    REASONING: false');
              stats.reasoningAdded++;
            }
            continue;
          }
        }
      }

      newLines.push(line);
    }
    content = newLines.join('\n');
  }

  // Clean up multiple blank lines
  content = content.replace(/\n{3,}/g, '\n\n');

  return { content, stats };
}

function migrateTestFile(filePath: string): { changed: boolean; stats: Stats } {
  const original = fs.readFileSync(filePath, 'utf-8');
  let content = original;
  const totalStats: Stats = { modeRemoved: 0, goalAdded: 0, reasoningAdded: 0 };

  // Find template literals containing DSL-like content (AGENT:, SUPERVISOR:, FLOW:)
  // We process the entire file content since MODE/GOAL/REASONING can appear
  // in template literals, string concatenations, etc.

  // Process template literals (backtick strings)
  content = content.replace(/`([^`]*(?:AGENT:|SUPERVISOR:)[^`]*)`/gs, (match, innerContent) => {
    const result = migrateDslContent(innerContent);
    totalStats.modeRemoved += result.stats.modeRemoved;
    totalStats.goalAdded += result.stats.goalAdded;
    totalStats.reasoningAdded += result.stats.reasoningAdded;
    return '`' + result.content + '`';
  });

  // Process string array elements that look like DSL lines: ['AGENT: Test', 'MODE: reasoning', ...]
  // Replace MODE entries in arrays
  content = content.replace(/(['"])MODE:\s*(?:scripted|reasoning)\1\s*,?\s*/g, (match) => {
    totalStats.modeRemoved++;
    return '';
  });

  // Clean up resulting empty array entries and extra commas
  content = content.replace(/,\s*,/g, ',');
  content = content.replace(/\[\s*,/g, '[');
  content = content.replace(/,\s*\]/g, ']');

  if (content !== original) {
    if (!dryRun) {
      fs.writeFileSync(filePath, content, 'utf-8');
    }
    return { changed: true, stats: totalStats };
  }

  return { changed: false, stats: totalStats };
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

console.log(`\nProcessing ${allFiles.length} test files${dryRun ? ' (DRY RUN)' : ''}...\n`);

let changedCount = 0;
let totalMode = 0;
let totalGoal = 0;
let totalReasoning = 0;

for (const file of allFiles) {
  const { changed, stats } = migrateTestFile(file);
  if (changed) {
    changedCount++;
    totalMode += stats.modeRemoved;
    totalGoal += stats.goalAdded;
    totalReasoning += stats.reasoningAdded;
    const changes: string[] = [];
    if (stats.modeRemoved > 0) changes.push(`${stats.modeRemoved} MODE`);
    if (stats.goalAdded > 0) changes.push(`${stats.goalAdded} GOAL`);
    if (stats.reasoningAdded > 0) changes.push(`${stats.reasoningAdded} REASONING`);
    console.log(`  ${path.relative(process.cwd(), file)}: ${changes.join(', ')}`);
  }
}

console.log(`\nSummary:`);
console.log(`  Files: ${changedCount}/${allFiles.length} changed`);
console.log(`  MODE removed: ${totalMode}`);
console.log(`  GOAL added: ${totalGoal}`);
console.log(`  REASONING added: ${totalReasoning}`);
if (dryRun) console.log(`\n  (DRY RUN)`);
console.log('');
