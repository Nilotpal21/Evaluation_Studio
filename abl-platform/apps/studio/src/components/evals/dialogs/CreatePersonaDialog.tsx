/**
 * CreatePersonaDialog — Create or edit an eval persona.
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
import type { EvalPersona } from '@/hooks/useEvalData';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  editPersona?: EvalPersona | null;
}

export function CreatePersonaDialog({ open, onClose, onCreated, editPersona }: Props) {
  const t = useTranslations('evals');
  const currentProject = useProjectStore((s) => s.currentProject);
  const isEdit = !!editPersona;

  const COMMUNICATION_STYLES = [
    { value: 'casual', label: t('personas.communication_style.casual') },
    { value: 'formal', label: t('personas.communication_style.formal') },
    { value: 'technical', label: t('personas.communication_style.technical') },
    { value: 'terse', label: t('personas.communication_style.terse') },
    { value: 'verbose', label: t('personas.communication_style.verbose') },
  ];
  const DOMAIN_KNOWLEDGE = [
    { value: 'beginner', label: t('personas.domain_knowledge.beginner') },
    { value: 'intermediate', label: t('personas.domain_knowledge.intermediate') },
    { value: 'expert', label: t('personas.domain_knowledge.expert') },
  ];
  const ADVERSARIAL_TYPES = [
    { value: '', label: t('personas.adversarial_type.none') },
    { value: 'prompt_injection', label: t('personas.adversarial_type.prompt_injection') },
    { value: 'social_engineering', label: t('personas.adversarial_type.social_engineering') },
    { value: 'off_topic', label: t('personas.adversarial_type.off_topic') },
    { value: 'abusive', label: t('personas.adversarial_type.abusive') },
    { value: 'edge_case', label: t('personas.adversarial_type.edge_case') },
  ];

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [communicationStyle, setCommunicationStyle] = useState('casual');
  const [domainKnowledge, setDomainKnowledge] = useState('intermediate');
  const [behaviorTraits, setBehaviorTraits] = useState('');
  const [goals, setGoals] = useState('');
  const [constraints, setConstraints] = useState('');
  const [sessionVariables, setSessionVariables] = useState('');
  const [sessionVariablesError, setSessionVariablesError] = useState('');
  const [adversarialType, setAdversarialType] = useState('');
  const [saving, setSaving] = useState(false);

  // Populate form for edit mode
  useEffect(() => {
    if (editPersona) {
      setName(editPersona.name);
      setDescription(editPersona.description ?? '');
      setCommunicationStyle(editPersona.communicationStyle);
      setDomainKnowledge(editPersona.domainKnowledge);
      setBehaviorTraits(editPersona.behaviorTraits?.join(', ') ?? '');
      setGoals(editPersona.goals ?? '');
      setConstraints(editPersona.constraints ?? '');
      setSessionVariables(
        editPersona.sessionVariables ? JSON.stringify(editPersona.sessionVariables, null, 2) : '',
      );
      setSessionVariablesError('');
      setAdversarialType(editPersona.adversarialType ?? '');
    } else {
      resetForm();
    }
  }, [editPersona, open]);

  function resetForm() {
    setName('');
    setDescription('');
    setCommunicationStyle('casual');
    setDomainKnowledge('intermediate');
    setBehaviorTraits('');
    setGoals('');
    setConstraints('');
    setSessionVariables('');
    setSessionVariablesError('');
    setAdversarialType('');
  }

  const handleSubmit = async () => {
    if (!currentProject || !name.trim()) return;
    let parsedSessionVariables: Record<string, unknown> | undefined;
    const trimmedSessionVariables = sessionVariables.trim();
    if (trimmedSessionVariables) {
      try {
        const parsed = JSON.parse(trimmedSessionVariables) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error(t('personas.dialog.session_variables_object_error'));
        }
        parsedSessionVariables = parsed as Record<string, unknown>;
      } catch (err) {
        setSessionVariablesError(
          err instanceof Error ? err.message : t('personas.dialog.session_variables_json_error'),
        );
        return;
      }
    }
    setSessionVariablesError('');
    setSaving(true);

    const payload = {
      name: name.trim(),
      description: description.trim() || undefined,
      communicationStyle,
      domainKnowledge,
      behaviorTraits: behaviorTraits
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      goals: goals.trim() || undefined,
      constraints: constraints.trim() || undefined,
      sessionVariables:
        parsedSessionVariables ?? (isEdit && editPersona?.sessionVariables ? {} : undefined),
      isAdversarial: !!adversarialType,
      adversarialType: adversarialType || undefined,
      source: 'custom',
    };

    try {
      const url = isEdit
        ? `/api/projects/${currentProject.id}/evals/personas/${editPersona!.id}`
        : `/api/projects/${currentProject.id}/evals/personas`;
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
      toast.success(isEdit ? t('personas.dialog.updated') : t('personas.dialog.created'));
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
      title={isEdit ? t('personas.dialog.edit_title') : t('personas.dialog.create_title')}
      description={t('personas.dialog.description')}
      maxWidth="lg"
    >
      <div className="space-y-4">
        <Input
          label={t('personas.dialog.name_label')}
          placeholder={t('personas.dialog.name_placeholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <Textarea
          label={t('personas.dialog.description_label')}
          placeholder={t('personas.dialog.description_placeholder')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
        />

        <div className="grid grid-cols-2 gap-4">
          <Select
            label={t('personas.dialog.communication_style_label')}
            options={COMMUNICATION_STYLES}
            value={communicationStyle}
            onChange={setCommunicationStyle}
          />
          <Select
            label={t('personas.dialog.domain_knowledge_label')}
            options={DOMAIN_KNOWLEDGE}
            value={domainKnowledge}
            onChange={setDomainKnowledge}
          />
        </div>

        <Input
          label={t('personas.dialog.behavior_traits_label')}
          placeholder={t('personas.dialog.behavior_traits_placeholder')}
          value={behaviorTraits}
          onChange={(e) => setBehaviorTraits(e.target.value)}
        />

        <Textarea
          label={t('personas.dialog.goals_label')}
          placeholder={t('personas.dialog.goals_placeholder')}
          value={goals}
          onChange={(e) => setGoals(e.target.value)}
          rows={2}
        />

        <Textarea
          label={t('personas.dialog.constraints_label')}
          placeholder={t('personas.dialog.constraints_placeholder')}
          value={constraints}
          onChange={(e) => setConstraints(e.target.value)}
          rows={2}
        />

        <Textarea
          label={t('personas.dialog.session_variables_label')}
          placeholder={t('personas.dialog.session_variables_placeholder')}
          value={sessionVariables}
          onChange={(e) => setSessionVariables(e.target.value)}
          error={sessionVariablesError}
          rows={4}
        />

        <Select
          label={t('personas.dialog.adversarial_type_label')}
          options={ADVERSARIAL_TYPES}
          value={adversarialType}
          onChange={setAdversarialType}
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
