'use client';

/**
 * ProposalTab
 *
 * Main proposal tab orchestrating three states:
 * 1. Generating — animated 9-step progress checklist
 * 2. Ready — TOC + section review with Accept/Modify/Skip
 * 3. Approved — read-only summary
 *
 * Uses useConnectorProposal() with automatic polling during generation.
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Download } from 'lucide-react';
import { sanitizeError } from '@/lib/sanitize-error';
import { Button } from '../../ui/Button';
import { Badge } from '../../ui/Badge';
import {
  useConnectorProposal,
  type ProposalSectionData,
} from '../../../hooks/useConnectorProposal';
import {
  acceptProposalSection,
  modifyProposalSection,
  skipProposalSection,
  acceptAllRemainingSections,
  abandonProposal,
  rerunProposalHealthCheck,
  disableProposalPermissions,
  exportProposal,
} from '../../../api/search-ai';
import { ProposalGenerationProgress } from './ProposalGenerationProgress';
import { ProposalSection } from './ProposalSection';
import { ProposalHealthCheckSection } from './ProposalHealthCheckSection';
import { ProposalScheduleSection } from './ProposalScheduleSection';
import { ProposalPermissionsSection } from './ProposalPermissionsSection';

interface ProposalTabProps {
  indexId: string;
  connectorId: string;
  simplifiedView: boolean;
  onNavigateToTab: (tab: string) => void;
}

/** The reviewable section IDs in priority order.
 * Scope and Filters moved to the Scope+Filters tab.
 * Connection, sample-preview, security-gate removed. */
const SECTION_ORDER = ['health-check', 'permissions', 'schedule'] as const;

type SectionId = (typeof SECTION_ORDER)[number];

function getSectionStatus(
  sections: Record<string, ProposalSectionData>,
  sectionId: string,
): ProposalSectionData['status'] {
  return sections[sectionId]?.status ?? 'pending';
}

export function ProposalTab({
  indexId,
  connectorId,
  simplifiedView,
  onNavigateToTab,
}: ProposalTabProps) {
  const t = useTranslations('search_ai.sharepoint.proposal');
  const { proposal, isLoading, mutate } = useConnectorProposal(indexId, connectorId, {
    pollWhileGenerating: true,
  });

  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(SECTION_ORDER));
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Auto-accept sections whose data shows they are already complete.
  // Runs once when the proposal transitions to 'ready'.
  const hasAutoAcceptedRef = useRef(false);
  useEffect(() => {
    if (!proposal || proposal.status !== 'ready' || hasAutoAcceptedRef.current) return;
    const sections = proposal.sections ?? {};
    const pendingSections = SECTION_ORDER.filter(
      (id) => (sections[id]?.status ?? 'pending') === 'pending',
    );
    if (pendingSections.length === 0) return;

    // Determine which sections can be auto-accepted based on their data
    const autoAcceptable = pendingSections.filter((id) => {
      const data = (sections[id]?.data ?? {}) as Record<string, unknown>;
      switch (id) {
        case 'health-check': {
          // Auto-accept if all checks pass
          const checks = (data.checks ?? []) as Array<{ status: string }>;
          return checks.length > 0 && checks.every((c) => c.status === 'pass');
        }
        case 'schedule':
          // Auto-accept if frequency is set
          return Boolean(data.frequency);
        case 'permissions':
          // Auto-accept if mode is set
          return Boolean(data.mode);
        default:
          return false;
      }
    });

    if (autoAcceptable.length > 0) {
      hasAutoAcceptedRef.current = true;
      // Accept all auto-acceptable sections in parallel
      Promise.all(
        autoAcceptable.map((sectionId) =>
          acceptProposalSection(indexId, connectorId, sectionId).catch(() => {
            // Ignore errors — user can still manually accept
          }),
        ),
      ).then(() => mutate());
    }
  }, [proposal, indexId, connectorId, mutate]);

  // Section label map
  const sectionLabels = useMemo(
    () => ({
      'health-check': t('section_health_check'),
      permissions: t('section_permissions'),
      schedule: t('section_schedule'),
    }),
    [t],
  );

  // Progress tracking
  const sections = proposal?.sections ?? {};
  const reviewedCount = useMemo(() => {
    return SECTION_ORDER.filter((id) => getSectionStatus(sections, id) !== 'pending').length;
  }, [sections]);

  // Toggle section expand
  const toggleSection = useCallback((sectionId: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
      }
      return next;
    });
  }, []);

  // Section actions
  const handleAccept = useCallback(
    async (sectionId: string) => {
      setActionLoading(sectionId);
      try {
        await acceptProposalSection(indexId, connectorId, sectionId);
        mutate();
      } catch (err: unknown) {
        toast.error(sanitizeError(err, t('action_error')));
      } finally {
        setActionLoading(null);
      }
    },
    [indexId, connectorId, mutate, t],
  );

  const handleModify = useCallback(
    async (sectionId: string, data: Record<string, unknown>) => {
      setActionLoading(sectionId);
      try {
        await modifyProposalSection(indexId, connectorId, sectionId, data);
        mutate();
      } catch (err: unknown) {
        toast.error(sanitizeError(err, t('action_error')));
      } finally {
        setActionLoading(null);
      }
    },
    [indexId, connectorId, mutate, t],
  );

  const handleSkip = useCallback(
    async (sectionId: string) => {
      setActionLoading(sectionId);
      try {
        await skipProposalSection(indexId, connectorId, sectionId);
        mutate();
      } catch (err: unknown) {
        toast.error(sanitizeError(err, t('action_error')));
      } finally {
        setActionLoading(null);
      }
    },
    [indexId, connectorId, mutate, t],
  );

  const handleAcceptAll = useCallback(async () => {
    setActionLoading('accept-all');
    try {
      await acceptAllRemainingSections(indexId, connectorId);
      mutate();
    } catch (err: unknown) {
      toast.error(sanitizeError(err, t('action_error')));
    } finally {
      setActionLoading(null);
    }
  }, [indexId, connectorId, mutate, t]);

  const handleAbandon = useCallback(async () => {
    setActionLoading('abandon');
    try {
      await abandonProposal(indexId, connectorId);
      mutate();
      toast.success(t('abandoned_success'));
    } catch (err: unknown) {
      toast.error(sanitizeError(err, t('action_error')));
    } finally {
      setActionLoading(null);
    }
  }, [indexId, connectorId, mutate, t]);

  const handleRerunHealthCheck = useCallback(async () => {
    setActionLoading('health-check');
    try {
      await rerunProposalHealthCheck(indexId, connectorId);
      mutate();
    } catch (err: unknown) {
      toast.error(sanitizeError(err, t('action_error')));
    } finally {
      setActionLoading(null);
    }
  }, [indexId, connectorId, mutate, t]);

  const handleDisablePermissions = useCallback(
    async (confirmationText: string) => {
      setActionLoading('permissions');
      try {
        await disableProposalPermissions(indexId, connectorId, confirmationText);
        mutate();
      } catch (err: unknown) {
        toast.error(sanitizeError(err, t('action_error')));
      } finally {
        setActionLoading(null);
      }
    },
    [indexId, connectorId, mutate, t],
  );

  const handleExport = useCallback(
    async (format: 'json' | 'yaml') => {
      try {
        const blob = await exportProposal(indexId, connectorId, format);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `proposal-${connectorId}.${format}`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err: unknown) {
        toast.error(sanitizeError(err, t('export_error')));
      }
    },
    [indexId, connectorId, t],
  );

  // Badge component for section status
  const statusBadge = useCallback(
    (status: ProposalSectionData['status']) => {
      const config: Record<
        ProposalSectionData['status'],
        { variant: 'success' | 'accent' | 'default' | 'warning'; label: string }
      > = {
        accepted: { variant: 'success', label: t('badge_accepted') },
        modified: { variant: 'accent', label: t('badge_modified') },
        pending: { variant: 'default', label: t('badge_pending') },
        skipped: { variant: 'warning', label: t('badge_skipped') },
      };
      const c = config[status];
      return <Badge variant={c.variant}>{c.label}</Badge>;
    },
    [t],
  );

  // Build section actions
  const buildActions = useCallback(
    (sectionId: SectionId) => {
      const status = getSectionStatus(sections, sectionId);
      const isApproved = proposal?.status === 'approved';
      if (isApproved) return [];

      const loading = actionLoading === sectionId;
      const actions: Array<{
        label: string;
        variant: 'primary' | 'secondary' | 'ghost';
        onClick: () => void;
        disabled?: boolean;
        loading?: boolean;
      }> = [];

      // Special actions per section
      if (sectionId === 'health-check') {
        actions.push({
          label: t('btn_re_run'),
          variant: 'ghost',
          onClick: () => void handleRerunHealthCheck(),
          disabled: loading,
          loading,
        });
      }

      if (status === 'pending') {
        actions.push({
          label: t('btn_accept'),
          variant: 'primary',
          onClick: () => void handleAccept(sectionId),
          disabled: loading,
          loading,
        });
        actions.push({
          label: t('btn_skip'),
          variant: 'ghost',
          onClick: () => void handleSkip(sectionId),
          disabled: loading,
        });
      }

      return actions;
    },
    [
      sections,
      proposal?.status,
      actionLoading,
      handleAccept,
      handleSkip,
      handleRerunHealthCheck,
      t,
    ],
  );

  // Render section content
  const renderSectionContent = useCallback(
    (sectionId: SectionId) => {
      const data = (sections[sectionId]?.data ?? {}) as Record<string, unknown>;

      switch (sectionId) {
        case 'health-check':
          return (
            <ProposalHealthCheckSection
              checks={
                (data.checks as Array<{
                  name: string;
                  status: 'pass' | 'fail' | 'warn' | 'warning';
                  detail?: string;
                }>) ?? []
              }
              labels={{
                connectivity: t('health_connectivity'),
                token_validity: t('health_token_validity'),
                scope_coverage: t('health_scope_coverage'),
                status_pass: t('health_pass'),
                status_fail: t('health_fail'),
              }}
            />
          );

        case 'schedule':
          return (
            <ProposalScheduleSection
              frequency={String(data.frequency ?? 'daily')}
              recommendedFrequency={String(data.recommendedFrequency ?? 'daily')}
              nextRun={(data.nextRun as string) ?? null}
              simplifiedView={simplifiedView}
              onModify={(modified) => void handleModify(sectionId, modified)}
              labels={{
                frequency_label: t('schedule_frequency'),
                recommended_label: t('schedule_recommended'),
                next_run_label: t('schedule_next_run'),
                not_scheduled: t('schedule_not_scheduled'),
                save_changes: t('schedule_save_changes'),
                frequency_hourly: t('schedule_hourly'),
                frequency_daily: t('schedule_daily'),
                frequency_weekly: t('schedule_weekly'),
                frequency_monthly: t('schedule_monthly'),
              }}
            />
          );

        case 'permissions':
          return (
            <ProposalPermissionsSection
              mode={String(data.mode ?? 'enabled')}
              permissionAwareEnabled={(data.permissionAwareEnabled as boolean) ?? true}
              reducedAccuracy={(data.reducedAccuracy as boolean) ?? false}
              warning={(data.warning as string) ?? null}
              onDisablePermissions={handleDisablePermissions}
              disableLoading={actionLoading === 'permissions'}
              labels={{
                mode_label: t('permissions_mode'),
                mode_enabled: t('permissions_enabled'),
                mode_disabled: t('permissions_disabled'),
                permission_aware_label: t('permissions_aware_label'),
                enabled: t('permissions_enabled'),
                disabled: t('permissions_disabled'),
                reduced_accuracy_warning: t('permissions_reduced_accuracy'),
                disable_link: t('permissions_disable_link'),
                disable_warning: t('permissions_disable_warning'),
                disable_confirm_text: 'public access',
                disable_consequences: [
                  t('permissions_disable_consequence_1'),
                  t('permissions_disable_consequence_2'),
                ],
                cancel: t('btn_cancel'),
                confirm_disable: t('permissions_confirm_disable'),
                trust_note: t('trust_note'),
              }}
            />
          );

        default:
          return null;
      }
    },
    [sections, simplifiedView, handleModify, handleDisablePermissions, actionLoading, t],
  );

  // Loading state — show skeleton cards
  if (isLoading && !proposal) {
    return (
      <div className="p-6 space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-default p-4 animate-pulse">
            <div className="h-4 w-1/3 bg-background-muted rounded mb-3" />
            <div className="h-3 w-2/3 bg-background-muted rounded mb-2" />
            <div className="h-3 w-1/2 bg-background-muted rounded" />
          </div>
        ))}
      </div>
    );
  }

  // No proposal
  if (!proposal) {
    return (
      <div className="p-6 text-center">
        <p className="text-sm text-muted">{t('no_proposal')}</p>
      </div>
    );
  }

  // Generating state
  if (proposal.status === 'generating') {
    return <ProposalGenerationProgress steps={proposal.generationSteps} />;
  }

  // Failed state
  if (proposal.status === 'failed') {
    return (
      <div className="p-6 text-center space-y-4">
        <Badge variant="error" dot>
          {t('generation_failed')}
        </Badge>
        <p className="text-sm text-muted">{t('generation_failed_description')}</p>
      </div>
    );
  }

  // Abandoned state
  if (proposal.status === 'abandoned') {
    return (
      <div className="p-6 text-center space-y-4">
        <Badge variant="warning" dot>
          {t('abandoned')}
        </Badge>
      </div>
    );
  }

  const isApproved = proposal.status === 'approved';
  const hasPendingSections = SECTION_ORDER.some(
    (id) => getSectionStatus(sections, id) === 'pending',
  );

  // Ready / Approved state
  return (
    <div className="p-6 space-y-6">
      {/* Progress indicator */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">
          {t('progress_label', {
            reviewed: reviewedCount,
            total: SECTION_ORDER.length,
          })}
        </p>
      </div>

      {/* Sections */}
      <div className="space-y-3">
        {SECTION_ORDER.map((sectionId) => (
          <ProposalSection
            key={sectionId}
            sectionId={sectionId}
            title={sectionLabels[sectionId]}
            badge={statusBadge(getSectionStatus(sections, sectionId))}
            expanded={expandedSections.has(sectionId)}
            onToggle={() => toggleSection(sectionId)}
            actions={buildActions(sectionId)}
          >
            {renderSectionContent(sectionId)}
          </ProposalSection>
        ))}
      </div>

      {/* Bottom actions */}
      {!isApproved && (
        <div className="flex items-center justify-between pt-4 border-t border-default">
          <div className="flex items-center gap-2">
            <Button
              variant="danger"
              size="sm"
              onClick={() => void handleAbandon()}
              disabled={actionLoading === 'abandon'}
              loading={actionLoading === 'abandon'}
            >
              {t('btn_abandon')}
            </Button>

            {/* Export */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleExport('json')}
              icon={<Download className="w-3.5 h-3.5" />}
            >
              {t('export_json')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleExport('yaml')}
              icon={<Download className="w-3.5 h-3.5" />}
            >
              {t('export_yaml')}
            </Button>
          </div>

          <div className="flex items-center gap-2">
            {/* Accept all remaining */}
            {hasPendingSections && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleAcceptAll()}
                disabled={actionLoading === 'accept-all'}
                loading={actionLoading === 'accept-all'}
              >
                {t('accept_all')}
              </Button>
            )}

            {/* Navigate to Scope+Filters once all sections reviewed */}
            {!hasPendingSections && (
              <Button variant="primary" size="sm" onClick={() => onNavigateToTab('scope-filters')}>
                {t('continue_to_scope')}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
