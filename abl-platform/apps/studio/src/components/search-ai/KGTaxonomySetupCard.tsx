/**
 * KGTaxonomySetupCard Component
 *
 * Three-step inline flow for taxonomy setup:
 * 1. Domain Selection — grid of domain cards
 * 2. Configuration — optional org profile + confirm
 * 3. Progress — poll setup job status
 */

'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { clsx } from 'clsx';
import {
  Landmark,
  HeartPulse,
  Cpu,
  Factory,
  ShoppingBag,
  ArrowLeft,
  CheckCircle,
  AlertCircle,
  Loader2,
  Network,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { useKGDomains, useKGSetupJobStatus } from '../../hooks/useKnowledgeGraph';
import {
  setupTaxonomy,
  getKGDomainDetails,
  listCustomDomains,
  getCustomDomain,
} from '../../api/search-ai';
import type { DomainSummary, DomainDefinition, OrgProfile } from '../../api/search-ai';
import { OrgProfileGenerator } from './OrgProfileGenerator';
import { CustomDomainGenerator } from './CustomDomainGenerator';
import { CustomDomainList } from './CustomDomainList';

interface KGTaxonomySetupCardProps {
  indexId: string;
  onComplete: () => void;
  autoConfigureModelId?: string;
}

type SetupStep = 'domain-selection' | 'configure' | 'progress';

interface ParsedProduct {
  id: string;
  name?: string;
}

interface ParsedOrganizationProfile {
  organizationName?: string;
  products?: ParsedProduct[];
}

const DOMAIN_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  'financial-services': Landmark,
  healthcare: HeartPulse,
  technology: Cpu,
  manufacturing: Factory,
  retail: ShoppingBag,
};

/**
 * Generate a smart template with all domain products as commented options
 */
function generateOrgProfileTemplate(domain: DomainDefinition): string {
  const productLines = domain.products.map((product) => {
    return `    // { "id": "${product.id}", "name": "${product.name}" },`;
  });

  return `{
  "organizationName": "Your Company Name",
  "products": [
    // Select the products you offer (uncomment to include):
${productLines.join('\n')}
  ]
}`;
}

export function KGTaxonomySetupCard({
  indexId,
  onComplete,
  autoConfigureModelId,
}: KGTaxonomySetupCardProps) {
  const t = useTranslations('search_ai.kg');

  const [step, setStep] = useState<SetupStep>('domain-selection');
  const [selectedDomain, setSelectedDomain] = useState<DomainSummary | null>(null);
  const [domainDetails, setDomainDetails] = useState<DomainDefinition | null>(null);
  const [isLoadingDomain, setIsLoadingDomain] = useState(false);
  const [orgProfileJson, setOrgProfileJson] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);

  // Guided mode state
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [selectedProducts, setSelectedProducts] = useState<Set<string>>(new Set());
  const [llmGeneratedProfile, setLlmGeneratedProfile] = useState<OrgProfile | null>(null);
  const [showLlmGenerator, setShowLlmGenerator] = useState(false);

  // Custom domain workflow state
  const [showCustomDomainFlow, setShowCustomDomainFlow] = useState(false);
  const [customDomainOrgProfile, setCustomDomainOrgProfile] = useState<OrgProfile | null>(null);
  const [showCustomDomainGenerator, setShowCustomDomainGenerator] = useState(false);

  // Handle LLM-generated profile
  const handleProfileGenerated = useCallback(
    (profile: OrgProfile) => {
      setLlmGeneratedProfile(profile);
      setOrgName(profile.organizationName);
      // Collapse LLM generator after successful generation
      setShowLlmGenerator(false);
      toast.success(t('org_profile_accepted'));
    },
    [t],
  );

  // Handle custom domain org profile generated
  const handleCustomDomainOrgProfileGenerated = useCallback((profile: OrgProfile) => {
    setCustomDomainOrgProfile(profile);
    setShowCustomDomainGenerator(true);
  }, []);

  // Handle custom domain generated and saved
  const handleCustomDomainSaved = useCallback((_domainId: string) => {
    // Reset to show the saved domains list within the custom domain flow
    setCustomDomainOrgProfile(null);
    setShowCustomDomainGenerator(false);
    // Keep showCustomDomainFlow=true so CustomDomainList renders
  }, []);

  // Helper: Toggle product selection
  const toggleProduct = useCallback((productId: string) => {
    setSelectedProducts((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) {
        next.delete(productId);
      } else {
        next.add(productId);
      }
      return next;
    });
  }, []);

  // Helper: Generate JSON from orgName + selectedProducts
  const generateJsonFromSelection = useCallback(() => {
    if (!domainDetails) return '';

    const selectedProductObjs = Array.from(selectedProducts)
      .map((productId) => {
        const product = domainDetails.products.find((p) => p.id === productId);
        return product ? { id: product.id, name: product.name } : null;
      })
      .filter((p) => p !== null);

    const profile = {
      organizationName: orgName || 'Your Company Name',
      products: selectedProductObjs,
    };

    return JSON.stringify(profile, null, 2);
  }, [domainDetails, orgName, selectedProducts]);

  // Type guard for product validation
  const isValidProduct = (item: ReturnType<typeof JSON.parse>): item is ParsedProduct => {
    return typeof item === 'object' && item !== null && 'id' in item && typeof item.id === 'string';
  };

  // Validate and extract organization profile from parsed JSON
  const validateOrganizationProfile = (
    value: ReturnType<typeof JSON.parse>,
  ): ParsedOrganizationProfile | null => {
    if (typeof value !== 'object' || value === null) {
      return null;
    }

    const result: ParsedOrganizationProfile = {};

    // Validate organizationName
    if ('organizationName' in value && typeof value.organizationName === 'string') {
      result.organizationName = value.organizationName;
    }

    // Validate products array
    if ('products' in value && Array.isArray(value.products)) {
      result.products = value.products.filter(isValidProduct);
    }

    return result;
  };

  // Helper: Parse JSON back into orgName + selectedProducts
  const parseJsonToSelection = useCallback((json: string) => {
    try {
      const parsed = JSON.parse(json);
      const profile = validateOrganizationProfile(parsed);

      if (!profile) {
        return;
      }

      // Extract organization name
      if (profile.organizationName) {
        setOrgName(
          profile.organizationName === 'Your Company Name' ? '' : profile.organizationName,
        );
      }

      // Extract product IDs
      if (profile.products) {
        const productIds = profile.products.map((p) => p.id);
        setSelectedProducts(new Set(productIds));
      }
    } catch {
      // Invalid JSON, ignore
    }
  }, []);

  // Fetch available built-in domains
  const { domains, isLoading: domainsLoading } = useKGDomains();

  // Fetch custom (tenant-saved) domains for this index
  const [customDomains, setCustomDomains] = useState<DomainSummary[]>([]);
  const [customDomainsLoading, setCustomDomainsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setCustomDomainsLoading(true);
    listCustomDomains(indexId)
      .then((res) => {
        if (cancelled) return;
        setCustomDomains(
          res.data.domains.map((d) => ({
            id: d._id,
            name: d.name,
            version: d.version,
            categoriesCount: d.categoriesCount,
            productsCount: d.productsCount,
            attributesCount: d.attributesCount,
          })),
        );
      })
      .catch(() => {
        /* non-critical — built-in domains still available */
      })
      .finally(() => {
        if (!cancelled) setCustomDomainsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [indexId, showCustomDomainFlow]);

  // Merge built-in + custom domains for the grid
  const allDomains = [...(domains ?? []), ...customDomains];
  const allDomainsLoading = domainsLoading || customDomainsLoading;

  // Track which domain IDs are custom (for routing to the right API)
  const customDomainIds = customDomains.map((d) => d.id);

  // Poll job status when we have a jobId
  const { status: jobStatus } = useKGSetupJobStatus(indexId, jobId);

  // Guard: fire completion exactly once (SWR revalidation, focus, reconnect
  // would otherwise re-trigger the effect with the same COMPLETED status).
  const completedRef = useRef(false);

  // Handle job completion
  useEffect(() => {
    if (jobStatus?.status === 'COMPLETED' && step === 'progress' && !completedRef.current) {
      completedRef.current = true;
      toast.success(t('setup_complete'));
      // Add a small delay to ensure backend data is committed before refreshing
      setTimeout(() => {
        onComplete();
      }, 500);
    }
  }, [jobStatus?.status, step, onComplete, t]);

  const handleDomainSelect = async (domain: DomainSummary) => {
    setSelectedDomain(domain);
    setIsLoadingDomain(true);

    try {
      // Fetch full domain details — custom domains use a different API
      const isCustom = customDomainIds.includes(domain.id);
      const details = isCustom
        ? (await getCustomDomain(indexId, domain.id)).data.domain
        : await getKGDomainDetails(domain.id);
      setDomainDetails(details);

      // Generate smart template with all products as commented options
      const template = generateOrgProfileTemplate(details);
      setOrgProfileJson(template);

      // Initialize guided mode with empty selections
      setOrgName('');
      setSelectedProducts(new Set());
      setShowAdvanced(false);

      setStep('configure');
    } catch (error) {
      toast.error(t('setup_failed_description'));
    } finally {
      setIsLoadingDomain(false);
    }
  };

  const handleBack = () => {
    setStep('domain-selection');
    setSelectedDomain(null);
    setDomainDetails(null);
    setOrgProfileJson('');
    setOrgName('');
    setSelectedProducts(new Set());
    setShowAdvanced(false);
  };

  const handleModeToggle = () => {
    if (showAdvanced) {
      // Switching from Advanced to Guided: parse JSON
      parseJsonToSelection(orgProfileJson);
    } else {
      // Switching from Guided to Advanced: generate JSON
      const json = generateJsonFromSelection();
      setOrgProfileJson(json);
    }
    setShowAdvanced(!showAdvanced);
  };

  const handleSetup = async () => {
    if (!selectedDomain) return;

    setIsSubmitting(true);
    try {
      let organizationProfile: any;

      // Priority: LLM-generated profile > Manual input
      if (llmGeneratedProfile) {
        // Use LLM-generated profile directly (already validated by API)
        organizationProfile = llmGeneratedProfile;
      } else {
        // Fall back to manual input (guided or advanced mode)
        const jsonToUse = showAdvanced ? orgProfileJson : generateJsonFromSelection();

        if (jsonToUse.trim()) {
          try {
            organizationProfile = JSON.parse(jsonToUse);
          } catch {
            toast.error(t('setup_failed_description'));
            setIsSubmitting(false);
            return;
          }
        }
      }

      const result = await setupTaxonomy(indexId, {
        domain: selectedDomain.id,
        organizationProfile,
        autoConfigureModelId,
      });

      setJobId(result.jobId);
      setStep('progress');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // If taxonomy already exists (created via prior attempt / race condition),
      // treat as success and call onComplete so the parent refreshes state.
      if (msg.includes('already exists')) {
        toast.success(t('setup_complete'));
        onComplete();
      } else {
        toast.error(msg);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Step 1: Domain Selection ──────────────────────────────────────────
  if (step === 'domain-selection') {
    // Custom domain creation flow
    if (showCustomDomainFlow) {
      return (
        <div className="py-8">
          <div className="max-w-2xl mx-auto">
            <button
              onClick={() => {
                setShowCustomDomainFlow(false);
                setCustomDomainOrgProfile(null);
                setShowCustomDomainGenerator(false);
              }}
              className="flex items-center gap-2 text-sm text-muted hover:text-foreground transition-default mb-6"
            >
              <ArrowLeft className="w-4 h-4" />
              {t('setup_back')}
            </button>

            <div className="space-y-4">
              {/* Step 1: Generate org profile */}
              {!customDomainOrgProfile && (
                <OrgProfileGenerator
                  indexId={indexId}
                  onGenerated={handleCustomDomainOrgProfileGenerated}
                />
              )}

              {/* Step 2: Generate custom domain from profile */}
              {customDomainOrgProfile && showCustomDomainGenerator && (
                <CustomDomainGenerator
                  indexId={indexId}
                  orgProfile={customDomainOrgProfile}
                  onSaved={handleCustomDomainSaved}
                />
              )}

              {/* Step 3: View saved domains */}
              {!customDomainOrgProfile && (
                <>
                  <div className="text-center py-6">
                    <p className="text-sm text-muted">{t('custom_domain_list_empty_help')}</p>
                  </div>
                  <CustomDomainList indexId={indexId} />
                </>
              )}
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="py-8">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-8">
            <h3 className="text-lg font-semibold mb-2">{t('setup_title')}</h3>
            <p className="text-sm text-muted">{t('setup_select_domain_description')}</p>
          </div>

          {allDomainsLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {[...Array(5)].map((_, i) => (
                <Card key={i} className="p-6">
                  <div className="skeleton h-24 w-full" />
                </Card>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {allDomains.map((domain) => {
                const isCustom = customDomainIds.includes(domain.id);
                const Icon = isCustom ? Network : DOMAIN_ICONS[domain.id] || Landmark;
                return (
                  <button
                    key={domain.id}
                    onClick={() => handleDomainSelect(domain)}
                    className="text-left"
                  >
                    <Card
                      className={clsx(
                        'p-6 transition-default hover:shadow-lg hover:-translate-y-0.5',
                        'border-2 border-transparent hover:border-accent',
                      )}
                    >
                      <div className="flex items-start gap-3 mb-3">
                        <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center shrink-0">
                          <Icon className="w-5 h-5 text-accent" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <h4 className="text-sm font-semibold">{domain.name}</h4>
                            {isCustom && (
                              <Badge variant="accent" className="text-xs">
                                Custom
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted">v{domain.version}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="default">
                          {t('setup_domain_products', { count: domain.productsCount })}
                        </Badge>
                        <Badge variant="default">
                          {t('setup_domain_attributes', { count: domain.attributesCount })}
                        </Badge>
                      </div>
                    </Card>
                  </button>
                );
              })}
            </div>
          )}

          {/* Create custom domain button */}
          <div className="mt-8 text-center">
            <button
              onClick={() => setShowCustomDomainFlow(true)}
              className="inline-flex items-center gap-2 px-6 py-3 text-sm font-medium rounded-lg border-2 border-dashed border-default hover:border-accent hover:bg-accent/5 transition-default"
            >
              <Network className="w-4 h-4" />
              {t('custom_domain_create_button')}
            </button>
            <p className="text-xs text-muted mt-2">{t('custom_domain_create_help')}</p>
          </div>
        </div>
      </div>
    );
  }

  // ── Step 2: Configure ─────────────────────────────────────────────────
  if (step === 'configure' && selectedDomain) {
    const Icon = DOMAIN_ICONS[selectedDomain.id] || Landmark;
    return (
      <div className="py-8">
        <div className="max-w-lg mx-auto">
          <button
            onClick={handleBack}
            className="flex items-center gap-2 text-sm text-muted hover:text-foreground transition-default mb-6"
          >
            <ArrowLeft className="w-4 h-4" />
            {t('setup_back')}
          </button>

          <Card className="p-6">
            <h3 className="text-lg font-semibold mb-4">{t('setup_configure')}</h3>

            {/* Selected domain summary */}
            <div className="flex items-center gap-3 p-3 rounded-lg bg-background-muted mb-6">
              <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center shrink-0">
                <Icon className="w-4 h-4 text-accent" />
              </div>
              <div>
                <p className="text-sm font-medium">{selectedDomain.name}</p>
                <p className="text-xs text-muted">
                  {selectedDomain.productsCount} products, {selectedDomain.attributesCount}{' '}
                  attributes
                </p>
              </div>
            </div>

            {/* LLM-Assisted Profile Generation (Optional) */}
            <div className="mb-6">
              <button
                type="button"
                onClick={() => setShowLlmGenerator(!showLlmGenerator)}
                className="flex items-center gap-2 text-sm font-medium text-info hover:opacity-80 transition-default mb-3"
              >
                {showLlmGenerator ? (
                  <CheckCircle className="w-4 h-4" />
                ) : (
                  <AlertCircle className="w-4 h-4" />
                )}
                {showLlmGenerator
                  ? t('org_profile_generator_hide')
                  : t('org_profile_generator_title')}
              </button>

              {showLlmGenerator && (
                <OrgProfileGenerator
                  indexId={indexId}
                  onGenerated={handleProfileGenerated}
                  className="mb-4"
                />
              )}
            </div>

            {/* Organization name */}
            <div className="mb-6">
              <label className="block text-sm font-medium mb-3">
                {t('setup_org_name_label')}
                <span className="text-xs text-muted ml-2">({t('common.optional')})</span>
              </label>
              <input
                type="text"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder={t('setup_org_name_placeholder')}
                className="w-full px-3 py-2 text-sm rounded-md border border-default bg-background focus:border-border-focus focus:outline-none transition-default"
                disabled={isLoadingDomain}
              />
            </div>

            {/* Product selection with mode toggle */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <label className="block text-sm font-medium">
                  {t('setup_products_label')}
                  <span className="text-xs text-muted ml-2">({t('common.optional')})</span>
                </label>
                <button
                  onClick={handleModeToggle}
                  className="text-xs text-muted hover:text-foreground transition-default"
                  type="button"
                >
                  {showAdvanced ? t('show_guided') : t('show_advanced')}
                </button>
              </div>

              {!showAdvanced && domainDetails ? (
                // Guided mode: chip selection grouped by category
                <div className="space-y-4">
                  {domainDetails.categories.map((category) => {
                    const categoryProducts = domainDetails.products.filter(
                      (p) => p.categoryId === category.id,
                    );
                    if (categoryProducts.length === 0) return null;

                    return (
                      <div key={category.id}>
                        <p className="text-xs font-medium text-muted mb-2">{category.name}</p>
                        <div className="flex flex-wrap gap-2">
                          {categoryProducts.map((product) => (
                            <button
                              key={product.id}
                              type="button"
                              onClick={() => toggleProduct(product.id)}
                              className={clsx(
                                'px-3 py-1.5 text-xs rounded-full border transition-default',
                                'hover:shadow-sm hover:-translate-y-0.5',
                                selectedProducts.has(product.id)
                                  ? 'bg-accent text-accent-foreground border-accent'
                                  : 'bg-background border-default hover:border-accent/50',
                              )}
                            >
                              {product.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                // Advanced mode: direct JSON editing
                <textarea
                  value={orgProfileJson}
                  onChange={(e) => setOrgProfileJson(e.target.value)}
                  placeholder={t('setup_org_profile_placeholder')}
                  rows={10}
                  className="w-full px-3 py-2 text-sm font-mono rounded-md border border-default bg-background focus:border-border-focus focus:outline-none transition-default resize-y"
                  disabled={isLoadingDomain}
                />
              )}

              <p className="text-xs text-muted mt-2">
                {!showAdvanced
                  ? t('setup_products_help_guided')
                  : t('setup_products_help_advanced')}
              </p>
            </div>

            {/* Submit button */}
            <button
              onClick={handleSetup}
              disabled={isSubmitting}
              className={clsx(
                'w-full px-4 py-2.5 text-sm font-medium rounded-md transition-default',
                'bg-accent text-accent-foreground hover:opacity-90',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            >
              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> : null}
              {t('setup_start_button')}
            </button>
          </Card>
        </div>
      </div>
    );
  }

  // ── Step 3: Progress ──────────────────────────────────────────────────
  if (step === 'progress') {
    const progress = jobStatus?.progress ?? 0;
    const isFailed = jobStatus?.status === 'FAILED';

    return (
      <div className="py-12 flex justify-center">
        <Card className="max-w-md w-full p-8">
          <div className="flex flex-col items-center text-center">
            {isFailed ? (
              <>
                <div className="w-12 h-12 rounded-xl bg-error/10 flex items-center justify-center mb-4">
                  <AlertCircle className="w-6 h-6 text-error" />
                </div>
                <h3 className="text-lg font-semibold mb-2">{t('setup_failed')}</h3>
                <p className="text-sm text-muted mb-4">
                  {jobStatus?.error || t('setup_failed_description')}
                </p>
                <button
                  onClick={handleBack}
                  className="px-4 py-2 text-sm font-medium rounded-md bg-accent text-accent-foreground hover:opacity-90 transition-default"
                >
                  {t('setup_retry')}
                </button>
              </>
            ) : (
              <>
                <div className="w-12 h-12 rounded-xl bg-accent/10 flex items-center justify-center mb-4">
                  <Loader2 className="w-6 h-6 text-accent animate-spin" />
                </div>
                <h3 className="text-lg font-semibold mb-2">{t('setup_progress_title')}</h3>
                <p className="text-sm text-muted mb-6">{t('setup_progress_description')}</p>

                {/* Progress bar */}
                <div className="w-full h-2 bg-background-muted rounded-full overflow-hidden mb-2">
                  <div
                    className="h-full bg-accent rounded-full transition-all duration-500"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <p className="text-xs text-muted">{progress}%</p>
              </>
            )}
          </div>
        </Card>
      </div>
    );
  }

  return null;
}
