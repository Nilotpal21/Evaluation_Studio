/**
 * Shared HTTP Tool Auth Helpers
 *
 * Small, runtime-agnostic helpers used by both Runtime and Studio when
 * resolving auth-profile-backed HTTP tool configuration.
 */

const CONFIG_VAR_PATTERN = /^\{\{config\.(\w+)\}\}$/;

export interface ConfigVarStoreLike {
  findConfigVar(params: {
    tenantId: string;
    projectId: string;
    key: string;
    variableNamespaceIds?: string[];
  }): Promise<{ value: string } | null>;
}

export interface HttpToolAuthScopeCarrier {
  http_binding?: {
    auth?: {
      config?: {
        oauth?: {
          scopes?: unknown;
        };
      };
    };
  };
}

export function extractRequestedOAuthScopes(tool: HttpToolAuthScopeCarrier): string[] {
  const scopes = tool.http_binding?.auth?.config?.oauth?.scopes;
  if (!Array.isArray(scopes)) {
    return [];
  }

  return Array.from(
    new Set(
      scopes
        .filter((scope): scope is string => typeof scope === 'string')
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0),
    ),
  );
}

export async function resolveAuthProfileRef(
  authProfileRef: string,
  tenantId: string,
  projectId: string,
  configVarStore?: ConfigVarStoreLike,
  variableNamespaceIds?: string[],
): Promise<string | null> {
  const match = authProfileRef.match(CONFIG_VAR_PATTERN);

  if (!match) {
    return authProfileRef;
  }

  if (!configVarStore) {
    return null;
  }

  const configKey = match[1];
  const result = await configVarStore.findConfigVar({
    tenantId,
    projectId,
    key: configKey,
    variableNamespaceIds,
  });

  return result?.value ?? null;
}
