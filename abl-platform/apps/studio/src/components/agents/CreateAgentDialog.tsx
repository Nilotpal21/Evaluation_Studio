/**
 * CreateAgentDialog Component
 *
 * Dialog for creating a new agent in a project from the agent list page.
 * Generates a skeleton ABL file based on the chosen execution mode.
 */

import { useState, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { sanitizeError } from '@/lib/sanitize-error';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';
import { addAgentToProject } from '../../api/projects';
import { saveDslWorkingCopy } from '../../api/runtime-agents';

interface CreateAgentDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onCreated: (agentName: string) => void;
}

const AGENT_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const MAX_NAME_LENGTH = 100;

// Mode options are populated dynamically using translations in the component

function generateSkeletonAbl(name: string, mode: string): string {
  const base = `AGENT: ${name}

PERSONA: |
  You are ${name.replace(/_/g, ' ')}.

GOAL: "Help users with ${name.replace(/_/g, ' ').toLowerCase()}"
`;

  if (mode === 'flow') {
    return `${base}
FLOW:
  entry_point: greet
  steps:
    - greet
    - complete

  greet:
    REASONING: false
    RESPOND: "Hello! How can I help you?"
    THEN: complete

  complete:
    REASONING: false
    RESPOND: "All done! Is there anything else?"
    THEN: COMPLETE
`;
  }

  return base;
}

export function CreateAgentDialog({ open, onClose, projectId, onCreated }: CreateAgentDialogProps) {
  const t = useTranslations('agents.create_dialog');
  const tCommon = useTranslations('common');
  const tAgents = useTranslations('agents');
  const [name, setName] = useState('');
  const [mode, setMode] = useState('reasoning'); // 'reasoning' | 'flow'
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [nameError, setNameError] = useState('');

  const modeOptions = [
    { value: 'reasoning', label: t('mode_reasoning') },
    { value: 'flow', label: 'Flow-based' },
  ];

  const validateName = useCallback(
    (value: string): string => {
      if (!value.trim()) return t('name_required');
      if (value.length > MAX_NAME_LENGTH) return t('name_too_long', { max: MAX_NAME_LENGTH });
      if (!AGENT_NAME_PATTERN.test(value)) return t('name_invalid');
      return '';
    },
    [t],
  );

  const handleSubmit = useCallback(async () => {
    const error = validateName(name);
    if (error) {
      setNameError(error);
      return;
    }

    setIsSubmitting(true);
    setNameError('');

    try {
      await addAgentToProject(projectId, {
        name: name.trim(),
        description: description.trim() || undefined,
      });

      const skeleton = generateSkeletonAbl(name.trim(), mode);
      await saveDslWorkingCopy(projectId, name.trim(), skeleton);

      toast.success(tAgents('create_success'));
      onCreated(name.trim());
      handleClose();
    } catch (err) {
      const message = sanitizeError(err, tAgents('create_failed'));
      toast.error(message);
      console.error('Agent creation failed:', err);
    } finally {
      setIsSubmitting(false);
    }
  }, [name, mode, description, projectId, onCreated, validateName, tAgents]);

  const handleClose = useCallback(() => {
    setName('');
    setMode('reasoning');
    setDescription('');
    setNameError('');
    onClose();
  }, [onClose]);

  return (
    <Dialog open={open} onClose={handleClose} title={t('title')} description={t('description')}>
      <div className="space-y-4">
        <Input
          label={t('name_label')}
          placeholder={t('name_placeholder')}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (nameError) setNameError(validateName(e.target.value));
          }}
          error={nameError}
          autoFocus
        />

        <Select label={t('mode_label')} options={modeOptions} value={mode} onChange={setMode} />

        <Input
          label={t('description_label')}
          placeholder={t('description_placeholder')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="ghost" onClick={handleClose} disabled={isSubmitting}>
            {tCommon('cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting || !name.trim()}>
            {isSubmitting ? (
              <span className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('creating')}
              </span>
            ) : (
              tAgents('create')
            )}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
