import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockProjectConfigVariableFind = vi.fn();
const mockProjectRuntimeConfigFindOne = vi.fn();
const mockProjectLLMConfigFindOne = vi.fn();
const mockResolvePromptLibraryRefOnDocument = vi.fn();

vi.mock('@abl/compiler', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@abl/compiler/platform/ir')),
  ...(await vi.importActual<Record<string, unknown>>(
    '@abl/compiler/platform/ir/project-runtime-config.js',
  )),
}));

function makeChainableQuery<T>(value: T) {
  return {
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(value),
  };
}

vi.mock('@agent-platform/database/models', () => ({
  ProjectConfigVariable: {
    find: (...args: unknown[]) => mockProjectConfigVariableFind(...args),
  },
  ProjectRuntimeConfig: {
    findOne: (...args: unknown[]) => ({
      lean: () => mockProjectRuntimeConfigFindOne(...args),
    }),
  },
  ProjectLLMConfig: {
    findOne: (...args: unknown[]) => ({
      lean: () => mockProjectLLMConfigFindOne(...args),
    }),
  },
  ProjectAgent: {
    find: vi.fn(),
    bulkWrite: vi.fn(),
  },
}));

vi.mock('@agent-platform/shared/prompts', () => ({
  resolvePromptLibraryRefOnDocument: (...args: unknown[]) =>
    mockResolvePromptLibraryRefOnDocument(...args),
}));

import { evaluateStudioProjectAgentDrafts } from '@/lib/abl/project-agent-draft-metadata';

describe('evaluateStudioProjectAgentDrafts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectConfigVariableFind.mockReturnValue(makeChainableQuery([]));
    mockProjectRuntimeConfigFindOne.mockResolvedValue(null);
    mockProjectLLMConfigFindOne.mockResolvedValue(null);
    mockResolvePromptLibraryRefOnDocument.mockResolvedValue(undefined);
  });

  it('keeps missing prompt-library refs scoped to the affected agent record', async () => {
    mockResolvePromptLibraryRefOnDocument.mockImplementation(
      async (document: { name?: string }) => {
        if (document.name === 'BookingAgent') {
          throw new Error('missing prompt version');
        }
      },
    );

    const metadata = await evaluateStudioProjectAgentDrafts({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      diagnosticSource: 'studio-repo',
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
          dslContent: 'AGENT: BillingAgent\nGOAL: "Handle billing"\n',
        },
      ],
    });

    expect(metadata.get('BookingAgent')).toMatchObject({
      dslValidationStatus: 'error',
    });
    expect(
      metadata
        .get('BookingAgent')
        ?.dslDiagnostics.some(
          (entry) =>
            entry.severity === 'error' &&
            entry.message.includes('prompt library reference') &&
            entry.message.includes('missing prompt version'),
        ),
    ).toBe(true);
    expect(metadata.get('BillingAgent')).toMatchObject({
      dslValidationStatus: 'valid',
      dslDiagnostics: [],
    });
  });

  it('surfaces malformed config-backed behavior profiles in persisted draft metadata', async () => {
    mockProjectConfigVariableFind.mockReturnValue(
      makeChainableQuery([
        {
          key: 'profile:voice_profile',
          value: '',
        },
      ]),
    );

    const metadata = await evaluateStudioProjectAgentDrafts({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      diagnosticSource: 'studio-repo',
      agents: [
        {
          recordName: 'BookingAgent',
          dslContent: 'AGENT: BookingAgent\nGOAL: "Book trips"\n',
        },
      ],
    });

    expect(metadata.get('BookingAgent')?.dslValidationStatus).not.toBe('valid');
    expect(
      metadata
        .get('BookingAgent')
        ?.dslDiagnostics.some(
          (entry) =>
            entry.message.includes('voice_profile') &&
            entry.message.includes('behavior profile content is empty'),
        ),
    ).toBe(true);
  });
});
