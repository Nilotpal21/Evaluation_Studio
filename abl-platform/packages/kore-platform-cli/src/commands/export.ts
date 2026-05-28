/**
 * CLI Export Command
 *
 * kore export [--project <id>] [--format yaml|legacy] [--output <path>]
 *             [--layers <layers>] [--all-layers]
 *
 * Downloads a project as a folder of agent/tool files.
 * version=2 uses the layered v2 orchestrator with --layers support.
 */

import type { Command } from 'commander';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import chalk from 'chalk';
import { getApiUrl, getConfig } from '../lib/config.js';
import { getToken } from '../lib/credentials.js';

/** Valid v2 layer names */
const VALID_LAYERS = [
  'core',
  'connections',
  'guardrails',
  'workflows',
  'evals',
  'search',
  'channels',
  'vocabulary',
] as const;

const DEFAULT_LAYERS = ['core', 'connections', 'guardrails', 'workflows'];

/** Polling interval for async export jobs (ms) */
const JOB_POLL_INTERVAL_MS = 2000;
/** Max time to wait for async job (ms) */
const JOB_POLL_TIMEOUT_MS = 300_000;

function getHeaders(): Record<string, string> {
  const token = getToken();
  if (!token) throw new Error('Not authenticated. Run: kore-platform-cli login');
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

function parseLayers(input: string): string[] {
  const layers = input
    .split(',')
    .map((l) => l.trim().toLowerCase())
    .filter((l) => (VALID_LAYERS as readonly string[]).includes(l));

  if (layers.length === 0) {
    console.error(chalk.red(`No valid layers specified. Valid layers: ${VALID_LAYERS.join(', ')}`));
    process.exit(1);
  }
  return layers;
}

export function registerExportCommand(program: Command): void {
  program
    .command('export')
    .description('Export a project as agent and tool files')
    .option('--project <id>', 'Project ID (uses current project if omitted)')
    .option('--format <format>', 'DSL format: yaml or legacy', 'legacy')
    .option('--output <path>', 'Output directory', '.')
    .option('--include-deployments', 'Include deployment configs', false)
    .option('--layers <layers>', 'Comma-separated layers to export (v2)')
    .option('--all-layers', 'Export all layers (v2)', false)
    .action(async (opts) => {
      const apiUrl = getApiUrl();
      const headers = getHeaders();
      const config = getConfig();
      const projectId = opts.project ?? config.currentProjectId;

      if (!projectId) {
        console.error('No project specified. Use --project <id> or set a current project.');
        process.exit(1);
      }

      const useV2 = opts.layers || opts.allLayers;
      const layers = opts.allLayers
        ? [...VALID_LAYERS]
        : opts.layers
          ? parseLayers(opts.layers)
          : DEFAULT_LAYERS;

      const params = new URLSearchParams({
        format: 'zip',
        dsl_format: opts.format,
      });

      if (useV2) {
        params.set('version', '2');
        params.set('layers', layers.join(','));
      }

      if (opts.includeDeployments) {
        params.set('include_deployments', 'true');
      }

      const versionLabel = useV2 ? 'v2' : 'v1';
      console.log(
        `Exporting project ${projectId} (${versionLabel}, format: ${opts.format}` +
          (useV2 ? `, layers: ${layers.join(',')}` : '') +
          ')...',
      );

      const response = await fetch(`${apiUrl}/api/projects/${projectId}/export?${params}`, {
        headers,
      });

      if (!response.ok) {
        console.error(chalk.red(`Export failed: ${response.statusText}`));
        process.exit(1);
      }

      let data = (await response.json()) as {
        success: boolean;
        jobId?: string;
        manifest?: Record<string, unknown>;
        lockfile?: Record<string, unknown>;
        files?: Record<string, string>;
        warnings?: string[];
        error?: { code: string; message: string };
      };

      // Async job detection: if API returns jobId, poll until complete
      if (data.jobId) {
        console.log(`Large export — async job started (${data.jobId}). Polling...`);
        data = await pollExportJob(apiUrl, projectId, data.jobId, headers);
      }

      if (!data.success) {
        console.error(chalk.red('Export failed:'), data.error?.message ?? 'Unknown error');
        process.exit(1);
      }

      // Write files to output directory
      const outputDir = resolve(opts.output);
      const slug = (data.manifest?.slug as string) ?? 'project';
      const projectDir = join(outputDir, slug);

      if (!existsSync(projectDir)) {
        mkdirSync(projectDir, { recursive: true });
      }

      let fileCount = 0;
      const files = data.files ?? {};
      for (const [filePath, content] of Object.entries(files)) {
        const fullPath = join(projectDir, filePath);
        const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(fullPath, content, 'utf-8');
        fileCount++;
      }

      // Write lockfile
      if (data.lockfile) {
        const lockfilePath = join(projectDir, 'lockfile.json');
        writeFileSync(lockfilePath, JSON.stringify(data.lockfile, null, 2), 'utf-8');
      }

      if (data.warnings && data.warnings.length > 0) {
        console.log(chalk.yellow('\nWarnings:'));
        for (const w of data.warnings) {
          console.log(chalk.yellow(`  - ${w}`));
        }
      }

      console.log(chalk.green(`\nExported ${fileCount} files to ${projectDir}`));
    });
}

/** Poll an async export job until it completes or times out */
async function pollExportJob(
  apiUrl: string,
  projectId: string,
  jobId: string,
  headers: Record<string, string>,
): Promise<{
  success: boolean;
  manifest?: Record<string, unknown>;
  lockfile?: Record<string, unknown>;
  files?: Record<string, string>;
  warnings?: string[];
  error?: { code: string; message: string };
}> {
  const start = Date.now();

  while (Date.now() - start < JOB_POLL_TIMEOUT_MS) {
    await sleep(JOB_POLL_INTERVAL_MS);

    const resp = await fetch(`${apiUrl}/api/projects/${projectId}/export/status?jobId=${jobId}`, {
      headers,
    });

    if (!resp.ok) {
      return { success: false, error: { code: 'POLL_FAILED', message: resp.statusText } };
    }

    const status = (await resp.json()) as {
      state: 'pending' | 'active' | 'completed' | 'failed';
      result?: {
        success: boolean;
        manifest: Record<string, unknown>;
        lockfile: Record<string, unknown>;
        files: Record<string, string>;
        warnings: string[];
      };
      error?: string;
    };

    if (status.state === 'completed' && status.result) {
      return status.result;
    }

    if (status.state === 'failed') {
      return {
        success: false,
        error: { code: 'JOB_FAILED', message: status.error ?? 'Export job failed' },
      };
    }

    process.stdout.write('.');
  }

  return {
    success: false,
    error: { code: 'TIMEOUT', message: 'Export job timed out after 5 minutes' },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
