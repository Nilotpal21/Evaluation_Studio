/**
 * CLI Git Sync Commands
 *
 * kore git init --project <id> --repo <url> [--branch <branch>]
 * kore git push --project <id> [--branch <branch>] [--message <msg>]
 * kore git pull --project <id> [--branch <branch>]
 * kore git status --project <id>
 * kore git promote --project <id> --from <branch> --to <branch>
 *
 * Manages Git sync for project exports using branch-per-environment.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { apiRequest } from '../lib/api-client.js';
import { getConfig } from '../lib/config.js';

function resolveProjectId(opts: { project?: string }): string {
  const config = getConfig();
  const projectId = opts.project ?? config.currentProjectId;
  if (!projectId) {
    console.error('No project specified. Use --project <id> or set a current project.');
    process.exit(1);
  }
  return projectId;
}

export function registerGitCommands(program: Command): void {
  const git = program.command('git').description('Git sync commands for project exports');

  // ── git init ──────────────────────────────────────────────────────────
  git
    .command('init')
    .description('Initialize Git sync for a project')
    .option('--project <id>', 'Project ID')
    .requiredOption('--repo <url>', 'Git repository URL')
    .option('--branch <branch>', 'Default branch name', 'main')
    .action(async (opts) => {
      const projectId = resolveProjectId(opts);

      console.log(`Initializing Git sync for project ${projectId}...`);
      console.log(`  Repository: ${opts.repo}`);
      console.log(`  Branch: ${opts.branch}`);

      const result = await apiRequest<{ success: boolean; message: string }>(
        `/api/projects/${projectId}/git/init`,
        {
          method: 'POST',
          body: { repoUrl: opts.repo, branch: opts.branch },
        },
      );

      console.log(chalk.green(`\n${result.message ?? 'Git sync initialized'}`));
    });

  // ── git push ──────────────────────────────────────────────────────────
  git
    .command('push')
    .description('Push current project state to Git')
    .option('--project <id>', 'Project ID')
    .option('--branch <branch>', 'Target branch')
    .option('--message <msg>', 'Commit message')
    .option('--layers <layers>', 'Comma-separated layers to push')
    .action(async (opts) => {
      const projectId = resolveProjectId(opts);

      console.log(`Pushing project ${projectId} to Git...`);

      const body: Record<string, unknown> = {};
      if (opts.branch) body.branch = opts.branch;
      if (opts.message) body.commitMessage = opts.message;
      if (opts.layers) body.layers = opts.layers.split(',').map((l: string) => l.trim());

      const result = await apiRequest<{
        success: boolean;
        commitSha: string;
        branch: string;
        filesChanged: number;
      }>(`/api/projects/${projectId}/git/push`, {
        method: 'POST',
        body,
      });

      console.log(chalk.green('\nPush complete'));
      console.log(`  Branch: ${result.branch}`);
      console.log(`  Commit: ${result.commitSha}`);
      console.log(`  Files changed: ${result.filesChanged}`);
    });

  // ── git pull ──────────────────────────────────────────────────────────
  git
    .command('pull')
    .description('Pull latest from Git into project')
    .option('--project <id>', 'Project ID')
    .option('--branch <branch>', 'Source branch')
    .option('--dry-run', 'Preview changes without applying', false)
    .action(async (opts) => {
      const projectId = resolveProjectId(opts);

      console.log(`Pulling from Git into project ${projectId}...`);

      const body: Record<string, unknown> = { dryRun: opts.dryRun };
      if (opts.branch) body.branch = opts.branch;

      const result = await apiRequest<{
        success: boolean;
        changes: { added: string[]; modified: string[]; removed: string[] };
        dryRun: boolean;
      }>(`/api/projects/${projectId}/git/pull`, {
        method: 'POST',
        body,
      });

      const { changes } = result;
      console.log('\nChanges:');
      if (changes.added.length > 0) {
        console.log(chalk.green(`  Added: ${changes.added.join(', ')}`));
      }
      if (changes.modified.length > 0) {
        console.log(chalk.yellow(`  Modified: ${changes.modified.join(', ')}`));
      }
      if (changes.removed.length > 0) {
        console.log(chalk.red(`  Removed: ${changes.removed.join(', ')}`));
      }
      if (
        changes.added.length === 0 &&
        changes.modified.length === 0 &&
        changes.removed.length === 0
      ) {
        console.log('  No changes');
      }

      if (result.dryRun) {
        console.log(chalk.gray('\n(Dry run - no changes applied)'));
      } else {
        console.log(chalk.green('\nPull complete'));
      }
    });

  // ── git status ────────────────────────────────────────────────────────
  git
    .command('status')
    .description('Show Git sync status for a project')
    .option('--project <id>', 'Project ID')
    .action(async (opts) => {
      const projectId = resolveProjectId(opts);

      const result = await apiRequest<{
        configured: boolean;
        repoUrl?: string;
        branch?: string;
        lastPushAt?: string;
        lastPushSha?: string;
        lastPullAt?: string;
        dirty?: boolean;
      }>(`/api/projects/${projectId}/git/status`);

      if (!result.configured) {
        console.log(chalk.yellow('Git sync is not configured for this project.'));
        console.log('Run: kore-platform-cli git init --repo <url>');
        return;
      }

      console.log(chalk.white.bold('Git Sync Status'));
      console.log(`  Repository: ${chalk.cyan(result.repoUrl ?? 'unknown')}`);
      console.log(`  Branch: ${chalk.cyan(result.branch ?? 'main')}`);
      if (result.lastPushAt) {
        console.log(`  Last push: ${result.lastPushAt} (${result.lastPushSha ?? 'unknown'})`);
      }
      if (result.lastPullAt) {
        console.log(`  Last pull: ${result.lastPullAt}`);
      }
      if (result.dirty) {
        console.log(chalk.yellow('  Status: uncommitted changes'));
      } else {
        console.log(chalk.green('  Status: clean'));
      }
    });

  // ── git promote ───────────────────────────────────────────────────────
  git
    .command('promote')
    .description('Promote project config from one branch to another (merge)')
    .option('--project <id>', 'Project ID')
    .requiredOption('--from <branch>', 'Source branch')
    .requiredOption('--to <branch>', 'Target branch')
    .action(async (opts) => {
      const projectId = resolveProjectId(opts);

      console.log(`Promoting ${opts.from} -> ${opts.to} for project ${projectId}...`);

      const result = await apiRequest<{
        success: boolean;
        mergeSha: string;
        conflicts?: string[];
      }>(`/api/projects/${projectId}/git/promote`, {
        method: 'POST',
        body: { fromBranch: opts.from, toBranch: opts.to },
      });

      if (result.conflicts && result.conflicts.length > 0) {
        console.log(chalk.yellow('\nMerge conflicts detected:'));
        for (const c of result.conflicts) {
          console.log(chalk.yellow(`  - ${c}`));
        }
      } else {
        console.log(chalk.green(`\nPromoted successfully`));
        console.log(`  Merge commit: ${result.mergeSha}`);
      }
    });
}
