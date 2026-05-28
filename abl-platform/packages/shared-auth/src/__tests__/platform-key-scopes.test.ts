import { afterEach, describe, expect, it, vi } from 'vitest';
import { VALID_CUSTOM_ROLE_PERMISSIONS } from '../rbac/index.js';
import {
  PLATFORM_KEY_SCOPES,
  PLATFORM_KEY_SCOPE_KEYS,
  checkScopeCeiling,
  expandScopesToPermissions,
} from '../scopes/index.js';

describe('platform key scope registry', () => {
  it('UT-5: exposes the expected 14 scopes across 5 categories', () => {
    expect(PLATFORM_KEY_SCOPE_KEYS).toHaveLength(14);
    expect(PLATFORM_KEY_SCOPE_KEYS).toEqual([
      'workflows.execute',
      'workflows.read',
      'chat.execute',
      'agents.read',
      'agents.write',
      'deployments.read',
      'deployments.write',
      'sessions.read',
      'search.query',
      'search.read',
      'search.ingest',
      'search.permission_write',
      'analytics.read',
      'tenant.read',
    ]);

    const categories = new Set(Object.values(PLATFORM_KEY_SCOPES).map((entry) => entry.category));
    expect(categories).toEqual(
      new Set(['execution', 'management', 'knowledge_base', 'analytics', 'admin']),
    );

    const validPermissionSet = new Set(VALID_CUSTOM_ROLE_PERMISSIONS);
    for (const entry of Object.values(PLATFORM_KEY_SCOPES)) {
      for (const permission of entry.requiredPermissions) {
        expect(validPermissionSet.has(permission)).toBe(true);
      }
    }
  });

  it('UT-6: groups scopes under the expected categories', () => {
    const grouped = Object.entries(PLATFORM_KEY_SCOPES).reduce<Record<string, string[]>>(
      (acc, [scope, entry]) => {
        const current = acc[entry.category] ?? [];
        current.push(scope);
        acc[entry.category] = current;
        return acc;
      },
      {},
    );

    expect(grouped.execution).toEqual(['workflows.execute', 'workflows.read', 'chat.execute']);
    expect(grouped.management).toEqual([
      'agents.read',
      'agents.write',
      'deployments.read',
      'deployments.write',
      'sessions.read',
    ]);
    expect(grouped.knowledge_base).toEqual([
      'search.query',
      'search.read',
      'search.ingest',
      'search.permission_write',
    ]);
    expect(grouped.analytics).toEqual(['analytics.read']);
    expect(grouped.admin).toEqual(['tenant.read']);
  });
});

describe('checkScopeCeiling', () => {
  it('UT-7: allows and denies scope grants based on the tenant role ceiling', () => {
    expect(checkScopeCeiling(['agents.write'], 'VIEWER')).toEqual({
      allowed: false,
      denied: ['agents.write'],
    });
    expect(checkScopeCeiling(['workflows.execute'], 'OPERATOR')).toEqual({ allowed: true });
    expect(checkScopeCeiling(['workflows.execute'], 'MEMBER')).toEqual({
      allowed: false,
      denied: ['workflows.execute'],
    });
    expect(checkScopeCeiling(['chat.execute'], 'ADMIN')).toEqual({
      allowed: false,
      denied: ['chat.execute'],
    });
    expect(checkScopeCeiling(['sessions.read'], 'ADMIN')).toEqual({
      allowed: false,
      denied: ['sessions.read'],
    });
    expect(checkScopeCeiling(['analytics.read'], 'ADMIN')).toEqual({
      allowed: false,
      denied: ['analytics.read'],
    });
    expect(
      checkScopeCeiling(
        ['workflows.execute', 'chat.execute', 'agents.write', 'analytics.read'],
        'OWNER',
      ),
    ).toEqual({ allowed: true });
  });
});

describe('expandScopesToPermissions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('UT-8: expands dot-separated registry scopes', () => {
    expect(expandScopesToPermissions(['workflows.execute'])).toEqual([
      'workflow:read',
      'workflow:execute',
    ]);
  });

  it('passes through legacy colon-separated permissions', () => {
    expect(expandScopesToPermissions(['workflow:execute'])).toEqual(['workflow:execute']);
  });

  it('skips unknown non-legacy scopes and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(expandScopesToPermissions(['unknown.scope'])).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      '[platform-key-scopes] Unknown scope skipped during expansion',
      { scope: 'unknown.scope' },
    );
  });

  it('handles mixed dot and colon scopes', () => {
    expect(expandScopesToPermissions(['agents.read', 'workflow:execute'])).toEqual([
      'agent:read',
      'workflow:execute',
    ]);
  });

  it('deduplicates overlapping permissions', () => {
    expect(expandScopesToPermissions(['agents.write', 'agents.read'])).toEqual([
      'agent:read',
      'agent:create',
      'agent:update',
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(expandScopesToPermissions([])).toEqual([]);
  });
});
