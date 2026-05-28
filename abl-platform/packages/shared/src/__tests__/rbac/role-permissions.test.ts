import { describe, expect, it } from 'vitest';
import {
  PROJECT_ROLE_NAMES,
  PROJECT_ROLE_PERMISSIONS,
  SENSITIVE_EXACT_PERMISSIONS,
  TENANT_ROLE_PERMISSIONS,
  evaluateProjectPermission,
  VALID_CUSTOM_ROLE_PERMISSIONS,
  validateCustomRolePermissions,
} from '../../rbac/index.js';
import {
  PROJECT_ROLE_NAMES as SHARED_AUTH_PROJECT_ROLE_NAMES,
  PROJECT_ROLE_PERMISSIONS as SHARED_AUTH_PROJECT_ROLE_PERMISSIONS,
  TENANT_ROLE_PERMISSIONS as SHARED_AUTH_TENANT_ROLE_PERMISSIONS,
  evaluateProjectPermission as evaluateSharedAuthProjectPermission,
  VALID_CUSTOM_ROLE_PERMISSIONS as SHARED_AUTH_VALID_CUSTOM_ROLE_PERMISSIONS,
  validateCustomRolePermissions as validateSharedAuthCustomRolePermissions,
} from '@agent-platform/shared-auth/rbac';

describe('shared RBAC role permissions', () => {
  it('re-exports the shared-auth role contract without creating a second implementation', () => {
    expect(PROJECT_ROLE_NAMES).toBe(SHARED_AUTH_PROJECT_ROLE_NAMES);
    expect(PROJECT_ROLE_PERMISSIONS).toBe(SHARED_AUTH_PROJECT_ROLE_PERMISSIONS);
    expect(TENANT_ROLE_PERMISSIONS).toBe(SHARED_AUTH_TENANT_ROLE_PERMISSIONS);
    expect(evaluateProjectPermission).toBe(evaluateSharedAuthProjectPermission);
    expect(VALID_CUSTOM_ROLE_PERMISSIONS).toBe(SHARED_AUTH_VALID_CUSTOM_ROLE_PERMISSIONS);
    expect(validateCustomRolePermissions).toBe(validateSharedAuthCustomRolePermissions);
  });

  it('keeps tester as an explicit built-in project role contract', () => {
    expect(PROJECT_ROLE_NAMES).toContain('tester');
    expect(PROJECT_ROLE_PERMISSIONS.tester).toEqual([
      'agent:read',
      'tool:read',
      'version:read',
      'deployment:read',
      'channel:read',
      'env_var:read',
      'session:read',
      'session:create',
      'workflow:read',
      'channel_connection:read',
      'credential:read',
      'lookup_data:read',
      'attachment:read',
      'simulate:execute',
      'analytics:read',
      'guardrail:read',
      'pii-pattern:read',
      'prompt:read',
      'prompt:test',
      'external_agent:read',
      'governance:audit-read',
    ]);
  });

  it('keeps workspace MEMBER able to create projects through the canonical contract', () => {
    expect(TENANT_ROLE_PERMISSIONS.MEMBER).toContain('project:create');
    expect(VALID_CUSTOM_ROLE_PERMISSIONS).toContain('project:create');
  });

  it('grants the AUDITOR workspace role read-only auth-profile access', () => {
    expect(TENANT_ROLE_PERMISSIONS.AUDITOR).toEqual(['tenant:read', 'auth-profile:read']);
    expect(TENANT_ROLE_PERMISSIONS.AUDITOR).not.toContain('auth-profile:write');
    expect(TENANT_ROLE_PERMISSIONS.AUDITOR).not.toContain('auth-profile:create');
    expect(TENANT_ROLE_PERMISSIONS.AUDITOR).not.toContain('auth-profile:delete');
  });

  it('grants ADMIN full auth-profile management via the auth-profile:* wildcard', () => {
    expect(TENANT_ROLE_PERMISSIONS.ADMIN).toContain('auth-profile:*');
  });

  it('grants ADMIN guardrail and PII pattern management for project safety configuration', () => {
    expect(TENANT_ROLE_PERMISSIONS.ADMIN).toEqual(
      expect.arrayContaining([
        'guardrail:read',
        'guardrail:write',
        'pii-pattern:read',
        'pii-pattern:write',
      ]),
    );
  });

  it('does not grant the AUDITOR role any write or modification permissions', () => {
    const auditorPermissions = TENANT_ROLE_PERMISSIONS.AUDITOR;
    const writeShaped = auditorPermissions.filter((permission) =>
      /:(write|create|update|delete|decrypt|execute)$/.test(permission),
    );
    expect(writeShaped).toEqual([]);
  });

  it('keeps every explicit built-in role permission inside the custom-role allowlist', () => {
    const builtInPermissions = [
      ...Object.values(TENANT_ROLE_PERMISSIONS).flat(),
      ...Object.values(PROJECT_ROLE_PERMISSIONS).flat(),
    ].filter((permission) => !permission.includes('*'));

    const missingPermissions = [...new Set(builtInPermissions)]
      .filter((permission) => !VALID_CUSTOM_ROLE_PERMISSIONS.includes(permission))
      .sort();

    expect(missingPermissions).toEqual([]);
  });

  it('rejects wildcard permissions for custom roles', () => {
    expect(VALID_CUSTOM_ROLE_PERMISSIONS.filter((permission) => permission.includes('*'))).toEqual(
      [],
    );
    expect(validateCustomRolePermissions(['agent:read', 'simulate:*'])).toEqual({
      valid: false,
      invalid: ['simulate:*'],
    });
  });

  it('allows pii reveal to be assigned only as an explicit custom-role permission', () => {
    expect(SENSITIVE_EXACT_PERMISSIONS).toContain('pii:reveal');
    expect(VALID_CUSTOM_ROLE_PERMISSIONS).toContain('pii:reveal');
    expect(PROJECT_ROLE_PERMISSIONS.admin).not.toContain('pii:reveal');
    expect(TENANT_ROLE_PERMISSIONS.OWNER).not.toContain('pii:reveal');
    expect(TENANT_ROLE_PERMISSIONS.ADMIN).not.toContain('pii:reveal');
    expect(validateCustomRolePermissions(['pii:reveal'])).toEqual({
      valid: true,
      invalid: [],
    });
  });

  it('evaluates built-in project roles through the canonical permission helper', () => {
    expect(evaluateProjectPermission('developer', 'agent:update')).toBe(true);
    expect(evaluateProjectPermission('developer', 'deployment:create')).toBe(false);
    expect(evaluateProjectPermission('viewer', 'project:export')).toBe(true);
  });

  it('normalizes built-in project role names before permission evaluation', () => {
    expect(evaluateProjectPermission(' Developer ', 'agent:update')).toBe(true);
    expect(evaluateProjectPermission(' VIEWER ', 'tool:write')).toBe(false);
  });

  it('evaluates custom project roles from explicit permissions and filters invalid grants', () => {
    expect(
      evaluateProjectPermission('custom', 'agent:read', [
        'agent:read',
        'invalid:permission',
        '*:*',
      ]),
    ).toBe(true);
    expect(
      evaluateProjectPermission('custom', 'agent:delete', [
        'agent:read',
        'invalid:permission',
        '*:*',
      ]),
    ).toBe(false);
    expect(evaluateProjectPermission('custom', 'tool:write', JSON.stringify(['tool:write']))).toBe(
      true,
    );
  });

  it('does not let built-in roles override their canonical permissions with custom inputs', () => {
    expect(evaluateProjectPermission('viewer', 'tool:write', ['tool:write', 'agent:update'])).toBe(
      false,
    );
  });

  it('requires the canonical custom role vocabulary before applying custom permissions', () => {
    expect(evaluateProjectPermission('editor', 'tool:write', ['tool:write'])).toBe(false);
  });

  it('fails closed when custom role permissions are provided as malformed JSON', () => {
    expect(evaluateProjectPermission('custom', 'tool:write', '{"permissions":["tool:write"]')).toBe(
      false,
    );
  });
});
