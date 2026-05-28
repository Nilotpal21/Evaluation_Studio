import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../../../../');
const TRACKER_PATH = path.join(
  ROOT,
  'docs/audit/2026-05-06-studio-db-dsl-runtime-propagation-master-tracker.md',
);
const MASTER_AUDIT_PATH = path.join(
  ROOT,
  'docs/audit/2026-05-06-studio-db-dsl-runtime-master-propagation-audit.md',
);

const REQUIRED_BOUNDARY_ROWS = [
  'Studio visual save',
  'Studio DSL save',
  'DB persistence',
  'YAML parser',
  'DSL parser',
  'Compiler IR',
  'Runtime execution',
  'Channel delivery',
  'Persistence',
  'Traces',
  'Rehydration',
  'Read surfaces',
] as const;

const REQUIRED_CONCERN_COLUMNS = [
  'Text response',
  'Rich content',
  'Voice config',
  'Actions',
  'Retry metadata',
  'Completion metadata',
  'Hook metadata',
  'PII registry/policy propagation',
] as const;

const REQUIRED_MODULE_ROWS = [
  'PII',
  'Project modules',
  'Guardrails',
  'Voice',
  'Rich templates',
  'Omnichannel',
  'Contact',
  'Sessions',
  'Traces',
  'Runtime config',
  'Import/export',
] as const;

const REQUIRED_LIFECYCLE_ROWS = [
  'ON_START',
  'ON_INPUT',
  'Navigation shortcut',
  'ON_RESULT',
] as const;

const REQUIRED_LIFECYCLE_COLUMNS = ['richContent', 'voiceConfig', 'actions'] as const;

const REQUIRED_CHANNEL_ROWS = [
  'http_async',
  'slack',
  'line',
  'msteams',
  'whatsapp',
  'messenger',
  'instagram',
  'twilio_sms',
  'zendesk',
  'telegram',
  'genesys',
  'ai4w',
  'email',
  'voice_vxml',
  'korevg',
  'audiocodes',
  'voice_pipeline',
  'voice_realtime',
  'voice',
  'voice_twilio',
  'voice_livekit',
  'ag_ui',
  'a2a',
  'sdk_websocket',
  'web_debug',
  'web_chat',
  'api',
  'http',
] as const;

const REQUIRED_AGENT_TRANSFER_ROWS = [
  'agent-transfer websocket',
  'agent-transfer channel_adapter',
  'agent-transfer voice_gateway',
] as const;

const REQUIRED_HELPER_FILES = [
  'apps/runtime/src/services/session/persisted-message-content.ts',
  'apps/runtime/src/services/execution/session-output-protection.ts',
  'apps/runtime/src/services/pii/session-pii-context.ts',
  'apps/runtime/src/services/event-bus/message-event-payload.ts',
  'apps/runtime/src/services/channel/outcome.ts',
  'apps/runtime/src/channels/manifest.ts',
  'apps/runtime/src/channels/channel-behavior-contract.ts',
  'apps/runtime/src/channels/pipeline/message-pipeline.ts',
  'apps/runtime/src/services/execution/channel-dispatcher.ts',
  'apps/runtime/src/services/agent-transfer/message-bridge.ts',
  'apps/runtime/src/services/agent-transfer/transcript-persistence.ts',
  'apps/studio/src/lib/abl-serializers.ts',
  'apps/studio/src/lib/abl/flow-visual-editor-compat.ts',
  'apps/studio/src/lib/abl/lifecycle-visual-editor-compat.ts',
  'packages/core/src/parser/agent-based-parser.ts',
  'packages/core/src/parser/yaml-parser.ts',
  'packages/compiler/src/platform/ir/compiler.ts',
  'packages/compiler/src/platform/ir/project-runtime-config.ts',
  'packages/language-service/src/serialize-yaml.ts',
  'apps/runtime/src/routes/project-runtime-config.ts',
  'apps/runtime/src/services/config/project-runtime-config-resolver.ts',
  'apps/runtime/src/services/config/project-runtime-config-write-validation.ts',
  'packages/project-io/src/import/runtime-config-save-validation.ts',
  'packages/project-io/src/import/core-direct-apply-orchestrator.ts',
  'packages/project-io/src/import/project-importer-v2.ts',
  'packages/project-io/src/export/project-exporter.ts',
  'packages/project-io/src/export/agent-export-materializer.ts',
] as const;

type ScanRule = {
  name: string;
  dirs: string[];
  pattern: RegExp;
};

const BYPASS_SCAN_RULES: ScanRule[] = [
  {
    name: 'structured assistant content constructors',
    dirs: [
      'apps/runtime/src/routes',
      'apps/runtime/src/websocket',
      'apps/runtime/src/services',
      'apps/studio/src/utils',
    ],
    pattern: /assistantStructuredContent\s*=|assistantStructuredContent:/,
  },
  {
    name: 'direct assistant history writes',
    dirs: ['apps/runtime/src/routes', 'apps/runtime/src/websocket', 'apps/runtime/src/services'],
    pattern:
      /conversationHistory\.push|\.conversationHistory\.push|push\(\{\s*role:\s*['"]assistant|role:\s*['"]assistant/,
  },
  {
    name: 'direct trace event writes',
    dirs: [
      'apps/runtime/src/routes',
      'apps/runtime/src/websocket',
      'apps/runtime/src/services',
      'apps/studio/src/utils',
    ],
    pattern:
      /getTraceStore\(\)\.addEvent|TraceStore\.addEvent|traceStore\.addEvent|\.addEvent\([^\n]*(transcript|arguments|tool|message|response)/,
  },
  {
    name: 'branch action parsing/execution paths',
    dirs: [
      'apps/runtime/src/services/execution',
      'packages/compiler/src/platform/ir',
      'packages/core/src/parser',
    ],
    pattern:
      /branch\.actions|matchedBranch\.actions|stepActions\s*=|actions:\s*branchResult\.actions|actions:\s*matchedBranch\.actions/,
  },
];

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expectTableRow(doc: string, rowLabel: string): void {
  const rowPattern = new RegExp(`\\|\\s*${escapeRegExp(rowLabel)}\\s*\\|`, 'i');
  expect(doc, `Missing required audit matrix row: ${rowLabel}`).toMatch(rowPattern);
}

function expectTableColumn(doc: string, columnLabel: string): void {
  const columnPattern = new RegExp(`\\|[^\\n]*${escapeRegExp(columnLabel)}[^\\n]*\\|`, 'i');
  expect(doc, `Missing required audit matrix column: ${columnLabel}`).toMatch(columnPattern);
}

function listSourceFiles(dir: string): string[] {
  const absoluteDir = path.join(ROOT, dir);
  if (!fs.existsSync(absoluteDir)) {
    return [];
  }

  const results: string[] = [];
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const absolutePath = path.join(absoluteDir, entry.name);
    const relativePath = path.relative(ROOT, absolutePath).split(path.sep).join('/');

    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === '.next' ||
        entry.name === '__tests__'
      ) {
        continue;
      }
      results.push(...listSourceFiles(relativePath));
      continue;
    }

    if (
      entry.isFile() &&
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !relativePath.includes('/__tests__/')
    ) {
      results.push(relativePath);
    }
  }

  return results;
}

function findMatchingFiles(rule: ScanRule): string[] {
  const files = new Set<string>();
  for (const dir of rule.dirs) {
    for (const file of listSourceFiles(dir)) {
      const source = read(path.join(ROOT, file));
      if (rule.pattern.test(source)) {
        files.add(file);
      }
      rule.pattern.lastIndex = 0;
    }
  }
  return [...files].sort();
}

describe('Studio -> DB -> DSL -> runtime propagation audit lint', () => {
  it('keeps the canonical boundary matrix and module matrix complete', () => {
    const tracker = read(TRACKER_PATH);

    for (const row of REQUIRED_BOUNDARY_ROWS) {
      expectTableRow(tracker, row);
    }

    for (const column of REQUIRED_CONCERN_COLUMNS) {
      expectTableColumn(tracker, column);
    }

    for (const moduleRow of REQUIRED_MODULE_ROWS) {
      expectTableRow(tracker, moduleRow);
    }

    for (const lifecycleRow of REQUIRED_LIFECYCLE_ROWS) {
      expectTableRow(tracker, lifecycleRow);
    }

    for (const lifecycleColumn of REQUIRED_LIFECYCLE_COLUMNS) {
      expectTableColumn(tracker, lifecycleColumn);
    }

    for (const channelRow of REQUIRED_CHANNEL_ROWS) {
      expectTableRow(tracker, channelRow);
    }

    for (const agentTransferRow of REQUIRED_AGENT_TRANSFER_ROWS) {
      expectTableRow(tracker, agentTransferRow);
    }
  });

  it('keeps canonical helper seams explicit and present on disk', () => {
    const tracker = read(TRACKER_PATH);
    const masterAudit = read(MASTER_AUDIT_PATH);
    const combinedDocs = `${tracker}\n${masterAudit}`;

    for (const file of REQUIRED_HELPER_FILES) {
      expect(fs.existsSync(path.join(ROOT, file)), `Missing canonical helper file: ${file}`).toBe(
        true,
      );
      expect(combinedDocs, `Canonical helper file is not documented: ${file}`).toContain(file);
    }
  });

  it('requires every high-risk bypass scan hit to be classified in the master tracker', () => {
    const tracker = read(TRACKER_PATH);
    const undocumented: string[] = [];

    for (const rule of BYPASS_SCAN_RULES) {
      for (const file of findMatchingFiles(rule)) {
        if (!tracker.includes(file)) {
          undocumented.push(`${file} (${rule.name})`);
        }
      }
    }

    expect(
      undocumented,
      [
        'Every file matching a propagation bypass scan must be listed in',
        path.relative(ROOT, TRACKER_PATH),
        'with a caller classification or source coverage row.',
      ].join(' '),
    ).toEqual([]);
  });

  it('requires each master tracker issue to keep source, severity, status, lock, and fix fields', () => {
    const tracker = read(TRACKER_PATH);
    const issueSections = tracker
      .split(/\n(?=### MTR-\d{3}:)/)
      .filter((section) => section.startsWith('### MTR-'));

    expect(issueSections.length, 'Expected at least one MTR issue section').toBeGreaterThan(0);

    for (const section of issueSections) {
      const title = section.split('\n')[0];
      for (const field of [
        'Severity',
        'Status',
        'Fixed status',
        'Regression lock status',
        'Seam',
        'Source file',
        'Affected path',
      ]) {
        expect(section, `${title} is missing required issue field: ${field}`).toContain(
          `| ${field}`,
        );
      }

      expect(
        section,
        `${title} status must classify confidence as confirmed, likely, suspected, or unknown`,
      ).toMatch(/\|\s*Status\s*\|\s*(Confirmed|Likely|Suspected|Unknown|Open pending)/i);
    }
  });
});
