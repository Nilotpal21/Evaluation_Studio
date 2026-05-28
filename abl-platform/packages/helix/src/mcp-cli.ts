#!/usr/bin/env node

import { resolve } from 'node:path';

import { HelixControlPlaneMcpServer } from './mcp/server.js';

interface ParsedArgs {
  workDir?: string;
  sessionDir?: string;
  journalDir?: string;
  help?: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--workdir' && args[index + 1]) {
      parsed.workDir = resolve(args[index + 1]);
      index += 1;
    } else if (arg === '--session-dir' && args[index + 1]) {
      parsed.sessionDir = resolve(args[index + 1]);
      index += 1;
    } else if (arg === '--journal-dir' && args[index + 1]) {
      parsed.journalDir = resolve(args[index + 1]);
      index += 1;
    }
  }

  return parsed;
}

function showHelp(): void {
  console.log(`
HELIX Control-Plane MCP Server

Usage: helix-mcp [options]

Options:
  --workdir <path>       Workspace root to inspect (defaults to current directory)
  --session-dir <path>   Override the HELIX session directory
  --journal-dir <path>   Override the HELIX journal directory
  --help, -h             Show help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    showHelp();
    process.exit(0);
  }

  const server = new HelixControlPlaneMcpServer({
    workDir: args.workDir,
    sessionDir: args.sessionDir,
    journalDir: args.journalDir,
  });

  process.on('SIGINT', async () => {
    await server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await server.stop();
    process.exit(0);
  });

  await server.start();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[helix-mcp] Fatal error:', message);
  process.exit(1);
});
