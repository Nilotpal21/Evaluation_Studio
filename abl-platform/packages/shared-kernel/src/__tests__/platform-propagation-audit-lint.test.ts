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
const LLD_PATH = path.join(
  ROOT,
  'docs/plans/2026-05-06-studio-db-dsl-runtime-full-matrix-structured-output-lld.md',
);

const REQUIRED_PLATFORM_ROWS = [
  'ON_SUCCESS',
  'ON_FAILURE',
  'ON_ERROR',
  'COMPLETE',
  'HOOKS',
  'Reask/no-match/default',
  'Tool calls',
  'Tool results',
  'Tool confirmation prompts',
  'Dynamic tool forms',
  'MCP/tool binding',
  'Session attachments',
  'Channel media downloaders/processors',
  'Email attachments',
  'A2A attachments',
  'Attachment traces',
  'WebSocket chunks',
  'SDK typed interrupts',
  'Async callback streaming',
  'Filler/status messages',
  'Voice realtime transcript deltas',
  'Studio SSE/Arch-AI stream',
  'Studio localization assets',
  'Runtime locale resolution',
  'Import/export locale files',
  'Channel/template localization',
  'Auth profiles',
  'Credentials/secrets redaction',
  'Tool auth binding',
  'Model resolution',
  'Tenant model policy',
  'Session memory',
  'Tool memory bridge',
  'Omnichannel recall',
  'Contact memory',
  'Context window/readback',
  'Import manifest validation',
  'Layer assemblers',
  'Layer disassemblers',
  'Direct apply',
  'Preview/revert',
  'Export workers/jobs',
  'Post-import validation',
  'Runtime proxy',
  'SDK channel proxy',
  'Web SDK core client',
  'Web SDK React package',
  'Web SDK vanilla embed',
  'Studio preview runtime',
  'SDK preview share',
  'Local handoff return structured output',
  'Remote A2A handoff return structured data',
  'Streaming remote A2A multipart return',
  'Lifecycle action-set serializer fidelity',
  'Session attachments proxy',
  'Trace/session read routes',
  'Governance proxy',
  'Runtime route mounting',
  'Studio route handler helpers',
  'Package barrels',
  'Background workers/jobs',
  'Queue processors',
] as const;

const REQUIRED_PLATFORM_COLUMNS = [
  'Definition',
  'Transform',
  'Presentation',
  'Persistence',
  'Consumption',
  'Wiring',
  'Regression lock',
] as const;

const SLICE18_CLOSED_PLATFORM_ROWS = [
  'Tool calls',
  'Tool results',
  'Tool confirmation prompts',
  'Dynamic tool forms',
  'MCP/tool binding',
] as const;

const SLICE19_CLOSED_PLATFORM_ROWS = [
  'Session attachments',
  'Channel media downloaders/processors',
  'Email attachments',
  'A2A attachments',
  'Attachment traces',
] as const;

const SLICE20_CLOSED_PLATFORM_ROWS = [
  'WebSocket chunks',
  'SDK typed interrupts',
  'Async callback streaming',
  'Filler/status messages',
  'Voice realtime transcript deltas',
  'Studio SSE/Arch-AI stream',
] as const;

const SLICE21_CLOSED_PLATFORM_ROWS = [
  'Studio localization assets',
  'Runtime locale resolution',
  'Import/export locale files',
  'Channel/template localization',
] as const;

const SLICE22_CLOSED_PLATFORM_ROWS = [
  'Auth profiles',
  'Credentials/secrets redaction',
  'Tool auth binding',
  'Model resolution',
  'Tenant model policy',
] as const;

const SLICE23_CLOSED_PLATFORM_ROWS = [
  'Session memory',
  'Tool memory bridge',
  'Omnichannel recall',
  'Contact memory',
  'Context window/readback',
] as const;

const SLICE24_CLOSED_PLATFORM_ROWS = [
  'Import manifest validation',
  'Layer assemblers',
  'Layer disassemblers',
  'Direct apply',
  'Preview/revert',
  'Export workers/jobs',
  'Post-import validation',
  'Runtime proxy',
  'SDK channel proxy',
  'Session attachments proxy',
  'Trace/session read routes',
  'Governance proxy',
  'Runtime route mounting',
  'Studio route handler helpers',
  'Package barrels',
  'Background workers/jobs',
  'Queue processors',
] as const;

const SLICE25_CLOSED_PLATFORM_ROWS = [
  'Web SDK core client',
  'Web SDK React package',
  'Web SDK vanilla embed',
  'Studio preview runtime',
  'SDK preview share',
] as const;

const SLICE26_CLOSED_PLATFORM_ROWS = [
  'Local handoff return structured output',
  'Remote A2A handoff return structured data',
  'Streaming remote A2A multipart return',
  'Lifecycle action-set serializer fidelity',
] as const;

const SLICE26_PLATFORM_REGRESSION_EVIDENCE = {
  'Local handoff return structured output': [
    'apps/runtime/src/__tests__/execution/a2a-structured-handoff-return.test.ts',
    'buildStructuredHandoffAssistantMessage',
  ],
  'Remote A2A handoff return structured data': [
    'apps/runtime/src/__tests__/execution/a2a-structured-handoff-return.test.ts',
    'extractA2AResponseOutput',
  ],
  'Streaming remote A2A multipart return': [
    'apps/runtime/src/__tests__/execution/a2a-structured-handoff-return.test.ts',
    'multipart text',
  ],
  'Lifecycle action-set serializer fidelity': [
    'apps/studio/src/__tests__/abl-serializers.test.ts',
    'round-trips lifecycle action sets',
  ],
} as const satisfies Record<(typeof SLICE26_CLOSED_PLATFORM_ROWS)[number], readonly string[]>;

const SLICE27_CLOSED_PLATFORM_ROWS = ['ON_SUCCESS', 'ON_FAILURE', 'HOOKS'] as const;

const SLICE27_PLATFORM_REGRESSION_EVIDENCE = {
  ON_SUCCESS: ['flow-authored-output-pii.test.ts', 'ON_SUCCESS structured action payload'],
  ON_FAILURE: ['flow-authored-output-pii.test.ts', 'ON_FAILURE structured action payload'],
  HOOKS: ['hooks-lifecycle.e2e.test.ts', 'assistant history content envelopes'],
} as const satisfies Record<(typeof SLICE27_CLOSED_PLATFORM_ROWS)[number], readonly string[]>;

const REQUIRED_PLATFORM_SOURCE_FILES = [
  'apps/runtime/src/services/execution/tool-confirmation.ts',
  'apps/runtime/src/services/execution/tool-result-compressor.ts',
  'apps/runtime/src/tools/load-project-tools-as-ir.ts',
  'packages/shared/src/tools/serialize-tool-form-to-dsl.ts',
  'packages/shared/src/tools/parse-dsl-to-tool-form.ts',
  'packages/shared/src/tools/project-tool-persistence.ts',
  'packages/shared/src/types/project-tool-form.ts',
  'apps/runtime/src/tools/attachment-tool-executor.ts',
  'apps/runtime/src/tools/attachment-param-validator.ts',
  'apps/runtime/src/services/a2a/attachment-ingestor.ts',
  'apps/runtime/src/channels/adapters/attachment-trace-utils.ts',
  'apps/studio/src/app/api/runtime/sessions/[id]/attachments/route.ts',
  'apps/runtime/src/websocket/handler.ts',
  'apps/runtime/src/websocket/sdk-handler.ts',
  'apps/runtime/src/websocket/twilio-media-handler.ts',
  'apps/runtime/src/services/filler/pipeline-filler.ts',
  'apps/runtime/src/services/voice/livekit/agent-worker.ts',
  'apps/studio/src/lib/arch-ai/sse-stream.ts',
  'apps/studio/src/lib/arch-ai/stream-observer.ts',
  'packages/project-io/src/locale-files.ts',
  'packages/i18n/src/resolve-locale.ts',
  'apps/studio/src/api/localization.ts',
  'packages/shared-auth-profile/src/apply-auth.ts',
  'packages/shared-auth-profile/src/redact.ts',
  'apps/runtime/src/services/auth-profile/resolve-tool-auth.ts',
  'apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts',
  'apps/runtime/src/services/llm/model-resolution.ts',
  'apps/runtime/src/routes/tenant-llm-policy.ts',
  'apps/runtime/src/services/execution/memory-integration.ts',
  'apps/runtime/src/services/execution/tool-memory-bridge.ts',
  'apps/runtime/src/services/execution/memory-executor.ts',
  'apps/runtime/src/services/omnichannel/recall-service.ts',
  'apps/runtime/src/routes/memory-api.ts',
  'packages/project-io/src/import/manifest-validator.ts',
  'packages/project-io/src/import/post-import-validator.ts',
  'packages/project-io/src/import/core-direct-apply.ts',
  'packages/project-io/src/import/core-import-preview.ts',
  'packages/project-io/src/export/layer-assemblers/index.ts',
  'packages/project-io/src/import/layer-disassemblers/index.ts',
  'apps/studio/src/services/export-job-processor.ts',
  'apps/studio/src/services/export-worker.ts',
  'apps/studio/src/lib/runtime-proxy.ts',
  'apps/studio/src/lib/sdk-runtime-channel-proxy.ts',
  'packages/web-sdk/src/index.ts',
  'packages/web-sdk/src/core/AgentSDK.ts',
  'packages/web-sdk/src/chat/ChatClient.ts',
  'packages/web-sdk/src/transport/DefaultTransport.ts',
  'packages/web-sdk/src/ui/ChatWidget.ts',
  'packages/web-sdk/src/ui/UnifiedWidget.ts',
  'packages/web-sdk/src/react/index.ts',
  'packages/web-sdk/src/react/AgentProvider.tsx',
  'packages/web-sdk/src/react/components/ChatWidget.tsx',
  'packages/web-sdk/src/templates/registry.ts',
  'packages/web-sdk/examples/vanilla-html/index.html',
  'apps/studio/src/app/preview/[projectId]/page.tsx',
  'apps/studio/src/app/api/sdk/preview-token/route.ts',
  'apps/studio/src/lib/share-preview-link.ts',
  'apps/studio/src/lib/preview-reconnect.ts',
  'apps/runtime/src/services/execution/routing-executor.ts',
  'apps/runtime/src/services/execution/hook-executor.ts',
  'apps/runtime/src/__tests__/execution/a2a-structured-handoff-return.test.ts',
  'apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts',
  'apps/runtime/src/__tests__/hooks-lifecycle.e2e.test.ts',
  'apps/studio/src/lib/abl-serializers.ts',
  'apps/studio/src/__tests__/abl-serializers.test.ts',
  'apps/studio/src/lib/route-handler.ts',
  'apps/studio/src/lib/safe-proxy.ts',
  'apps/runtime/src/server.ts',
  'apps/runtime/src/services/queues/index.ts',
  'packages/project-io/src/index.ts',
] as const;

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expectTableRow(doc: string, rowLabel: string): void {
  const rowPattern = new RegExp(`\\|\\s*${escapeRegExp(rowLabel)}\\s*\\|`, 'i');
  expect(doc, `Missing required platform propagation row: ${rowLabel}`).toMatch(rowPattern);
}

function expectTableColumn(doc: string, columnLabel: string): void {
  const columnPattern = new RegExp(`\\|[^\\n]*${escapeRegExp(columnLabel)}[^\\n]*\\|`, 'i');
  expect(doc, `Missing required platform propagation column: ${columnLabel}`).toMatch(
    columnPattern,
  );
}

function getTableRowCells(doc: string, rowLabel: string): string[] {
  const rowPattern = new RegExp(`^\\|\\s*${escapeRegExp(rowLabel)}\\s*\\|.*$`, 'im');
  const row = doc.match(rowPattern)?.[0];
  expect(row, `Missing required platform propagation row: ${rowLabel}`).toBeTruthy();
  return row!
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
}

describe('Platform propagation audit extension lint', () => {
  it('keeps the second platform propagation matrix complete', () => {
    const tracker = read(TRACKER_PATH);

    for (const column of REQUIRED_PLATFORM_COLUMNS) {
      expectTableColumn(tracker, column);
    }

    for (const row of REQUIRED_PLATFORM_ROWS) {
      expectTableRow(tracker, row);
    }
  });

  it('keeps Slice 18 tools/forms rows fully locked once closed', () => {
    const tracker = read(TRACKER_PATH);

    for (const row of SLICE18_CLOSED_PLATFORM_ROWS) {
      const cells = getTableRowCells(tracker, row);
      const statusCells = cells.slice(1, 7);
      expect(statusCells, `${row} must be PASS across all platform propagation lanes`).toEqual([
        'PASS',
        'PASS',
        'PASS',
        'PASS',
        'PASS',
        'PASS',
      ]);
      expect(cells[7], `${row} must cite deterministic regression evidence`).not.toMatch(
        /\bMissing\b/i,
      );
    }
  });

  it('keeps Slice 19 attachment/media rows fully locked once closed', () => {
    const tracker = read(TRACKER_PATH);

    for (const row of SLICE19_CLOSED_PLATFORM_ROWS) {
      const cells = getTableRowCells(tracker, row);
      const statusCells = cells.slice(1, 7);
      expect(statusCells, `${row} must be PASS across all platform propagation lanes`).toEqual([
        'PASS',
        'PASS',
        'PASS',
        'PASS',
        'PASS',
        'PASS',
      ]);
      expect(cells[7], `${row} must cite deterministic regression evidence`).not.toMatch(
        /\bMissing\b/i,
      );
    }
  });

  it('keeps Slice 20 streaming/realtime rows fully locked once closed', () => {
    const tracker = read(TRACKER_PATH);

    for (const row of SLICE20_CLOSED_PLATFORM_ROWS) {
      const cells = getTableRowCells(tracker, row);
      const statusCells = cells.slice(1, 7);
      expect(statusCells, `${row} must be PASS across all platform propagation lanes`).toEqual([
        'PASS',
        'PASS',
        'PASS',
        'PASS',
        'PASS',
        'PASS',
      ]);
      expect(cells[7], `${row} must cite deterministic regression evidence`).not.toMatch(
        /\bMissing\b/i,
      );
    }
  });

  it('keeps Slice 21 localization rows fully locked once closed', () => {
    const tracker = read(TRACKER_PATH);

    for (const row of SLICE21_CLOSED_PLATFORM_ROWS) {
      const cells = getTableRowCells(tracker, row);
      const statusCells = cells.slice(1, 7);
      expect(statusCells, `${row} must be PASS across all platform propagation lanes`).toEqual([
        'PASS',
        'PASS',
        'PASS',
        'PASS',
        'PASS',
        'PASS',
      ]);
      expect(cells[7], `${row} must cite deterministic regression evidence`).not.toMatch(
        /\bMissing\b/i,
      );
    }
  });

  it('keeps Slice 22 auth/model/policy rows fully locked once closed', () => {
    const tracker = read(TRACKER_PATH);

    for (const row of SLICE22_CLOSED_PLATFORM_ROWS) {
      const cells = getTableRowCells(tracker, row);
      const statusCells = cells.slice(1, 7);
      expect(statusCells, `${row} must be PASS across all platform propagation lanes`).toEqual([
        'PASS',
        'PASS',
        'PASS',
        'PASS',
        'PASS',
        'PASS',
      ]);
      expect(cells[7], `${row} must cite deterministic regression evidence`).not.toMatch(
        /\bMissing\b/i,
      );
    }
  });

  it('keeps Slice 23 memory/recall/context rows fully locked once closed', () => {
    const tracker = read(TRACKER_PATH);

    for (const row of SLICE23_CLOSED_PLATFORM_ROWS) {
      const cells = getTableRowCells(tracker, row);
      const statusCells = cells.slice(1, 7);
      expect(statusCells, `${row} must be PASS across all platform propagation lanes`).toEqual([
        'PASS',
        'PASS',
        'PASS',
        'PASS',
        'PASS',
        'PASS',
      ]);
      expect(cells[7], `${row} must cite deterministic regression evidence`).not.toMatch(
        /\bMissing\b/i,
      );
    }
  });

  it('keeps Slice 24 import/export/proxy/wiring rows fully locked once closed', () => {
    const tracker = read(TRACKER_PATH);

    for (const row of SLICE24_CLOSED_PLATFORM_ROWS) {
      const cells = getTableRowCells(tracker, row);
      const statusCells = cells.slice(1, 7);
      expect(statusCells, `${row} must be PASS across all platform propagation lanes`).toEqual([
        'PASS',
        'PASS',
        'PASS',
        'PASS',
        'PASS',
        'PASS',
      ]);
      expect(cells[7], `${row} must cite deterministic regression evidence`).not.toMatch(
        /\bMissing\b/i,
      );
    }
  });

  it('keeps Slice 25 Web SDK and preview rows fully locked once closed', () => {
    const tracker = read(TRACKER_PATH);

    for (const row of SLICE25_CLOSED_PLATFORM_ROWS) {
      const cells = getTableRowCells(tracker, row);
      const statusCells = cells.slice(1, 7);
      expect(statusCells, `${row} must be PASS across all platform propagation lanes`).toEqual([
        'PASS',
        'PASS',
        'PASS',
        'PASS',
        'PASS',
        'PASS',
      ]);
      expect(cells[7], `${row} must cite deterministic regression evidence`).not.toMatch(
        /\bMissing\b/i,
      );
    }
  });

  it('keeps Slice 26 handoff and lifecycle serializer rows fully locked once closed', () => {
    const tracker = read(TRACKER_PATH);

    for (const row of SLICE26_CLOSED_PLATFORM_ROWS) {
      const cells = getTableRowCells(tracker, row);
      const statusCells = cells.slice(1, 7);
      expect(statusCells, `${row} must be PASS across all platform propagation lanes`).toEqual([
        'PASS',
        'PASS',
        'PASS',
        'PASS',
        'PASS',
        'PASS',
      ]);
      expect(cells[7], `${row} must cite deterministic regression evidence`).not.toMatch(
        /\bMissing\b/i,
      );

      for (const expectedEvidence of SLICE26_PLATFORM_REGRESSION_EVIDENCE[row]) {
        expect(cells[7], `${row} must cite ${expectedEvidence}`).toContain(expectedEvidence);
      }
    }
  });

  it('keeps Slice 27 lifecycle tail and hook rows fully locked once closed', () => {
    const tracker = read(TRACKER_PATH);

    for (const row of SLICE27_CLOSED_PLATFORM_ROWS) {
      const cells = getTableRowCells(tracker, row);
      const statusCells = cells.slice(1, 7);
      expect(statusCells, `${row} must be PASS across all platform propagation lanes`).toEqual([
        'PASS',
        'PASS',
        'PASS',
        'PASS',
        'PASS',
        'PASS',
      ]);
      expect(cells[7], `${row} must cite deterministic regression evidence`).not.toMatch(
        /\bMissing\b/i,
      );

      for (const expectedEvidence of SLICE27_PLATFORM_REGRESSION_EVIDENCE[row]) {
        expect(cells[7], `${row} must cite ${expectedEvidence}`).toContain(expectedEvidence);
      }
    }
  });

  it('keeps the platform source inventory explicit and present on disk', () => {
    const tracker = read(TRACKER_PATH);
    const lld = read(LLD_PATH);
    const combinedDocs = `${tracker}\n${lld}`;

    for (const file of REQUIRED_PLATFORM_SOURCE_FILES) {
      expect(fs.existsSync(path.join(ROOT, file)), `Missing platform source file: ${file}`).toBe(
        true,
      );
      expect(combinedDocs, `Platform source file is not documented: ${file}`).toContain(file);
    }
  });
});
