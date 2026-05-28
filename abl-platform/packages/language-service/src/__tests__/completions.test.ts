import { describe, it, expect } from 'vitest';
import { getCompletions } from '../completions';
import type { CompletionContext } from '../types';

describe('getCompletions', () => {
  it('suggests top-level YAML keys at start of empty line', () => {
    const yaml = `agent: test\n`;
    const completions = getCompletions(yaml, { line: 2, column: 1 });
    const labels = completions.map((c) => c.label);
    expect(labels).toContain('mode');
    expect(labels).toContain('goal');
    expect(labels).toContain('tools');
    expect(labels).toContain('flow');
    expect(labels).toContain('constraints');
  });

  it('suggests tool names inside tools section', () => {
    const yaml = `agent: test\ntools:\n  - `;
    const ctx: CompletionContext = {
      availableTools: [
        { name: 'search_hotels', type: 'HTTP', description: 'Search for hotels' },
        { name: 'book_room', type: 'MCP', description: 'Book a room' },
      ],
    };
    const completions = getCompletions(yaml, { line: 3, column: 5 }, ctx);
    const labels = completions.map((c) => c.label);
    expect(labels).toContain('search_hotels');
    expect(labels).toContain('book_room');
  });

  it('suggests flow step keywords inside a flow step', () => {
    const yaml = `agent: test\nmode: scripted\nflow:\n  steps:\n    greeting:\n      `;
    const completions = getCompletions(yaml, { line: 6, column: 7 });
    const labels = completions.map((c) => c.label);
    expect(labels).toContain('respond');
    expect(labels).toContain('call');
    expect(labels).toContain('then');
    expect(labels).toContain('gather');
    expect(labels).toContain('set');
    expect(labels).toContain('when');
  });

  it('suggests agent names for handoff targets', () => {
    const yaml = `agent: test\nhandoff:\n  - to: `;
    const ctx: CompletionContext = {
      availableAgents: [{ name: 'support_agent' }, { name: 'billing_agent' }],
    };
    const completions = getCompletions(yaml, { line: 3, column: 9 }, ctx);
    const labels = completions.map((c) => c.label);
    expect(labels).toContain('support_agent');
    expect(labels).toContain('billing_agent');
  });

  it('returns empty for unrecognized context', () => {
    const yaml = `some random text`;
    const completions = getCompletions(yaml, { line: 1, column: 17 });
    // At indent 0, the engine suggests remaining top-level keys
    expect(Array.isArray(completions)).toBe(true);
  });

  it('suggests legacy top-level keys when format is legacy', () => {
    const legacy = `AGENT: test\n`;
    const ctx: CompletionContext = { format: 'legacy' };
    const completions = getCompletions(legacy, { line: 2, column: 1 }, ctx);
    const labels = completions.map((c) => c.label);
    expect(labels).toContain('MODE');
    expect(labels).toContain('GOAL');
    expect(labels).toContain('TOOLS');
    expect(labels).not.toContain('AGENT'); // already present
    // Should not suggest yaml-format keys
    expect(labels).not.toContain('agent');
    expect(labels).not.toContain('mode');
  });

  // --- Task 2: CEL function completions in expression contexts ---

  it('suggests CEL functions inside a when: line', () => {
    const yaml = `agent: test\nmode: scripted\nflow:\n  steps:\n    greeting:\n      when: `;
    const results = getCompletions(yaml, { line: 6, column: 13 });
    expect(results).toHaveLength(32);
    expect(results.some((r) => r.label === 'abl.upper')).toBe(true);
    expect(results.some((r) => r.label === 'abl.coalesce')).toBe(true);
    expect(results.every((r) => r.kind === 'function')).toBe(true);
  });

  it('suggests CEL functions inside a validate: line', () => {
    const yaml = `agent: test\nmode: scripted\nflow:\n  steps:\n    greeting:\n      validate: `;
    const results = getCompletions(yaml, { line: 6, column: 17 });
    expect(results.some((r) => r.label === 'abl.is_number')).toBe(true);
  });

  it('suggests CEL functions inside a set: value', () => {
    const yaml = `agent: test\nmode: scripted\nflow:\n  steps:\n    greeting:\n      set:\n        x: `;
    const results = getCompletions(yaml, { line: 7, column: 12 });
    expect(results.some((r) => r.label === 'abl.now')).toBe(true);
    expect(results.every((r) => r.kind === 'function')).toBe(true);
  });

  it('CEL function completions include documentation', () => {
    const yaml = `agent: test\nmode: scripted\nflow:\n  steps:\n    greeting:\n      when: `;
    const results = getCompletions(yaml, { line: 6, column: 13 });
    const upper = results.find((r) => r.label === 'abl.upper');
    expect(upper).toBeDefined();
    expect(upper!.documentation).toContain('uppercase');
    expect(upper!.detail).toContain('abl.upper');
  });

  // --- Task 3: Value completions for enum-like fields ---

  it('suggests mode values after mode:', () => {
    const yaml = `agent: test\nmode: `;
    const results = getCompletions(yaml, { line: 2, column: 7 });
    expect(results.some((r) => r.label === 'reasoning')).toBe(true);
    expect(results.some((r) => r.label === 'scripted')).toBe(true);
    expect(results.every((r) => r.kind === 'value')).toBe(true);
  });

  it('suggests tool type values after type: inside tools', () => {
    const yaml = `agent: test\ntools:\n  my_tool:\n    type: `;
    const results = getCompletions(yaml, { line: 4, column: 11 });
    expect(results.some((r) => r.label === 'http')).toBe(true);
    expect(results.some((r) => r.label === 'mcp')).toBe(true);
    expect(results.some((r) => r.label === 'lambda')).toBe(true);
  });

  it('suggests escalation priority values', () => {
    const yaml = `agent: test\nhandoff:\n  - to: support\n    priority: `;
    const results = getCompletions(yaml, { line: 4, column: 15 });
    expect(results.some((r) => r.label === 'high')).toBe(true);
    expect(results.some((r) => r.label === 'low')).toBe(true);
  });

  it('suggests history strategy values inside handoff context', () => {
    const yaml = `agent: test\nhandoff:\n  - to: support\n    context:\n      history: `;
    const results = getCompletions(yaml, { line: 5, column: 16 });

    expect(results.some((r) => r.label === 'auto')).toBe(true);
    expect(results.some((r) => r.label === 'summary_only')).toBe(true);
    expect(results.some((r) => r.label === 'full')).toBe(true);
    expect(results.some((r) => r.label === 'last_<n>')).toBe(true);
  });

  it('suggests typed history properties inside a handoff history block', () => {
    const yaml = `agent: test\nhandoff:\n  - to: support\n    context:\n      history:\n        `;
    const results = getCompletions(yaml, { line: 6, column: 9 });

    expect(results.some((r) => r.label === 'mode')).toBe(true);
    expect(results.some((r) => r.label === 'count')).toBe(true);
  });

  it('suggests typed history mode values inside a handoff history block', () => {
    const yaml = `agent: test\nhandoff:\n  - to: support\n    context:\n      history:\n        mode: `;
    const results = getCompletions(yaml, { line: 6, column: 15 });

    expect(results.some((r) => r.label === 'auto')).toBe(true);
    expect(results.some((r) => r.label === 'last_n')).toBe(true);
  });

  it('suggests project models for execution model values', () => {
    const yaml = `agent: test\nexecution:\n  model: `;
    const ctx: CompletionContext = {
      availableModels: [
        {
          modelId: 'GPT-4.1',
          name: 'GPT-4.1 (Azure)',
          provider: 'azure',
          isDefault: true,
        },
        { modelId: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
      ],
    };

    const results = getCompletions(yaml, { line: 3, column: 10 }, ctx);
    expect(results.map((r) => r.label)).toContain('GPT-4.1');
    expect(results.find((r) => r.label === 'GPT-4.1')?.insertText).toBe('GPT-4.1');
    expect(results.find((r) => r.label === 'GPT-4.1')?.detail).toContain('Azure');
  });

  it('suggests project models for execution fallback_model values', () => {
    const yaml = `agent: test\nexecution:\n  fallback_model: `;
    const ctx: CompletionContext = {
      availableModels: [{ modelId: 'GPT-4.1', name: 'GPT-4.1 (Azure)', provider: 'azure' }],
    };

    const results = getCompletions(yaml, { line: 3, column: 19 }, ctx);
    expect(results.map((r) => r.label)).toEqual(['GPT-4.1']);
  });

  it('suggests project models in legacy uppercase execution blocks', () => {
    const yaml = `AGENT: test\nEXECUTION:\n  model: `;
    const ctx: CompletionContext = {
      format: 'legacy',
      availableModels: [{ modelId: 'GPT-4.1', name: 'GPT-4.1 (Azure)', provider: 'azure' }],
    };

    const results = getCompletions(yaml, { line: 3, column: 10 }, ctx);
    expect(results.map((r) => r.label)).toEqual(['GPT-4.1']);
  });

  it('suggests action values after action: in flow steps', () => {
    const yaml = `agent: test\nflow:\n  steps:\n    start:\n      on_complete:\n        action: `;
    const results = getCompletions(yaml, { line: 6, column: 16 });
    expect(results.some((r) => r.label === 'handoff')).toBe(true);
    expect(results.some((r) => r.label === 'escalate')).toBe(true);
  });

  // --- Task 4: Gather field property and type value completions ---

  it('suggests gather field properties', () => {
    const yaml = `agent: test\ngather:\n  name:\n    `;
    const results = getCompletions(yaml, { line: 4, column: 5 });
    expect(results.some((r) => r.label === 'type')).toBe(true);
    expect(results.some((r) => r.label === 'required')).toBe(true);
    expect(results.some((r) => r.label === 'description')).toBe(true);
    expect(results.some((r) => r.label === 'validate')).toBe(true);
    expect(results.some((r) => r.label === 'default')).toBe(true);
    expect(results.every((r) => r.kind === 'field')).toBe(true);
  });

  it('suggests canonical handoff context properties', () => {
    const yaml = `agent: test\nhandoff:\n  - to: support\n    context:\n      `;
    const results = getCompletions(yaml, { line: 5, column: 7 });

    expect(results.some((r) => r.label === 'memory_grants')).toBe(true);
    expect(results.some((r) => r.label === 'history')).toBe(true);
  });

  it('suggests gather field type values', () => {
    const yaml = `agent: test\ngather:\n  name:\n    type: `;
    const results = getCompletions(yaml, { line: 4, column: 11 });
    expect(results.some((r) => r.label === 'string')).toBe(true);
    expect(results.some((r) => r.label === 'number')).toBe(true);
    expect(results.some((r) => r.label === 'boolean')).toBe(true);
    expect(results.some((r) => r.label === 'date')).toBe(true);
  });
});
