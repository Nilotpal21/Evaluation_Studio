import {
  MAX_VARIABLE_NAMESPACES_PER_PROJECT,
  MAX_VARIABLE_NAMESPACES_PER_VARIABLE,
  MAX_ENV_VARS_PER_PROJECT,
  MAX_VARIABLE_NAMESPACE_NAME_LENGTH,
  MAX_VARIABLE_NAMESPACE_DISPLAY_NAME_LENGTH,
  VARIABLE_NAMESPACE_NAME_PATTERN,
  DEFAULT_VARIABLE_NAMESPACE_NAME,
  DEFAULT_VARIABLE_NAMESPACE_DISPLAY_NAME,
} from '../constants.js';

describe('Variable namespace constants', () => {
  it('exports variable namespace limits', () => {
    expect(MAX_VARIABLE_NAMESPACES_PER_PROJECT).toBe(25);
    expect(MAX_VARIABLE_NAMESPACES_PER_VARIABLE).toBe(10);
    expect(MAX_ENV_VARS_PER_PROJECT).toBe(500);
  });

  it('exports variable namespace name constraints', () => {
    expect(MAX_VARIABLE_NAMESPACE_NAME_LENGTH).toBe(50);
    expect(MAX_VARIABLE_NAMESPACE_DISPLAY_NAME_LENGTH).toBe(100);
    expect(VARIABLE_NAMESPACE_NAME_PATTERN).toEqual(/^[a-z][a-z0-9-]*$/);
  });

  it('exports default variable namespace values', () => {
    expect(DEFAULT_VARIABLE_NAMESPACE_NAME).toBe('default');
    expect(DEFAULT_VARIABLE_NAMESPACE_DISPLAY_NAME).toBe('Default');
  });

  it('validates variable namespace name pattern correctly', () => {
    expect(VARIABLE_NAMESPACE_NAME_PATTERN.test('stripe')).toBe(true);
    expect(VARIABLE_NAMESPACE_NAME_PATTERN.test('my-namespace')).toBe(true);
    expect(VARIABLE_NAMESPACE_NAME_PATTERN.test('a1')).toBe(true);
    expect(VARIABLE_NAMESPACE_NAME_PATTERN.test('1invalid')).toBe(false);
    expect(VARIABLE_NAMESPACE_NAME_PATTERN.test('UPPER')).toBe(false);
    expect(VARIABLE_NAMESPACE_NAME_PATTERN.test('has space')).toBe(false);
    expect(VARIABLE_NAMESPACE_NAME_PATTERN.test('')).toBe(false);
  });
});
