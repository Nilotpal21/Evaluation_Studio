import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockResolveProjectToolsFromDocuments = vi.fn();
const mockResolvePromptLibraryRefOnDocument = vi.fn();

vi.mock('../../services/execution/types.js', () => ({
  resolveProjectToolsFromDocuments: (...args: unknown[]) =>
    mockResolveProjectToolsFromDocuments(...args),
}));

vi.mock('@agent-platform/shared/prompts', () => ({
  resolvePromptLibraryRefOnDocument: (...args: unknown[]) =>
    mockResolvePromptLibraryRefOnDocument(...args),
}));

import {
  backfillMissingRuntimeProjectAgentDraftMetadata,
  evaluateRuntimeProjectAgentDrafts,
  mergeProjectAgentDraftStates,
  toProjectAgentDraftState,
} from '../../services/session/project-agent-draft-metadata.js';

describe('runtime project agent draft state helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveProjectToolsFromDocuments.mockResolvedValue(new Map());
    mockResolvePromptLibraryRefOnDocument.mockResolvedValue(undefined);
  });

  it('preserves systemPromptLibraryRef when building a draft state', () => {
    expect(
      toProjectAgentDraftState({
        name: 'BookingAgent',
        dslContent: 'AGENT: BookingAgent\nGOAL: "Book trips"\n',
        systemPromptLibraryRef: {
          promptId: 'prompt-1',
          versionId: 'version-1',
        },
      }),
    ).toEqual({
      recordName: 'BookingAgent',
      dslContent: 'AGENT: BookingAgent\nGOAL: "Book trips"\n',
      systemPromptLibraryRef: {
        promptId: 'prompt-1',
        versionId: 'version-1',
      },
    });
  });

  it('carries prompt companion overrides through projected draft state merges', () => {
    const merged = mergeProjectAgentDraftStates(
      [
        {
          name: 'BookingAgent',
          dslContent: 'AGENT: BookingAgent\nGOAL: "Book trips"\n',
          systemPromptLibraryRef: {
            promptId: 'prompt-1',
            versionId: 'version-1',
          },
        },
      ],
      [
        {
          recordName: 'BookingAgent',
          dslContent: 'AGENT: BookingAgent\nGOAL: "Book trips"\n',
          systemPromptLibraryRef: {
            promptId: 'prompt-1',
            versionId: 'version-2',
          },
        },
      ],
    );

    expect(merged).toEqual([
      {
        recordName: 'BookingAgent',
        dslContent: 'AGENT: BookingAgent\nGOAL: "Book trips"\n',
        systemPromptLibraryRef: {
          promptId: 'prompt-1',
          versionId: 'version-2',
        },
      },
    ]);
  });

  it('changes sourceHash when only the prompt companion metadata changes', async () => {
    const baseDsl = 'AGENT: BookingAgent\nGOAL: "Book trips"\n';

    const v1 = await evaluateRuntimeProjectAgentDrafts({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      diagnosticSource: 'runtime-test',
      agents: [
        {
          recordName: 'BookingAgent',
          dslContent: baseDsl,
          systemPromptLibraryRef: {
            promptId: 'prompt-1',
            versionId: 'version-1',
          },
        },
      ],
    });

    const v2 = await evaluateRuntimeProjectAgentDrafts({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      diagnosticSource: 'runtime-test',
      agents: [
        {
          recordName: 'BookingAgent',
          dslContent: baseDsl,
          systemPromptLibraryRef: {
            promptId: 'prompt-1',
            versionId: 'version-2',
          },
        },
      ],
    });

    expect(v1.get('BookingAgent')?.dslValidationStatus).toBe('valid');
    expect(v2.get('BookingAgent')?.dslValidationStatus).toBe('valid');
    expect(v1.get('BookingAgent')?.sourceHash).not.toBe(v2.get('BookingAgent')?.sourceHash);
  });

  it('resolves prompt-library refs and scopes failures to the affected draft', async () => {
    mockResolvePromptLibraryRefOnDocument.mockImplementation(
      async (document: { name?: string }) => {
        if (document.name === 'BillingAgent') {
          throw new Error('missing prompt version');
        }
      },
    );

    const result = await evaluateRuntimeProjectAgentDrafts({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      diagnosticSource: 'runtime-test',
      agents: [
        {
          recordName: 'BookingAgent',
          dslContent: 'AGENT: BookingAgent\nGOAL: "Book trips"\n',
          systemPromptLibraryRef: {
            promptId: 'prompt-1',
            versionId: 'version-1',
          },
        },
        {
          recordName: 'BillingAgent',
          dslContent: 'AGENT: BillingAgent\nGOAL: "Handle invoices"\n',
          systemPromptLibraryRef: {
            promptId: 'prompt-2',
            versionId: 'version-2',
          },
        },
      ],
    });

    expect(mockResolvePromptLibraryRefOnDocument).toHaveBeenCalledTimes(2);
    expect(result.get('BookingAgent')?.dslValidationStatus).toBe('valid');
    expect(result.get('BillingAgent')?.dslValidationStatus).toBe('error');
    expect(result.get('BillingAgent')?.dslDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          source: 'runtime-test',
          message: expect.stringContaining('missing prompt version'),
        }),
      ]),
    );
  });

  it('appends config-backed behavior profiles to the runtime compile context', async () => {
    const result = await evaluateRuntimeProjectAgentDrafts({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      diagnosticSource: 'runtime-test',
      configVariables: {
        'profile:voice_profile': 'BEHAVIOR_PROFILE: voice_profile\nPRIORITY: 10\nWHEN: true',
      },
      agents: [
        {
          recordName: 'BookingAgent',
          dslContent:
            'AGENT: BookingAgent\nGOAL: "Book trips"\nUSE BEHAVIOR_PROFILE: voice_profile\n',
        },
      ],
    });

    expect(mockResolveProjectToolsFromDocuments).toHaveBeenCalledWith(
      'tenant-1',
      'proj-1',
      expect.arrayContaining([
        expect.objectContaining({ name: 'BookingAgent' }),
        expect.objectContaining({ name: 'voice_profile' }),
      ]),
    );
    expect(result.get('BookingAgent')?.dslValidationStatus).toBe('valid');
  });

  it('surfaces malformed config-backed behavior profiles as draft warnings', async () => {
    const result = await evaluateRuntimeProjectAgentDrafts({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      diagnosticSource: 'runtime-test',
      configVariables: {
        'profile:voice_profile': 'AGENT: wrong_kind\nGOAL: "not a behavior profile"\n',
      },
      agents: [
        {
          recordName: 'BookingAgent',
          dslContent: 'AGENT: BookingAgent\nGOAL: "Book trips"\n',
        },
      ],
    });

    expect(result.get('BookingAgent')?.dslValidationStatus).toBe('warning');
    expect(result.get('BookingAgent')?.dslDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'warning',
          source: 'runtime-test',
          message: expect.stringContaining('expected BEHAVIOR_PROFILE document'),
        }),
      ]),
    );
  });

  it('lazy backfills only non-empty drafts missing validation metadata', async () => {
    const evaluateDrafts = vi.fn().mockResolvedValue(
      new Map([
        [
          'LegacyAgent',
          {
            sourceHash: 'legacy-hash',
            dslValidationStatus: 'valid',
            dslDiagnostics: [],
          },
        ],
        [
          'AlreadyValid',
          {
            sourceHash: 'new-valid-hash',
            dslValidationStatus: 'warning',
            dslDiagnostics: [
              {
                severity: 'warning',
                message: 'context warning',
                source: 'runtime-test',
              },
            ],
          },
        ],
      ]),
    );
    const loadConfigVariables = vi.fn().mockResolvedValue({ feature_flag: 'on' });
    const persistMetadata = vi.fn().mockResolvedValue(undefined);

    const result = await backfillMissingRuntimeProjectAgentDraftMetadata({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        {
          name: 'LegacyAgent',
          dslContent: 'AGENT: LegacyAgent\nGOAL: "Help"\n',
          dslValidationStatus: null,
        },
        {
          name: 'AlreadyValid',
          dslContent: 'AGENT: AlreadyValid\nGOAL: "Help"\n',
          dslValidationStatus: 'valid',
          sourceHash: 'existing-valid-hash',
          dslDiagnostics: [],
        },
      ],
      diagnosticSource: 'runtime-test',
      deps: {
        evaluateDrafts,
        loadConfigVariables,
        persistMetadata,
      },
    });

    expect(evaluateDrafts).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      diagnosticSource: 'runtime-test',
      configVariables: { feature_flag: 'on' },
      agents: [
        {
          recordName: 'LegacyAgent',
          dslContent: 'AGENT: LegacyAgent\nGOAL: "Help"\n',
          systemPromptLibraryRef: null,
        },
        {
          recordName: 'AlreadyValid',
          dslContent: 'AGENT: AlreadyValid\nGOAL: "Help"\n',
          systemPromptLibraryRef: null,
        },
      ],
    });
    expect(persistMetadata).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        {
          name: 'LegacyAgent',
          dslContent: 'AGENT: LegacyAgent\nGOAL: "Help"\n',
          dslValidationStatus: null,
        },
      ],
      metadataByAgent: expect.any(Map),
    });
    expect(result.backfilledAgentNames).toEqual(['LegacyAgent']);
    expect(result.agents).toEqual([
      {
        name: 'LegacyAgent',
        dslContent: 'AGENT: LegacyAgent\nGOAL: "Help"\n',
        sourceHash: 'legacy-hash',
        dslValidationStatus: 'valid',
        dslDiagnostics: [],
      },
      {
        name: 'AlreadyValid',
        dslContent: 'AGENT: AlreadyValid\nGOAL: "Help"\n',
        dslValidationStatus: 'valid',
        sourceHash: 'existing-valid-hash',
        dslDiagnostics: [],
      },
    ]);
  });

  it('does not lazy backfill drafts that already have an explicit error status', async () => {
    const evaluateDrafts = vi.fn();
    const loadConfigVariables = vi.fn();
    const persistMetadata = vi.fn();

    const result = await backfillMissingRuntimeProjectAgentDraftMetadata({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        {
          name: 'BrokenAgent',
          dslContent: 'AGENT: BrokenAgent\nGOAL: "Help"\n',
          dslValidationStatus: 'error',
          dslDiagnostics: [
            {
              severity: 'error',
              message: 'already validated',
              source: 'studio',
            },
          ],
        },
      ],
      deps: {
        evaluateDrafts,
        loadConfigVariables,
        persistMetadata,
      },
    });

    expect(evaluateDrafts).not.toHaveBeenCalled();
    expect(loadConfigVariables).not.toHaveBeenCalled();
    expect(persistMetadata).not.toHaveBeenCalled();
    expect(result.backfilledAgentNames).toEqual([]);
    expect(result.agents).toEqual([
      {
        name: 'BrokenAgent',
        dslContent: 'AGENT: BrokenAgent\nGOAL: "Help"\n',
        dslValidationStatus: 'error',
        dslDiagnostics: [
          {
            severity: 'error',
            message: 'already validated',
            source: 'studio',
          },
        ],
      },
    ]);
  });
});
