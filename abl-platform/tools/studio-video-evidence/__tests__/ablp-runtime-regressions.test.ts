import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const runtimeRegressionsScenario = join(
  process.cwd(),
  'tools/studio-video-evidence/scenarios/ablp-runtime-regressions.mjs',
);

function expectScenarioSnippets(source: string, snippets: string[]) {
  const missing = snippets.filter((snippet) => !source.includes(snippet));

  expect(missing).toEqual([]);
}

describe('studio video evidence ABLP-587 scenario', () => {
  it('defines the ABLP-535 live runtime PII redaction reproduction', async () => {
    const mod = await import('../scenarios/ablp-runtime-regressions.mjs');
    const source = await readFile(runtimeRegressionsScenario, 'utf8');

    expect(mod.buildAblp535AgentDsl).toEqual(expect.any(Function));
    expectScenarioSnippets(source, [
      'function buildAblp535AgentDsl',
      'async function runAblp535',
      "case 'ABLP-535':",
      '780b4d1c-1166-487e-ae7a-27eedd12905b',
      'createProjectPIIPattern',
      'redact_input: true',
      'redact_output: true',
      'request-does-not-contain-raw-pii',
      'request-uses-safe-pii-representation',
      'request-does-not-nest-pii-tokens',
      'assistant-response-does-not-contain-raw-pii',
      'ablp-535-live-runtime-pii-redacted.png',
      'verifySessionReloadPII',
      'session-detail-api-does-not-contain-raw-pii',
      'session-detail-screen-does-not-contain-raw-pii',
      'session-traces-do-not-contain-raw-pii',
      "screenshotPrefix: 'ablp-535'",
      'session-detail-redacted.png',
    ]);
  });

  it('defines the ABLP-539 live and session-reload PII pattern reproduction', async () => {
    const source = await readFile(runtimeRegressionsScenario, 'utf8');

    expectScenarioSnippets(source, [
      'async function runAblp539',
      "case 'ABLP-539':",
      'AB1234567',
      'A8006170900',
      '555-123-4567',
      'phone_builtin_disabled',
      'member-ids-tokenized-before-model-request',
      'member-id-tokens-are-not-nested',
      'assistant-renders-member-ids-masked',
      'session-detail-api-renders-member-ids-masked',
      'session-detail-screen-renders-member-ids-masked',
      'session-traces-render-member-ids-masked',
      "screenshotPrefix: 'ablp-539'",
      'session-detail-redacted.png',
    ]);
  });

  it('defines the reusable supervisor handoff rich-content evidence flow', async () => {
    const mod = await import('../scenarios/ablp-runtime-regressions.mjs');
    const source = await readFile(runtimeRegressionsScenario, 'utf8');

    expect(mod.buildAblp587SupervisorDsl).toEqual(expect.any(Function));
    expect(mod.buildAblp587ChildDsl).toEqual(expect.any(Function));
    expect(mod.runAblp587).toEqual(expect.any(Function));
    expectScenarioSnippets(source, [
      'function buildAblp587SupervisorDsl',
      'function buildAblp587ChildDsl',
      'async function runAblp587',
      'transcriptEvidence',
      'Supervisor handoff',
      'first child response',
      'FORMATS',
      'ACTIONS',
      'first-child-response-rendered-rich-content-and-action',
    ]);
  });

  it('wires ABLP-587 into the reusable runtime regressions scenario dispatch', async () => {
    const source = await readFile(runtimeRegressionsScenario, 'utf8');

    expectScenarioSnippets(source, [
      "case 'ABLP-587':",
      'runAblp587',
      'pnpm studio:video:evidence -- --scenario ablp-runtime-regressions --issue ABLP-587',
    ]);
  });

  it('keeps unsupported issue ids fail-closed', async () => {
    const source = await readFile(runtimeRegressionsScenario, 'utf8');

    expectScenarioSnippets(source, ['default:', 'does not support issue ${issue}']);
  });
});
