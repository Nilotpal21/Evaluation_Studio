import { describe, expect, it } from 'vitest';

import { runFeasibilityChecks } from '../index.js';

describe('runFeasibilityChecks', () => {
  it('flags unresolved tools and voice/model feasibility risks', () => {
    const findings = runFeasibilityChecks({
      code: `AGENT: VoiceAgent
GOAL: "Help callers"
CHANNELS:
  - voice
TOOLS:
  lookup_account(account_id: string) -> object
`,
      declaredToolNames: ['lookup_account'],
      resolvedToolNames: [],
    });

    expect(findings.map((finding) => finding.checkName)).toEqual(
      expect.arrayContaining(['tool-binding', 'voice-model-feasibility']),
    );
  });

  it('flags flow empty-response and persistent-memory identity checks', () => {
    const findings = runFeasibilityChecks({
      code: `AGENT: MemoryFlow
GOAL: "Track preferences"
MEMORY:
  persistent:
    user.preference: string
FLOW:
  start:
    REASONING: false
    SET:
      done = true
`,
    });

    expect(findings.map((finding) => finding.checkName)).toEqual(
      expect.arrayContaining(['empty-response', 'memory-scope-identity']),
    );
  });
});
