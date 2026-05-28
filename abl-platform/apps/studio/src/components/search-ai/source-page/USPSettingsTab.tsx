'use client';

/**
 * USPSettingsTab — Read-only crawl configuration cards.
 *
 * Displays the source's crawlConfig in organized cards using DS Card component:
 * - Strategy, Scope, Sections, Rendering, Auth, Profile, DangerZone
 * All read-only — editing happens via Recrawl (CrawlFlowV5).
 */

import { useTranslations } from 'next-intl';
import { Globe, Settings, Layers, Shield, Gauge, Trash2, FileText, Monitor } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import type { SearchAISource } from '@/api/search-ai';

interface USPSettingsTabProps {
  source: SearchAISource;
  onDeleteSource: () => void;
}

function ConfigCard({
  title,
  icon,
  children,
  testid,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  testid?: string;
}) {
  return (
    <Card padding="md" hoverable={false} data-testid={testid}>
      <h4 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-3">
        {icon}
        {title}
      </h4>
      <div className="text-sm text-muted space-y-1">{children}</div>
    </Card>
  );
}

function ConfigRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="flex justify-between">
      <span>{label}</span>
      <span className="text-foreground font-medium">{value ?? '\u2014'}</span>
    </div>
  );
}

/** Strategy display names — covers wizard strategies + backend crawl methods */
const STRATEGY_LABELS: Record<string, string> = {
  'guided-discovery': 'Guided Discovery',
  'crawl-sitemap': 'Sitemap Crawl',
  'direct-urls': 'Direct URLs',
  smart: 'Smart Crawl',
  browser: 'Browser Crawl',
  bulk: 'Bulk Crawl',
  hybrid: 'Hybrid Crawl',
  http: 'HTTP Crawl',
  playwright: 'Browser (Playwright)',
  intelligence: 'Intelligence Crawl',
  auto: 'Auto',
};

export function USPSettingsTab({ source, onDeleteSource }: USPSettingsTabProps) {
  const t = useTranslations('search_ai.source_page');
  const config = source.crawlConfig;

  if (!config) {
    return (
      <div className="text-sm text-muted p-8 text-center" data-testid="usp-settings-empty">
        <Settings className="h-8 w-8 mx-auto mb-3 text-muted/50" />
        <p className="font-medium text-foreground mb-1">{t('settings_empty_title')}</p>
        <p>{t('settings_empty_description')}</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4" data-testid="usp-settings-tab">
      {/* Strategy */}
      <ConfigCard
        title={t('settings_strategy')}
        icon={<Globe className="h-4 w-4" />}
        testid="usp-settings-strategy"
      >
        <ConfigRow
          label={t('settings_crawl_strategy')}
          value={STRATEGY_LABELS[config.strategy ?? ''] ?? config.strategy}
        />
        {config.wizardStep && (
          <ConfigRow label={t('settings_wizard_step')} value={config.wizardStep} />
        )}
      </ConfigCard>

      {/* Scope */}
      <ConfigCard
        title={t('settings_scope')}
        icon={<Gauge className="h-4 w-4" />}
        testid="usp-settings-scope"
      >
        {config.settings ? (
          <>
            <ConfigRow label={t('settings_max_pages')} value={config.settings.maxPages} />
            <ConfigRow label={t('settings_max_depth')} value={config.settings.maxDepth} />
            <ConfigRow label={t('settings_scope_label')} value={config.settings.scope} />
            <ConfigRow
              label={t('settings_robots_txt')}
              value={
                config.settings.respectRobotsTxt ? t('settings_respected') : t('settings_ignored')
              }
            />
          </>
        ) : (
          <p className="text-xs text-muted/70 italic">{t('settings_not_configured')}</p>
        )}
      </ConfigCard>

      {/* Sections */}
      {(config.sections?.length ?? 0) > 0 && (
        <ConfigCard
          title={t('settings_sections')}
          icon={<Layers className="h-4 w-4" />}
          testid="usp-settings-sections"
        >
          {(config.sections ?? [])
            .filter((s) => s.included)
            .map((section) => (
              <div key={section.sectionId} className="flex justify-between">
                <span className="truncate mr-2">{section.name || section.pattern}</span>
                <span className="text-foreground font-medium whitespace-nowrap">
                  {t('settings_pages', { count: section.pageCount })}
                </span>
              </div>
            ))}
          {(config.sections ?? []).filter((s) => !s.included).length > 0 && (
            <div className="text-xs text-muted/70 pt-1">
              {t('settings_sections_excluded', {
                count: (config.sections ?? []).filter((s) => !s.included).length,
              })}
            </div>
          )}
        </ConfigCard>
      )}

      {/* Rendering */}
      <ConfigCard
        title={t('settings_rendering')}
        icon={<Monitor className="h-4 w-4" />}
        testid="usp-settings-rendering"
      >
        {(config.groupStrategies?.length ?? 0) > 0 ? (
          (config.groupStrategies ?? []).map((gs, i) => (
            <div key={i} className="flex justify-between">
              <span className="truncate mr-2">{gs.pattern}</span>
              <span className="text-foreground font-medium">{gs.method}</span>
            </div>
          ))
        ) : (
          <p className="text-xs text-muted/70 italic">{t('settings_not_configured')}</p>
        )}
      </ConfigCard>

      {/* Auth */}
      <ConfigCard
        title={t('settings_auth')}
        icon={<Shield className="h-4 w-4" />}
        testid="usp-settings-auth"
      >
        {config.auth?.method ? (
          <>
            <ConfigRow label={t('settings_auth_method')} value={config.auth.method} />
            {/* No credentials shown for security */}
          </>
        ) : (
          <ConfigRow label={t('settings_auth_method')} value={t('settings_none')} />
        )}
      </ConfigCard>

      {/* Profile */}
      <ConfigCard
        title={t('settings_profile')}
        icon={<FileText className="h-4 w-4" />}
        testid="usp-settings-profile"
      >
        {config.profile ? (
          <>
            <ConfigRow label={t('settings_site_type')} value={config.profile.siteType} />
            <ConfigRow
              label={t('settings_sitemap')}
              value={config.profile.hasSitemap ? t('settings_yes') : t('settings_no')}
            />
            <ConfigRow
              label={t('settings_js_required')}
              value={config.profile.jsRequired ? t('settings_yes') : t('settings_no')}
            />
            {config.profile.platform && (
              <ConfigRow label={t('settings_platform')} value={config.profile.platform} />
            )}
            <ConfigRow
              label={t('settings_avg_response')}
              value={`${config.profile.avgResponseTime}ms`}
            />
          </>
        ) : (
          <p className="text-xs text-muted/70 italic">{t('settings_not_configured')}</p>
        )}
      </ConfigCard>

      {/* Danger Zone — compact separator + inline delete */}
      <div className="col-span-full border-t border-default pt-4 mt-2">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted">{t('settings_danger_description')}</p>
          <Button
            variant="ghost"
            size="sm"
            className="text-error hover:text-error hover:bg-error-subtle shrink-0 ml-4"
            onClick={onDeleteSource}
            data-testid="usp-delete-source-btn"
          >
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
            {t('settings_delete_source')}
          </Button>
        </div>
      </div>
    </div>
  );
}
