import { describe, test, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { mintWorkflowAuthToken, WORKFLOW_AUTH_TOKEN_SUB } from '../workflow-auth-token.js';

const TEST_SECRET = '1'.repeat(64);

describe('mintWorkflowAuthToken', () => {
  test('subject is the stable service identifier, never a session principal', () => {
    expect(WORKFLOW_AUTH_TOKEN_SUB).toBe('service:runtime');
    const token = mintWorkflowAuthToken({
      secret: TEST_SECRET,
      tenantId: 'tenant-abc',
      projectId: 'proj-xyz',
    });
    const decoded = jwt.verify(token, TEST_SECRET) as Record<string, unknown>;
    expect(decoded.sub).toBe('service:runtime');
  });

  test('carries tenantId, projectId, role=OWNER, internal=true, type=access', () => {
    const token = mintWorkflowAuthToken({
      secret: TEST_SECRET,
      tenantId: 'tenant-abc',
      projectId: 'proj-xyz',
    });
    const decoded = jwt.verify(token, TEST_SECRET) as Record<string, unknown>;
    expect(decoded.tenantId).toBe('tenant-abc');
    expect(decoded.projectId).toBe('proj-xyz');
    expect(decoded.role).toBe('OWNER');
    expect(decoded.internal).toBe(true);
    expect(decoded.type).toBe('access');
    expect(decoded.tokenClass).toBe('user');
  });

  test('projectId claim is omitted when not provided', () => {
    const token = mintWorkflowAuthToken({ secret: TEST_SECRET, tenantId: 'tenant-abc' });
    const decoded = jwt.verify(token, TEST_SECRET) as Record<string, unknown>;
    expect(decoded.projectId).toBeUndefined();
    expect(decoded.tenantId).toBe('tenant-abc');
  });

  test('token signed with one secret is rejected by another', () => {
    const token = mintWorkflowAuthToken({ secret: TEST_SECRET, tenantId: 'tenant-abc' });
    expect(() => jwt.verify(token, '0'.repeat(64))).toThrow();
  });
});
