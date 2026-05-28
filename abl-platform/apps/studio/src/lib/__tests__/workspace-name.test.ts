import { describe, expect, test } from 'vitest';
import { buildDefaultWorkspaceName } from '../workspace-name';

describe('buildDefaultWorkspaceName', () => {
  test('uses the user name when it is already supported', () => {
    expect(buildDefaultWorkspaceName('Alice')).toBe('Alice Workspace');
  });

  test('normalizes accents and strips unsupported punctuation', () => {
    expect(buildDefaultWorkspaceName("Renée O'Brien")).toBe('Renee O Brien Workspace');
  });

  test('falls back when the user name has no supported characters', () => {
    expect(buildDefaultWorkspaceName('🚀✨')).toBe('My Workspace');
  });

  test('trims the generated name to the workspace name length limit', () => {
    const workspaceName = buildDefaultWorkspaceName('A'.repeat(150));

    expect(workspaceName).toHaveLength(100);
    expect(workspaceName.endsWith(' Workspace')).toBe(true);
  });
});
