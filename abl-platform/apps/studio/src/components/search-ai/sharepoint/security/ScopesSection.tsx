/**
 * ScopesSection Component
 *
 * Displays granted OAuth scopes with descriptions, granted dates,
 * and expandable "Why we need this" justification per scope.
 * Also shows "Permissions NOT Requested" section as a trust signal.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Shield, ChevronDown, ChevronRight, XCircle } from 'lucide-react';
import { Badge } from '../../../ui/Badge';
import type { SecurityOverview } from '../../../../hooks/useSecurityOverview';
import { SHAREPOINT_PERMISSION_MANIFEST } from '../sharepoint-permission-manifest';

interface ScopesSectionProps {
  scopes: SecurityOverview['grantedScopes'];
}

/** Look up justification from the manifest for a given scope name. */
function findJustification(scopeName: string) {
  const allScopes = [
    ...SHAREPOINT_PERMISSION_MANIFEST.requiredScopes,
    ...SHAREPOINT_PERMISSION_MANIFEST.conditionalScopes,
  ];
  return allScopes.find((s) => s.scope === scopeName);
}

export function ScopesSection({ scopes }: ScopesSectionProps) {
  const t = useTranslations('search_ai.sharepoint.security');
  const [expandedScope, setExpandedScope] = useState<string | null>(null);

  const notRequested = SHAREPOINT_PERMISSION_MANIFEST.notRequestedScopes;

  return (
    <div className="space-y-4">
      {/* Granted scopes */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Shield className="w-4 h-4 text-muted" />
          {t('scopes_title')}
        </h3>
        {scopes.length === 0 ? (
          <p className="text-sm text-muted">{t('scopes_none')}</p>
        ) : (
          <div className="space-y-2">
            {scopes.map((scope) => {
              const justification = findJustification(scope.scope);
              const isExpanded = expandedScope === scope.scope;

              return (
                <div key={scope.scope} className="p-3 rounded-lg bg-background-subtle">
                  <div className="flex items-start justify-between">
                    <div>
                      <Badge variant="info">{scope.scope}</Badge>
                      <p className="text-xs text-muted mt-1">{scope.description}</p>
                    </div>
                    {scope.grantedAt && (
                      <span className="text-xs text-muted shrink-0">
                        {new Date(scope.grantedAt).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </span>
                    )}
                  </div>

                  {/* Expandable justification */}
                  {justification && (
                    <div className="mt-2">
                      <button
                        type="button"
                        onClick={() => setExpandedScope(isExpanded ? null : scope.scope)}
                        className="text-xs text-accent hover:text-accent/80 transition-default flex items-center gap-1"
                      >
                        {isExpanded ? (
                          <ChevronDown className="w-3 h-3" />
                        ) : (
                          <ChevronRight className="w-3 h-3" />
                        )}
                        {t('scopes_why_label')}
                      </button>
                      {isExpanded && (
                        <div className="mt-2 pl-4 space-y-1 text-xs text-muted border-l-2 border-accent/20">
                          <p>
                            <span className="font-medium text-foreground">
                              {t('scopes_why_reason')}:
                            </span>{' '}
                            {justification.why}
                          </p>
                          <p>
                            <span className="font-medium text-foreground">
                              {t('scopes_why_used_for')}:
                            </span>{' '}
                            {justification.usedFor}
                          </p>
                          <p>
                            <span className="font-medium text-foreground">
                              {t('scopes_why_cannot')}:
                            </span>{' '}
                            {justification.cannotDo}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Permissions NOT requested */}
      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-muted uppercase tracking-wider">
          {t('scopes_not_requested_title')}
        </h4>
        <div className="space-y-1">
          {notRequested.map((nr) => (
            <div key={nr.scope} className="flex items-center gap-2 text-xs text-muted">
              <XCircle className="w-3 h-3 shrink-0 opacity-50" />
              <span>
                <code className="text-foreground/60">{nr.scope}</code> — {nr.reason}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
