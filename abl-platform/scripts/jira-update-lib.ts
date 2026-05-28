import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const JIRA_ENV_KEYS = [
  'JIRA_BASE_URL',
  'ATLASSIAN_BASE_URL',
  'JIRA_EMAIL',
  'JIRA_API_TOKEN',
  'ATLASSIAN_API_KEY',
  'JIRA_PROJECT_KEY',
] as const;

export interface JiraSectionInput {
  heading: string;
  content: string;
}

export interface JiraUpdateCliOptions {
  ticket: string | null;
  commentHeading: string;
  commentText: string[];
  commentFiles: string[];
  commentSections: JiraSectionInput[];
  qaShippedText: string[];
  qaShippedFiles: string[];
  qaVerificationText: string[];
  qaVerificationFiles: string[];
  qaFollowUpText: string[];
  qaFollowUpFiles: string[];
  descriptionHeading: string;
  descriptionText: string[];
  descriptionFiles: string[];
  descriptionSections: JiraSectionInput[];
  transition: string | null;
  transitionToStatus: string | null;
  transitionPath: string[];
  assignee: string | null;
  assigneeAccountId: string | null;
  attachments: string[];
  setLabels: string[];
  dryRun: boolean;
  help: boolean;
}

const DEFAULT_COMMENT_HEADING = 'Update';
const DEFAULT_DESCRIPTION_HEADING = 'Description';

export function parseSelectedDotEnvKeys(
  content: string,
  allowedKeys: readonly string[] = JIRA_ENV_KEYS,
  existingEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const allowed = new Set(allowedKeys);
  const result: Record<string, string> = {};

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIndex = line.indexOf('=');
    if (eqIndex < 0) continue;

    const key = line.slice(0, eqIndex).trim();
    if (!allowed.has(key) || existingEnv[key]) continue;

    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

export function loadJiraEnvFromDotEnv(
  dotEnvPath = resolve(process.cwd(), '.env'),
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    const content = readFileSync(dotEnvPath, 'utf-8');
    const parsed = parseSelectedDotEnvKeys(content, JIRA_ENV_KEYS, env);
    for (const [key, value] of Object.entries(parsed)) {
      env[key] = value;
    }
  } catch {
    // .env is optional; callers may already have env vars injected.
  }
}

export function parseSectionSpec(input: string): JiraSectionInput {
  const separatorIndex = input.indexOf('::');
  if (separatorIndex <= 0 || separatorIndex === input.length - 2) {
    throw new Error(
      `Invalid section "${input}". Use the format "Heading::Body" for section flags.`,
    );
  }

  return {
    heading: input.slice(0, separatorIndex).trim(),
    content: normalizeEscapedLineBreaks(input.slice(separatorIndex + 2).trim()),
  };
}

function normalizeEscapedLineBreaks(content: string): string {
  return content
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n');
}

export function parseLabelList(input: string): string[] {
  return input
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseArgs(argv: string[]): JiraUpdateCliOptions {
  const normalizedArgs = argv[0] === '--' ? argv.slice(1) : argv;
  const options: JiraUpdateCliOptions = {
    ticket: null,
    commentHeading: DEFAULT_COMMENT_HEADING,
    commentText: [],
    commentFiles: [],
    commentSections: [],
    qaShippedText: [],
    qaShippedFiles: [],
    qaVerificationText: [],
    qaVerificationFiles: [],
    qaFollowUpText: [],
    qaFollowUpFiles: [],
    descriptionHeading: DEFAULT_DESCRIPTION_HEADING,
    descriptionText: [],
    descriptionFiles: [],
    descriptionSections: [],
    transition: null,
    transitionToStatus: null,
    transitionPath: [],
    assignee: null,
    assigneeAccountId: null,
    attachments: [],
    setLabels: [],
    dryRun: false,
    help: false,
  };

  const nextValue = (index: number, flag: string): string => {
    const value = normalizedArgs[index + 1];
    if (!value || value.startsWith('-')) {
      throw new Error(`Missing value for ${flag}.`);
    }
    return value;
  };

  for (let i = 0; i < normalizedArgs.length; i += 1) {
    const arg = normalizedArgs[i];

    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--ticket':
      case '-t':
        options.ticket = nextValue(i, arg);
        i += 1;
        break;
      case '--comment':
        options.commentText.push(nextValue(i, arg));
        i += 1;
        break;
      case '--comment-file':
        options.commentFiles.push(nextValue(i, arg));
        i += 1;
        break;
      case '--comment-heading':
        options.commentHeading = nextValue(i, arg);
        i += 1;
        break;
      case '--comment-section':
        options.commentSections.push(parseSectionSpec(nextValue(i, arg)));
        i += 1;
        break;
      case '--qa-shipped':
        options.qaShippedText.push(nextValue(i, arg));
        i += 1;
        break;
      case '--qa-shipped-file':
        options.qaShippedFiles.push(nextValue(i, arg));
        i += 1;
        break;
      case '--qa-verification':
        options.qaVerificationText.push(nextValue(i, arg));
        i += 1;
        break;
      case '--qa-verification-file':
        options.qaVerificationFiles.push(nextValue(i, arg));
        i += 1;
        break;
      case '--qa-follow-up':
        options.qaFollowUpText.push(nextValue(i, arg));
        i += 1;
        break;
      case '--qa-follow-up-file':
        options.qaFollowUpFiles.push(nextValue(i, arg));
        i += 1;
        break;
      case '--description':
        options.descriptionText.push(nextValue(i, arg));
        i += 1;
        break;
      case '--description-file':
        options.descriptionFiles.push(nextValue(i, arg));
        i += 1;
        break;
      case '--description-heading':
        options.descriptionHeading = nextValue(i, arg);
        i += 1;
        break;
      case '--description-section':
        options.descriptionSections.push(parseSectionSpec(nextValue(i, arg)));
        i += 1;
        break;
      case '--transition':
        options.transition = nextValue(i, arg);
        i += 1;
        break;
      case '--transition-to-status':
      case '--transition-to':
        options.transitionToStatus = nextValue(i, arg);
        i += 1;
        break;
      case '--transition-path':
        options.transitionPath = parseLabelList(nextValue(i, arg));
        i += 1;
        break;
      case '--assignee':
        options.assignee = nextValue(i, arg);
        i += 1;
        break;
      case '--assignee-account-id':
        options.assigneeAccountId = nextValue(i, arg);
        i += 1;
        break;
      case '--attachment':
      case '--attach':
        options.attachments.push(nextValue(i, arg));
        i += 1;
        break;
      case '--labels':
      case '--set-labels':
        options.setLabels = parseLabelList(nextValue(i, arg));
        i += 1;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown flag: ${arg}`);
        }
        if (options.ticket == null) {
          options.ticket = arg;
          break;
        }
        throw new Error(`Unexpected positional argument: ${arg}`);
    }
  }

  if (options.help) {
    return options;
  }

  if (!options.ticket) {
    throw new Error('A Jira ticket key is required. Pass it positionally or with --ticket.');
  }

  if (options.transition && options.transitionToStatus) {
    throw new Error('Use either --transition or --transition-to-status, not both.');
  }

  if (options.assignee && options.assigneeAccountId) {
    throw new Error('Use either --assignee or --assignee-account-id, not both.');
  }

  if (options.transitionPath.length > 0 && !options.transitionToStatus) {
    throw new Error('--transition-path requires --transition-to-status.');
  }

  const hasUpdates =
    options.commentText.length > 0 ||
    options.commentFiles.length > 0 ||
    options.commentSections.length > 0 ||
    options.qaShippedText.length > 0 ||
    options.qaShippedFiles.length > 0 ||
    options.qaVerificationText.length > 0 ||
    options.qaVerificationFiles.length > 0 ||
    options.qaFollowUpText.length > 0 ||
    options.qaFollowUpFiles.length > 0 ||
    options.descriptionText.length > 0 ||
    options.descriptionFiles.length > 0 ||
    options.descriptionSections.length > 0 ||
    options.transition !== null ||
    options.transitionToStatus !== null ||
    options.assignee !== null ||
    options.assigneeAccountId !== null ||
    options.attachments.length > 0 ||
    options.setLabels.length > 0;

  if (!hasUpdates) {
    throw new Error(
      'No updates requested. Add a comment, description, labels, or a transition to update the ticket.',
    );
  }

  return options;
}

export function renderUsage(): string {
  return [
    'Usage:',
    '  pnpm jira:update -- <TICKET> [options]',
    '  tsx scripts/jira-update.ts <TICKET> [options]',
    '',
    'Options:',
    '  --ticket, -t <KEY>              Jira ticket key (optional if passed positionally)',
    '  --comment <TEXT>                Add a comment section with the default comment heading',
    '  --comment-file <PATH>           Add a comment section from a file',
    '  --comment-heading <TEXT>        Heading used for --comment / --comment-file (default: Update)',
    '  --comment-section "H::BODY"     Add a structured comment section',
    '  --qa-shipped <TEXT>             Add a QA-style "Shipped" section to the comment',
    '  --qa-shipped-file <PATH>        Add a QA-style "Shipped" section from a file',
    '  --qa-verification <TEXT>        Add a QA-style "Verification" section to the comment',
    '  --qa-verification-file <PATH>   Add a QA-style "Verification" section from a file',
    '  --qa-follow-up <TEXT>           Add a QA-style "Remaining follow-up" section',
    '  --qa-follow-up-file <PATH>      Add a QA-style "Remaining follow-up" section from a file',
    '  --description <TEXT>            Replace description with a single section',
    '  --description-file <PATH>       Replace description with file content',
    '  --description-heading <TEXT>    Heading used for --description / --description-file',
    '  --description-section "H::BODY" Add a structured description section',
    '  --transition <NAME>             Apply a directly available transition or destination status',
    '  --transition-to-status <STATUS> Walk available workflow hops until the ticket reaches STATUS',
    '  --transition-path <A,B,C>        Preferred transition/status names for --transition-to-status',
    '  --assignee <QUERY>              Assign to a Jira user matched by display name, email, or search query',
    '  --assignee-account-id <ID>      Assign directly to a Jira Cloud accountId',
    '  --attachment <PATH>             Attach an evidence file; may be repeated',
    '  --labels <A,B,C>                Replace labels with the provided comma-separated set',
    '  --dry-run                       Print the resolved Jira update payload without sending it',
    '  --help, -h                      Show this message',
    '',
    'Examples:',
    '  pnpm jira:update -- ABLP-327 \\',
    '    --qa-shipped-file /tmp/shipped.md \\',
    '    --qa-verification "Ran pnpm build --filter=@agent-platform/studio" \\',
    '    --qa-follow-up "Inventory remaining Studio admin routes"',
    '  pnpm jira:update -- ABLP-581 \\',
    '    --transition-to-status "Development Completed" \\',
    '    --assignee "Prakash Rochkari"',
    '',
    'Notes:',
    '  - Credentials are loaded from the current environment or a local .env file',
    '    using the same read-only key loading pattern Helix uses.',
    '  - Comments and descriptions are sent as Atlassian Document Format sections,',
    '    matching the structure Helix uses for Jira updates.',
    '  - Prefer the *-file flags for multi-line QA updates or shell-sensitive content.',
  ].join('\n');
}
