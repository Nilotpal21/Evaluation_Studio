/**
 * CreateKnowledgeBaseDialog Component
 *
 * Simplified dialog for creating a new knowledge base.
 * Only requires name + optional description. Technical details
 * (embedding model, chunk strategy) are auto-configured.
 *
 * Validates name uniqueness client-side (against existing KBs)
 * and falls back to backend 409 DUPLICATE_NAME on race conditions.
 */

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import useSWR from 'swr';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { createKnowledgeBase, fetchKnowledgeBases } from '../../api/search-ai';
import { useAuthStore } from '../../store/auth-store';
import { toast } from 'sonner';
import { sanitizeError } from '../../lib/sanitize-error';

interface CreateKnowledgeBaseDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onCreated: (kbId: string) => void;
}

export function CreateKnowledgeBaseDialog({
  open,
  onClose,
  projectId,
  onCreated,
}: CreateKnowledgeBaseDialogProps) {
  const t = useTranslations('search_ai.create_dialog');
  const { tenantId } = useAuthStore();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch existing KB names for client-side duplicate detection
  const { data: kbData } = useSWR(open && projectId ? [`/knowledge-bases`, projectId] : null, () =>
    fetchKnowledgeBases(projectId),
  );
  const existingNames = useMemo(() => {
    if (!kbData?.knowledgeBases) return new Set<string>();
    return new Set(kbData.knowledgeBases.map((kb) => kb.name.toLowerCase().trim()));
  }, [kbData]);

  // Live duplicate check as user types
  const isDuplicate = name.trim().length > 0 && existingNames.has(name.trim().toLowerCase());

  const handleSubmit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t('error_name_required'));
      return;
    }

    // Client-side duplicate check
    if (existingNames.has(trimmedName.toLowerCase())) {
      setError(t('error_duplicate_name'));
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await createKnowledgeBase({
        tenantId: tenantId || '',
        projectId,
        name: trimmedName,
        description: description.trim() || undefined,
      });
      setName('');
      setDescription('');
      toast.success(t('toast_created'));
      onCreated(result.knowledgeBase._id);
    } catch (err) {
      // Surface backend duplicate error explicitly (race condition fallback)
      const errCode = err instanceof Error && 'code' in err ? (err as any).code : undefined;
      if (errCode === 'DUPLICATE_NAME') {
        setError(t('error_duplicate_name'));
      } else {
        setError(sanitizeError(err, t('error_create_failed')));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('title')} maxWidth="md">
      <div className="space-y-4">
        <div>
          <Input
            label={t('name_label')}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              // Clear error when user starts typing again
              if (error) setError(null);
            }}
            placeholder={t('name_placeholder')}
          />
          {isDuplicate && !error && (
            <p className="text-sm text-warning mt-1">{t('warning_duplicate_name')}</p>
          )}
        </div>

        <Input
          label={t('description_label')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('description_placeholder')}
        />

        {error && <p className="text-sm text-error">{error}</p>}

        <div className="flex gap-3 pt-2">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            {t('cancel')}
          </Button>
          <Button
            onClick={handleSubmit}
            loading={loading}
            disabled={isDuplicate || !name.trim()}
            className="flex-1"
          >
            {t('submit')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
