import { describe, expect, test } from 'vitest';
import { parseCliOptions, parseRollbackSteps } from '../migrations/cli.js';

describe('migration CLI options', () => {
  test('accepts underscore and hyphen phase names', () => {
    expect(parseCliOptions(['--phase', 'pre_deploy'])).toEqual({ phase: 'pre_deploy' });
    expect(parseCliOptions(['--phase=post_deploy'])).toEqual({ phase: 'post_deploy' });
    expect(parseCliOptions(['--phase', 'pre-deploy'])).toEqual({ phase: 'pre_deploy' });
    expect(parseCliOptions(['--phase=post-deploy'])).toEqual({ phase: 'post_deploy' });
  });

  test('rejects invalid phase options', () => {
    expect(() => parseCliOptions(['--phase'])).toThrow('--phase requires a value');
    expect(() => parseCliOptions(['--phase', 'before-deploy'])).toThrow(
      'Invalid --phase value: before-deploy',
    );
    expect(() => parseCliOptions(['--unknown'])).toThrow('Unknown option: --unknown');
  });

  test('requires rollback steps to be a positive integer', () => {
    expect(parseRollbackSteps(undefined)).toBe(1);
    expect(parseRollbackSteps('3')).toBe(3);
    expect(() => parseRollbackSteps('0')).toThrow('Invalid rollback steps value: 0');
    expect(() => parseRollbackSteps('-1')).toThrow('Invalid rollback steps value: -1');
    expect(() => parseRollbackSteps('abc')).toThrow('Invalid rollback steps value: abc');
  });
});
