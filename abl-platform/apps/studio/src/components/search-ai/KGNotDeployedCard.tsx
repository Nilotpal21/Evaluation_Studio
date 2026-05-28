/**
 * KGNotDeployedCard Component
 *
 * Informational card shown when Neo4j is not provisioned.
 * No action buttons — just information and "contact admin" guidance.
 */

'use client';

import { Network, CheckCircle, Info } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Card } from '../ui/Card';

const BENEFITS = [
  'not_deployed_benefit_classify',
  'not_deployed_benefit_extract',
  'not_deployed_benefit_graph',
  'not_deployed_benefit_search',
] as const;

export function KGNotDeployedCard() {
  const t = useTranslations('search_ai.kg');

  return (
    <div className="py-12 flex justify-center">
      <Card className="max-w-lg w-full p-8">
        <div className="flex flex-col items-center text-center">
          <div className="w-12 h-12 rounded-xl bg-purple/10 flex items-center justify-center mb-4">
            <Network className="w-6 h-6 text-purple" />
          </div>

          <h3 className="text-lg font-semibold mb-2">{t('not_deployed_title')}</h3>

          {/* Info banner — neutral background, NOT error red */}
          <div className="w-full rounded-lg bg-background-muted p-4 mb-6 text-left">
            <div className="flex items-start gap-3">
              <Info className="w-5 h-5 text-muted shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium mb-1">{t('not_deployed_banner_title')}</p>
                <p className="text-xs text-muted">{t('not_deployed_banner_description')}</p>
              </div>
            </div>
          </div>

          <p className="text-sm text-muted mb-6">{t('not_deployed_contact_admin')}</p>

          {/* What you'll get */}
          <div className="w-full space-y-3 text-left">
            {BENEFITS.map((key) => (
              <div key={key} className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-success/10 flex items-center justify-center shrink-0">
                  <CheckCircle className="w-4 h-4 text-success" />
                </div>
                <span className="text-sm">{t(key)}</span>
              </div>
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
}
