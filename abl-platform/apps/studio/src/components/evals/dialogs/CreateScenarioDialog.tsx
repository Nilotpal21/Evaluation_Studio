/**
 * CreateScenarioDialog — Create or edit an eval scenario.
 */

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useProjectStore } from '@/store/project-store';
import { apiFetch } from '@/lib/api-client';
import { Dialog } from '../../ui/Dialog';
import { Input } from '../../ui/Input';
import { Textarea } from '../../ui/Textarea';
import { Select } from '../../ui/Select';
import { Button } from '../../ui/Button';
import type { EvalScenario } from '@/hooks/useEvalData';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  editScenario?: EvalScenario | null;
}

export function CreateScenarioDialog({ open, onClose, onCreated, editScenario }: Props) {
  const t = useTranslations('evals');
  const currentProject = useProjectStore((s) => s.currentProject);
  const isEdit = !!editScenario;

  const CATEGORIES = [
    { value: 'general', label: t('scenarios.category.general') },
    { value: 'happy_path', label: t('scenarios.category.happy_path') },
    { value: 'edge_case', label: t('scenarios.category.edge_case') },
    { value: 'error_handling', label: t('scenarios.category.error_handling') },
    { value: 'multi_turn', label: t('scenarios.category.multi_turn') },
    { value: 'handoff', label: t('scenarios.category.handoff') },
    { value: 'adversarial', label: t('scenarios.category.adversarial') },
    { value: 'support', label: t('scenarios.category.support') },
    { value: 'sales', label: t('scenarios.category.sales') },
    { value: 'onboarding', label: t('scenarios.category.onboarding') },
    { value: 'troubleshooting', label: t('scenarios.category.troubleshooting') },
    { value: 'billing', label: t('scenarios.category.billing') },
    { value: 'technical', label: t('scenarios.category.technical') },
  ];
  const DIFFICULTIES = [
    { value: 'easy', label: t('scenarios.difficulty.easy') },
    { value: 'medium', label: t('scenarios.difficulty.medium') },
    { value: 'hard', label: t('scenarios.difficulty.hard') },
  ];

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('general');
  const [difficulty, setDifficulty] = useState('medium');
  const [entryAgent, setEntryAgent] = useState('');
  const [initialMessage, setInitialMessage] = useState('');
  const [expectedOutcome, setExpectedOutcome] = useState('');
  const [maxTurns, setMaxTurns] = useState('10');
  const [agentPath, setAgentPath] = useState('');
  const [expectedMilestones, setExpectedMilestones] = useState('');
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editScenario) {
      setName(editScenario.name);
      setDescription(editScenario.description ?? '');
      setCategory(editScenario.category);
      setDifficulty(editScenario.difficulty);
      setEntryAgent(editScenario.entryAgent ?? '');
      setInitialMessage(editScenario.initialMessage ?? '');
      setExpectedOutcome(editScenario.expectedOutcome ?? '');
      setMaxTurns(String(editScenario.maxTurns));
      setAgentPath(editScenario.agentPath?.join(', ') ?? '');
      setExpectedMilestones(editScenario.expectedMilestones?.join(', ') ?? '');
      setTags(editScenario.tags?.join(', ') ?? '');
    } else {
      resetForm();
    }
  }, [editScenario, open]);

  function resetForm() {
    setName('');
    setDescription('');
    setCategory('general');
    setDifficulty('medium');
    setEntryAgent('');
    setInitialMessage('');
    setExpectedOutcome('');
    setMaxTurns('10');
    setAgentPath('');
    setExpectedMilestones('');
    setTags('');
  }

  const handleSubmit = async () => {
    if (!currentProject || !name.trim()) return;
    setSaving(true);

    const splitCommaSafe = (s: string) =>
      s
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

    const payload = {
      name: name.trim(),
      description: description.trim() || undefined,
      category,
      difficulty,
      entryAgent: entryAgent.trim() || undefined,
      initialMessage: initialMessage.trim() || undefined,
      expectedOutcome: expectedOutcome.trim() || undefined,
      maxTurns: parseInt(maxTurns, 10) || 10,
      agentPath: splitCommaSafe(agentPath),
      expectedMilestones: splitCommaSafe(expectedMilestones),
      tags: splitCommaSafe(tags),
    };

    try {
      const url = isEdit
        ? `/api/projects/${currentProject.id}/evals/scenarios/${editScenario!.id}`
        : `/api/projects/${currentProject.id}/evals/scenarios`;
      const method = isEdit ? 'PATCH' : 'POST';
      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(
          data.error || data.errors?.[0]?.msg || `${isEdit ? 'Update' : 'Create'} failed`,
        );
      }
      toast.success(isEdit ? t('scenarios.dialog.updated') : t('scenarios.dialog.created'));
      resetForm();
      onCreated();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isEdit ? t('scenarios.dialog.edit_title') : t('scenarios.dialog.create_title')}
      description={t('scenarios.dialog.description')}
      maxWidth="lg"
    >
      <div className="space-y-4">
        <Input
          label={t('scenarios.dialog.name_label')}
          placeholder={t('scenarios.dialog.name_placeholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <Textarea
          label={t('scenarios.dialog.description_label')}
          placeholder={t('scenarios.dialog.description_placeholder')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
        />

        <div className="grid grid-cols-2 gap-4">
          <Select
            label={t('scenarios.dialog.category_label')}
            options={CATEGORIES}
            value={category}
            onChange={setCategory}
          />
          <Select
            label={t('scenarios.dialog.difficulty_label')}
            options={DIFFICULTIES}
            value={difficulty}
            onChange={setDifficulty}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Input
            label={t('scenarios.dialog.entry_agent_label')}
            placeholder={t('scenarios.dialog.entry_agent_placeholder')}
            value={entryAgent}
            onChange={(e) => setEntryAgent(e.target.value)}
          />
          <Input
            label={t('scenarios.dialog.max_turns_label')}
            type="number"
            placeholder="10"
            value={maxTurns}
            onChange={(e) => setMaxTurns(e.target.value)}
          />
        </div>

        <Textarea
          label={t('scenarios.dialog.initial_message_label')}
          placeholder={t('scenarios.dialog.initial_message_placeholder')}
          value={initialMessage}
          onChange={(e) => setInitialMessage(e.target.value)}
          rows={2}
        />

        <Textarea
          label={t('scenarios.dialog.expected_outcome_label')}
          placeholder={t('scenarios.dialog.expected_outcome_placeholder')}
          value={expectedOutcome}
          onChange={(e) => setExpectedOutcome(e.target.value)}
          rows={2}
        />

        <Input
          label={t('scenarios.dialog.agent_path_label')}
          placeholder={t('scenarios.dialog.agent_path_placeholder')}
          value={agentPath}
          onChange={(e) => setAgentPath(e.target.value)}
        />

        <Input
          label={t('scenarios.dialog.milestones_label')}
          placeholder={t('scenarios.dialog.milestones_placeholder')}
          value={expectedMilestones}
          onChange={(e) => setExpectedMilestones(e.target.value)}
        />

        <Input
          label={t('scenarios.dialog.tags_label')}
          placeholder={t('scenarios.dialog.tags_placeholder')}
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={saving} disabled={!name.trim()}>
            {isEdit ? 'Update' : 'Create'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
