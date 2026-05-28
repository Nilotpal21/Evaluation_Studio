/**
 * IntelligenceSection
 *
 * Top-level component for the Intelligence section.
 * Shows the hub view when no sub-section is selected,
 * otherwise renders the sub-nav + wrapped component.
 */

import { useEffect } from 'react';
import type { SearchAISource } from '../../../api/search-ai';
import { useNavigationStore } from '../../../store/navigation-store';
import { EnrichmentFeedbackProvider } from '../feedback/EnrichmentFeedbackContext';
import { PipelineEditorV2 } from '../pipelines/v2';
import { FieldsTab } from '../FieldsTab';
import { VocabularyTab } from '../VocabularyTab';
import { KnowledgeGraphTab } from '../KnowledgeGraphTab';
import { SettingsTab } from '../SettingsTab';
import { IntelligenceHub } from './IntelligenceHub';
import { IntelligenceSubNav } from './IntelligenceSubNav';

interface IntelligenceSectionProps {
  indexId: string;
  projectId: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  sources: SearchAISource[];
}

const VALID_SUB_SECTIONS = new Set([
  'overview',
  'pipeline',
  'fields',
  'vocabulary',
  'knowledge-graph',
  'llm-models',
]);

export function IntelligenceSection({
  indexId,
  projectId,
  knowledgeBaseId,
  knowledgeBaseName,
  sources,
}: IntelligenceSectionProps) {
  const subSection = useNavigationStore((s) => s.subSection);
  const setSubSection = useNavigationStore((s) => s.setSubSection);

  useEffect(() => {
    if (!subSection) {
      setSubSection('pipeline');
    } else if (!VALID_SUB_SECTIONS.has(subSection)) {
      setSubSection('pipeline');
    }
  }, [subSection, setSubSection]);

  const renderContent = () => {
    switch (subSection) {
      case 'pipeline':
        return (
          <PipelineEditorV2
            projectId={projectId}
            knowledgeBaseId={knowledgeBaseId}
            knowledgeBaseName={knowledgeBaseName}
          />
        );
      case 'overview':
        return <IntelligenceHub indexId={indexId} knowledgeBaseId={knowledgeBaseId} />;
      case 'fields':
        return <FieldsTab indexId={indexId} sources={sources} />;
      case 'vocabulary':
        return <VocabularyTab indexId={indexId} />;
      case 'knowledge-graph':
        return <KnowledgeGraphTab indexId={indexId} />;
      case 'llm-models':
        return <SettingsTab indexId={indexId} projectId={projectId} />;
      default:
        return (
          <PipelineEditorV2
            projectId={projectId}
            knowledgeBaseId={knowledgeBaseId}
            knowledgeBaseName={knowledgeBaseName}
          />
        );
    }
  };

  return (
    <EnrichmentFeedbackProvider>
      <div className="flex flex-col h-full">
        <IntelligenceSubNav activeSubSection={subSection} onSubSectionChange={setSubSection} />
        <div className="flex-1 overflow-y-auto">{renderContent()}</div>
      </div>
    </EnrichmentFeedbackProvider>
  );
}
