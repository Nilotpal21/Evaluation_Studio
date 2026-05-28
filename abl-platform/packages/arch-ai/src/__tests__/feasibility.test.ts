import { describe, expect, it } from 'vitest';
import { runFeasibilityChecks } from '../feasibility/index.js';

describe('runFeasibilityChecks', () => {
  it('warns about provider allowlists only when EXECUTION declares a model or provider', () => {
    expect(
      runFeasibilityChecks({
        code: 'AGENT: Example\nEXECUTION:\n  timeout: 30s\nRESPOND: "ok"',
      }).some((finding) => finding.checkName === 'provider-allowlist'),
    ).toBe(false);

    expect(
      runFeasibilityChecks({
        code: 'AGENT: Example\nEXECUTION:\n  model: claude-sonnet-4-5\nRESPOND: "ok"',
      }).some((finding) => finding.checkName === 'provider-allowlist'),
    ).toBe(true);
  });
});
