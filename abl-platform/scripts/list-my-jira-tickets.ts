#!/usr/bin/env npx tsx
/**
 * List Jira tickets created by the current user.
 *
 * Usage:
 *   npx tsx scripts/list-my-jira-tickets.ts [--assigned] [--project ABLP]
 *
 * Options:
 *   --assigned    Show tickets assigned to you (instead of created by you)
 *   --project     Override project key (default: JIRA_PROJECT_KEY env var or ABLP)
 */

import { JiraClient } from './jira-client.js';

async function main() {
  const args = process.argv.slice(2);
  const showAssigned = args.includes('--assigned');
  const projectIndex = args.indexOf('--project');

  // Use project from: 1) --project flag, 2) JIRA_PROJECT_KEY env, 3) default to ABLP
  let projectKey: string | undefined;
  if (projectIndex >= 0) {
    projectKey = args[projectIndex + 1];
  } else {
    projectKey = process.env.JIRA_PROJECT_KEY || 'ABLP';
  }

  const jira = new JiraClient();

  if (!jira.isConfigured()) {
    console.error('Error: Jira credentials not configured in .env');
    console.error('Required: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN');
    process.exit(1);
  }

  console.log(
    `\n${showAssigned ? 'Fetching assigned tickets' : 'Fetching your tickets'}${projectKey ? ` from ${projectKey}` : ''}...\n`,
  );

  const result = showAssigned
    ? await jira.getMyAssignedTickets(projectKey)
    : await jira.getMyTickets(projectKey);

  if (!result.success) {
    console.error('Error:', result.error?.message);
    process.exit(1);
  }

  console.log('ℹ️  Tickets in "Done" status are excluded from this listing.\n');

  if (result.data.length === 0) {
    console.log('No tickets found.');
    return;
  }

  console.log(`Found ${result.data.length} ticket(s):\n`);

  for (const ticket of result.data) {
    console.log(`[${ticket.key}] ${ticket.summary}`);
    console.log(`  Status: ${ticket.status}\n`);
  }
}

main();
