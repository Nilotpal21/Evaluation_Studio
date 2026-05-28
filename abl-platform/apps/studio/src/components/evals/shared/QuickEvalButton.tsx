/**
 * QuickEvalButton — One-click button to AI-generate personas, scenarios,
 * evaluators and immediately start an eval run.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { useProjectStore } from '@/store/project-store';
import { useEvalsStore } from '@/store/evals-store';
import { apiFetch } from '@/lib/api-client';
import { Button } from '../../ui/Button';

interface QuickEvalButtonProps {
  size?: 'sm' | 'xs';
  onStarted?: () => void;
}

export function QuickEvalButton({ size = 'sm', onStarted }: QuickEvalButtonProps) {
  const t = useTranslations('evals');
  const currentProject = useProjectStore((s) => s.currentProject);
  const setActiveTab = useEvalsStore((s) => s.setActiveTab);
  const setSelectedRunId = useEvalsStore((s) => s.setSelectedRunId);
  const [isRunning, setIsRunning] = useState(false);

  const handleQuickEval = async () => {
    if (!currentProject || isRunning) return;
    setIsRunning(true);
    try {
      const res = await apiFetch(`/api/projects/${currentProject.id}/evals/quick`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.errors?.[0]?.msg || 'Quick eval failed');

      toast.success(t('quick_eval.started'));
      setSelectedRunId(data.runId);
      setActiveTab('runs');
      onStarted?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <Button
      size={size}
      variant="secondary"
      onClick={handleQuickEval}
      loading={isRunning}
      disabled={isRunning}
      icon={<Sparkles className="w-3.5 h-3.5" />}
    >
      {isRunning ? t('quick_eval.loading') : t('quick_eval.button')}
    </Button>
  );
}
