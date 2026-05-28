/**
 * Auth Commands
 *
 * Login, logout, and whoami commands.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import open from 'open';
import { startDeviceAuth, pollDeviceToken, type DeviceTokenResponse } from '../lib/api-client.js';
import {
  saveCredentials,
  clearCredentials,
  getCredentials,
  getEmail,
  getCredentialsPath,
} from '../lib/credentials.js';
import { getApiUrl } from '../lib/config.js';

// =============================================================================
// HELPERS
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDeviceTokenResponse(response: unknown): response is DeviceTokenResponse {
  return typeof response === 'object' && response !== null && 'access_token' in response;
}

// =============================================================================
// COMMANDS
// =============================================================================

/**
 * Login command - device authorization flow
 */
export async function login(): Promise<void> {
  const apiUrl = getApiUrl();
  console.log(chalk.blue('Starting device authorization...\n'));

  const spinner = ora('Requesting authorization').start();

  try {
    // Start device auth
    const deviceAuth = await startDeviceAuth(['read_traces', 'read_state', 'subscribe']);

    spinner.stop();

    // Display instructions
    console.log(chalk.cyan('┌────────────────────────────────────────────┐'));
    console.log(
      chalk.cyan('│  ') +
        chalk.white('Open this URL in your browser:') +
        chalk.cyan('           │'),
    );
    console.log(
      chalk.cyan('│  ') +
        chalk.yellow(deviceAuth.verification_uri_complete.padEnd(40)) +
        chalk.cyan(' │'),
    );
    console.log(chalk.cyan('│                                            │'));
    console.log(
      chalk.cyan('│  ') +
        chalk.white('Or enter code: ') +
        chalk.green.bold(deviceAuth.user_code.padEnd(24)) +
        chalk.cyan(' │'),
    );
    console.log(chalk.cyan('└────────────────────────────────────────────┘\n'));

    // Try to open browser
    try {
      await open(deviceAuth.verification_uri_complete);
      console.log(chalk.gray('Opening browser automatically...\n'));
    } catch {
      console.log(chalk.gray('Please open the URL manually.\n'));
    }

    // Poll for token
    const pollSpinner = ora('Waiting for authorization').start();
    const startTime = Date.now();
    const timeoutMs = deviceAuth.expires_in * 1000;

    while (Date.now() - startTime < timeoutMs) {
      await sleep(deviceAuth.interval * 1000);

      try {
        const result = await pollDeviceToken(deviceAuth.device_code);

        if (isDeviceTokenResponse(result)) {
          pollSpinner.stop();

          // Save credentials
          const expiresAt = new Date(Date.now() + result.expires_in * 1000).toISOString();

          saveCredentials({
            token: result.access_token,
            refreshToken: result.refresh_token,
            expiresAt,
          });

          console.log(chalk.green('\n✓ Successfully authenticated!'));
          console.log(chalk.gray(`  Token saved to ${getCredentialsPath()}`));
          return;
        }

        // Check for errors
        const errorResult = result as { error: string };
        if (errorResult.error === 'authorization_pending') {
          // Keep polling
          continue;
        }

        if (errorResult.error === 'expired_token') {
          pollSpinner.stop();
          console.error(chalk.red('\n✗ Authorization expired. Please try again.'));
          process.exit(1);
        }

        pollSpinner.stop();
        console.error(chalk.red(`\n✗ Error: ${errorResult.error}`));
        process.exit(1);
      } catch (error) {
        // Network error, keep trying
        continue;
      }
    }

    pollSpinner.stop();
    console.error(chalk.red('\n✗ Authorization timed out. Please try again.'));
    process.exit(1);
  } catch (error) {
    spinner.stop();
    console.error(
      chalk.red(
        `\n✗ Failed to start authorization: ${error instanceof Error ? error.message : error}`,
      ),
    );
    process.exit(1);
  }
}

/**
 * Logout command
 */
export async function logout(): Promise<void> {
  clearCredentials();
  console.log(chalk.green('✓ Logged out successfully'));
}

/**
 * Whoami command
 */
export async function whoami(): Promise<void> {
  const creds = getCredentials();

  if (!creds) {
    console.log(chalk.yellow('Not logged in'));
    console.log(chalk.gray('Run: kore-platform-cli login'));
    return;
  }

  const email = getEmail();
  const expiresAt = new Date(creds.expiresAt);
  const now = new Date();
  const hoursLeft = Math.round((expiresAt.getTime() - now.getTime()) / 3600000);

  console.log(chalk.white('Logged in as: ') + chalk.cyan(email || 'Unknown'));
  console.log(
    chalk.white('Token expires: ') +
      chalk.gray(hoursLeft > 0 ? `in ${hoursLeft} hour${hoursLeft === 1 ? '' : 's'}` : 'soon'),
  );
  console.log(chalk.white('API URL: ') + chalk.gray(getApiUrl()));
}

/**
 * Dev login command - for development without Google OAuth
 */
export async function devLogin(email: string, name?: string): Promise<void> {
  const apiUrl = getApiUrl();
  console.log(chalk.blue('Attempting dev login...\n'));

  const spinner = ora('Authenticating').start();

  try {
    const response = await fetch(`${apiUrl}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name: name || email.split('@')[0] }),
    });

    if (!response.ok) {
      const error = (await response.json()) as { error?: string };
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    const result = (await response.json()) as {
      user: { email: string; name: string };
      accessToken: string;
      refreshToken?: string;
      expiresIn: number;
    };

    spinner.stop();

    // Save credentials
    const expiresAt = new Date(Date.now() + result.expiresIn * 1000).toISOString();
    saveCredentials({
      token: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt,
      email: result.user.email,
    });

    console.log(chalk.green(`✓ Logged in as ${result.user.email}`));
    console.log(chalk.gray(`  Token saved to ${getCredentialsPath()}`));
  } catch (error) {
    spinner.stop();
    console.error(
      chalk.red(`✗ Dev login failed: ${error instanceof Error ? error.message : error}`),
    );
    console.log(chalk.gray('\nMake sure:'));
    console.log(chalk.gray('  1. The server is running (pnpm dev in apps/platform)'));
    console.log(chalk.gray('  2. NODE_ENV is set to "development"'));
    process.exit(1);
  }
}

// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerAuthCommands(program: Command): void {
  program.command('login').description('Authenticate with Kore Platform').action(login);

  program
    .command('dev-login')
    .description('Dev login (development only, bypasses Google OAuth)')
    .argument('<email>', 'Email address')
    .option('-n, --name <name>', 'Display name')
    .action((email: string, options: { name?: string }) => devLogin(email, options.name));

  program.command('logout').description('Revoke authentication').action(logout);

  program.command('whoami').description('Show current user').action(whoami);
}
