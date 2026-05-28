/**
 * KGEnableCard Component
 *
 * Shown when knowledge graph is not enabled for the index.
 * Displays benefits and a toggle to enable KG enrichment.
 */

'use client';

import { useState } from 'react';
import { Network, FileSearch, GitBranch, Search, CheckCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Card } from '../ui/Card';
import { Toggle } from '../ui/Toggle';
import { updateIndexKGEnabled } from '../../api/search-ai';

interface KGEnableCardProps {
  indexId: string;
  onEnabled: () => void;
}

const BENEFITS = [
  { icon: FileSearch, key: 'enable_benefit_classify' },
  { icon: Network, key: 'enable_benefit_extract' },
  { icon: GitBranch, key: 'enable_benefit_graph' },
  { icon: Search, key: 'enable_benefit_search' },
] as const;

export function KGEnableCard({ indexId, onEnabled }: KGEnableCardProps) {
  const t = useTranslations('search_ai.kg');
  const [isToggling, setIsToggling] = useState(false);

  const handleToggle = async (enabled: boolean) => {
    if (!enabled) return;
    setIsToggling(true);
    try {
      await updateIndexKGEnabled(indexId, true);
      toast.success(t('enable_success'));
      onEnabled();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setIsToggling(false);
    }
  };

  return (
    <div className="py-12 flex justify-center">
      <Card className="max-w-lg w-full p-8">
        <div className="flex flex-col items-center text-center">
          <div className="w-12 h-12 rounded-xl bg-purple/10 flex items-center justify-center mb-4">
            <Network className="w-6 h-6 text-purple" />
          </div>

          <h3 className="text-lg font-semibold mb-2">{t('enable_title')}</h3>
          <p className="text-sm text-muted mb-6">{t('enable_description')}</p>

          <div className="w-full space-y-3 mb-8 text-left">
            {BENEFITS.map(({ icon: Icon, key }) => (
              <div key={key} className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-success/10 flex items-center justify-center shrink-0">
                  <CheckCircle className="w-4 h-4 text-success" />
                </div>
                <span className="text-sm">{t(key)}</span>
              </div>
            ))}
          </div>

          <Toggle
            checked={false}
            onChange={handleToggle}
            label={t('enable_toggle_label')}
            disabled={isToggling}
          />
        </div>
      </Card>
    </div>
  );
}
