/**
 * SmartWelcome Component
 *
 * Entity-aware welcome panel for the Arch in-project overlay.
 * Shows project stats and contextual suggestion chips based on the
 * current navigation page/subPage.
 */

import React, { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useNavigationStore } from '@/store/navigation-store';
import { ArchSuggestionChips } from '@/components/arch-shared/ArchSuggestionChips';
import { SECTION_LABEL_CLASS } from '@/lib/typography';
import { ProjectHealthBar, type ProjectHealthData } from './ProjectHealthBar';
import { InProjectSessionResumeCard } from './InProjectSessionResumeCard';
import { WorkflowCards } from './WorkflowCards';
import type { ArchSession } from '@/lib/arch-ai/ui/types';
import type { ArchSuggestion, ProjectSummary } from '@/lib/arch-ai/types/arch';
import type { ResumeSnapshot } from '@agent-platform/arch-ai/types';

interface SmartWelcomeProps {
  projectId: string;
  summary?: ProjectSummary | null;
  onChipSelect: (suggestion: ArchSuggestion) => void;
  healthData?: ProjectHealthData | null;
  healthLoading?: boolean;
  onWorkflowSelect: (prompt: string) => void;
  resumeSession?: ArchSession | null;
  resume?: ResumeSnapshot | null;
  onResumeSession?: () => void;
  onStartNewSession?: () => void;
  resumeActionPending?: boolean;
  resumeError?: string | null;
}

/**
 * Generate contextual suggestion chips based on the current page and subPage.
 */
function generateChips(
  page: string | null,
  subPage: string | null,
  t: (key: string, values?: Record<string, string | number>) => string,
): ArchSuggestion[] {
  if (page === 'agents' && subPage) {
    return [
      {
        id: 'modify-agent',
        label: t('chip_modify', { name: subPage }),
        description: t('chip_modify', { name: subPage }),
        category: 'modify',
        prompt: `Modify agent ${subPage}`,
        icon: 'Wrench',
      },
      {
        id: 'check-agent-health',
        label: t('chip_check_health', { name: subPage }),
        description: t('chip_check_health', { name: subPage }),
        category: 'health',
        prompt: `Check health of agent ${subPage}`,
        icon: 'HeartPulse',
      },
      {
        id: 'view-topology',
        label: t('chip_view_topology'),
        description: t('chip_view_topology'),
        category: 'topology',
        prompt: 'Show the agent topology',
        icon: 'Network',
      },
    ];
  }

  if (page === 'agents') {
    return [
      {
        id: 'review-agents',
        label: t('chip_review_agents'),
        description: t('chip_review_agents'),
        category: 'health',
        prompt: 'Review all agents in this project',
        icon: 'HeartPulse',
      },
      {
        id: 'health-check',
        label: t('chip_health_check'),
        description: t('chip_health_check'),
        category: 'health',
        prompt: 'Run a health check on all agents',
        icon: 'HeartPulse',
      },
      {
        id: 'add-agent',
        label: t('chip_add_agent'),
        description: t('chip_add_agent'),
        category: 'feature',
        prompt: 'Add a new agent to this project',
        icon: 'Sparkles',
      },
    ];
  }

  if (page === 'sessions') {
    return [
      {
        id: 'view-traces',
        label: t('chip_view_recent_traces'),
        description: t('chip_view_recent_traces'),
        category: 'trace',
        prompt: 'Show recent session traces',
        icon: 'Search',
      },
      {
        id: 'health-check',
        label: t('chip_health_check'),
        description: t('chip_health_check'),
        category: 'health',
        prompt: 'Run a health check on all agents',
        icon: 'HeartPulse',
      },
      {
        id: 'run-tests',
        label: t('chip_run_tests'),
        description: t('chip_run_tests'),
        category: 'testing',
        prompt: 'Run tests for this project',
        icon: 'TestTube',
      },
    ];
  }

  if (page === 'tools') {
    return [
      {
        id: 'review-tool-config',
        label: t('chip_review_tool_config'),
        description: t('chip_review_tool_config'),
        category: 'health',
        prompt: 'Review tool configuration',
        icon: 'HeartPulse',
      },
      {
        id: 'review-integrations',
        label: t('chip_review_integrations'),
        description: t('chip_review_integrations'),
        category: 'health',
        prompt: 'Review my integrations',
        icon: 'Plug',
      },
      {
        id: 'add-tool',
        label: t('chip_add_tool'),
        description: t('chip_add_tool'),
        category: 'feature',
        prompt: 'Add a new tool to this project',
        icon: 'Sparkles',
      },
      {
        id: 'health-check',
        label: t('chip_health_check'),
        description: t('chip_health_check'),
        category: 'health',
        prompt: 'Run a health check on all agents',
        icon: 'HeartPulse',
      },
    ];
  }

  // Default chips for any other page
  return [
    {
      id: 'explore-project',
      label: t('chip_explore_project'),
      description: t('chip_explore_project'),
      category: 'feature',
      prompt: 'Explore this project and summarize its current state',
      icon: 'Sparkles',
    },
    {
      id: 'health-check',
      label: t('chip_health_check'),
      description: t('chip_health_check'),
      category: 'health',
      prompt: 'Run a health check on all agents',
      icon: 'HeartPulse',
    },
    {
      id: 'review-integrations',
      label: t('chip_review_integrations'),
      description: t('chip_review_integrations'),
      category: 'health',
      prompt: 'Review my integrations',
      icon: 'Plug',
    },
    {
      id: 'view-topology',
      label: t('chip_view_topology'),
      description: t('chip_view_topology'),
      category: 'topology',
      prompt: 'Show the agent topology',
      icon: 'Network',
    },
  ];
}

export function SmartWelcome({
  projectId,
  summary,
  onChipSelect,
  healthData,
  healthLoading,
  onWorkflowSelect,
  resumeSession,
  resume,
  onResumeSession,
  onStartNewSession,
  resumeActionPending = false,
  resumeError,
}: SmartWelcomeProps) {
  const t = useTranslations('arch_in_project');
  const page = useNavigationStore((s) => s.page);
  const subPage = useNavigationStore((s) => s.subPage);

  const agentCount = summary?.agentCount ?? 0;
  const channelCount = summary?.channelCount ?? 0;

  const chips = useMemo(() => generateChips(page, subPage, t), [page, subPage, t]);

  return (
    <div className="flex flex-col gap-5 py-4" data-project-id={projectId}>
      {/* Greeting */}
      <p className="text-sm text-foreground-muted leading-relaxed">
        {t('welcome_greeting', { agentCount, channelCount })}
      </p>

      {/* Health bar */}
      <ProjectHealthBar
        {...(healthData ?? {
          totalAgents: 0,
          passing: 0,
          warnings: 0,
          errors: 0,
          healthPercent: 0,
          passedChecks: 0,
          totalChecks: 0,
          projectWarnings: 0,
          projectErrors: 0,
          overall: 'Unknown',
          topIssue: null,
        })}
        isLoading={healthLoading}
      />

      {resumeSession && onResumeSession && onStartNewSession ? (
        <InProjectSessionResumeCard
          session={resumeSession}
          resume={resume ?? null}
          onResume={onResumeSession}
          onStartNew={onStartNewSession}
          disabled={resumeActionPending}
          error={resumeError}
        />
      ) : null}

      {/* Workflow cards */}
      <div>
        <p className={`mb-2 ${SECTION_LABEL_CLASS}`}>Workflows</p>
        <WorkflowCards onSelect={onWorkflowSelect} />
      </div>

      {/* Contextual suggestion chips */}
      <ArchSuggestionChips suggestions={chips} onSelect={onChipSelect} />
    </div>
  );
}
