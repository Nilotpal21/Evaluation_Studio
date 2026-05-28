#!/usr/bin/env npx tsx
/**
 * Create a Jira ticket with custom fields
 *
 * Usage:
 *   npx tsx scripts/create-jira-ticket.ts --summary "..." --description "..." [options]
 *
 * Options:
 *   --summary          (required) Ticket summary/title
 *   --description      (required) Ticket description (plain text or markdown)
 *   --type             Issue type (default: Story)
 *   --project          Project key (default: JIRA_PROJECT_KEY env or ABLP)
 *   --labels           Comma-separated labels (e.g., "bug,urgent")
 *   --priority         Priority name (e.g., "High", "Medium")
 *   --assignee         Assignee email
 */

import { createTicket, type AdfDocument } from './jira-client.js';

interface CliArgs {
  summary?: string;
  description?: string;
  type?: string;
  project?: string;
  labels?: string;
  priority?: string;
  assignee?: string;
}

function parseArgs(argv: string[] = process.argv.slice(2)): CliArgs {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const parsed: CliArgs = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--summary':
        parsed.summary = next;
        i++;
        break;
      case '--description':
        parsed.description = next;
        i++;
        break;
      case '--type':
        parsed.type = next;
        i++;
        break;
      case '--project':
        parsed.project = next;
        i++;
        break;
      case '--labels':
        parsed.labels = next;
        i++;
        break;
      case '--priority':
        parsed.priority = next;
        i++;
        break;
      case '--assignee':
        parsed.assignee = next;
        i++;
        break;
    }
  }

  return parsed;
}

function convertToADF(text: string): AdfDocument {
  // Simple markdown-like parsing: treat lines starting with - as bullet lists
  // Everything else as paragraphs
  const lines = text.split('\n').filter((line) => line.trim());
  const content: AdfDocument['content'] = [];

  let currentList: AdfDocument['content'] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('- ')) {
      // Bullet item
      const itemText = trimmed.slice(2);
      currentList.push({
        type: 'listItem',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: itemText }],
          },
        ],
      });
    } else {
      // Not a bullet - flush any pending list
      if (currentList.length > 0) {
        content.push({
          type: 'bulletList',
          content: currentList,
        });
        currentList = [];
      }

      // Add as paragraph
      if (trimmed.startsWith('## ')) {
        content.push({
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: trimmed.slice(3) }],
        });
      } else if (trimmed.startsWith('# ')) {
        content.push({
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: trimmed.slice(2) }],
        });
      } else {
        content.push({
          type: 'paragraph',
          content: [{ type: 'text', text: trimmed }],
        });
      }
    }
  }

  // Flush any remaining list
  if (currentList.length > 0) {
    content.push({
      type: 'bulletList',
      content: currentList,
    });
  }

  return {
    type: 'doc',
    version: 1,
    content,
  };
}

async function main() {
  const args = parseArgs();

  if (!args.summary || !args.description) {
    console.error('Error: --summary and --description are required');
    console.error('\nUsage:');
    console.error(
      '  npx tsx scripts/create-jira-ticket.ts --summary "..." --description "..." [options]',
    );
    console.error('\nOptions:');
    console.error('  --summary       (required) Ticket summary/title');
    console.error('  --description   (required) Ticket description');
    console.error('  --type          Issue type (default: Story)');
    console.error('  --project       Project key (default: JIRA_PROJECT_KEY env or ABLP)');
    console.error('  --labels        Comma-separated labels');
    console.error('  --priority      Priority name');
    console.error('  --assignee      Assignee email');
    process.exit(1);
  }

  const projectKey = args.project || process.env.JIRA_PROJECT_KEY || 'ABLP';
  const issueType = args.type || 'Story';
  const labels = args.labels ? args.labels.split(',').map((l) => l.trim()) : [];
  const issue = await createTicket({
    projectKey,
    summary: args.summary,
    description: convertToADF(args.description),
    issueType,
    labels: labels.length > 0 ? labels : undefined,
    priority: args.priority,
    assigneeEmail: args.assignee,
  });
  const baseUrl = process.env.JIRA_BASE_URL || process.env.ATLASSIAN_BASE_URL || '';
  console.log(`\n✅ Created ticket: ${issue.key}`);
  console.log(`View at: ${baseUrl}/browse/${issue.key}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`❌ ${message}`);
  process.exitCode = 1;
});
