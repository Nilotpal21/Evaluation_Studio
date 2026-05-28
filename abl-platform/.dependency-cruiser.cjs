/** @type {import('dependency-cruiser').IConfiguration} */

// Generate per-app no-cross-import rules since dependency-cruiser
// does not support backreferences like $1 in pathNot.
const apps = [
  'admin',
  'runtime',
  'search-ai',
  'search-ai-runtime',
  'studio',
  'workflow-engine',
  'observatory-cli',
  'crawler-go-worker',
  'crawler-mcp-server',
  'multimodal-service',
  'nlu-sidecar',
];

// Production app-to-app rules — exclude test files so production signal is clean
const noAppToAppRules = apps.map((app) => ({
  name: `no-app-to-app-${app}`,
  comment: `${app} must not import from other apps (production code)`,
  severity: 'warn',
  from: {
    path: `^apps/${app}/`,
    pathNot: '__tests__|\\.(test|spec)\\.(ts|tsx)$',
  },
  to: {
    path: '^apps/',
    pathNot: `^apps/${app}/`,
  },
}));

// Test-only app-to-app rules — reported at info level, not blocking
const noAppToAppTestRules = apps.map((app) => ({
  name: `no-app-to-app-${app}-test`,
  comment: `${app} test files importing from other apps (informational)`,
  severity: 'info',
  from: {
    path: `^apps/${app}/.*(/__tests__/|\\.(test|spec)\\.(ts|tsx)$)`,
  },
  to: {
    path: '^apps/',
    pathNot: `^apps/${app}/`,
  },
}));

module.exports = {
  forbidden: [
    ...noAppToAppRules,
    ...noAppToAppTestRules,
    {
      name: 'no-shared-to-database-direct',
      comment: 'shared-kernel must not depend on database (target: Sprint 4)',
      severity: 'info',
      from: { path: '^packages/shared/' },
      to: { path: '^packages/database' },
    },
    {
      name: 'no-db-in-routes',
      comment: 'Route files must not import database models directly',
      severity: 'warn',
      from: { path: '(routes?|route\\.ts)' },
      to: { path: '^packages/database/src/models' },
    },
    {
      name: 'no-reverse-coupling',
      comment: 'Packages must not import from apps',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
