import { describe, expect, it } from 'vitest';
import { computeSourceHash } from '../utils/hash.js';
import {
  prepareProjectToolDslForPersistence,
  validateProjectToolDslForPersistence,
} from '../tools/project-tool-persistence.js';

const ctx = { tenantId: 'tenant-test', projectId: 'project-test' };

describe('project tool persistence guard', () => {
  it('accepts valid workflow DSL and returns the canonical source hash', () => {
    const dslContent = `run_onboarding(account_id: string) -> object
  description: "Run onboarding workflow"
  type: workflow
  workflow_id: "wf_onboarding"
  trigger_id: "trg_manual"`;

    const result = prepareProjectToolDslForPersistence({
      ...ctx,
      name: 'run_onboarding',
      toolType: 'workflow',
      dslContent,
    });

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.sourceHash).toBe(computeSourceHash(dslContent));
  });

  it('rejects records whose DB name and DSL signature disagree', () => {
    const result = validateProjectToolDslForPersistence({
      ...ctx,
      name: 'new_name',
      toolType: 'http',
      dslContent: `old_name() -> object
  description: "Old name"
  type: http
  endpoint: "https://api.example.com/old"
  method: GET`,
    });

    expect(result).toEqual({
      valid: false,
      message: 'Tool DSL signature name "old_name" must match tool name "new_name".',
    });
  });

  it('rejects type-specific invalid DSL before runtime execution', () => {
    const result = validateProjectToolDslForPersistence({
      ...ctx,
      name: 'run_onboarding',
      toolType: 'workflow',
      dslContent: `run_onboarding() -> object
  description: "Run onboarding workflow"
  type: workflow
  workflow_id: "wf_onboarding"`,
    });

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.message).toContain('trigger_id');
  });

  it('rejects malformed signature parameters instead of silently dropping them', () => {
    const result = validateProjectToolDslForPersistence({
      ...ctx,
      name: 'bad_params',
      toolType: 'http',
      dslContent: `bad_params(city string) -> object
  description: "Invalid params"
  type: http
  endpoint: "https://api.example.com/search"
  method: GET`,
    });

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.message).toContain('Invalid parameter syntax');
    expect(result.message).toContain('city string');
  });

  it('explains the snake_case rule when a camelCase name is used', () => {
    // The strict regex requires snake_case; the previous error message just
    // said "Tool DSL must start with a valid tool signature, for example
    // tool_name() -> object." even though the DSL clearly *did* start with a
    // signature — the user just used camelCase. This is the most common LLM
    // mistake when generating tool DSL.
    const result = validateProjectToolDslForPersistence({
      ...ctx,
      name: 'archBattleTool',
      toolType: 'http',
      dslContent: `archBattleTool() -> object
  description: "camelCase name"
  type: http
  endpoint: "https://api.example.com/x"
  method: GET`,
    });

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.message).toContain('archBattleTool');
    expect(result.message).toContain('snake_case');
  });

  it('still falls back to the generic message when first line is not a signature at all', () => {
    const result = validateProjectToolDslForPersistence({
      ...ctx,
      name: 'whatever',
      toolType: 'http',
      dslContent: `# This is a comment
type: http
endpoint: "https://api.example.com/x"`,
    });

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.message).toBe(
      'Tool DSL must start with a valid tool signature, for example: tool_name() -> object.',
    );
  });
});
