/**
 * StartRunDialog — Dialog for configuring and starting an eval run.
 *
 * Lets user select an eval set, shows matrix preview and cost estimate,
 * then creates and starts the run via two API calls.
 */

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { useProjectStore } from '@/store/project-store';
import { useEvalSets } from '@/hooks/useEvalData';
import { apiFetch } from '@/lib/api-client';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Select } from '../../ui/Select';
import { Badge } from '../../ui/Badge';
import { CostEstimate } from '../shared/CostEstimate';

interface StartRunDialogProps {
  open: boolean;
  onClose: () => void;
  onStarted: () => void;
}

export function StartRunDialog({ open, onClose, onStarted }: StartRunDialogProps) {
  const t = useTranslations('evals');
  const currentProject = useProjectStore((s) => s.currentProject);
  const projectId = currentProject?.id ?? null;
  const { sets, isLoading: setsLoading, hasMore, loadMore, isLoadingMore } = useEvalSets(projectId);

  const [selectedSetId, setSelectedSetId] = useState('');
  const [starting, setStarting] = useState(false);

  const selectedSet = useMemo(
    () => sets.find((s) => s.id === selectedSetId) ?? null,
    [sets, selectedSetId],
  );

  const p = selectedSet?.personaIds.length ?? 0;
  const s = selectedSet?.scenarioIds.length ?? 0;
  const e = selectedSet?.evaluatorIds.length ?? 0;
  const v = selectedSet?.variants ?? 1;
  const totalEvals = p * s * e * v;
  const dimensionStr = `${p}P × ${s}S × ${e}E × ${v}V`;

  const handleStart = async () => {
    if (!currentProject || !selectedSetId) return;

    setStarting(true);
    try {
      // Step 1: Create the run
      const createRes = await apiFetch(`/api/projects/${currentProject.id}/evals/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ evalSetId: selectedSetId, triggerSource: 'manual' }),
      });
      const createData = await createRes.json();
      if (!createRes.ok)
        throw new Error(createData.error || createData.errors?.[0]?.msg || 'Failed to create run');

      // Step 2: Start the run
      const startRes = await apiFetch(
        `/api/projects/${currentProject.id}/evals/runs/${createData.run.id}/start`,
        { method: 'POST' },
      );
      const startData = await startRes.json();
      if (!startRes.ok)
        throw new Error(startData.error || startData.errors?.[0]?.msg || 'Failed to start run');

      toast.success(t('runs.start_dialog.started'));
      setSelectedSetId('');
      onStarted();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  const selectOptions = [
    { value: '', label: t('runs.start_dialog.select_placeholder') },
    ...sets.map((set) => ({ value: set.id, label: set.name })),
  ];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('runs.start_dialog.title')}
      description={t('runs.start_dialog.description')}
      maxWidth="lg"
    >
      <div className="space-y-5">
        {/* Eval Set Selector */}
        <Select
          label={t('runs.start_dialog.eval_set')}
          options={selectOptions}
          value={selectedSetId}
          onChange={setSelectedSetId}
          disabled={setsLoading}
        />
        {hasMore && (
          <Button
            size="xs"
            variant="secondary"
            onClick={() => void loadMore()}
            loading={isLoadingMore}
            icon={<ChevronDown className="w-3 h-3" />}
          >
            {t('load_more')}
          </Button>
        )}

        {/* Matrix Preview */}
        {selectedSet && (
          <>
            <div className="bg-background-muted rounded-lg p-3 text-center">
              <div className="text-xs text-muted mb-1">{t('runs.start_dialog.matrix_size')}</div>
              <div className="text-lg font-semibold text-foreground">{dimensionStr}</div>
              <div className="text-sm text-muted mt-1">
                {t('runs.start_dialog.total_evaluations', { count: totalEvals.toLocaleString() })}
              </div>
            </div>

            {/* Entity names preview */}
            <div className="space-y-2">
              {selectedSet._personaNames && (
                <div className="flex flex-wrap gap-1">
                  {Object.values(selectedSet._personaNames).map((name) => (
                    <Badge key={name} variant="accent" className="text-xs">
                      {name}
                    </Badge>
                  ))}
                </div>
              )}
              {selectedSet._scenarioNames && (
                <div className="flex flex-wrap gap-1">
                  {Object.values(selectedSet._scenarioNames).map((name) => (
                    <Badge key={name} variant="info" className="text-xs">
                      {name}
                    </Badge>
                  ))}
                </div>
              )}
              {selectedSet._evaluatorNames && (
                <div className="flex flex-wrap gap-1">
                  {Object.values(selectedSet._evaluatorNames).map((name) => (
                    <Badge key={name} variant="accent" className="text-xs">
                      {name}
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            {/* Cost Estimate */}
            <CostEstimate personas={p} scenarios={s} evaluators={e} variants={v} />
          </>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleStart} loading={starting} disabled={!selectedSetId}>
            {t('runs.start_dialog.start')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
