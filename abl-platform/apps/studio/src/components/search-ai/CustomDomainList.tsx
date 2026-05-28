/**
 * CustomDomainList Component
 *
 * Lists saved custom domain definitions with actions to view details or delete.
 * Part of RFC-001 Phase 3: Domain Auto-Generation
 */

'use client';

import { useState, useCallback, useEffect } from 'react';
import { clsx } from 'clsx';
import {
  Network,
  Trash2,
  Eye,
  Loader2,
  FolderTree,
  Package,
  Tag,
  Calendar,
  AlertCircle,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { listCustomDomains, deleteCustomDomain } from '../../api/search-ai';

interface CustomDomainListProps {
  indexId: string;
  onViewDomain?: (domainId: string) => void;
  className?: string;
}

interface CustomDomainSummary {
  _id: string;
  name: string;
  version: string;
  industry: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  categoriesCount: number;
  productsCount: number;
  attributesCount: number;
}

export function CustomDomainList({ indexId, onViewDomain, className }: CustomDomainListProps) {
  const t = useTranslations('search_ai.kg');

  const [domains, setDomains] = useState<CustomDomainSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadDomains = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await listCustomDomains(indexId);
      setDomains(response.data.domains);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      toast.error(errorMessage);
    } finally {
      setIsLoading(false);
    }
  }, [indexId]);

  useEffect(() => {
    loadDomains();
  }, [loadDomains]);

  const handleDelete = useCallback(
    async (domainId: string, domainName: string) => {
      if (!confirm(t('custom_domain_delete_confirm', { name: domainName }))) {
        return;
      }

      setDeletingId(domainId);
      try {
        await deleteCustomDomain(indexId, domainId);
        toast.success(t('custom_domain_deleted', { name: domainName }));
        // Reload the list
        await loadDomains();
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        toast.error(errorMessage);
      } finally {
        setDeletingId(null);
      }
    },
    [indexId, loadDomains, t],
  );

  if (isLoading) {
    return (
      <Card className={clsx('p-6 flex items-center justify-center', className)}>
        <Loader2 className="w-5 h-5 animate-spin text-muted" />
      </Card>
    );
  }

  if (error) {
    return (
      <Card className={clsx('p-4', className)}>
        <div className="flex items-start gap-2 p-3 rounded-lg bg-error/10 border border-error/30">
          <AlertCircle className="w-4 h-4 text-error shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-xs font-medium text-error">{t('common.error')}</p>
            <p className="text-xs text-error/80 mt-1">{error}</p>
          </div>
        </div>
      </Card>
    );
  }

  if (domains.length === 0) {
    return (
      <Card className={clsx('p-6 text-center', className)}>
        <Network className="w-8 h-8 text-muted mx-auto mb-2" />
        <p className="text-sm text-muted">{t('custom_domain_list_empty')}</p>
        <p className="text-xs text-muted mt-1">{t('custom_domain_list_empty_help')}</p>
      </Card>
    );
  }

  return (
    <Card className={clsx('p-4', className)}>
      <div className="flex items-center gap-2 mb-4">
        <Network className="w-4 h-4 text-foreground" />
        <h4 className="text-sm font-semibold">{t('custom_domain_list_title')}</h4>
        <Badge variant="default" className="ml-auto text-xs">
          {domains.length}
        </Badge>
      </div>

      <div className="space-y-2">
        {domains.map((domain) => (
          <div
            key={domain._id}
            className="p-3 rounded-lg border border-default hover:bg-background-muted transition-default"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <p className="text-sm font-medium font-mono truncate">{domain.name}</p>
                  <Badge variant="default" className="text-xs shrink-0">
                    v{domain.version}
                  </Badge>
                </div>

                <p className="text-xs text-muted mb-2">{domain.industry}</p>

                <div className="flex items-center gap-3 text-xs text-muted">
                  <div className="flex items-center gap-1">
                    <FolderTree className="w-3 h-3" />
                    <span>{domain.categoriesCount}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Package className="w-3 h-3" />
                    <span>{domain.productsCount}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Tag className="w-3 h-3" />
                    <span>{domain.attributesCount}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Calendar className="w-3 h-3" />
                    <span>{new Date(domain.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                {onViewDomain && (
                  <button
                    onClick={() => onViewDomain(domain._id)}
                    className="p-2 rounded-md hover:bg-background-muted transition-default"
                    title={t('custom_domain_view')}
                  >
                    <Eye className="w-4 h-4 text-muted hover:text-foreground" />
                  </button>
                )}
                <button
                  onClick={() => handleDelete(domain._id, domain.name)}
                  disabled={deletingId === domain._id}
                  className="p-2 rounded-md hover:bg-error/10 transition-default disabled:opacity-50"
                  title={t('custom_domain_delete')}
                >
                  {deletingId === domain._id ? (
                    <Loader2 className="w-4 h-4 animate-spin text-error" />
                  ) : (
                    <Trash2 className="w-4 h-4 text-muted hover:text-error" />
                  )}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
