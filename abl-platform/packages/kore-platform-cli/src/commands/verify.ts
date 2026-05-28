/**
 * CLI Verify Command
 *
 * kore verify <path>
 *
 * Offline SHA verification of an export folder. No server needed.
 * Reads lockfile.json and verifies 3-tier SHA integrity against files on disk.
 */

import type { Command } from 'commander';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { createHash } from 'crypto';
import chalk from 'chalk';

/** Recursively read all files in a directory into a path->content map */
function readDirectory(dir: string, basePath = ''): Map<string, string> {
  const files = new Map<string, string>();
  const entries = readdirSync(dir);

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const relPath = basePath ? `${basePath}/${entry}` : entry;
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      const subFiles = readDirectory(fullPath, relPath);
      for (const [k, v] of subFiles) {
        files.set(k, v);
      }
    } else if (stat.isFile() && entry !== 'abl.lock') {
      files.set(relPath, readFileSync(fullPath, 'utf-8'));
    }
  }

  return files;
}

interface LockfileEntry {
  source_hash: string;
  version?: string;
  status?: string;
}

interface LockfileV2 {
  lockfile_version: string;
  generated_at: string;
  agents: Record<string, LockfileEntry>;
  tools: Record<string, LockfileEntry>;
  configs: Record<string, LockfileEntry>;
  connections: Record<string, LockfileEntry>;
  guardrails: Record<string, LockfileEntry>;
  workflows: Record<string, LockfileEntry>;
  evals: Record<string, LockfileEntry>;
  search: Record<string, LockfileEntry>;
  channels: Record<string, LockfileEntry>;
  vocabulary: Record<string, LockfileEntry>;
  layer_hashes: Record<string, string>;
  integrity: string;
}

/** Compute SHA-256 of file content (matching the lockfile generator logic) */
function computeSourceHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Sort record keys for deterministic JSON */
function sortedRecord(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return sorted;
}

/** Find the file that corresponds to a lockfile entry */
function findFileForEntry(
  section: string,
  name: string,
  files: Map<string, string>,
): string | undefined {
  // Try common naming patterns
  const patterns = [
    // agents/supervisor.agent.abl
    `agents/${name}.agent.abl`,
    // tools/search.tools.abl
    `tools/${name}.tools.abl`,
    // config/*.json
    `config/${name}.json`,
    // connections/connectors/*.connection.json
    `connections/connectors/${name}.connection.json`,
    // guardrails/*.guardrail.json
    `guardrails/${name}.guardrail.json`,
    // workflows/*.workflow.json
    `workflows/${name}.workflow.json`,
    // evals paths (nested)
    `evals/${name}`,
    // search paths
    `search/${name}`,
    // channels paths
    `channels/${name}`,
    // vocabulary paths
    `vocabulary/${name}`,
  ];

  // Try exact match with section prefix
  for (const pattern of patterns) {
    if (files.has(pattern)) {
      return files.get(pattern);
    }
  }

  // Try fuzzy match: look for any file containing the name in the expected section directory
  const sectionDir = sectionToDir(section);
  for (const [path, content] of files) {
    if (path.startsWith(sectionDir) && path.includes(name)) {
      return content;
    }
  }

  return undefined;
}

function sectionToDir(section: string): string {
  const map: Record<string, string> = {
    agents: 'agents/',
    tools: 'tools/',
    configs: 'config/',
    connections: 'connections/',
    guardrails: 'guardrails/',
    workflows: 'workflows/',
    evals: 'evals/',
    search: 'search/',
    channels: 'channels/',
    vocabulary: 'vocabulary/',
  };
  return map[section] ?? `${section}/`;
}

export function registerVerifyCommand(program: Command): void {
  program
    .command('verify <path>')
    .description('Verify SHA integrity of an export folder (offline, no server needed)')
    .action(async (exportPath: string) => {
      const absPath = resolve(exportPath);

      if (!existsSync(absPath)) {
        console.error(chalk.red(`Path does not exist: ${absPath}`));
        process.exit(1);
      }

      const lockfilePath = join(absPath, 'abl.lock');
      if (!existsSync(lockfilePath)) {
        console.error(chalk.red('No abl.lock found in the export directory.'));
        console.error('This command requires a v2 export with a lockfile.');
        process.exit(1);
      }

      console.log(`Verifying export at ${absPath}...`);

      // Read lockfile
      const lockfile = JSON.parse(readFileSync(lockfilePath, 'utf-8')) as LockfileV2;

      if (lockfile.lockfile_version !== '2.0') {
        console.error(chalk.red(`Unsupported lockfile version: ${lockfile.lockfile_version}`));
        process.exit(1);
      }

      // Read all files
      const files = readDirectory(absPath);
      console.log(`  Found ${files.size} files + abl.lock\n`);

      let hasErrors = false;

      // Tier 1: Root integrity
      console.log(chalk.white.bold('Tier 1: Root Integrity'));
      const integrityPayload = JSON.stringify({
        agents: sortedRecord(lockfile.agents),
        tools: sortedRecord(lockfile.tools),
        configs: sortedRecord(lockfile.configs),
        connections: sortedRecord(lockfile.connections),
        guardrails: sortedRecord(lockfile.guardrails),
        workflows: sortedRecord(lockfile.workflows),
        evals: sortedRecord(lockfile.evals),
        search: sortedRecord(lockfile.search),
        channels: sortedRecord(lockfile.channels),
        vocabulary: sortedRecord(lockfile.vocabulary),
        layer_hashes: sortedRecord(lockfile.layer_hashes),
      });
      const computedIntegrity = createHash('sha256').update(integrityPayload, 'utf8').digest('hex');
      const integrityMatch = computedIntegrity === lockfile.integrity;

      if (integrityMatch) {
        console.log(chalk.green('  Root hash: PASS'));
      } else {
        console.log(chalk.red('  Root hash: FAIL — lockfile may be corrupted or tampered'));
        hasErrors = true;
      }

      // Tier 2 & 3: Per-layer and per-file verification
      console.log(chalk.white.bold('\nTier 2-3: Layer & File Verification'));

      const sections: Array<{ name: string; entries: Record<string, LockfileEntry> }> = [
        { name: 'agents', entries: lockfile.agents ?? {} },
        { name: 'tools', entries: lockfile.tools ?? {} },
        { name: 'configs', entries: lockfile.configs ?? {} },
        { name: 'connections', entries: lockfile.connections ?? {} },
        { name: 'guardrails', entries: lockfile.guardrails ?? {} },
        { name: 'workflows', entries: lockfile.workflows ?? {} },
        { name: 'evals', entries: lockfile.evals ?? {} },
        { name: 'search', entries: lockfile.search ?? {} },
        { name: 'channels', entries: lockfile.channels ?? {} },
        { name: 'vocabulary', entries: lockfile.vocabulary ?? {} },
      ];

      for (const { name, entries } of sections) {
        const entryCount = Object.keys(entries).length;
        if (entryCount === 0) continue;

        const mismatched: string[] = [];
        const missing: string[] = [];

        for (const [entryName, meta] of Object.entries(entries)) {
          const content = findFileForEntry(name, entryName, files);
          if (content === undefined) {
            missing.push(entryName);
            continue;
          }

          const computed = computeSourceHash(content);
          if (computed !== meta.source_hash) {
            mismatched.push(entryName);
          }
        }

        if (mismatched.length === 0 && missing.length === 0) {
          console.log(chalk.green(`  ${name} (${entryCount} entries): PASS`));
        } else {
          hasErrors = true;
          console.log(chalk.red(`  ${name} (${entryCount} entries): FAIL`));
          for (const m of mismatched) {
            console.log(chalk.red(`    - ${m}: hash mismatch (file modified since export)`));
          }
          for (const m of missing) {
            console.log(chalk.yellow(`    - ${m}: file not found`));
          }
        }
      }

      // Summary
      console.log('');
      if (hasErrors) {
        console.log(
          chalk.red('VERIFICATION FAILED — export has been modified or corrupted since generation'),
        );
        process.exit(1);
      } else {
        console.log(chalk.green('VERIFICATION PASSED — all files match their recorded hashes'));
      }
    });
}
