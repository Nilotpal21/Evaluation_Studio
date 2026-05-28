/**
 * CustomDomainGenerator Component
 *
 * LLM-assisted custom domain definition generation from organization profile.
 * Generates complete taxonomy structure with categories, products, and attributes.
 *
 * Part of RFC-001 Phase 3: Domain Auto-Generation
 */

'use client';

import { useState, useCallback } from 'react';
import { clsx } from 'clsx';
import {
  Sparkles,
  Loader2,
  AlertCircle,
  CheckCircle,
  DollarSign,
  XCircle,
  Check,
  Network,
  Package,
  Tag,
  FolderTree,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Checkbox } from '../ui/Checkbox';
import {
  generateCustomDomain,
  saveCustomDomain,
  type OrgProfile,
  type DomainDefinition,
} from '../../api/search-ai';

interface CustomDomainGeneratorProps {
  indexId: string;
  orgProfile: OrgProfile;
  onGenerated?: (domain: DomainDefinition) => void;
  onSaved?: (domainId: string) => void;
  className?: string;
}

interface GenerationResult {
  domain: DomainDefinition;
  cost: number;
  durationMs: number;
  statistics: {
    categoriesCount: number;
    productsCount: number;
    attributesCount: number;
    departmentBoundariesCount: number;
  };
}

export function CustomDomainGenerator({
  indexId,
  orgProfile,
  onGenerated,
  onSaved,
  className,
}: CustomDomainGeneratorProps) {
  const t = useTranslations('search_ai.kg');

  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setAsActive, setSetAsActive] = useState(true);

  const handleGenerate = useCallback(async () => {
    setIsGenerating(true);
    setError(null);
    setResult(null);

    try {
      const response = await generateCustomDomain(indexId, orgProfile);

      setResult({
        domain: response.data.domain,
        cost: response.data.cost,
        durationMs: response.data.metadata.durationMs,
        statistics: response.data.metadata.statistics,
      });

      toast.success(
        t('custom_domain_generated', { domain: response.data.domain.name || 'custom-domain' }),
      );

      if (onGenerated) {
        onGenerated(response.data.domain);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      toast.error(errorMessage);
    } finally {
      setIsGenerating(false);
    }
  }, [indexId, orgProfile, onGenerated, t]);

  const handleSave = useCallback(async () => {
    if (!result) return;

    setIsSaving(true);
    try {
      const response = await saveCustomDomain(indexId, result.domain, setAsActive);

      toast.success(
        setAsActive
          ? t('custom_domain_saved_and_activated', { domain: result.domain.name })
          : t('custom_domain_saved', { domain: result.domain.name }),
      );

      if (onSaved) {
        onSaved(response.data.domainId);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      toast.error(errorMessage);
    } finally {
      setIsSaving(false);
    }
  }, [result, indexId, setAsActive, onSaved, t]);

  const handleReset = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return (
    <Card className={clsx('p-4', className)}>
      <div className="flex items-center gap-2 mb-4">
        <Sparkles className="w-4 h-4 text-accent" />
        <h4 className="text-sm font-semibold">{t('custom_domain_generator_title')}</h4>
        <Badge variant="accent" className="ml-auto text-xs">
          {t('org_profile_llm_powered')}
        </Badge>
      </div>

      <p className="text-xs text-muted mb-4">{t('custom_domain_generator_description')}</p>

      {/* Organization profile summary */}
      <div className="p-3 rounded-lg bg-background-muted border border-default mb-4">
        <div className="space-y-2">
          <div>
            <p className="text-xs font-medium text-muted">{t('org_profile_organization_name')}</p>
            <p className="text-sm">{orgProfile.organizationName}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted">{t('org_profile_industry')}</p>
            <p className="text-sm">{orgProfile.industry}</p>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted">
            <span>
              {orgProfile.keyTerms.length} {t('org_profile_key_terms')}
            </span>
            <span>
              {Object.keys(orgProfile.acronyms).length} {t('org_profile_acronyms')}
            </span>
          </div>
        </div>
      </div>

      {/* Generate button */}
      {!result && (
        <div className="space-y-3">
          {error && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-error/10 border border-error/30">
              <AlertCircle className="w-4 h-4 text-error shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-xs font-medium text-error">{t('common.error')}</p>
                <p className="text-xs text-error/80 mt-1">{error}</p>
              </div>
            </div>
          )}

          <button
            onClick={handleGenerate}
            disabled={isGenerating}
            className={clsx(
              'w-full px-4 py-2.5 text-sm font-medium rounded-md transition-default',
              'bg-accent text-accent-foreground hover:opacity-90',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            {isGenerating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
                {t('custom_domain_generating')}
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 inline mr-2" />
                {t('custom_domain_generate_button')}
              </>
            )}
          </button>

          <p className="text-xs text-muted text-center">{t('custom_domain_cost_estimate')}</p>
        </div>
      )}

      {/* Generated result */}
      {result && (
        <div className="space-y-3">
          <div className="flex items-start gap-2 p-3 rounded-lg bg-success/10 border border-success/30">
            <CheckCircle className="w-4 h-4 text-success shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-xs font-medium text-success">
                {t('custom_domain_generated_title')}
              </p>
              <p className="text-xs text-success/80 mt-1">
                {result.domain.name} v{result.domain.version}
              </p>
            </div>
          </div>

          {/* Cost and duration */}
          <div className="flex items-center gap-3 text-xs text-muted">
            <div className="flex items-center gap-1">
              <DollarSign className="w-3 h-3" />
              <span>${result.cost.toFixed(4)}</span>
            </div>
            <div className="flex items-center gap-1">
              <span>{(result.durationMs / 1000).toFixed(1)}s</span>
            </div>
          </div>

          {/* Domain preview */}
          <div className="p-3 rounded-lg bg-background-muted border border-default">
            <div className="space-y-3">
              <div>
                <p className="text-xs font-medium text-muted mb-1">{t('custom_domain_name')}</p>
                <p className="text-sm font-mono">{result.domain.name}</p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex items-center gap-2 p-2 rounded bg-accent/10 border border-accent/30">
                  <FolderTree className="w-4 h-4 text-accent shrink-0" />
                  <div>
                    <p className="text-xs text-muted">{t('custom_domain_categories')}</p>
                    <p className="text-sm font-semibold">{result.statistics.categoriesCount}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2 p-2 rounded bg-purple/10 border border-purple/30">
                  <Package className="w-4 h-4 text-purple shrink-0" />
                  <div>
                    <p className="text-xs text-muted">{t('custom_domain_products')}</p>
                    <p className="text-sm font-semibold">{result.statistics.productsCount}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2 p-2 rounded bg-info/10 border border-info/30">
                  <Tag className="w-4 h-4 text-info shrink-0" />
                  <div>
                    <p className="text-xs text-muted">{t('custom_domain_attributes')}</p>
                    <p className="text-sm font-semibold">{result.statistics.attributesCount}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2 p-2 rounded bg-warning/10 border border-warning/30">
                  <Network className="w-4 h-4 text-warning shrink-0" />
                  <div>
                    <p className="text-xs text-muted">{t('custom_domain_boundaries')}</p>
                    <p className="text-sm font-semibold">
                      {result.statistics.departmentBoundariesCount}
                    </p>
                  </div>
                </div>
              </div>

              {/* Sample categories */}
              {result.domain.categories.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted mb-1">
                    {t('custom_domain_sample_categories')}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {result.domain.categories.slice(0, 5).map((cat) => (
                      <Badge key={cat.id} variant="accent" className="text-xs">
                        {cat.name}
                      </Badge>
                    ))}
                    {result.domain.categories.length > 5 && (
                      <Badge variant="accent" className="text-xs">
                        +{result.domain.categories.length - 5}
                      </Badge>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Set as active checkbox */}
          <div className="p-3 rounded-lg border border-default hover:bg-background-muted transition-default">
            <Checkbox
              checked={setAsActive}
              onChange={(checked) => setSetAsActive(checked)}
              disabled={isSaving}
              label={t('custom_domain_set_as_active')}
              description={t('custom_domain_set_as_active_help')}
            />
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={isSaving}
              className={clsx(
                'flex-1 px-4 py-2 text-sm font-medium rounded-md transition-default',
                'bg-accent text-accent-foreground hover:opacity-90',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            >
              {isSaving ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
                  {t('custom_domain_saving')}
                </>
              ) : (
                <>
                  <Check className="w-4 h-4 inline mr-2" />
                  {t('custom_domain_save_button')}
                </>
              )}
            </button>
            <button
              onClick={handleReset}
              disabled={isSaving}
              className="px-4 py-2 text-sm font-medium rounded-md border border-default hover:bg-background-muted transition-default disabled:opacity-50"
            >
              <XCircle className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
