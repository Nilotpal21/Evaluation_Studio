'use client';

import { useEffect, useState, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  ArrowLeft,
  Download,
  Star,
  Eye,
  CheckCircle2,
  Bot,
  FolderOpen,
  Users as UsersIcon,
  Workflow,
  MessageSquare,
} from 'lucide-react';
import {
  useMarketplaceStore,
  selectSelectedTemplate,
  selectSelectedVersion,
  selectDetailLoading,
  selectDetailError,
} from '@/store/marketplace-store';
import { TemplateTypeBadge } from '@/components/marketplace/TemplateTypeBadge';
import { TemplateScreenshotGallery } from '@/components/marketplace/TemplateScreenshotGallery';
import { DemoConversation } from '@/components/marketplace/DemoConversation';
import { TemplateConfigPreview } from '@/components/marketplace/TemplateConfigPreview';
import { PrerequisitesSection } from '@/components/marketplace/PrerequisitesSection';
import { TopologyTab } from '@/components/marketplace/TopologyTab';
import { InstallButton } from '@/components/marketplace/InstallButton';
import { ProjectInstallDialog } from '@/components/marketplace/ProjectInstallDialog';
import { AgentInstallProjectSelector } from '@/components/marketplace/AgentInstallProjectSelector';
import { AgentInstallPreviewDialog } from '@/components/marketplace/AgentInstallPreviewDialog';
import { Badge } from '@/components/ui/Badge';
import { Tabs } from '@/components/ui/Tabs';
import { Button } from '@/components/ui/Button';
import { Skeleton, SkeletonText } from '@/components/ui/Skeleton';

function formatCount(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(count);
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function TemplateDetailPage() {
  const t = useTranslations('marketplace');
  const params = useParams();
  const router = useRouter();
  const slug = typeof params.slug === 'string' ? params.slug : '';

  const template = useMarketplaceStore(selectSelectedTemplate);
  const version = useMarketplaceStore(selectSelectedVersion);
  const loading = useMarketplaceStore(selectDetailLoading);
  const error = useMarketplaceStore(selectDetailError);
  const fetchTemplateDetail = useMarketplaceStore((s) => s.fetchTemplateDetail);

  const [activeTab, setActiveTab] = useState('overview');

  // Install dialog state
  const [showProjectInstall, setShowProjectInstall] = useState(false);
  const [showProjectSelector, setShowProjectSelector] = useState(false);
  const [showAgentPreview, setShowAgentPreview] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedProjectName, setSelectedProjectName] = useState('');

  useEffect(() => {
    if (slug) {
      fetchTemplateDetail(slug);
    }
  }, [slug, fetchTemplateDetail]);

  const tabs = useMemo(() => {
    if (!template) return [];
    const tabList = [{ id: 'overview', label: t('detail.overview') }];

    tabList.push({ id: 'topology', label: t('topology.title') });

    if (template.media.length > 0) {
      tabList.push({
        id: 'media',
        label: t('media.title'),
      });
    }

    // Always show Demos tab — empty state if no conversations
    tabList.push({
      id: 'demo',
      label: t('detail.demos'),
    });

    if (version?.customizationSchema) {
      tabList.push({
        id: 'configuration',
        label: t('detail.configPreview'),
      });
    }

    return tabList;
  }, [template, version, t]);

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        <Skeleton className="h-6 w-32" />
        <div className="flex items-start gap-4">
          <Skeleton className="w-12 h-12 rounded-xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
        <Skeleton className="h-10 w-full" />
        <SkeletonText lines={6} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
        <div className="rounded-xl border border-error bg-error-subtle p-4">
          <p className="text-sm text-error">{error}</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fetchTemplateDetail(slug)}
            className="mt-2"
          >
            {t('errors.retry')}
          </Button>
        </div>
      </div>
    );
  }

  if (!template) {
    return null;
  }

  const typeMetadata = template.typeMetadata as Record<string, unknown> | null;
  const agentCount =
    typeMetadata && typeof typeMetadata.agentCount === 'number' ? typeMetadata.agentCount : null;
  const hasSupervisor =
    typeMetadata && typeof typeMetadata.hasSupervisor === 'boolean'
      ? typeMetadata.hasSupervisor
      : false;
  const hasFlow =
    typeMetadata && typeof typeMetadata.hasFlow === 'boolean' ? typeMetadata.hasFlow : false;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      {/* Back nav */}
      <button
        onClick={() => router.push('/marketplace')}
        className="flex items-center gap-1.5 text-xs font-medium text-muted hover:text-foreground transition-default"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        {t('nav.templateStore')}
      </button>

      {/* Hero + Sidebar layout */}
      <div className="flex flex-col lg:flex-row gap-6">
        {/* Main content */}
        <div className="flex-1 min-w-0 space-y-6">
          {/* Hero */}
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-background-muted flex items-center justify-center flex-shrink-0">
              {template.type === 'agent' ? (
                <Bot className="w-6 h-6 text-foreground-muted" />
              ) : (
                <FolderOpen className="w-6 h-6 text-foreground-muted" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl font-semibold text-foreground tracking-tight">
                {template.name}
              </h1>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-sm text-muted">
                  {t('detail.publishedBy', { publisher: template.publisherName })}
                </span>
                {template.publisherVerified && (
                  <CheckCircle2 className="w-3.5 h-3.5 text-success" />
                )}
              </div>
              {/* Stats */}
              <div className="flex items-center gap-3 text-sm text-muted mt-1">
                {template.ratingAverage > 0 && (
                  <span className="flex items-center gap-1">
                    <Star className="w-3.5 h-3.5 text-warning fill-warning" />
                    <span>{template.ratingAverage.toFixed(1)}</span>
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <Download className="w-3.5 h-3.5" />
                  <span>{formatCount(template.installCount)}</span>
                </span>
                <span className="flex items-center gap-1">
                  <Eye className="w-3.5 h-3.5" />
                  <span>{t('detail.views', { count: template.viewCount })}</span>
                </span>
              </div>
              {/* Badges */}
              <div className="flex items-center gap-2 mt-2">
                <TemplateTypeBadge type={template.type} size="sm" />
                <Badge variant="default">
                  {t(`categories.${template.category}` as any) ?? template.category}
                </Badge>
                <Badge variant="default">{t(`complexity.${template.complexity}` as any)}</Badge>
              </div>
            </div>
          </div>

          {/* Tabs */}
          {tabs.length > 0 && (
            <Tabs
              tabs={tabs}
              activeTab={activeTab}
              onTabChange={setActiveTab}
              layoutId="template-detail-tabs"
            />
          )}

          {/* Tab content */}
          <div className="animate-fade-in">
            {activeTab === 'overview' && (
              <div className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                {template.longDescription}
              </div>
            )}
            {activeTab === 'topology' && <TopologyTab template={template} version={version} />}
            {activeTab === 'media' && template.media.length > 0 && (
              <TemplateScreenshotGallery media={template.media} />
            )}
            {activeTab === 'demo' &&
              (template.demoConversation.length > 0 ? (
                <DemoConversation messages={template.demoConversation} />
              ) : (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <MessageSquare className="w-10 h-10 text-muted mb-3" />
                  <p className="text-sm font-medium text-foreground">No demos available yet</p>
                  <p className="text-xs text-muted mt-1">
                    Demo conversations will appear here once added by the template author.
                  </p>
                </div>
              ))}
            {activeTab === 'configuration' && version?.customizationSchema && (
              <TemplateConfigPreview schema={version.customizationSchema} />
            )}
          </div>
        </div>

        {/* Sidebar */}
        <div className="w-full lg:w-72 flex-shrink-0 space-y-4">
          {/* Install CTA */}
          <div className="rounded-xl border border-default bg-background-elevated p-4">
            <InstallButton
              template={template}
              version={version}
              onProjectInstall={() => setShowProjectInstall(true)}
              onAgentInstall={() => setShowProjectSelector(true)}
            />
          </div>

          {/* Version & metadata */}
          <div className="rounded-xl border border-default bg-background-elevated p-4 space-y-3">
            {version && (
              <div className="flex justify-between text-sm">
                <span className="text-muted">{t('detail.version', { version: '' }).trim()}</span>
                <span className="text-foreground">{version.version}</span>
              </div>
            )}
            <div className="flex justify-between text-sm">
              <span className="text-muted">
                {t('detail.lastUpdated', { date: '' }).replace(/\s+$/, '')}
              </span>
              <span className="text-foreground">{formatDate(template.updatedAt)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted">{t('filters.complexity')}</span>
              <span className="text-foreground">
                {t(`complexity.${template.complexity}` as any)}
              </span>
            </div>
          </div>

          {/* What's included */}
          {template.type === 'project' && typeMetadata && (
            <div className="rounded-xl border border-default bg-background-elevated p-4 space-y-3">
              <h4 className="text-sm font-medium text-foreground">{t('detail.whatsIncluded')}</h4>
              {agentCount !== null && (
                <div className="flex items-center gap-2 text-sm text-muted">
                  <UsersIcon className="w-3.5 h-3.5" />
                  <span>{t('detail.agentCount', { count: agentCount })}</span>
                </div>
              )}
              {hasSupervisor && (
                <div className="flex items-center gap-2 text-sm text-muted">
                  <Bot className="w-3.5 h-3.5" />
                  <span>{t('detail.supervisor')}</span>
                </div>
              )}
              {hasFlow && (
                <div className="flex items-center gap-2 text-sm text-muted">
                  <Workflow className="w-3.5 h-3.5" />
                  <span>{t('detail.flowBased')}</span>
                </div>
              )}
            </div>
          )}

          {/* Prerequisites */}
          {template.prerequisites && (
            <div className="rounded-xl border border-default bg-background-elevated p-4 space-y-3">
              <h4 className="text-sm font-medium text-foreground">{t('prerequisites.title')}</h4>
              <PrerequisitesSection prerequisites={template.prerequisites} />
            </div>
          )}

          {/* Tags */}
          {template.tags.length > 0 && (
            <div className="rounded-xl border border-default bg-background-elevated p-4">
              <div className="flex flex-wrap gap-1.5">
                {template.tags.map((tag) => (
                  <Badge key={tag} variant="default">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Install Dialogs */}
      {showProjectInstall && version && (
        <ProjectInstallDialog
          open={showProjectInstall}
          onClose={() => setShowProjectInstall(false)}
          template={template}
          version={version}
          onInstallComplete={(projectId) => {
            setShowProjectInstall(false);
            window.location.href = `/projects/${projectId}/agents`;
          }}
        />
      )}

      {showProjectSelector && (
        <AgentInstallProjectSelector
          open={showProjectSelector}
          onClose={() => setShowProjectSelector(false)}
          onProjectSelected={(projectId, projectName) => {
            setSelectedProjectId(projectId);
            setSelectedProjectName(projectName);
            setShowProjectSelector(false);
            setShowAgentPreview(true);
          }}
        />
      )}

      {showAgentPreview && selectedProjectId && version && (
        <AgentInstallPreviewDialog
          open={showAgentPreview}
          onClose={() => setShowAgentPreview(false)}
          template={template}
          version={version}
          projectId={selectedProjectId}
          projectName={selectedProjectName}
          onInstallComplete={() => {
            setShowAgentPreview(false);
          }}
        />
      )}
    </div>
  );
}
