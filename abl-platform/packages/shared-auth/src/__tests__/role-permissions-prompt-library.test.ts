import { describe, test, expect } from 'vitest';
import {
  PERMISSION_REGISTRY,
  VALID_CUSTOM_ROLE_PERMISSIONS,
  PROJECT_ROLE_PERMISSIONS,
} from '../rbac/role-permissions.js';

describe('prompt-library permissions', () => {
  test('all 6 prompt permissions are in VALID_CUSTOM_ROLE_PERMISSIONS', () => {
    for (const perm of [
      'prompt:create',
      'prompt:read',
      'prompt:update',
      'prompt:delete',
      'prompt:test',
      'prompt:promote',
    ]) {
      expect(VALID_CUSTOM_ROLE_PERMISSIONS).toContain(perm);
    }
  });

  test('developer role has prompt:* wildcard', () => {
    expect(PROJECT_ROLE_PERMISSIONS.developer).toContain('prompt:*');
  });

  test('tester role has prompt:read and prompt:test', () => {
    expect(PROJECT_ROLE_PERMISSIONS.tester).toContain('prompt:read');
    expect(PROJECT_ROLE_PERMISSIONS.tester).toContain('prompt:test');
  });

  test('viewer role has prompt:read', () => {
    expect(PROJECT_ROLE_PERMISSIONS.viewer).toContain('prompt:read');
  });

  test('prompt-library category in PERMISSION_REGISTRY', () => {
    const cat = PERMISSION_REGISTRY.find((c) => c.category === 'prompt-library');
    expect(cat).toBeDefined();
    expect(cat!.permissions).toHaveLength(6);
  });
});
