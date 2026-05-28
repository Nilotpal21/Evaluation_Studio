import { getPermissionCeiling, hasPermission } from '../rbac/index.js';
import { PLATFORM_KEY_SCOPES, type ScopeEntry } from './platform-key-scopes.js';

export type ScopeCeilingResult = { allowed: true } | { allowed: false; denied: string[] };
type PlatformKeyScopeName = keyof typeof PLATFORM_KEY_SCOPES;

// @abl/compiler/platform is not a dependency of shared-auth yet, so keep the
// unknown-scope warning local to this package until logging is standardized.
function warnUnknownScope(scope: string): void {
  console.warn('[platform-key-scopes] Unknown scope skipped during expansion', { scope });
}

function getScopeEntry(scope: string): ScopeEntry | undefined {
  return Object.prototype.hasOwnProperty.call(PLATFORM_KEY_SCOPES, scope)
    ? PLATFORM_KEY_SCOPES[scope as PlatformKeyScopeName]
    : undefined;
}

export function checkScopeCeiling(
  requestedScopes: string[],
  creatorTenantRole: string,
): ScopeCeilingResult {
  const ceiling = getPermissionCeiling(creatorTenantRole);
  const denied = new Set<string>();

  for (const scope of requestedScopes) {
    const entry = getScopeEntry(scope);
    if (!entry) {
      denied.add(scope);
      continue;
    }

    for (const permission of entry.requiredPermissions) {
      if (!hasPermission(ceiling, permission)) {
        denied.add(scope);
        break;
      }
    }
  }

  return denied.size === 0 ? { allowed: true } : { allowed: false, denied: [...denied] };
}

export function expandScopesToPermissions(scopes: string[]): string[] {
  const permissions = new Set<string>();

  for (const scope of scopes) {
    const entry = getScopeEntry(scope);
    if (entry) {
      for (const permission of entry.requiredPermissions) {
        permissions.add(permission);
      }
      continue;
    }

    if (scope.includes(':')) {
      permissions.add(scope);
      continue;
    }

    warnUnknownScope(scope);
  }

  return [...permissions];
}

export function validateRegistryScopes(scopes: string[]): { valid: boolean; invalid: string[] } {
  const invalid = [...new Set(scopes.filter((scope) => !getScopeEntry(scope)))];
  return { valid: invalid.length === 0, invalid };
}
