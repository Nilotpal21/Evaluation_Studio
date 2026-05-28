/**
 * PersonasTab — Card grid of eval personas.
 *
 * Displays persona cards with communication style, domain knowledge,
 * behavior traits, adversarial badge. Supports create, edit, delete.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, Plus, Users, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { useProjectStore } from '@/store/project-store';
import { useEvalPersonas, type EvalPersona } from '@/hooks/useEvalData';
import { apiFetch } from '@/lib/api-client';
import { normalizeGeneratedPersona } from '@/lib/eval-generation-normalizers';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { PersonaCard } from '../../ui/PersonaCard';
import { CreatePersonaDialog } from '../dialogs/CreatePersonaDialog';

export function PersonasTab() {
  const t = useTranslations('evals');
  const currentProject = useProjectStore((s) => s.currentProject);
  const { personas, isLoading, refresh, hasMore, loadMore, isLoadingMore, total } = useEvalPersonas(
    currentProject?.id ?? null,
  );
  const [showCreate, setShowCreate] = useState(false);
  const [editPersona, setEditPersona] = useState<EvalPersona | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  const handleGenerate = async () => {
    if (!currentProject || isGenerating) return;
    setIsGenerating(true);
    try {
      const genRes = await apiFetch(`/api/projects/${currentProject.id}/evals/generate/personas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 3 }),
      });
      const genData = await genRes.json();
      if (!genRes.ok)
        throw new Error(genData.error || genData.errors?.[0]?.msg || 'Generation failed');

      let saved = 0;
      for (const p of genData.personas ?? []) {
        const persona = normalizeGeneratedPersona(p);
        const saveRes = await apiFetch(`/api/projects/${currentProject.id}/evals/personas`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...persona,
            source: 'ai-generated',
          }),
        });
        if (saveRes.ok) saved++;
      }
      toast.success(t('personas.generate_success', { count: saved }));
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDelete = async (persona: EvalPersona) => {
    if (!currentProject) return;
    if (!window.confirm(t('personas.delete_confirm', { name: persona.name }))) return;
    try {
      const res = await apiFetch(
        `/api/projects/${currentProject.id}/evals/personas/${persona.id}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || data.errors?.[0]?.msg || 'Delete failed');
      }
      toast.success(t('personas.deleted', { name: persona.name }));
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDuplicate = async (persona: EvalPersona) => {
    if (!currentProject) return;
    try {
      const res = await apiFetch(`/api/projects/${currentProject.id}/evals/personas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `${persona.name} (Copy)`,
          description: persona.description,
          communicationStyle: persona.communicationStyle,
          domainKnowledge: persona.domainKnowledge,
          behaviorTraits: persona.behaviorTraits,
          goals: persona.goals,
          constraints: persona.constraints,
          isAdversarial: persona.isAdversarial,
          adversarialType: persona.adversarialType,
          source: 'custom',
        }),
      });
      const dupData = await res.json();
      if (!res.ok) throw new Error(dupData.error || dupData.errors?.[0]?.msg || 'Duplicate failed');
      toast.success(t('personas.duplicated'));
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  if (isLoading) {
    return <div className="text-sm text-muted py-12 text-center">{t('personas.loading')}</div>;
  }

  if (personas.length === 0) {
    return (
      <>
        <EmptyState
          icon={<Users className="w-6 h-6" />}
          title={t('personas.empty_title')}
          description={t('personas.empty_description')}
          action={
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                onClick={handleGenerate}
                loading={isGenerating}
                disabled={isGenerating}
                icon={<Sparkles className="w-4 h-4" />}
              >
                {t('personas.generate')}
              </Button>
              <Button onClick={() => setShowCreate(true)} icon={<Plus className="w-4 h-4" />}>
                {t('personas.create')}
              </Button>
            </div>
          }
        />
        <CreatePersonaDialog
          open={showCreate}
          onClose={() => setShowCreate(false)}
          onCreated={refresh}
        />
      </>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-muted">
          {t('showing_count', { shown: personas.length, total })}
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={handleGenerate}
            loading={isGenerating}
            disabled={isGenerating}
            icon={<Sparkles className="w-3.5 h-3.5" />}
          >
            {t('personas.generate')}
          </Button>
          <Button
            size="sm"
            onClick={() => setShowCreate(true)}
            icon={<Plus className="w-3.5 h-3.5" />}
          >
            {t('personas.create')}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {personas.map((persona) => (
          <PersonaCard
            key={persona.id}
            persona={persona}
            onEdit={() => setEditPersona(persona)}
            onDelete={() => handleDelete(persona)}
            onDuplicate={() => handleDuplicate(persona)}
          />
        ))}
      </div>

      {hasMore && (
        <div className="flex justify-center mt-4">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void loadMore()}
            loading={isLoadingMore}
            icon={<ChevronDown className="w-3.5 h-3.5" />}
          >
            {t('load_more')}
          </Button>
        </div>
      )}

      <CreatePersonaDialog
        open={showCreate || !!editPersona}
        onClose={() => {
          setShowCreate(false);
          setEditPersona(null);
        }}
        onCreated={refresh}
        editPersona={editPersona}
      />
    </>
  );
}
