/**
 * Connector Commands
 *
 * Enterprise connector management commands (SharePoint, Jira, etc.).
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { isAuthenticated } from '../lib/credentials.js';
import {
  listConnectors,
  createConnector,
  updateConnector,
  deleteConnector,
  initiateConnectorAuth,
  getConnectorAuthStatus,
  startConnectorSync,
  getConnectorSyncStatus,
  pauseConnectorSync,
  resumeConnectorSync,
  type Connector,
  type SyncStatusResponse,
} from '../lib/api-client.js';

// =============================================================================
// HELPERS
// =============================================================================

function requireAuth(): void {
  if (!isAuthenticated()) {
    console.error(chalk.red('Not authenticated. Run: kore-platform-cli login'));
    process.exit(1);
  }
}

function formatConnectorsTable(connectors: Connector[]): void {
  if (connectors.length === 0) {
    console.log(chalk.yellow('No connectors found.'));
    console.log(
      chalk.gray(
        'Create one with: kore-platform-cli connector create <type> <name> --index-id <id>',
      ),
    );
    return;
  }

  // Calculate column widths
  const idWidth = 26;
  const typeWidth = 15;
  const statusWidth = 12;
  const docsWidth = 10;

  // Header
  console.log(
    chalk.gray(
      '┌' +
        '─'.repeat(idWidth) +
        '┬' +
        '─'.repeat(typeWidth) +
        '┬' +
        '─'.repeat(statusWidth) +
        '┬' +
        '─'.repeat(docsWidth) +
        '┐',
    ),
  );
  console.log(
    chalk.gray('│') +
      chalk.white(' Connector ID'.padEnd(idWidth)) +
      chalk.gray('│') +
      chalk.white(' Type'.padEnd(typeWidth)) +
      chalk.gray('│') +
      chalk.white(' Status'.padEnd(statusWidth)) +
      chalk.gray('│') +
      chalk.white(' Documents'.padEnd(docsWidth)) +
      chalk.gray('│'),
  );
  console.log(
    chalk.gray(
      '├' +
        '─'.repeat(idWidth) +
        '┼' +
        '─'.repeat(typeWidth) +
        '┼' +
        '─'.repeat(statusWidth) +
        '┼' +
        '─'.repeat(docsWidth) +
        '┤',
    ),
  );

  // Rows
  for (const connector of connectors) {
    const id = (' ' + connector._id.substring(0, 24)).padEnd(idWidth);
    const type = (' ' + connector.connectorType).padEnd(typeWidth);

    const status = connector.errorState.isPaused ? 'paused' : 'active';
    let statusColor;
    switch (status) {
      case 'active':
        statusColor = chalk.green;
        break;
      case 'paused':
        statusColor = chalk.yellow;
        break;
      default:
        statusColor = chalk.gray;
    }
    const statusText = (' ' + status).padEnd(statusWidth);
    const docs = String(connector.syncState.totalDocuments).padStart(docsWidth - 2);

    console.log(
      chalk.gray('│') +
        chalk.white(id) +
        chalk.gray('│') +
        chalk.cyan(type) +
        chalk.gray('│') +
        statusColor(statusText) +
        chalk.gray('│') +
        ' ' +
        chalk.white(docs) +
        ' ' +
        chalk.gray('│'),
    );
  }

  // Footer
  console.log(
    chalk.gray(
      '└' +
        '─'.repeat(idWidth) +
        '┴' +
        '─'.repeat(typeWidth) +
        '┴' +
        '─'.repeat(statusWidth) +
        '┴' +
        '─'.repeat(docsWidth) +
        '┘',
    ),
  );
}

// =============================================================================
// COMMANDS
// =============================================================================

/**
 * List connectors
 */
async function list(options: { indexId?: string }): Promise<void> {
  requireAuth();

  if (!options.indexId) {
    console.error(chalk.red('--index-id is required'));
    process.exit(1);
  }

  const spinner = ora('Loading connectors').start();

  try {
    const { connectors } = await listConnectors(options.indexId);

    spinner.stop();
    formatConnectorsTable(connectors);
  } catch (error) {
    spinner.stop();
    console.error(
      chalk.red(`Failed to list connectors: ${error instanceof Error ? error.message : error}`),
    );
    process.exit(1);
  }
}

/**
 * Create a connector
 */
async function create(
  type: 'sharepoint' | 'jira' | 'confluence',
  name: string,
  options: { indexId: string; tenantUrl?: string; clientId?: string },
): Promise<void> {
  requireAuth();

  if (!options.indexId) {
    console.error(chalk.red('--index-id is required'));
    process.exit(1);
  }

  // For SharePoint, require tenantUrl and clientId
  if (type === 'sharepoint') {
    if (!options.tenantUrl || !options.clientId) {
      console.error(chalk.red('SharePoint connectors require --tenant-url and --client-id'));
      process.exit(1);
    }
  }

  const spinner = ora(`Creating ${type} connector`).start();

  try {
    const connectionConfig: Record<string, unknown> = {};
    if (type === 'sharepoint') {
      connectionConfig.tenantUrl = options.tenantUrl;
      connectionConfig.clientId = options.clientId;
    }

    const { connector } = await createConnector({
      indexId: options.indexId,
      name,
      connectorType: type,
      connectionConfig,
    });

    spinner.stop();

    console.log(chalk.green(`✓ Created ${type} connector: ${name}`));
    console.log(chalk.gray(`  Connector ID: ${connector._id}`));
    console.log(
      chalk.gray(
        `  Next step: Authenticate with: kore-platform-cli connector auth ${connector._id}`,
      ),
    );
  } catch (error) {
    spinner.stop();
    console.error(
      chalk.red(`Failed to create connector: ${error instanceof Error ? error.message : error}`),
    );
    process.exit(1);
  }
}

/**
 * Authenticate connector (OAuth Device Flow)
 */
async function auth(connectorId: string): Promise<void> {
  requireAuth();

  const spinner = ora('Initializing authentication').start();

  try {
    // Initiate device code flow
    const deviceCode = await initiateConnectorAuth(connectorId);

    spinner.stop();

    // Display device code to user
    console.log(chalk.white.bold('\n┌────────────────────────────────────────────┐'));
    console.log(chalk.white.bold('│  Open this URL in your browser:            │'));
    console.log(
      chalk.white.bold('│  ') +
        chalk.cyan(deviceCode.verificationUri.padEnd(38)) +
        chalk.white.bold(' │'),
    );
    console.log(chalk.white.bold('│                                            │'));
    console.log(
      chalk.white.bold('│  Enter code: ') +
        chalk.yellow.bold(deviceCode.userCode.padEnd(24)) +
        chalk.white.bold(' │'),
    );
    console.log(chalk.white.bold('└────────────────────────────────────────────┘\n'));

    // Poll for completion
    const authSpinner = ora('Waiting for authorization').start();

    let authenticated = false;
    const interval = deviceCode.interval || 5;
    const maxAttempts = Math.floor(deviceCode.expiresIn / interval);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, interval * 1000));

      try {
        const status = await getConnectorAuthStatus(connectorId);

        if (status.authenticated) {
          authenticated = true;
          break;
        }

        if (status.status === 'expired') {
          authSpinner.fail('Device code expired');
          console.log(
            chalk.gray('Please run the command again to start a new authentication flow.'),
          );
          process.exit(1);
        }

        if (status.status === 'denied') {
          authSpinner.fail('Authorization denied');
          process.exit(1);
        }

        if (status.status === 'slow_down' && status.interval) {
          // Increase polling interval
          await new Promise((resolve) => setTimeout(resolve, (status.interval || interval) * 1000));
        }

        // Update spinner text with attempt count
        authSpinner.text = `Waiting for authorization (${attempt + 1}/${maxAttempts})`;
      } catch (pollError) {
        // Continue polling on transient errors
        continue;
      }
    }

    if (!authenticated) {
      authSpinner.fail('Authentication timed out');
      console.log(chalk.gray('Please run the command again to start a new authentication flow.'));
      process.exit(1);
    }

    authSpinner.stop();
    console.log(chalk.green('✓ Successfully authenticated!'));
    console.log(
      chalk.gray(
        `  You can now start a sync with: kore-platform-cli connector sync start ${connectorId}`,
      ),
    );
  } catch (error) {
    spinner.stop();
    console.error(
      chalk.red(`Authentication failed: ${error instanceof Error ? error.message : error}`),
    );
    process.exit(1);
  }
}

/**
 * Configure filters
 */
async function filterSet(
  connectorId: string,
  options: {
    indexId?: string;
    sites?: string;
    libraries?: string;
    contentTypes?: string;
    modifiedSince?: string;
    mode?: 'include' | 'exclude';
  },
): Promise<void> {
  requireAuth();

  if (!options.indexId) {
    console.error(chalk.red('--index-id is required'));
    process.exit(1);
  }

  const spinner = ora('Updating filters').start();

  try {
    const filterConfig: any = {};

    if (options.sites) {
      filterConfig.siteUrls = options.sites.split(',').map((s) => s.trim());
    }
    if (options.libraries) {
      filterConfig.libraryNames = options.libraries.split(',').map((l) => l.trim());
    }
    if (options.contentTypes) {
      filterConfig.contentTypes = options.contentTypes.split(',').map((t) => t.trim());
    }
    if (options.modifiedSince) {
      filterConfig.modifiedSince = new Date(options.modifiedSince);
    }
    if (options.mode) {
      filterConfig.mode = options.mode;
    }

    await updateConnector(options.indexId, connectorId, { filterConfig });

    spinner.stop();
    console.log(chalk.green('✓ Filters updated'));
  } catch (error) {
    spinner.stop();
    console.error(
      chalk.red(`Failed to update filters: ${error instanceof Error ? error.message : error}`),
    );
    process.exit(1);
  }
}

/**
 * Clear filters
 */
async function filterClear(connectorId: string, options: { indexId?: string }): Promise<void> {
  requireAuth();

  if (!options.indexId) {
    console.error(chalk.red('--index-id is required'));
    process.exit(1);
  }

  const spinner = ora('Clearing filters').start();

  try {
    await updateConnector(options.indexId, connectorId, {
      filterConfig: {
        mode: 'include',
        siteUrls: [],
        libraryNames: [],
        contentTypes: [],
        modifiedSince: null,
      },
    });

    spinner.stop();
    console.log(chalk.green('✓ Filters cleared'));
  } catch (error) {
    spinner.stop();
    console.error(
      chalk.red(`Failed to clear filters: ${error instanceof Error ? error.message : error}`),
    );
    process.exit(1);
  }
}

/**
 * Set permission mode
 */
async function permissionMode(
  connectorId: string,
  options: { indexId?: string; mode: 'full' | 'simplified' | 'disabled' },
): Promise<void> {
  requireAuth();

  if (!options.indexId) {
    console.error(chalk.red('--index-id is required'));
    process.exit(1);
  }

  if (!options.mode) {
    console.error(chalk.red('--mode is required (full, simplified, or disabled)'));
    process.exit(1);
  }

  const spinner = ora(`Setting permission mode to ${options.mode}`).start();

  try {
    await updateConnector(options.indexId, connectorId, {
      permissionConfig: { mode: options.mode },
    });

    spinner.stop();
    console.log(chalk.green(`✓ Permission mode set to ${options.mode}`));

    if (options.mode === 'full') {
      console.log(chalk.gray('  Accuracy: 100% (may require additional OAuth scopes)'));
    } else if (options.mode === 'simplified') {
      console.log(chalk.gray('  Accuracy: ~95% (faster, fewer API calls)'));
    } else {
      console.log(chalk.gray('  All documents will be accessible to all users'));
    }
  } catch (error) {
    spinner.stop();
    console.error(
      chalk.red(`Failed to set permission mode: ${error instanceof Error ? error.message : error}`),
    );
    process.exit(1);
  }
}

/**
 * Start sync
 */
async function syncStart(connectorId: string, options: { delta?: boolean }): Promise<void> {
  requireAuth();

  const syncType = options.delta ? 'delta' : 'full';
  const spinner = ora(`Starting ${syncType} sync`).start();

  try {
    await startConnectorSync(connectorId, syncType);

    spinner.stop();
    console.log(chalk.green(`✓ ${syncType} sync started`));
    console.log(
      chalk.gray(`  Check status with: kore-platform-cli connector sync status ${connectorId}`),
    );
  } catch (error) {
    spinner.stop();
    console.error(
      chalk.red(`Failed to start sync: ${error instanceof Error ? error.message : error}`),
    );
    process.exit(1);
  }
}

/**
 * Get sync status
 */
async function syncStatus(connectorId: string): Promise<void> {
  requireAuth();

  const spinner = ora('Loading sync status').start();

  try {
    const status = await getConnectorSyncStatus(connectorId);

    spinner.stop();

    console.log(chalk.white('Status: ') + chalk.cyan(status.status));

    if (status.status === 'syncing') {
      console.log(
        chalk.white('Progress: ') +
          chalk.yellow(`${status.progress.processed} / ${status.progress.total}`) +
          chalk.gray(` (${status.progress.percentage}%)`),
      );

      if (status.progress.failed > 0) {
        console.log(chalk.white('Failed: ') + chalk.red(status.progress.failed));
      }
    } else if (status.status === 'paused') {
      console.log(chalk.yellow('Sync is paused'));
      if (status.errorState.pauseReason) {
        console.log(chalk.gray(`  Reason: ${status.errorState.pauseReason}`));
      }
    } else {
      console.log(chalk.gray('No active sync'));
      if (status.syncState.lastFullSyncAt) {
        console.log(
          chalk.gray(`  Last sync: ${new Date(status.syncState.lastFullSyncAt).toLocaleString()}`),
        );
      }
    }
  } catch (error) {
    spinner.stop();
    console.error(
      chalk.red(`Failed to get sync status: ${error instanceof Error ? error.message : error}`),
    );
    process.exit(1);
  }
}

/**
 * Pause sync
 */
async function syncPause(connectorId: string, options: { reason?: string }): Promise<void> {
  requireAuth();

  const spinner = ora('Pausing sync').start();

  try {
    await pauseConnectorSync(connectorId, options.reason);

    spinner.stop();
    console.log(chalk.green('✓ Sync paused'));
    console.log(
      chalk.gray(`  Resume with: kore-platform-cli connector sync resume ${connectorId}`),
    );
  } catch (error) {
    spinner.stop();
    console.error(
      chalk.red(`Failed to pause sync: ${error instanceof Error ? error.message : error}`),
    );
    process.exit(1);
  }
}

/**
 * Resume sync
 */
async function syncResume(connectorId: string): Promise<void> {
  requireAuth();

  const spinner = ora('Resuming sync').start();

  try {
    await resumeConnectorSync(connectorId);

    spinner.stop();
    console.log(chalk.green('✓ Sync resumed'));
  } catch (error) {
    spinner.stop();
    console.error(
      chalk.red(`Failed to resume sync: ${error instanceof Error ? error.message : error}`),
    );
    process.exit(1);
  }
}

/**
 * Delete connector
 */
async function remove(
  connectorId: string,
  options: { indexId?: string; force?: boolean },
): Promise<void> {
  requireAuth();

  if (!options.indexId) {
    console.error(chalk.red('--index-id is required'));
    process.exit(1);
  }

  if (!options.force) {
    console.log(
      chalk.yellow(`This will permanently delete the connector and revoke OAuth tokens.`),
    );
    console.log(chalk.gray('Use --force to skip this confirmation.'));
    process.exit(1);
  }

  const spinner = ora('Deleting connector').start();

  try {
    await deleteConnector(options.indexId, connectorId);

    spinner.stop();
    console.log(chalk.green('✓ Connector deleted'));
  } catch (error) {
    spinner.stop();
    console.error(
      chalk.red(`Failed to delete connector: ${error instanceof Error ? error.message : error}`),
    );
    process.exit(1);
  }
}

// =============================================================================
// EXPORTS (for testing)
// =============================================================================

export {
  list,
  create,
  auth,
  filterSet,
  filterClear,
  permissionMode,
  syncStart,
  syncStatus,
  syncPause,
  syncResume,
  remove,
};

// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerConnectorCommands(program: Command): void {
  const connector = program
    .command('connector')
    .description('Manage enterprise connectors (SharePoint, Jira, etc.)');

  // List connectors
  connector
    .command('list')
    .alias('ls')
    .description('List all connectors')
    .option('--index-id <id>', 'Index ID (required)')
    .action(list);

  // Create connector
  connector
    .command('create <type> <name>')
    .description('Create a new connector (type: sharepoint, jira, confluence)')
    .option('--index-id <id>', 'Search index ID (required)')
    .option('--tenant-url <url>', 'SharePoint tenant URL (required for SharePoint)')
    .option('--client-id <id>', 'Azure AD client ID (required for SharePoint)')
    .action(create);

  // Authenticate
  connector
    .command('auth <connector-id>')
    .description('Authenticate connector (OAuth Device Flow)')
    .action(auth);

  // Filters
  const filter = connector.command('filter').description('Manage connector filters');

  filter
    .command('set <connector-id>')
    .description('Set filters')
    .option('--index-id <id>', 'Index ID (required)')
    .option('--sites <urls>', 'Comma-separated site URLs')
    .option('--libraries <names>', 'Comma-separated library names')
    .option('--content-types <types>', 'Comma-separated content types')
    .option('--modified-since <date>', 'Only sync documents modified after this date')
    .option('--mode <mode>', 'Filter mode: include or exclude')
    .action(filterSet);

  filter
    .command('clear <connector-id>')
    .description('Clear all filters')
    .option('--index-id <id>', 'Index ID (required)')
    .action(filterClear);

  // Permissions
  const permission = connector.command('permission').description('Manage permission settings');

  permission
    .command('mode <connector-id>')
    .description('Set permission crawl mode')
    .option('--index-id <id>', 'Index ID (required)')
    .option('--mode <mode>', 'Mode: full, simplified, or disabled (required)')
    .action(permissionMode);

  // Sync
  const sync = connector.command('sync').description('Manage synchronization');

  sync
    .command('start <connector-id>')
    .description('Start synchronization')
    .option('--delta', 'Run delta (incremental) sync instead of full sync')
    .action(syncStart);

  sync.command('status <connector-id>').description('Get sync status').action(syncStatus);

  sync
    .command('pause <connector-id>')
    .description('Pause running sync')
    .option('--reason <reason>', 'Reason for pausing')
    .action(syncPause);

  sync.command('resume <connector-id>').description('Resume paused sync').action(syncResume);

  // Delete connector
  connector
    .command('delete <connector-id>')
    .alias('rm')
    .description('Delete a connector')
    .option('--index-id <id>', 'Index ID (required)')
    .option('-f, --force', 'Skip confirmation')
    .action(remove);
}
