#!/usr/bin/env npx tsx
/**
 * CLI wrapper around Helix's createTicket to create JIRA issues.
 *
 * Usage:
 *   pnpm jira:create -- --summary "My ticket" --description "Details here"
 *   pnpm jira:create -- --summary "My ticket" --project ABLP --type Story
 *   pnpm jira:create -- --summary "My ticket" --labels "backend,studio"
 *   pnpm jira:create -- --summary "My ticket" --dry-run
 */

import { readFileSync } from 'node:fs';

import { createTicket, buildAdfDescription } from './jira-client.js';

import { loadJiraEnvFromDotEnv } from './jira-update-lib.js';

function out(message: string): void {
  process.stdout.write(`${message}\n`);
}

function stderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

const USAGE = `Usage:
  pnpm jira:create -- [options]

Required:
  --summary, -s <TEXT>       Ticket summary (title)

Optional:
  --description, -d <TEXT>   Ticket description (plain text, converted to ADF)
  --description-file <PATH>  Read description from file (avoids shell quoting limits)
  --project, -p <KEY>        Jira project key (default: ABLP)
  --type, -t <NAME>          Issue type (default: Story)
  --labels, -l <A,B,C>       Comma-separated labels
  --dry-run                  Print payload without creating
  --help, -h                 Show this help`;

interface ParsedArgs {
  summary: string | null;
  description: string | null;
  descriptionFile: string | null;
  projectKey: string;
  issueType: string;
  labels: string[];
  dryRun: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const result: ParsedArgs = {
    summary: null,
    description: null,
    descriptionFile: null,
    projectKey: process.env.JIRA_PROJECT_KEY ?? 'ABLP',
    issueType: 'Story',
    labels: [],
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--summary':
      case '-s':
        result.summary = args[++i];
        break;
      case '--description':
      case '-d':
        result.description = args[++i];
        break;
      case '--description-file':
        result.descriptionFile = args[++i];
        break;
      case '--project':
      case '-p':
        result.projectKey = args[++i];
        break;
      case '--type':
      case '-t':
        result.issueType = args[++i];
        break;
      case '--labels':
      case '-l':
        result.labels = args[++i]
          .split(',')
          .map((l) => l.trim())
          .filter(Boolean);
        break;
      case '--dry-run':
        result.dryRun = true;
        break;
      case '--help':
      case '-h':
        result.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return result;
}

async function main(): Promise<void> {
  loadJiraEnvFromDotEnv();

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    stderr('');
    stderr(USAGE);
    process.exitCode = 1;
    return;
  }

  if (parsed.help) {
    out(USAGE);
    return;
  }

  if (!parsed.summary) {
    stderr('A --summary is required.');
    stderr('');
    stderr(USAGE);
    process.exitCode = 1;
    return;
  }

  let descriptionContent = parsed.description;
  if (parsed.descriptionFile) {
    try {
      descriptionContent = readFileSync(parsed.descriptionFile, 'utf8');
    } catch (error) {
      stderr(
        `Failed to read --description-file ${parsed.descriptionFile}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const descriptionAdf = buildAdfDescription([
    {
      heading: 'Description',
      content: descriptionContent ?? parsed.summary,
    },
  ]);

  const payload = {
    projectKey: parsed.projectKey,
    summary: parsed.summary,
    description: descriptionAdf,
    issueType: parsed.issueType,
    labels: parsed.labels.length > 0 ? parsed.labels : undefined,
  };

  if (parsed.dryRun) {
    out(JSON.stringify(payload, null, 2));
    return;
  }

  const issue = await createTicket(payload);
  out(issue.key);
}

main().catch((error: unknown) => {
  stderr(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
