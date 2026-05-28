/**
 * Workspace Commands
 *
 * Workspace (tenant) management commands.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { listWorkspaces, switchWorkspace, type Workspace } from '../lib/api-client.js';
import {
  setCurrentWorkspace,
  getCurrentWorkspaceId,
  getCurrentWorkspaceName,
  clearCurrentProject,
} from '../lib/config.js';
import { isAuthenticated, getCredentials, saveCredentials } from '../lib/credentials.js';

// =============================================================================
// HELPERS
// =============================================================================

function requireAuth(): void {
  if (!isAuthenticated()) {
    process.stderr.write(chalk.red('Not authenticated. Run: kore-platform-cli login') + '\n');
    process.exit(1);
  }
}

function formatTable(workspaces: Workspace[]): void {
  const currentId = getCurrentWorkspaceId();

  // Calculate column widths
  const nameWidth = Math.max(14, ...workspaces.map((w) => w.tenantName.length)) + 2;
  const roleWidth = Math.max(8, ...workspaces.map((w) => w.role.length)) + 2;
  const idWidth = 40;

  // Header
  process.stdout.write(
    chalk.gray(
      '┌' + '─'.repeat(nameWidth) + '┬' + '─'.repeat(roleWidth) + '┬' + '─'.repeat(idWidth) + '┐',
    ) + '\n',
  );
  process.stdout.write(
    chalk.gray('│') +
      chalk.white(' Name'.padEnd(nameWidth)) +
      chalk.gray('│') +
      chalk.white(' Role'.padEnd(roleWidth)) +
      chalk.gray('│') +
      chalk.white(' ID'.padEnd(idWidth)) +
      chalk.gray('│') +
      '\n',
  );
  process.stdout.write(
    chalk.gray(
      '├' + '─'.repeat(nameWidth) + '┼' + '─'.repeat(roleWidth) + '┼' + '─'.repeat(idWidth) + '┤',
    ) + '\n',
  );

  // Rows
  for (const workspace of workspaces) {
    const isCurrent = workspace.tenantId === currentId;
    const name = isCurrent
      ? chalk.green(workspace.tenantName.padEnd(nameWidth - 2)) + chalk.green('* ')
      : ' ' + workspace.tenantName.padEnd(nameWidth - 1);
    const role = ' ' + workspace.role.padEnd(roleWidth - 1);
    const id = ' ' + workspace.tenantId.padEnd(idWidth - 1);

    process.stdout.write(
      chalk.gray('│') +
        name +
        chalk.gray('│') +
        chalk.cyan(role) +
        chalk.gray('│') +
        chalk.gray(id) +
        chalk.gray('│') +
        '\n',
    );
  }

  // Footer
  process.stdout.write(
    chalk.gray(
      '└' + '─'.repeat(nameWidth) + '┴' + '─'.repeat(roleWidth) + '┴' + '─'.repeat(idWidth) + '┘',
    ) + '\n',
  );
}

// =============================================================================
// COMMANDS
// =============================================================================

/**
 * List workspaces
 */
async function list(): Promise<void> {
  requireAuth();

  const spinner = ora('Loading workspaces').start();

  try {
    const { tenants } = await listWorkspaces();
    spinner.stop();

    if (tenants.length === 0) {
      process.stdout.write(chalk.yellow('No workspaces found.') + '\n');
      return;
    }

    formatTable(tenants);

    const currentName = getCurrentWorkspaceName();
    if (currentName) {
      process.stdout.write(chalk.gray(`\nActive workspace: ${currentName}`) + '\n');
    }
  } catch (error) {
    spinner.stop();
    process.stderr.write(
      chalk.red(
        `Failed to list workspaces: ${error instanceof Error ? error.message : String(error)}`,
      ) + '\n',
    );
    process.exit(1);
  }
}

/**
 * Select (switch to) a workspace
 */
async function select(nameOrId: string): Promise<void> {
  requireAuth();

  const spinner = ora('Finding workspace').start();

  try {
    const { tenants } = await listWorkspaces();
    const lower = nameOrId.toLowerCase();
    const workspace = tenants.find(
      (w) => w.tenantName.toLowerCase() === lower || w.tenantId === nameOrId,
    );

    if (!workspace) {
      spinner.stop();
      process.stderr.write(chalk.red(`Workspace not found: ${nameOrId}`) + '\n');
      process.stdout.write(chalk.gray('Run: kore-platform-cli workspaces list') + '\n');
      process.exit(1);
    }

    // Skip if already on this workspace
    if (getCurrentWorkspaceId() === workspace.tenantId) {
      spinner.stop();
      process.stdout.write(chalk.yellow(`Already on workspace: ${workspace.tenantName}`) + '\n');
      return;
    }

    spinner.text = 'Switching workspace';
    const result = await switchWorkspace(workspace.tenantId);

    // Update stored access token with the new tenant-scoped JWT
    const creds = getCredentials();
    if (creds) {
      saveCredentials({
        token: result.accessToken,
        refreshToken: creds.refreshToken,
        expiresAt: creds.expiresAt,
        email: creds.email,
      });
    }

    // Persist workspace selection
    setCurrentWorkspace(workspace.tenantId, workspace.tenantName);

    // Clear project selection — projects are scoped to a workspace
    clearCurrentProject();

    spinner.stop();

    process.stdout.write(chalk.green(`✓ Switched to workspace: ${workspace.tenantName}`) + '\n');
    process.stdout.write(chalk.gray(`  Role: ${result.role}`) + '\n');
    process.stdout.write(
      chalk.gray('  Active project cleared (run: kore-platform-cli projects select <slug>)') + '\n',
    );
  } catch (error) {
    spinner.stop();
    process.stderr.write(
      chalk.red(
        `Failed to switch workspace: ${error instanceof Error ? error.message : String(error)}`,
      ) + '\n',
    );
    process.exit(1);
  }
}

/**
 * Show current workspace
 */
function current(): void {
  const name = getCurrentWorkspaceName();
  const id = getCurrentWorkspaceId();

  if (!name || !id) {
    process.stdout.write(chalk.yellow('No active workspace') + '\n');
    process.stdout.write(
      chalk.gray('Select one with: kore-platform-cli workspaces select <name>') + '\n',
    );
    return;
  }

  process.stdout.write(chalk.white('Active workspace: ') + chalk.cyan(name) + '\n');
  process.stdout.write(chalk.white('ID: ') + chalk.gray(id) + '\n');
}

// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerWorkspaceCommands(program: Command): void {
  const workspaces = program.command('workspaces').description('Manage workspaces');

  workspaces.command('list').alias('ls').description('List all workspaces').action(list);

  workspaces
    .command('select <name>')
    .description('Switch to a workspace (by name or ID)')
    .action(select);

  workspaces.command('current').description('Show active workspace').action(current);
}
