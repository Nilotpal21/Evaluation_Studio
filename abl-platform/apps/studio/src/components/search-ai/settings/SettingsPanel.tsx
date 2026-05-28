/**
 * SettingsPanel Component
 *
 * Slide-out panel for KB settings.
 * Contains General, Index Config, and Danger Zone sections.
 */

import { useTranslations } from 'next-intl';
import { SlidePanel } from '../../ui/SlidePanel';
import { GeneralSection } from './GeneralSection';
import { IndexConfigSection } from './IndexConfigSection';
import { CitationSection } from './CitationSection';
import { DangerZoneSection } from './DangerZoneSection';
import type { KnowledgeBaseDetail } from '../../../api/search-ai';

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  knowledgeBase: KnowledgeBaseDetail;
  onRefresh: () => void;
}

export function SettingsPanel({ open, onClose, knowledgeBase, onRefresh }: SettingsPanelProps) {
  const t = useTranslations('search_ai.settings');
  return (
    <SlidePanel open={open} onClose={onClose} title={t('title')} width="xl">
      <div className="space-y-8">
        <GeneralSection
          key={knowledgeBase._id}
          knowledgeBase={knowledgeBase}
          onUpdate={onRefresh}
        />

        <div className="border-t border-default" />

        <IndexConfigSection knowledgeBase={knowledgeBase} onUpdate={onRefresh} />

        <div className="border-t border-default" />

        <CitationSection knowledgeBase={knowledgeBase} onUpdate={onRefresh} />

        <div className="border-t border-default" />

        <DangerZoneSection
          knowledgeBase={knowledgeBase}
          onDeleted={onClose}
          onUpdated={onRefresh}
        />
      </div>
    </SlidePanel>
  );
}
