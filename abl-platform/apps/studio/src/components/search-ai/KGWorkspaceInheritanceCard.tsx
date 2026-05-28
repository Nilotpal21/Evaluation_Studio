/**
 * KGWorkspaceInheritanceCard Component
 *
 * Shows existing Knowledge Graph configuration from sibling indexes
 * in the same workspace/project. Allows user to inherit the same
 * model configuration for consistency.
 */

'use client';

import { CheckCircle, Sparkles, ChevronRight, Calendar } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';

/**
 * Format date as relative time (e.g., "2 hours ago")
 */
function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) {
    return 'just now';
  } else if (diffMinutes < 60) {
    return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;
  } else if (diffHours < 24) {
    return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  } else if (diffDays < 30) {
    return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  } else {
    return date.toLocaleDateString();
  }
}

interface ConfiguredIndex {
  indexId: string;
  knowledgeBaseName: string;
  model: {
    id: string;
    displayName: string;
    provider: string;
    tier: string;
  } | null;
  configuredAt: string;
}

interface WorkspaceRecommendation {
  action: string;
  message: string;
}

interface KGWorkspaceInheritanceCardProps {
  configuredIndexes: ConfiguredIndex[];
  recommendation: WorkspaceRecommendation;
  onInherit: (modelId: string, inheritedFrom: string) => void;
  onChooseDifferent: () => void;
  isConfiguring?: boolean;
}

/**
 * Get provider display color
 */
function getProviderColor(provider: string): string {
  const p = provider.toLowerCase();
  if (p === 'anthropic') return 'bg-purple';
  if (p === 'openai') return 'bg-success';
  return 'bg-accent';
}

export function KGWorkspaceInheritanceCard({
  configuredIndexes,
  recommendation,
  onInherit,
  onChooseDifferent,
  isConfiguring = false,
}: KGWorkspaceInheritanceCardProps) {
  const t = useTranslations('knowledgeGraph');

  // Use the first (most recent) configured index as the primary recommendation
  const primaryConfig = configuredIndexes[0];
  const hasModel = primaryConfig?.model !== null;

  const handleInherit = () => {
    if (primaryConfig?.model) {
      onInherit(primaryConfig.model.id, primaryConfig.indexId);
    }
  };

  return (
    <Card className="p-6">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <CheckCircle className="h-5 w-5 text-success" />
        <h3 className="text-lg font-semibold text-foreground">
          {t('workspace_kg_configured', {
            defaultValue: 'Knowledge Graph Already Configured in Workspace',
          })}
        </h3>
      </div>

      <p className="text-sm text-muted mb-6">
        {t('workspace_kg_description', {
          defaultValue:
            'Another knowledge base in this workspace is using Knowledge Graph. You can use the same model for consistency.',
        })}
      </p>

      {/* Existing Configuration Card */}
      <div className="bg-background-muted rounded-lg p-4 mb-6 border border-border">
        <div className="flex items-start justify-between mb-3">
          <div>
            <p className="text-sm font-medium text-foreground mb-1">
              {primaryConfig.knowledgeBaseName}
            </p>
            <div className="flex items-center gap-2 text-xs text-muted">
              <Calendar className="h-3 w-3" />
              <span>
                {t('configured_time', { defaultValue: 'Configured' })}{' '}
                {formatRelativeTime(new Date(primaryConfig.configuredAt))}
              </span>
            </div>
          </div>
          <Badge variant="success">{t('active', { defaultValue: 'Active' })}</Badge>
        </div>

        {hasModel && primaryConfig.model && (
          <div className="flex items-center gap-2 pt-3 border-t border-border">
            <Sparkles className="h-4 w-4 text-accent" />
            <span className="text-sm font-medium text-foreground">
              {primaryConfig.model.displayName}
            </span>
            <Badge variant="default">
              <div
                className={`w-2 h-2 rounded-full mr-1 ${getProviderColor(primaryConfig.model.provider)}`}
              />
              {primaryConfig.model.provider}
            </Badge>
          </div>
        )}

        {!hasModel && (
          <div className="pt-3 border-t border-border">
            <p className="text-xs text-muted">
              {t('model_not_available', { defaultValue: 'Model information not available' })}
            </p>
          </div>
        )}
      </div>

      {/* Recommendation Banner */}
      <div className="bg-accent/10 border border-accent/20 rounded-lg p-4 mb-6">
        <div className="flex items-start gap-2">
          <Sparkles className="h-4 w-4 text-accent mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-accent mb-1">
              {t('recommended', { defaultValue: '💡 Recommended' })}
            </p>
            <p className="text-xs text-muted">{recommendation.message}</p>
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex gap-3">
        <Button
          onClick={handleInherit}
          disabled={!hasModel || isConfiguring}
          variant="primary"
          size="md"
          className="flex-1"
        >
          {isConfiguring ? (
            <>
              <div className="h-4 w-4 mr-2 border-2 border-current border-t-transparent rounded-full animate-spin" />
              {t('configuring', { defaultValue: 'Configuring...' })}
            </>
          ) : (
            <>
              {t('use_same_model', { defaultValue: 'Use Same Model' })}
              <ChevronRight className="h-4 w-4 ml-2" />
            </>
          )}
        </Button>

        <Button onClick={onChooseDifferent} disabled={isConfiguring} variant="secondary" size="md">
          {t('choose_different', { defaultValue: 'Choose Different' })}
        </Button>
      </div>

      {/* Additional Info */}
      {configuredIndexes.length > 1 && (
        <div className="mt-4 pt-4 border-t border-border">
          <p className="text-xs text-muted">
            {t('multiple_configs', {
              defaultValue: `+${configuredIndexes.length - 1} other knowledge base(s) in this workspace also using Knowledge Graph`,
              count: configuredIndexes.length - 1,
            })}
          </p>
        </div>
      )}
    </Card>
  );
}
