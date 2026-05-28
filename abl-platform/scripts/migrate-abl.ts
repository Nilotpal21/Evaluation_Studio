#!/usr/bin/env npx tsx
/**
 * ABL Migration Script — Unified Agent Type
 *
 * Migrates existing .abl files:
 * 1. Remove MODE: lines (with surrounding blank lines)
 * 2. Ensure GOAL: exists on every agent
 * 3. Add REASONING: false to every flow step definition
 *
 * Usage:
 *   npx tsx scripts/migrate-abl.ts [--dry-run] [path]
 *
 *   --dry-run   Show what would change without writing files
 *   path        Optional directory or file path (defaults to examples/)
 */

import * as fs from 'fs';
import * as path from 'path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const targetPath = args.find((a) => !a.startsWith('--')) || 'examples';

interface MigrationResult {
  file: string;
  modeRemoved: boolean;
  goalAdded: boolean;
  reasoningStepsAdded: number;
  unchanged: boolean;
}

function findAblFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findAblFiles(fullPath));
    } else if (entry.name.endsWith('.abl')) {
      files.push(fullPath);
    }
  }
  return files;
}

function migrateFile(filePath: string): MigrationResult {
  const original = fs.readFileSync(filePath, 'utf-8');
  let content = original;
  const result: MigrationResult = {
    file: filePath,
    modeRemoved: false,
    goalAdded: false,
    reasoningStepsAdded: 0,
    unchanged: true,
  };

  // 1. Remove MODE: lines (and clean up surrounding blank lines)
  const modeRegex = /\n?^MODE:\s*(?:scripted|reasoning)\s*\n?/gm;
  if (modeRegex.test(content)) {
    content = content.replace(/\n*^MODE:\s*(?:scripted|reasoning)\s*\n*/gm, '\n');
    result.modeRemoved = true;
  }

  // 2. Check if GOAL exists (for agents without one)
  if (!/^GOAL:/m.test(content)) {
    // Extract agent name for a default goal
    const agentMatch = content.match(/^AGENT:\s*(.+)/m);
    const agentName = agentMatch ? agentMatch[1].trim() : 'Unknown';
    // Add GOAL after AGENT line (and any VERSION/DESCRIPTION lines)
    const insertionPoint = content.match(/^(AGENT:.*(?:\n(?:VERSION|DESCRIPTION):.*)*\n)/m);
    if (insertionPoint) {
      const after = insertionPoint[0];
      content = content.replace(
        after,
        after + `\nGOAL: "Handle ${agentName.replace(/_/g, ' ')} tasks"\n`,
      );
      result.goalAdded = true;
    }
  }

  // 3. Add REASONING: false to flow step definitions
  // Flow steps are defined as `  stepname:` (indented) after a `FLOW:` section
  // They are identified by being at 2-space indent followed by content at 4-space indent
  if (/^FLOW:/m.test(content)) {
    const lines = content.split('\n');
    const newLines: string[] = [];
    let inFlow = false;
    let inStepDefs = false; // After the steps list, in step definitions
    let pastStepsList = false; // After the `steps:` list items

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trimStart();

      // Detect FLOW: section start
      if (/^FLOW:/.test(trimmed) && !line.startsWith(' ')) {
        inFlow = true;
        inStepDefs = false;
        pastStepsList = false;
        newLines.push(line);
        continue;
      }

      // Detect leaving FLOW section (non-indented non-empty non-comment line)
      if (inFlow && trimmed.length > 0 && !line.startsWith(' ') && !line.startsWith('#')) {
        inFlow = false;
        inStepDefs = false;
        newLines.push(line);
        continue;
      }

      if (inFlow) {
        // Detect flow step definition: 2-space indent + name + colon
        // But not `steps:`, `entry_point:`, or list items (- ...)
        const indent = line.length - line.trimStart().length;

        // Check for step list arrow syntax: `welcome -> get_destination -> ...`
        // This is the step order, not a definition
        if (indent === 2 && trimmed.includes(' -> ')) {
          pastStepsList = true;
          newLines.push(line);
          continue;
        }

        // Check for `steps:` or `entry_point:` headers
        if (indent === 2 && (trimmed.startsWith('steps:') || trimmed.startsWith('entry_point:'))) {
          newLines.push(line);
          continue;
        }

        // Check for step list items (- stepname)
        if (indent === 4 && trimmed.startsWith('- ') && !trimmed.includes(':')) {
          newLines.push(line);
          continue;
        }

        // Detect step definition: 2-space indent + word + colon (not a keyword like GATHER:, CALL:, etc.)
        const stepDefMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*):$/);
        if (indent === 2 && stepDefMatch) {
          const stepName = stepDefMatch[1];
          // Skip if this is steps: or entry_point:
          if (stepName === 'steps' || stepName === 'entry_point') {
            newLines.push(line);
            continue;
          }
          inStepDefs = true;

          // Check if next non-empty line already has REASONING:
          let hasReasoning = false;
          for (let j = i + 1; j < lines.length; j++) {
            const nextTrimmed = lines[j].trimStart();
            if (nextTrimmed.length === 0) continue;
            const nextIndent = lines[j].length - nextTrimmed.length;
            if (nextIndent <= indent) break; // Left the step
            if (nextTrimmed.startsWith('REASONING:')) {
              hasReasoning = true;
              break;
            }
            break; // Only check first non-empty line
          }

          newLines.push(line);
          if (!hasReasoning) {
            // Add REASONING: false at 4-space indent (step content indent)
            newLines.push('    REASONING: false');
            result.reasoningStepsAdded++;
          }
          continue;
        }
      }

      newLines.push(line);
    }

    content = newLines.join('\n');
  }

  // Clean up multiple consecutive blank lines (max 2)
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
const resolvedPath = path.resolve(targetPath);
let files: string[];

if (fs.statSync(resolvedPath).isDirectory()) {
  files = findAblFiles(resolvedPath);
} else {
  files = [resolvedPath];
}

console.log(`\nMigrating ${files.length} .abl files${dryRun ? ' (DRY RUN)' : ''}...\n`);

const results: MigrationResult[] = [];
for (const file of files) {
  const result = migrateFile(file);
  results.push(result);

  const changes: string[] = [];
  if (result.modeRemoved) changes.push('MODE removed');
  if (result.goalAdded) changes.push('GOAL added');
  if (result.reasoningStepsAdded > 0)
    changes.push(`REASONING added to ${result.reasoningStepsAdded} steps`);

  if (changes.length > 0) {
    console.log(`  ${path.relative(process.cwd(), file)}: ${changes.join(', ')}`);
  }
}

const changed = results.filter((r) => !r.unchanged);
const modeRemoved = results.filter((r) => r.modeRemoved).length;
const goalAdded = results.filter((r) => r.goalAdded).length;
const stepsAdded = results.reduce((sum, r) => sum + r.reasoningStepsAdded, 0);

console.log(`\nSummary:`);
console.log(`  Files processed: ${files.length}`);
console.log(`  Files changed: ${changed.length}`);
console.log(`  MODE removed: ${modeRemoved} files`);
console.log(`  GOAL added: ${goalAdded} files`);
console.log(`  REASONING added: ${stepsAdded} steps`);
if (dryRun) {
  console.log(`\n  (DRY RUN — no files were modified)`);
}
console.log('');
