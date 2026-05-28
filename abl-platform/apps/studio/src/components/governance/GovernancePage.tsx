'use client';

import { Suspense, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { useNavigationStore } from '../../store/navigation-store';
import { DetailPageShell } from '../ui/DetailPageShell';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { Badge } from '../ui/Badge';
import { AgentComplianceTable } from './AgentComplianceTable';
import { GovernancePolicyEditor } from './GovernancePolicyEditor';
import { ComplianceCardGrid } from './ComplianceCardGrid';
import { AuditEventTimeline } from './AuditEventTimeline';
import { ExportBar } from './ExportBar';
import { FrameworksTab } from './FrameworksTab';
import { useGovernancePolicies } from '../../hooks/useGovernancePolicies';
import { useGovernanceStatus } from '../../hooks/useGovernanceStatus';
import { useGovernanceFrameworks } from '../../hooks/useGovernanceFrameworks';
import type {
  GovernancePolicyItem,
  CreatePolicyBody,
  UpdatePolicyBody,
} from '../../lib/governance-contracts';

type GovernanceTab = 'registry' | 'compliance' | 'audit' | 'frameworks';

const PERIOD_OPTIONS = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
];

function GovernanceContent() {
  const t = useTranslations('governance');
  const searchParams = useSearchParams();
  const router = useRouter();
  const { projectId } = useNavigationStore();

  const [activeTab, setActiveTab] = useState<GovernanceTab>(
    (searchParams.get('tab') as GovernanceTab) ?? 'registry',
  );
  const period = searchParams.get('period') ?? '7d';

  const [editorOpen, setEditorOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<GovernancePolicyItem | null>(null);

  const {
    policies,
    isLoading: policiesLoading,
    createPolicy,
    updatePolicy,
    deletePolicy,
  } = useGovernancePolicies(projectId ?? null);
  const { statusData, isLoading: statusLoading } = useGovernanceStatus(projectId ?? null, period);
  const { frameworks, isLoading: frameworksLoading } = useGovernanceFrameworks(
    projectId ?? null,
    period,
  );

  const setPeriod = (p: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('period', p);
    router.push(`?${params.toString()}`);
  };

  const setTab = (tab: string) => {
    setActiveTab(tab as GovernanceTab);
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', tab);
    router.push(`?${params.toString()}`);
  };

  const openEditor = (policy?: GovernancePolicyItem) => {
    setEditTarget(policy ?? null);
    setEditorOpen(true);
  };

  const handleSave = async (body: CreatePolicyBody | UpdatePolicyBody) => {
    if (editTarget) {
      await updatePolicy(editTarget._id, body as UpdatePolicyBody);
    } else {
      await createPolicy(body as CreatePolicyBody);
    }
  };

  const actions = (
    <>
      <Select options={PERIOD_OPTIONS} value={period} onChange={setPeriod} />
      {activeTab === 'registry' && (
        <Button
          variant="primary"
          size="sm"
          icon={<Plus className="w-3.5 h-3.5" />}
          onClick={() => openEditor()}
        >
          {t('policy.create')}
        </Button>
      )}
      {activeTab === 'audit' && projectId && <ExportBar projectId={projectId} period={period} />}
    </>
  );

  return (
    <DetailPageShell
      title={t('title')}
      description={t('subtitle')}
      actions={actions}
      tabs={[
        {
          id: 'registry',
          label: t('tab.registry'),
        },
        {
          id: 'compliance',
          label: t('tab.compliance'),
        },
        {
          id: 'audit',
          label: t('tab.audit'),
        },
        {
          id: 'frameworks',
          label: t('tab.frameworks'),
        },
      ]}
      activeTab={activeTab}
      onTabChange={setTab}
      tabsLayoutId="governance-tabs"
      maxWidth="xl"
      className="bg-noise"
    >
      {activeTab === 'registry' && (
        <div className="space-y-4">
          {policies.length > 0 && (
            <div className="rounded-lg border border-default divide-y divide-default">
              {policies.map((policy) => (
                <div key={policy._id} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <span className="font-medium text-sm">{policy.name}</span>
                    {policy.description && (
                      <span className="ml-2 text-xs text-muted">{policy.description}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={policy.status === 'enabled' ? 'success' : 'default'}
                      appearance="outlined"
                    >
                      {policy.status}
                    </Badge>
                    <Button variant="ghost" size="xs" onClick={() => openEditor(policy)}>
                      {t('action.edit')}
                    </Button>
                    <Button variant="ghost" size="xs" onClick={() => deletePolicy(policy._id)}>
                      {t('action.delete')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <AgentComplianceTable
            agents={statusData?.agents ?? []}
            isLoading={statusLoading || policiesLoading}
            onAddPolicy={() => openEditor()}
          />
        </div>
      )}

      {activeTab === 'compliance' && (
        <ComplianceCardGrid agents={statusData?.agents ?? []} isLoading={statusLoading} />
      )}

      {activeTab === 'audit' && projectId && (
        <AuditEventTimeline projectId={projectId} period={period} />
      )}

      {activeTab === 'frameworks' && (
        <FrameworksTab frameworks={frameworks} isLoading={frameworksLoading} />
      )}

      <GovernancePolicyEditor
        open={editorOpen}
        onClose={() => {
          setEditorOpen(false);
          setEditTarget(null);
        }}
        initial={editTarget}
        onSave={handleSave}
      />
    </DetailPageShell>
  );
}

export function GovernancePage() {
  return (
    <Suspense fallback={null}>
      <GovernanceContent />
    </Suspense>
  );
}
