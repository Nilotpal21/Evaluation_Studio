/**
 * Debug Commands
 *
 * Debug token management and session debugging.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import WebSocket from 'ws';
import { buildWebDebugWSProtocols } from '@agent-platform/shared/websocket-auth';
import { listDebugTokens, createDebugToken, revokeAllDebugTokens } from '../lib/api-client.js';
import { getRuntimeApiUrl } from '../lib/config.js';
import { isAuthenticated, getToken } from '../lib/credentials.js';

// =============================================================================
// HELPERS
// =============================================================================

function requireAuth(): void {
  if (!isAuthenticated()) {
    console.error(chalk.red('Not authenticated. Run: kore-platform-cli login'));
    process.exit(1);
  }
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString();
}

function formatTimeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) return `${diffDays}d ago`;
  if (diffHours > 0) return `${diffHours}h ago`;
  return 'just now';
}

// =============================================================================
// COMMANDS
// =============================================================================

/**
 * List debug tokens
 */
async function listTokens(): Promise<void> {
  requireAuth();

  const spinner = ora('Loading tokens').start();

  try {
    const { tokens } = await listDebugTokens();
    spinner.stop();

    if (tokens.length === 0) {
      console.log(chalk.yellow('No active debug tokens.'));
      console.log(chalk.gray('Create one with: kore-platform-cli debug token create'));
      return;
    }

    console.log(chalk.white.bold('Active Debug Tokens:\n'));

    for (const token of tokens) {
      console.log(chalk.cyan(`  ID: ${token.id}`));
      console.log(chalk.gray(`    Scopes: ${token.scopes.join(', ')}`));
      console.log(chalk.gray(`    Created: ${formatDate(token.createdAt)}`));
      console.log(chalk.gray(`    Expires: ${formatDate(token.expiresAt)}`));
      if (token.lastUsedAt) {
        console.log(chalk.gray(`    Last used: ${formatTimeAgo(token.lastUsedAt)}`));
      }
      console.log();
    }
  } catch (error) {
    spinner.stop();
    console.error(
      chalk.red(`Failed to list tokens: ${error instanceof Error ? error.message : error}`),
    );
    process.exit(1);
  }
}

/**
 * Create a debug token
 */
async function tokenCreate(options: { scopes?: string; expires?: string }): Promise<void> {
  requireAuth();

  const spinner = ora('Creating token').start();

  try {
    const scopes = options.scopes?.split(',').map((s) => s.trim());
    const expiresIn = options.expires ? parseInt(options.expires, 10) * 3600 : undefined;

    const result = await createDebugToken({
      scopes,
      expiresIn,
    });

    spinner.stop();

    console.log(chalk.green('✓ Debug token created\n'));
    console.log(chalk.white('Token: ') + chalk.yellow(result.token));
    console.log(chalk.white('Scopes: ') + chalk.gray(result.scopes.join(', ')));
    console.log(chalk.white('Expires: ') + chalk.gray(formatDate(result.expiresAt)));
    console.log();
    console.log(chalk.gray('Use this token with the MCP server or for direct API access.'));
  } catch (error) {
    spinner.stop();
    console.error(
      chalk.red(`Failed to create token: ${error instanceof Error ? error.message : error}`),
    );
    process.exit(1);
  }
}

/**
 * Revoke all debug tokens
 */
async function tokenRevokeAll(): Promise<void> {
  requireAuth();

  const spinner = ora('Revoking tokens').start();

  try {
    await revokeAllDebugTokens();
    spinner.stop();
    console.log(chalk.green('✓ All debug tokens revoked'));
  } catch (error) {
    spinner.stop();
    console.error(
      chalk.red(`Failed to revoke tokens: ${error instanceof Error ? error.message : error}`),
    );
    process.exit(1);
  }
}

/**
 * Subscribe to session traces
 */
async function subscribe(sessionId: string): Promise<void> {
  requireAuth();

  const token = getToken();
  if (!token) {
    console.error(chalk.red('No valid token found'));
    process.exit(1);
  }

  const runtimeApiUrl = getRuntimeApiUrl();
  const wsUrl = runtimeApiUrl.replace(/^http/, 'ws') + '/ws';

  console.log(chalk.blue(`Subscribing to session: ${sessionId}\n`));

  const ws = new WebSocket(wsUrl, buildWebDebugWSProtocols(token));

  ws.on('open', () => {
    console.log(chalk.gray('Connected to WebSocket\n'));

    // Subscribe to session
    ws.send(
      JSON.stringify({
        type: 'subscribe_session',
        sessionId,
      }),
    );
  });

  ws.on('message', (data: WebSocket.Data) => {
    try {
      const message = JSON.parse(data.toString());
      const timestamp = new Date().toLocaleTimeString();

      // Format based on message type
      switch (message.type) {
        case 'subscribed':
          console.log(chalk.green(`[${timestamp}] Subscribed to ${message.sessionId}`));
          break;

        case 'error':
          console.log(chalk.red(`[${timestamp}] Error: ${message.error}`));
          break;

        case 'trace':
          const trace = message.data;
          const eventType = trace.type || 'event';
          const color = eventType.includes('error')
            ? chalk.red
            : eventType.includes('start')
              ? chalk.green
              : chalk.cyan;

          console.log(color(`[${timestamp}] ${eventType}: ${JSON.stringify(trace.data || {})}`));
          break;

        default:
          console.log(chalk.gray(`[${timestamp}] ${message.type}: ${JSON.stringify(message)}`));
      }
    } catch {
      console.log(chalk.gray(`[${new Date().toLocaleTimeString()}] ${data.toString()}`));
    }
  });

  ws.on('close', () => {
    console.log(chalk.yellow('\nDisconnected'));
  });

  ws.on('error', (error) => {
    console.error(chalk.red(`WebSocket error: ${error.message}`));
  });

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    console.log(chalk.gray('\n\nClosing connection...'));
    ws.close();
    process.exit(0);
  });
}

// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerDebugCommands(program: Command): void {
  const debug = program.command('debug').description('Debug tools and tokens');

  // Token subcommands
  const token = debug.command('token').description('Manage debug tokens');

  token.command('list').alias('ls').description('List active debug tokens').action(listTokens);

  token
    .command('create')
    .description('Create a new debug token')
    .option('-s, --scopes <scopes>', 'Comma-separated scopes')
    .option('-e, --expires <hours>', 'Token expiry in hours (default: 1)')
    .action(tokenCreate);

  token.command('revoke-all').description('Revoke all debug tokens').action(tokenRevokeAll);

  // Subscribe command
  debug
    .command('subscribe <sessionId>')
    .description('Subscribe to live session traces')
    .action(subscribe);

  // Traces shorthand
  debug
    .command('traces [sessionId]')
    .description('View traces (alias for subscribe)')
    .action((sessionId) => {
      if (!sessionId) {
        console.log(chalk.yellow('Session ID required'));
        console.log(chalk.gray('Usage: kore-platform-cli debug traces <sessionId>'));
        return;
      }
      subscribe(sessionId);
    });
}
