/**
 * IntelligenceSubNav
 *
 * Tab-based sub-navigation for Intelligence sub-sections.
 */

import { LayoutGrid, Workflow, TableProperties, BookOpen, Share2, Cpu } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
import { Tabs } from '../../ui/Tabs';

const OVERVIEW_ID = 'overview';

interface IntelligenceSubNavProps {
  activeSubSection: string | null;
  onSubSectionChange: (subSection: string | null) => void;
}

export function IntelligenceSubNav({
  activeSubSection,
  onSubSectionChange,
}: IntelligenceSubNavProps) {
  const t = useTranslations('search_ai.intelligence');

  const subSections = useMemo(
    () => [
      {
        id: OVERVIEW_ID,
        label: t('tab_overview'),
        icon: <LayoutGrid className="w-3.5 h-3.5" />,
      },
      {
        id: 'pipeline',
        label: t('tab_pipeline'),
        icon: <Workflow className="w-3.5 h-3.5" />,
      },
      {
        id: 'fields',
        label: t('tab_fields'),
        icon: <TableProperties className="w-3.5 h-3.5" />,
      },
      {
        id: 'vocabulary',
        label: t('tab_vocabulary'),
        icon: <BookOpen className="w-3.5 h-3.5" />,
      },
      {
        id: 'knowledge-graph',
        label: t('tab_knowledge_graph'),
        icon: <Share2 className="w-3.5 h-3.5" />,
      },
      {
        id: 'llm-models',
        label: t('tab_llm_models'),
        icon: <Cpu className="w-3.5 h-3.5" />,
      },
    ],
    [t],
  );

  return (
    <Tabs
      tabs={subSections}
      activeTab={activeSubSection ?? OVERVIEW_ID}
      onTabChange={(id) => onSubSectionChange(id)}
      layoutId="intelligence-sub-nav"
    />
  );
}
