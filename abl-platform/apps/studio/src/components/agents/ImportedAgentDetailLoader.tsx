'use client';

/**
 * ImportedAgentDetailLoader
 *
 * Full-page read-only detail view for an imported agent.
 * Finds the matching agent from useImportedSymbols() and renders
 * identity, tools, handoffs, delegates, and runtime metadata.
 */

import { useMemo } from 'react';
import { Bot, Package, Lock, Wrench, ArrowRightLeft, Copy, Users, Workflow } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Badge } from '../ui/Badge';
import { DetailPageShell } from '../ui/DetailPageShell';
import { ReadOnlySection } from '../ui/ReadOnlySection';
import type { ImportedAgent } from '../../hooks/useImportedSymbols';
import { useImportedSymbols } from '../../hooks/useImportedSymbols';

interface ImportedAgentDetailLoaderProps {
  alias: string;
  agentName: string;
  onBack: () => void;
}

// ---------------------------------------------------------------------------
// Chip list for tools / handoffs / delegates
// ---------------------------------------------------------------------------

function ChipList({ items, emptyText }: { items: string[] | undefined; emptyText: string }) {
  if (!items || items.length === 0) {
    return <p className="text-sm text-muted italic">{emptyText}</p>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <span
          key={item}
          className="inline-flex items-center px-2.5 py-1 rounded-lg bg-background-muted text-sm text-foreground border border-default"
        >
          {item}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function ImportedAgentDetailLoader({
  alias,
  agentName,
  onBack,
}: ImportedAgentDetailLoaderProps) {
  const t = useTranslations('agents.imported_detail');
  const { agents } = useImportedSymbols();

  const agent: ImportedAgent | undefined = useMemo(
    () => agents.find((a) => a.alias === alias && a.name === agentName),
    [agents, alias, agentName],
  );

  const mountedName = agent ? `${agent.alias}__${agent.name}` : '';

  // -------------------------------------------------------------------------
  // Loading / not found
  // -------------------------------------------------------------------------

  if (!agent) {
    return (
      <DetailPageShell title={t('title')} backTo={{ label: t('back'), onClick: onBack }}>
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Bot className="w-10 h-10 text-muted mb-3" />
          <p className="text-sm text-muted">
            {t('not_found_description', { alias, name: agentName })}
          </p>
        </div>
      </DetailPageShell>
    );
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <DetailPageShell
      title={`${agent.alias}.${agent.name}`}
      backTo={{ label: t('back'), onClick: onBack }}
      actions={
        <Badge variant="purple" appearance="outlined">
          <Lock className="w-3 h-3 mr-1" />
          {t('title')}
        </Badge>
      }
    >
      <div className="space-y-5">
        {/* Provenance banner */}
        <div className="rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 flex items-center gap-3">
          <Package className="w-5 h-5 text-accent shrink-0" />
          <div className="min-w-0">
            <span className="text-sm font-medium text-foreground">{agent.moduleProjectName}</span>
            <div className="text-xs text-muted mt-0.5">
              Alias: <code className="bg-muted px-1 py-0.5 rounded">{agent.alias}</code>
              {agent.resolvedVersion && (
                <span className="ml-2">&middot; Version {agent.resolvedVersion}</span>
              )}
            </div>
          </div>
        </div>

        {/* Read-only notice */}
        <div className="rounded-lg border border-warning/30 bg-warning/10 p-3">
          <p className="text-xs text-warning">{t('read_only_notice')}</p>
        </div>

        {/* Identity */}
        <ReadOnlySection title={t('identity')}>
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-muted uppercase tracking-wide mb-1">
                  {t('name')}
                </label>
                <p className="text-sm text-foreground">{agent.name}</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted uppercase tracking-wide mb-1">
                  {t('execution_mode')}
                </label>
                <div>
                  {agent.mode ? (
                    <Badge variant={agent.mode === 'reasoning' ? 'accent' : 'info'}>
                      {agent.mode}
                    </Badge>
                  ) : (
                    <span className="text-sm text-muted italic">Not specified</span>
                  )}
                </div>
              </div>
            </div>

            {agent.description && (
              <div>
                <label className="block text-xs font-medium text-muted uppercase tracking-wide mb-1">
                  {t('description')}
                </label>
                <p className="text-sm text-foreground">{agent.description}</p>
              </div>
            )}

            {/* Capabilities badges */}
            <div className="flex flex-wrap gap-2">
              {agent.hasGather && (
                <Badge variant="info" appearance="outlined">
                  Gather
                </Badge>
              )}
              {agent.hasFlow && (
                <Badge variant="info" appearance="outlined">
                  <Workflow className="w-3 h-3 mr-1" />
                  Flow
                </Badge>
              )}
            </div>
          </div>
        </ReadOnlySection>

        {/* Tools */}
        <ReadOnlySection title={t('tools_used')}>
          <div className="flex items-center gap-2 mb-3">
            <Wrench className="w-4 h-4 text-muted" />
            <span className="text-xs text-muted uppercase tracking-wide font-medium">
              {agent.tools?.length ?? 0} tool{(agent.tools?.length ?? 0) !== 1 ? 's' : ''}
            </span>
          </div>
          <ChipList items={agent.tools} emptyText={t('no_tools')} />
        </ReadOnlySection>

        {/* Handoffs */}
        <ReadOnlySection title={t('handoff_targets')}>
          <div className="flex items-center gap-2 mb-3">
            <ArrowRightLeft className="w-4 h-4 text-muted" />
            <span className="text-xs text-muted uppercase tracking-wide font-medium">
              {agent.handoffTargets?.length ?? 0} target
              {(agent.handoffTargets?.length ?? 0) !== 1 ? 's' : ''}
            </span>
          </div>
          <ChipList items={agent.handoffTargets} emptyText={t('no_handoffs')} />
        </ReadOnlySection>

        {/* Delegates */}
        <ReadOnlySection title={t('delegate_targets')}>
          <div className="flex items-center gap-2 mb-3">
            <Users className="w-4 h-4 text-muted" />
            <span className="text-xs text-muted uppercase tracking-wide font-medium">
              {agent.delegateTargets?.length ?? 0} target
              {(agent.delegateTargets?.length ?? 0) !== 1 ? 's' : ''}
            </span>
          </div>
          <ChipList items={agent.delegateTargets} emptyText={t('no_delegates')} />
        </ReadOnlySection>

        {/* Runtime Name */}
        <ReadOnlySection title={t('runtime_name')}>
          <div className="flex items-center gap-2">
            <code className="text-sm bg-muted px-3 py-1.5 rounded font-mono flex-1">
              {mountedName}
            </code>
            <button
              onClick={() => navigator.clipboard.writeText(mountedName)}
              className="text-muted hover:text-foreground p-1.5 rounded hover:bg-muted transition-colors"
              title={t('copy_runtime_name')}
            >
              <Copy className="w-4 h-4" />
            </button>
          </div>
          <p className="text-xs text-muted mt-2">Use this name in ABL handoff/delegate targets</p>
        </ReadOnlySection>
      </div>
    </DetailPageShell>
  );
}
