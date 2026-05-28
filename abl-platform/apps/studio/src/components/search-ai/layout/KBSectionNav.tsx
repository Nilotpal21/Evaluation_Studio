/**
 * KBSectionNav Component
 *
 * Horizontal section navigation for knowledge base detail page.
 * Four sections: Home, Data, Intelligence, Search & Test.
 */

import { useTranslations } from 'next-intl';
import { Home, Database, Brain, Search } from 'lucide-react';
import { Tabs } from '../../ui/Tabs';

interface KBSectionNavProps {
  activeSection: string;
  onSectionChange: (section: string) => void;
}

export function KBSectionNav({ activeSection, onSectionChange }: KBSectionNavProps) {
  const t = useTranslations('search_ai.nav');

  const sections = [
    { id: 'home', label: t('home'), icon: <Home className="w-3.5 h-3.5" /> },
    { id: 'data', label: t('data'), icon: <Database className="w-3.5 h-3.5" /> },
    {
      id: 'intelligence',
      label: t('intelligence'),
      icon: <Brain className="w-3.5 h-3.5" />,
    },
    {
      id: 'search',
      label: t('search_test'),
      icon: <Search className="w-3.5 h-3.5" />,
    },
  ];

  return (
    <Tabs
      tabs={sections}
      activeTab={activeSection}
      onTabChange={onSectionChange}
      layoutId="kb-section-nav"
      className="px-6"
    />
  );
}
