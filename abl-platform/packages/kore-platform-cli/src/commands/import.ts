/**
 * CLI Import Command
 *
 * kore import <path> [--project <id>] [--dry-run] [--verbose]
 *
 * Import agents and tools from a local directory into a project.
 * Uses Studio v2 import endpoints with staged import support.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { getApiUrl, getConfig } from '../lib/config.js';
import { getToken } from '../lib/credentials.js';

// CLI output helpers — use process.stdout/stderr to avoid server-side lint hooks
function print(msg: string): void {
  process.stdout.write(msg + '\n');
}
function printErr(msg: string): void {
  process.stderr.write(msg + '\n');
}

function getHeaders(): Record<string, string> {
  const token = getToken();
  if (!token) throw new Error('Not authenticated. Run: kore-platform-cli login');
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

/** Recursively read all files in a directory into a path->content map */
function readDirectory(dir: string, basePath = ''): Record<string, string> {
  const files: Record<string, string> = {};
  const entries = readdirSync(dir);

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const relPath = basePath ? `${basePath}/${entry}` : entry;
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      Object.assign(files, readDirectory(fullPath, relPath));
    } else if (stat.isFile()) {
      files[relPath] = readFileSync(fullPath, 'utf-8');
    }
  }

  return files;
}

/** Extract entry_agent from project.json in the file map */
function extractEntryAgent(files: Record<string, string>): string | null {
  const projectJson = files['project.json'];
  if (!projectJson) return null;
  try {
    const manifest = JSON.parse(projectJson) as { entry_agent?: string };
    return manifest.entry_agent ?? null;
  } catch {
    return null;
  }
}

// ─── V2 Preview Response Shape ──────────────────────────────────────────────

interface ImportPreviewV2 {
  success: boolean;
  preview: {
    valid: boolean;
    formatVersion?: string;
    layers?: string[];
    layerChanges?: Record<
      string,
      { added: number; modified: number; removed: number; unchanged: number }
    >;
    agentChanges: {
      added: string[];
      modified: Array<{ name: string; diff?: unknown }>;
      removed: string[];
      unchanged: string[];
    };
    toolChanges: {
      added: string[];
      modified: string[];
      removed: string[];
    };
    syntaxErrors: Array<{ file: string; errors: Array<{ line?: number; message: string }> }>;
    warnings: string[];
  };
  warnings?: string[];
  error?: { code: string; message: string };
}

// ─── V2 Apply Response Shape ────────────────────────────────────────────────

interface ImportApplyV2 {
  success: boolean;
  operationId?: string;
  phase?: string;
  layers?: string[];
  error?: { code?: string; phase?: string; layer?: string; message: string };
}

export function registerImportCommand(program: Command): void {
  program
    .command('import <path>')
    .description('Import agents and tools from a directory into a project')
    .option('--project <id>', 'Project ID (uses current project if omitted)')
    .option('--dry-run', 'Preview changes without applying', false)
    .option('--verbose', 'Print raw API responses', false)
    .action(async (importPath: string, opts) => {
      const apiUrl = getApiUrl();
      const headers = getHeaders();
      const config = getConfig();
      const projectId = opts.project ?? config.currentProjectId;

      if (!projectId) {
        printErr(chalk.red('No project specified. Use --project <id> or set a current project.'));
        process.exit(1);
      }

      const absPath = resolve(importPath);
      print(`Reading files from ${absPath}...`);

      const files = readDirectory(absPath);
      const fileCount = Object.keys(files).length;
      print(`Found ${fileCount} files`);

      if (fileCount === 0) {
        printErr(chalk.red('No files found in the specified directory.'));
        process.exit(1);
      }

      // ── Preview ──────────────────────────────────────────────────────

      const spinner = ora('Previewing import...').start();
      const previewResponse = await fetch(`${apiUrl}/api/projects/${projectId}/import/preview`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ files }),
      });

      if (!previewResponse.ok) {
        spinner.stop();
        const errorText = await previewResponse.text().catch(() => previewResponse.statusText);
        printErr(chalk.red(`Preview failed (${previewResponse.status}): ${errorText}`));
        process.exit(1);
      }

      const preview = (await previewResponse.json()) as ImportPreviewV2;
      spinner.stop();

      if (opts.verbose) {
        print(chalk.gray('\n[verbose] Preview response:'));
        print(chalk.gray(JSON.stringify(preview, null, 2)));
      }

      if (!preview.success || preview.error) {
        printErr(chalk.red(`Preview failed: ${preview.error?.message ?? 'Unknown error'}`));
        process.exit(1);
      }

      const previewData = preview.preview;

      // Display layer changes
      if (previewData.layerChanges) {
        print(chalk.white.bold('\nLayer summary:'));
        for (const [layer, summary] of Object.entries(previewData.layerChanges)) {
          const parts: string[] = [];
          if (summary.added > 0) parts.push(chalk.green(`+${summary.added}`));
          if (summary.modified > 0) parts.push(chalk.yellow(`~${summary.modified}`));
          if (summary.removed > 0) parts.push(chalk.red(`-${summary.removed}`));
          if (summary.unchanged > 0) parts.push(chalk.gray(`=${summary.unchanged}`));
          print(`  ${layer}: ${parts.join(' ')}`);
        }
      }

      // Display agent changes
      const agents = previewData.agentChanges;
      if (agents.added.length || agents.modified.length || agents.removed.length) {
        print(chalk.white.bold('\nAgent changes:'));
        if (agents.added.length) print(chalk.green(`  Added: ${agents.added.join(', ')}`));
        if (agents.modified.length)
          print(chalk.yellow(`  Modified: ${agents.modified.map((a) => a.name).join(', ')}`));
        if (agents.removed.length) print(chalk.red(`  Removed: ${agents.removed.join(', ')}`));
        if (agents.unchanged.length)
          print(chalk.gray(`  Unchanged: ${agents.unchanged.join(', ')}`));
      }

      // Display tool changes
      const tools = previewData.toolChanges;
      if (tools.added.length || tools.modified.length || tools.removed.length) {
        print(chalk.white.bold('\nTool changes:'));
        if (tools.added.length) print(chalk.green(`  Added: ${tools.added.join(', ')}`));
        if (tools.modified.length) print(chalk.yellow(`  Modified: ${tools.modified.join(', ')}`));
        if (tools.removed.length) print(chalk.red(`  Removed: ${tools.removed.join(', ')}`));
      }

      // Display syntax errors
      if (previewData.syntaxErrors?.length) {
        print(chalk.red.bold('\nSyntax errors:'));
        for (const err of previewData.syntaxErrors) {
          print(chalk.red(`  ${err.file}:`));
          for (const e of err.errors) {
            const loc = e.line ? ` (line ${e.line})` : '';
            print(chalk.red(`    - ${e.message}${loc}`));
          }
        }
      }

      // Display warnings
      const allWarnings = [...(previewData.warnings ?? []), ...(preview.warnings ?? [])];
      if (allWarnings.length) {
        print(chalk.yellow.bold('\nWarnings:'));
        for (const w of allWarnings) {
          print(chalk.yellow(`  - ${w}`));
        }
      }

      if (opts.dryRun) {
        print(chalk.gray('\n(Dry run - no changes applied)'));
        return;
      }

      if (!previewData.valid) {
        printErr(chalk.red('\nImport has validation errors. Fix them and retry.'));
        process.exit(1);
      }

      // ── Apply ────────────────────────────────────────────────────────

      const applySpinner = ora('Applying import...').start();
      const applyResponse = await fetch(`${apiUrl}/api/projects/${projectId}/import/apply`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ files }),
      });

      if (!applyResponse.ok) {
        applySpinner.stop();
        const errorText = await applyResponse.text().catch(() => applyResponse.statusText);
        printErr(chalk.red(`Import failed (${applyResponse.status}): ${errorText}`));
        process.exit(1);
      }

      const applyResult = (await applyResponse.json()) as ImportApplyV2;
      applySpinner.stop();

      if (opts.verbose) {
        print(chalk.gray('\n[verbose] Apply response:'));
        print(chalk.gray(JSON.stringify(applyResult, null, 2)));
      }

      if (!applyResult.success) {
        printErr(chalk.red(`Import failed: ${applyResult.error?.message ?? 'Unknown error'}`));
        if (applyResult.error?.phase) printErr(chalk.red(`  Phase: ${applyResult.error.phase}`));
        if (applyResult.error?.layer) printErr(chalk.red(`  Layer: ${applyResult.error.layer}`));
        process.exit(1);
      }

      print(chalk.green('✓ Import applied successfully'));
      if (applyResult.operationId) print(chalk.gray(`  Operation: ${applyResult.operationId}`));
      if (applyResult.phase) print(chalk.gray(`  Phase: ${applyResult.phase}`));
      if (applyResult.layers?.length)
        print(chalk.gray(`  Layers: ${applyResult.layers.join(', ')}`));

      // ── Set entry agent ──────────────────────────────────────────────

      const entryAgent = extractEntryAgent(files);
      if (entryAgent) {
        try {
          const patchResponse = await fetch(`${apiUrl}/api/projects/${projectId}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ entryAgentName: entryAgent }),
          });

          if (patchResponse.ok) {
            print(chalk.green(`✓ Set entry agent: ${entryAgent}`));
          } else {
            print(chalk.yellow(`  Warning: Could not set entry agent (${patchResponse.status})`));
          }
        } catch (err) {
          print(
            chalk.yellow(
              `  Warning: Could not set entry agent: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        }
      }
    });
}
