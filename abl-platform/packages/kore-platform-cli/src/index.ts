#!/usr/bin/env node
/**
 * Kore Platform CLI
 *
 * Command-line tool for managing Kore Platform resources.
 *
 * Features:
 * - Authentication (device flow)
 * - Project management
 * - Debug tools and tokens
 * - MCP server mode for Claude Code
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { registerAuthCommands } from './commands/auth.js';
import { registerProjectCommands } from './commands/projects.js';
import { registerDebugCommands } from './commands/debug.js';
import { registerConnectorCommands } from './commands/connectors.js';
import { registerModelCommands } from './commands/models.js';
import { registerExportCommand } from './commands/export.js';
import { registerImportCommand } from './commands/import.js';
import { registerGitCommands } from './commands/git.js';
import { registerVerifyCommand } from './commands/verify.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerSizingCommands } from './commands/sizing.js';
import { registerAgentCommands } from './commands/agents.js';
import { registerToolCommands } from './commands/tools.js';
import { registerWorkspaceCommands } from './commands/workspaces.js';
import { registerArchCommands } from './commands/arch.js';
import { registerLockfileCommands } from './commands/lockfile.js';
import { startMCPServer } from './mcp/server.js';
import {
  getConfig,
  getConfigPath,
  setApiUrl,
  setRuntimeApiUrl,
  setSearchAiApiUrl,
} from './lib/config.js';
import { getCredentialsPath, getToken } from './lib/credentials.js';

// =============================================================================
// PROGRAM
// =============================================================================

const program = new Command();

program
  .name('kore-platform-cli')
  .description('CLI tool for Kore Platform - debug, deploy, and manage agents')
  .version('0.1.0');

// =============================================================================
// REGISTER COMMANDS
// =============================================================================

registerAuthCommands(program);
registerProjectCommands(program);
registerDebugCommands(program);
registerConnectorCommands(program);
registerModelCommands(program);
registerExportCommand(program);
registerImportCommand(program);
registerGitCommands(program);
registerVerifyCommand(program);
registerDoctorCommand(program);
registerSizingCommands(program);
registerAgentCommands(program);
registerToolCommands(program);
registerWorkspaceCommands(program);
registerArchCommands(program);
registerLockfileCommands(program);

// =============================================================================
// MCP SERVER MODE
// =============================================================================

program
  .command('mcp')
  .description('Start MCP server mode for Claude Code integration')
  .action(async () => {
    await startMCPServer();
  });

// =============================================================================
// CONFIG COMMAND
// =============================================================================

const configCmd = program.command('config').description('Manage configuration');

configCmd
  .command('show')
  .alias('ls')
  .description('Show current configuration')
  .action(() => {
    const config = getConfig();
    process.stdout.write(chalk.white.bold('Configuration:\n\n'));
    process.stdout.write(chalk.gray('  Config file: ') + getConfigPath() + '\n');
    process.stdout.write(chalk.gray('  Credentials: ') + getCredentialsPath() + '\n');
    process.stdout.write('\n');
    process.stdout.write(chalk.white('  apiUrl: ') + chalk.cyan(config.apiUrl) + '\n');
    if (config.runtimeApiUrl)
      process.stdout.write(
        chalk.white('  runtimeApiUrl: ') + chalk.cyan(config.runtimeApiUrl) + '\n',
      );
    if (config.searchAiApiUrl)
      process.stdout.write(
        chalk.white('  searchAiApiUrl: ') + chalk.cyan(config.searchAiApiUrl) + '\n',
      );
    if (config.currentWorkspaceName)
      process.stdout.write(
        chalk.white('  currentWorkspace: ') + chalk.cyan(config.currentWorkspaceName) + '\n',
      );
    if (config.currentProjectSlug)
      process.stdout.write(
        chalk.white('  currentProject: ') + chalk.cyan(config.currentProjectSlug) + '\n',
      );
  });

// Also show config when running `config` with no subcommand
configCmd.action(() => {
  configCmd.commands.find((c) => c.name() === 'show')?.parse([], { from: 'user' });
});

const CONFIG_SETTERS: Record<string, (url: string) => void> = {
  apiUrl: setApiUrl,
  runtimeApiUrl: setRuntimeApiUrl,
  searchAiApiUrl: setSearchAiApiUrl,
};

configCmd
  .command('set <key> <value>')
  .description('Set a configuration value (apiUrl, runtimeApiUrl, searchAiApiUrl)')
  .action((key: string, value: string) => {
    const setter = CONFIG_SETTERS[key];
    if (!setter) {
      process.stderr.write(
        chalk.red(
          `Unknown config key: ${key}. Valid keys: ${Object.keys(CONFIG_SETTERS).join(', ')}\n`,
        ),
      );
      process.exit(1);
    }
    try {
      new URL(value);
    } catch {
      process.stderr.write(chalk.red(`Invalid URL: ${value}\n`));
      process.exit(1);
    }
    setter(value);
    process.stdout.write(chalk.green(`✓ Set ${key} = ${value}\n`));
  });

configCmd
  .command('get <key>')
  .description('Get a configuration value')
  .action((key: string) => {
    const config = getConfig();
    const val = (config as unknown as Record<string, unknown>)[key];
    if (val === undefined) {
      process.stderr.write(chalk.red(`Unknown config key: ${key}\n`));
      process.exit(1);
    }
    process.stdout.write(String(val) + '\n');
  });

// =============================================================================
// TOKEN COMMAND
// =============================================================================

program
  .command('token')
  .description('Print the current access token to stdout (for use with curl/httpie)')
  .action(() => {
    const token = getToken();
    if (!token) {
      process.stderr.write(chalk.red('Not authenticated. Run: kore-platform-cli login\n'));
      process.exit(1);
    }
    process.stdout.write(token + '\n');
  });

// =============================================================================
// PARSE
// =============================================================================

program.parse();
