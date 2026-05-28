import { describe, expect, it } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import {
  evaluateProjectAgentDraftMetadata,
  validateProjectAgentDraftDeclaredName,
} from '../project-agent-draft-metadata.js';

const BILLING_AGENT_WITH_MISSING_HANDOFF = `
AGENT: billing_agent
GOAL: "Handle billing questions"

HANDOFF:
  - TO: booking_agent
    WHEN: always
    CONTEXT:
      pass: []
`;

function parseDocument(dsl: string) {
  const result = parseAgentBasedABL(dsl);
  expect(result.errors).toHaveLength(0);
  expect(result.document).not.toBeNull();
  return result.document!;
}

describe('evaluateProjectAgentDraftMetadata', () => {
  it('marks parse-valid but compiler-invalid drafts as error', () => {
    const metadata = evaluateProjectAgentDraftMetadata({
      agents: [
        {
          recordName: 'travel_agent',
          dslContent: 'AGENT: travel_agent\nGOAL: "Handle travel questions"\n',
        },
        {
          recordName: 'billing_agent',
          dslContent: BILLING_AGENT_WITH_MISSING_HANDOFF,
        },
      ],
      diagnosticSource: 'unit-test',
    });

    expect(metadata.get('travel_agent')).toMatchObject({
      dslValidationStatus: 'valid',
      dslDiagnostics: [],
    });
    expect(metadata.get('billing_agent')).toMatchObject({
      dslValidationStatus: 'error',
    });
    expect(
      metadata
        .get('billing_agent')
        ?.dslDiagnostics.some(
          (entry) =>
            entry.severity === 'error' &&
            entry.message.includes('Handoff target "booking_agent" does not exist'),
        ),
    ).toBe(true);
  });

  it('rejects a draft whose declared name no longer matches the persisted record', () => {
    const metadata = evaluateProjectAgentDraftMetadata({
      agents: [
        {
          recordName: 'booking_agent',
          dslContent: 'AGENT: travel_agent\nGOAL: "Renamed working copy"\n',
        },
        {
          recordName: 'billing_agent',
          dslContent: BILLING_AGENT_WITH_MISSING_HANDOFF,
        },
      ],
      diagnosticSource: 'unit-test',
    });

    expect(metadata.get('booking_agent')).toMatchObject({
      dslValidationStatus: 'error',
      declaredName: 'travel_agent',
    });
    expect(
      metadata
        .get('booking_agent')
        ?.dslDiagnostics.some(
          (entry) =>
            entry.severity === 'error' &&
            entry.message ===
              'Agent DSL declares "travel_agent" but this record is "booking_agent". Use the rename flow to change agent identity.',
        ),
    ).toBe(true);
    expect(
      metadata
        .get('booking_agent')
        ?.dslDiagnostics.some((entry) =>
          entry.message.includes('Handoff target "booking_agent" does not exist'),
        ),
    ).toBe(false);
    expect(metadata.get('billing_agent')?.dslValidationStatus).toBe('error');
  });

  it('can invalidate an untouched sibling from the projected final project state', () => {
    const metadata = evaluateProjectAgentDraftMetadata({
      agents: [
        {
          recordName: 'billing_agent',
          dslContent: BILLING_AGENT_WITH_MISSING_HANDOFF,
        },
      ],
      diagnosticSource: 'unit-test',
    });

    expect(metadata.get('billing_agent')).toMatchObject({
      dslValidationStatus: 'error',
    });
  });

  it('changes sourceHash when only prompt companion metadata changes', () => {
    const baseDsl = 'AGENT: booking_agent\nGOAL: "Handle booking questions"\n';

    const v1 = evaluateProjectAgentDraftMetadata({
      agents: [
        {
          recordName: 'booking_agent',
          dslContent: baseDsl,
          systemPromptLibraryRef: {
            promptId: 'prompt-1',
            versionId: 'version-1',
          },
        },
      ],
      diagnosticSource: 'unit-test',
    });

    const v2 = evaluateProjectAgentDraftMetadata({
      agents: [
        {
          recordName: 'booking_agent',
          dslContent: baseDsl,
          systemPromptLibraryRef: {
            promptId: 'prompt-1',
            versionId: 'version-2',
          },
        },
      ],
      diagnosticSource: 'unit-test',
    });

    expect(v1.get('booking_agent')?.dslValidationStatus).toBe('valid');
    expect(v2.get('booking_agent')?.dslValidationStatus).toBe('valid');
    expect(v1.get('booking_agent')?.sourceHash).not.toBe(v2.get('booking_agent')?.sourceHash);
  });

  it('uses contextual documents when compiling persisted draft metadata', () => {
    const metadata = evaluateProjectAgentDraftMetadata({
      agents: [
        {
          recordName: 'billing_agent',
          dslContent: BILLING_AGENT_WITH_MISSING_HANDOFF,
        },
      ],
      contextDocuments: [parseDocument('AGENT: booking_agent\nGOAL: "Handle booking questions"\n')],
      diagnosticSource: 'unit-test',
    });

    expect(metadata.get('billing_agent')).toMatchObject({
      dslValidationStatus: 'valid',
      dslDiagnostics: [],
    });
  });

  it('keeps per-record context diagnostics scoped to the affected agent', () => {
    const metadata = evaluateProjectAgentDraftMetadata({
      agents: [
        {
          recordName: 'booking_agent',
          dslContent: 'AGENT: booking_agent\nGOAL: "Handle booking questions"\n',
        },
        {
          recordName: 'billing_agent',
          dslContent: 'AGENT: billing_agent\nGOAL: "Handle billing questions"\n',
        },
      ],
      recordDiagnostics: new Map([
        [
          'booking_agent',
          {
            errors: ['Prompt library version is missing'],
          },
        ],
      ]),
      diagnosticSource: 'unit-test',
    });

    expect(metadata.get('booking_agent')).toMatchObject({
      dslValidationStatus: 'error',
    });
    expect(
      metadata
        .get('booking_agent')
        ?.dslDiagnostics.some(
          (entry) =>
            entry.severity === 'error' && entry.message === 'Prompt library version is missing',
        ),
    ).toBe(true);
    expect(metadata.get('billing_agent')).toMatchObject({
      dslValidationStatus: 'valid',
      dslDiagnostics: [],
    });
  });
});

describe('validateProjectAgentDraftDeclaredName', () => {
  it('returns a blocking mismatch when the DSL header renames the persisted record', () => {
    expect(
      validateProjectAgentDraftDeclaredName({
        recordName: 'booking_agent',
        dslContent: 'AGENT: travel_agent\nGOAL: "Renamed working copy"\n',
      }),
    ).toEqual({
      ok: false,
      code: 'AGENT_DSL_NAME_MISMATCH',
      recordName: 'booking_agent',
      declaredName: 'travel_agent',
      message:
        'Agent DSL declares "travel_agent" but this record is "booking_agent". Use the rename flow to change agent identity.',
    });
  });

  it('allows matching agent and supervisor headers', () => {
    expect(
      validateProjectAgentDraftDeclaredName({
        recordName: 'booking_agent',
        dslContent: 'AGENT: booking_agent\nGOAL: "Handle booking"\n',
      }),
    ).toMatchObject({ ok: true, declaredName: 'booking_agent' });

    expect(
      validateProjectAgentDraftDeclaredName({
        recordName: 'SupportSupervisor',
        dslContent: 'SUPERVISOR: SupportSupervisor\nGOAL: "Route support"\n',
      }),
    ).toMatchObject({ ok: true, declaredName: 'SupportSupervisor' });
  });
});

describe('rewriteProjectAgentDraftDeclaredName', () => {
  it('rewrites the canonical agent header during a rename', async () => {
    const { rewriteProjectAgentDraftDeclaredName } =
      await import('../project-agent-draft-metadata.js');

    expect(
      rewriteProjectAgentDraftDeclaredName({
        recordName: 'booking_agent',
        nextName: 'travel_agent',
        dslContent: 'AGENT: booking_agent\nGOAL: "Handle booking"\n',
      }),
    ).toEqual({
      ok: true,
      recordName: 'booking_agent',
      declaredName: 'booking_agent',
      dslContent: 'AGENT: travel_agent\nGOAL: "Handle booking"\n',
    });
  });

  it('refuses to rewrite a draft that is already split from its record', async () => {
    const { rewriteProjectAgentDraftDeclaredName } =
      await import('../project-agent-draft-metadata.js');

    expect(
      rewriteProjectAgentDraftDeclaredName({
        recordName: 'booking_agent',
        nextName: 'support_agent',
        dslContent: 'AGENT: travel_agent\nGOAL: "Already split"\n',
      }),
    ).toMatchObject({
      ok: false,
      code: 'AGENT_DSL_NAME_MISMATCH',
      recordName: 'booking_agent',
      declaredName: 'travel_agent',
    });
  });
});
