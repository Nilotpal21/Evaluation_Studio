import { describe, expect, it } from 'vitest';

import { synthesizeDeterministicBlueprintDraft } from '../blueprint-topology-fallback.js';
import type { Specification } from '../types/specification.js';

const forbiddenFallbackCopy = /I synthesized|topology generator|valid graph|Please review/i;

function buildSpecification(): Specification {
  return {
    version: 1,
    projectName: 'Customer Support',
    description:
      'Route customer queries to the right departments for returns, order status, and escalation.',
    channels: [],
    language: 'English',
    uploadedFiles: [],
    conversationNotes: [],
  };
}

describe('blueprint topology fallback', () => {
  it('uses product-facing summary copy for deterministic specification fallback', () => {
    const fallback = synthesizeDeterministicBlueprintDraft(buildSpecification());

    expect(fallback.topology.entryPoint).toBeTruthy();
    expect(fallback.topology.agents.length).toBeGreaterThan(0);
    expect(fallback.summary).toContain('Created a');
    expect(fallback.summary).toContain('You can adjust names, ownership, or handoff paths');
    expect(fallback.summary).not.toMatch(forbiddenFallbackCopy);
  });

  it('uses product-facing summary copy for source-contract fallback', () => {
    const fallback = synthesizeDeterministicBlueprintDraft(buildSpecification(), {
      sourceFiles: ['support-architecture.md'],
      declaredAgents: [
        {
          name: 'Reception',
          role: 'intake',
          tools: [],
          memoryVariables: [],
          limitations: [],
          provenance: { fileName: 'support-architecture.md' },
        },
        {
          name: 'Orders',
          role: 'order support',
          tools: [],
          memoryVariables: [],
          limitations: [],
          provenance: { fileName: 'support-architecture.md' },
        },
      ],
      entryAgent: 'Reception',
      channels: ['web'],
      requiredMcpServers: [],
      sharedMemoryVariables: [],
      universalRules: [],
      guardrails: [],
      tools: [],
      optionalExternalAgents: [],
      confidence: 0.95,
    });

    expect(fallback.patternName).toBe('Source Document Contract');
    expect(fallback.summary).toContain('Created a source-faithful blueprint');
    expect(fallback.summary).toContain('uses Reception as the entry point');
    expect(fallback.summary).not.toMatch(forbiddenFallbackCopy);
  });
});
