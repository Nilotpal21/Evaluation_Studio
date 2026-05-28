/**
 * KBOverviewTab Component
 *
 * Stats grid, configuration card, and actions (rebuild, delete) for a knowledge base.
 */

import { useState, useMemo } from 'react';
import { FileText, Layers, FolderInput, Cpu, RefreshCw, Trash2, BookOpen } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { rebuildKnowledgeBase, deleteKnowledgeBase } from '../../api/search-ai';
import { useNavigationStore } from '../../store/navigation-store';
import { toast } from 'sonner';
import type { KnowledgeBaseDetail } from '../../api/search-ai';

/**
 * Derive the KB tool name from a slug, matching the backend toolNameFromSlug logic.
 */
function deriveKBToolName(slug: string): string {
  const sanitized = slug
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return `search_kb_${sanitized}`.slice(0, 64).replace(/_$/, '');
}

interface KBOverviewTabProps {
  knowledgeBase: KnowledgeBaseDetail;
  onRefresh: () => void;
}

export function KBOverviewTab({ knowledgeBase, onRefresh }: KBOverviewTabProps) {
  const t = useTranslations('search_ai.overview_tab');
  const { projectId, navigate } = useNavigationStore();
  const [rebuilding, setRebuilding] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleRebuild = async () => {
    setRebuilding(true);
    try {
      await rebuildKnowledgeBase(knowledgeBase._id);
      onRefresh();
      toast.success(t('toast_rebuild_started'));
    } catch {
      toast.error(t('toast_rebuild_failed'));
    } finally {
      setRebuilding(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteKnowledgeBase(knowledgeBase._id);
      toast.success(t('toast_deleted'));
      if (projectId) {
        navigate(`/projects/${projectId}/search`);
      }
    } catch {
      toast.error(t('toast_delete_failed'));
    } finally {
      setDeleting(false);
      setDeleteOpen(false);
    }
  };

  const index = knowledgeBase.index;

  const stats = useMemo(
    () => [
      {
        label: t('stat_documents'),
        value: knowledgeBase.documentCount.toLocaleString(),
        icon: <FileText className="w-4 h-4" />,
      },
      {
        label: t('stat_chunks'),
        value: index?.chunkCount?.toLocaleString() ?? '0',
        icon: <Layers className="w-4 h-4" />,
      },
      {
        label: t('stat_connectors'),
        value: knowledgeBase.connectorCount,
        icon: <FolderInput className="w-4 h-4" />,
      },
      {
        label: t('stat_embedding_model'),
        value: index?.embeddingModel ?? '—',
        icon: <Cpu className="w-4 h-4" />,
      },
    ],
    [t, knowledgeBase.documentCount, knowledgeBase.connectorCount, index],
  );

  return (
    <div className="space-y-6">
      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat) => (
          <Card key={stat.label} hoverable={false} padding="md">
            <div className="flex items-center gap-2 text-muted mb-1">
              {stat.icon}
              <span className="text-xs font-medium uppercase tracking-wider">{stat.label}</span>
            </div>
            <div className="text-lg font-semibold text-foreground truncate">{stat.value}</div>
          </Card>
        ))}
      </div>

      {/* Configuration (from linked index) */}
      {index && (
        <Card hoverable={false} padding="lg">
          <h3 className="text-sm font-semibold text-foreground mb-4">{t('configuration')}</h3>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted">{t('chunk_strategy')}</span>
              <div className="text-foreground font-medium mt-0.5">
                {index.tokenChunkStrategy
                  ? `Token-based: ${index.tokenChunkStrategy.method} (${index.tokenChunkStrategy.chunkSize}/${index.tokenChunkStrategy.chunkOverlap})`
                  : 'Auto'}
              </div>
            </div>
            <div>
              <span className="text-muted">{t('vector_store')}</span>
              <div className="text-foreground font-medium mt-0.5">
                {index.vectorStore.provider} — {index.vectorStore.collectionName}
              </div>
            </div>
            <div>
              <span className="text-muted">{t('embedding_dimensions')}</span>
              <div className="text-foreground font-medium mt-0.5">{index.embeddingDimensions}</div>
            </div>
            <div>
              <span className="text-muted">{t('search_defaults')}</span>
              <div className="text-foreground font-medium mt-0.5">
                {t('search_defaults_value', {
                  topK: index.searchDefaults.topK,
                  threshold: index.searchDefaults.similarityThreshold,
                })}
              </div>
            </div>
            {knowledgeBase.lastIndexedAt && (
              <div>
                <span className="text-muted">{t('last_indexed')}</span>
                <div className="text-foreground font-medium mt-0.5">
                  {new Date(knowledgeBase.lastIndexedAt).toLocaleString()}
                </div>
              </div>
            )}
            {knowledgeBase.indexError && (
              <div className="col-span-2">
                <span className="text-error">{t('index_error')}</span>
                <div className="text-error text-xs mt-0.5 font-mono bg-error-subtle p-2 rounded">
                  {knowledgeBase.indexError}
                </div>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Agent Tool */}
      <Card hoverable={false} padding="lg">
        <h3 className="text-sm font-semibold text-foreground mb-3">{t('agent_tool')}</h3>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-success" />
            <code className="text-sm font-mono text-foreground">
              {deriveKBToolName(knowledgeBase.index?.slug ?? knowledgeBase.name)}
            </code>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (projectId) navigate(`/projects/${projectId}/tools?tab=searchai`);
            }}
          >
            {t('view_in_tools')}
          </Button>
        </div>
        <p className="text-xs text-foreground-muted mt-2">{t('agent_tool_description')}</p>
      </Card>

      {/* Actions */}
      <Card hoverable={false} padding="lg">
        <h3 className="text-sm font-semibold text-foreground mb-4">{t('actions')}</h3>
        <div className="flex gap-3">
          <Button
            variant="secondary"
            icon={<RefreshCw className="w-4 h-4" />}
            loading={rebuilding}
            onClick={handleRebuild}
          >
            {t('rebuild')}
          </Button>
          <Button
            variant="danger"
            icon={<Trash2 className="w-4 h-4" />}
            onClick={() => setDeleteOpen(true)}
          >
            {t('delete_kb')}
          </Button>
        </div>
      </Card>

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDelete}
        title={t('delete_confirm_title')}
        description={t('delete_confirm_description', { name: knowledgeBase.name })}
        confirmLabel={t('delete_confirm_label')}
        variant="danger"
        loading={deleting}
      />
    </div>
  );
}
