import { describe, expect, it } from 'vitest';
import {
  mergeProjectAgentDraftStates,
  toProjectAgentDraftState,
} from '@/lib/abl/project-agent-draft-metadata';

describe('studio project agent draft state helpers', () => {
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
});
