/**
 * BiasSettingsPanel — Toggle panel for R1 bias mitigation settings.
 *
 * 4 toggles: Position Swap, Blind Evaluation, Cross-Model Judge, Evidence-First.
 */

import { useTranslations } from 'next-intl';
import { Shield } from 'lucide-react';
import { Toggle } from '../../ui/Toggle';

interface BiasSettings {
  positionSwapEnabled: boolean;
  blindEvaluation: boolean;
  crossModelJudge: boolean;
  evidenceFirstMode: boolean;
}

interface BiasSettingsPanelProps {
  settings: BiasSettings;
  onChange: (settings: BiasSettings) => void;
}

export function BiasSettingsPanel({ settings, onChange }: BiasSettingsPanelProps) {
  const t = useTranslations('evals');
  const enabledCount = Object.values(settings).filter(Boolean).length;

  const BIAS_TOGGLES: Array<{
    key: keyof BiasSettings;
    label: string;
    description: string;
  }> = [
    {
      key: 'positionSwapEnabled',
      label: t('bias.position_swap'),
      description: t('bias.position_swap_desc'),
    },
    {
      key: 'blindEvaluation',
      label: t('bias.blind_evaluation'),
      description: t('bias.blind_evaluation_desc'),
    },
    {
      key: 'crossModelJudge',
      label: t('bias.cross_model'),
      description: t('bias.cross_model_desc'),
    },
    {
      key: 'evidenceFirstMode',
      label: t('bias.evidence_first'),
      description: t('bias.evidence_first_desc'),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Shield className="w-4 h-4 text-accent" />
        <span className="text-sm font-medium text-foreground">{t('bias.title')}</span>
        {enabledCount > 0 && (
          <span className="text-xs px-1.5 py-0.5 rounded-full bg-accent-subtle text-accent">
            {enabledCount}/4
          </span>
        )}
      </div>

      <div className="space-y-2">
        {BIAS_TOGGLES.map(({ key, label, description }) => (
          <div
            key={key}
            className="p-2.5 rounded-lg border border-default hover:bg-background-muted transition-default"
          >
            <Toggle
              checked={settings[key]}
              onChange={(val) => onChange({ ...settings, [key]: val })}
              label={label}
              description={description}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export type { BiasSettings };
