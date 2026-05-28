import type { UserConfig } from '@commitlint/types';

// Custom rule: commit must start with a JIRA ticket [ABC-123]
const jiraTicketRule = (parsed: {
  header: string | null;
  ticket: string | null;
}): [boolean, string?] => {
  const { header, ticket } = parsed;
  // Exempt merge commits and bot/automated commits
  if (header?.startsWith('Merge ')) return [true];
  if (header?.startsWith('chore(deps)')) return [true];
  if (header?.startsWith('build(deps)')) return [true];
  if (!ticket) {
    return [false, 'commit must start with JIRA ticket: [ABC-123] type(scope): description'];
  }
  return [true];
};

// Custom rule: warn when a `feat` commit contains words suggesting it's actually a fix or refactor
const featTypeMismatchRule = (parsed: {
  type: string | null;
  subject: string | null;
  body: string | null;
  header: string | null;
}): [boolean, string?] => {
  const { type, subject, body } = parsed;
  if (type !== 'feat') return [true];

  const fixWords = /\b(fix|resolve|patch|correct|repair|restore)\b/i;
  const textToCheck = [subject, body].filter(Boolean).join(' ');

  if (fixWords.test(textToCheck)) {
    return [
      false,
      'feat commit contains fix/refactor language ("fix", "resolve", "patch", "correct", "repair", "restore"). Consider using `fix` or `refactor` type instead.',
    ];
  }
  return [true];
};

const config: UserConfig = {
  parserPreset: {
    parserOpts: {
      // Custom parser pattern: [TICKET] type(scope): subject
      headerPattern: /^\[([A-Z]+-\d+)\]\s*(\w+)(?:\(([^)]+)\))?:\s*(.+)$/,
      headerCorrespondence: ['ticket', 'type', 'scope', 'subject'],
    },
  },
  plugins: [
    {
      rules: {
        'jira-ticket': (parsed) => jiraTicketRule(parsed as any),
        'feat-type-mismatch': (parsed) => featTypeMismatchRule(parsed as any),
      },
    },
  ],
  rules: {
    'jira-ticket': [2, 'always'],
    'feat-type-mismatch': [1, 'always'],
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'style',
        'refactor',
        'perf',
        'test',
        'build',
        'ci',
        'chore',
        'revert',
      ],
    ],
    'type-empty': [2, 'never'],
    'subject-empty': [2, 'never'],
    'scope-enum': [
      2,
      'always',
      [
        // Apps
        'admin',
        'crawler-go-worker',
        'crawler-mcp-server',
        'multimodal-service',
        'nlu-sidecar',
        'observatory-cli',
        'runtime',
        'search-ai',
        'search-ai-runtime',
        'studio',
        'admin',
        'multimodal-service',
        'telco-noc',
        'workflow-engine',
        // Packages
        'academy',
        'a2a',
        'arch-ai',
        'helix',
        'abl-lsp-server',
        'abl-vscode',
        'admin-ui',
        'agent-transfer',
        'analyzer',
        'auth-enterprise',
        'circuit-breaker',
        'sti',
        'cli',
        'compiler',
        'config',
        'connectors',
        'core',
        'crawler',
        'database',
        'editor',
        'eventstore',
        'execution',
        'i18n',
        'language-service',
        'llm',
        'mcp-debug',
        'nl-parser',
        'observatory',
        'openapi',
        'pipeline-engine',
        'platform-cli',
        'project-io',
        'redis',
        'search-ai-internal',
        'search-ai-sdk',
        'shared',
        'shared-auth',
        'auth-profile',
        'shared-kernel',
        'shared-observability',
        'sizing-calculator',
        'sti',
        'tailwind-config',
        'web-sdk',
        // Infra
        'ci',
        'deps',
        'docker',
        'helm',
        'terraform',
      ],
    ],
    'scope-empty': [1, 'never'], // warn if no scope, but don't block
  },
  // Exempt merge commits from all rules
  ignores: [(commit: string) => commit.startsWith('Merge ')],
};

export default config;
