import { describe, expect, it } from 'vitest';
import { SYSTEM_ROLES } from '../constants/system-roles.js';

function permissionsFor(roleName: string): string[] {
  const role = SYSTEM_ROLES.find((entry) => entry.name === roleName);
  if (!role) {
    throw new Error(`Missing system role: ${roleName}`);
  }
  return role.permissions;
}

describe('system role permissions', () => {
  it('seeds ADMIN with guardrail and PII pattern management permissions', () => {
    expect(permissionsFor('ADMIN')).toEqual(
      expect.arrayContaining([
        'guardrail:read',
        'guardrail:write',
        'pii-pattern:read',
        'pii-pattern:write',
      ]),
    );
  });
});
