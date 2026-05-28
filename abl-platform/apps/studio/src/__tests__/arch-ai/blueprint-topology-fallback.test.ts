import { describe, expect, it } from 'vitest';
import type { ArchSession } from '@agent-platform/arch-ai/types';
import { synthesizeDeterministicBlueprintDraft } from '@/lib/arch-ai/blueprint-topology-fallback';

describe('blueprint topology fallback', () => {
  it('synthesizes a deterministic draft topology when blueprint generation returns no graph', () => {
    const specification: ArchSession['metadata']['specification'] = {
      version: 1,
      projectName: 'Customer Support',
      description:
        'Route customer queries to the right departments for returns, order status, and escalation.',
      channels: [],
      language: 'English',
      uploadedFiles: [],
      conversationNotes: [],
    };

    const fallback = synthesizeDeterministicBlueprintDraft(specification);

    expect(fallback.topology.entryPoint).toBeTruthy();
    expect(fallback.topology.agents.length).toBeGreaterThan(0);
    expect(fallback.summary).toContain('Created a');
    expect(fallback.summary).toContain('You can adjust names, ownership, or handoff paths');
    expect(fallback.summary).not.toMatch(
      /I synthesized|topology generator|valid graph|Please review/i,
    );
    expect(fallback.patternName).toBeTruthy();
  });
});
