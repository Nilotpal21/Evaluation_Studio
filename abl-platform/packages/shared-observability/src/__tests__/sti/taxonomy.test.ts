import { describe, it, expect } from 'vitest';
import {
  STI_PATHS,
  isValidSTIPath,
  assertSTIPath,
  pathDepth,
  pathStartsWith,
} from '../../sti/taxonomy.js';

describe('taxonomy', () => {
  it('exports 10 paths', () => {
    expect(STI_PATHS).toHaveLength(10);
  });

  it('validates known paths', () => {
    expect(isValidSTIPath('runtime/executor/agent-enter')).toBe(true);
    expect(isValidSTIPath('runtime/executor/flow/step-entry')).toBe(true);
  });

  it('rejects unknown paths', () => {
    expect(isValidSTIPath('unknown/path')).toBe(false);
  });

  it('assertSTIPath throws for unknown paths', () => {
    expect(() => assertSTIPath('bad/path')).toThrow('Unknown STI path');
  });

  it('assertSTIPath does not throw for valid paths', () => {
    expect(() => assertSTIPath('runtime/executor/llm-call')).not.toThrow();
  });

  it('pathDepth returns correct depth', () => {
    expect(pathDepth('runtime/executor/agent-enter')).toBe(3);
    expect(pathDepth('runtime/executor/flow/step-entry')).toBe(4);
  });

  it('pathStartsWith checks prefix correctly', () => {
    expect(pathStartsWith('runtime/executor/flow/step-entry', 'runtime/executor')).toBe(true);
    expect(pathStartsWith('runtime/executor/flow/step-entry', 'runtime/executor/flow')).toBe(true);
    expect(pathStartsWith('runtime/executor/agent-enter', 'runtime/executor/flow')).toBe(false);
  });
});
