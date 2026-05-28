/**
 * EvalsPage Component
 *
 * Evaluations page with 5 internal tabs: Personas, Scenarios, Evaluators,
 * Eval Sets, and Runs. Uses Zustand store for persisted tab state.
 */

import { useTranslations } from 'next-intl';
import { Users, Route, Eye, Layers, Play } from 'lucide-react';
import { Tabs } from '../ui/Tabs';
import { PageHeader } from '../ui/PageHeader';
import { TooltipProvider } from '../ui/Tooltip';
import { useEvalsStore, type EvalTab } from '@/store/evals-store';
import { PersonasTab } from './tabs/PersonasTab';
import { ScenariosTab } from './tabs/ScenariosTab';
import { EvaluatorsTab } from './tabs/EvaluatorsTab';
import { EvalSetsTab } from './tabs/EvalSetsTab';
import { RunsTab } from './tabs/RunsTab';
import { QuickEvalButton } from './shared/QuickEvalButton';

export function EvalsPage() {
  const t = useTranslations('evals');
  const activeTab = useEvalsStore((s) => s.activeTab);
  const setActiveTab = useEvalsStore((s) => s.setActiveTab);

  const EVAL_TABS = [
    { id: 'personas', label: t('tabs.personas'), icon: <Users className="w-3.5 h-3.5" /> },
    { id: 'scenarios', label: t('tabs.scenarios'), icon: <Route className="w-3.5 h-3.5" /> },
    { id: 'evaluators', label: t('tabs.evaluators'), icon: <Eye className="w-3.5 h-3.5" /> },
    { id: 'eval-sets', label: t('tabs.eval_sets'), icon: <Layers className="w-3.5 h-3.5" /> },
    { id: 'runs', label: t('tabs.runs'), icon: <Play className="w-3.5 h-3.5" /> },
  ];

  return (
    <TooltipProvider>
      <div className="h-full overflow-y-auto">
        <div className="max-w-6xl mx-auto px-6 py-8">
          <div className="flex items-center justify-between">
            <PageHeader title={t('title')} description={t('subtitle')} />
            <QuickEvalButton />
          </div>

          <div className="mt-6">
            <Tabs
              tabs={EVAL_TABS}
              activeTab={activeTab}
              onTabChange={(id) => setActiveTab(id as EvalTab)}
              layoutId="evals-tab-indicator"
            />

            <div className="mt-6">
              {activeTab === 'personas' && <PersonasTab />}
              {activeTab === 'scenarios' && <ScenariosTab />}
              {activeTab === 'evaluators' && <EvaluatorsTab />}
              {activeTab === 'eval-sets' && <EvalSetsTab />}
              {activeTab === 'runs' && <RunsTab />}
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
