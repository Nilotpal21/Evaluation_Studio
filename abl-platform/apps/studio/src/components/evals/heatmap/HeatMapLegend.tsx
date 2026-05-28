/**
 * HeatMapLegend Component
 *
 * Horizontal color gradient legend showing the score scale from 1.0 to 5.0
 * with four color stops: error (red), warning (yellow), accent (blue), success (green).
 */

import { useTranslations } from 'next-intl';
import { Tooltip } from '../../ui/Tooltip';

export function HeatMapLegend() {
  const t = useTranslations('evals');
  return (
    <div className="flex items-center gap-3 mt-4">
      <span className="text-xs text-muted whitespace-nowrap shrink-0">
        {t('heatmap.legend_label')}
      </span>

      {/* Bar + tick labels stacked, tooltip on the whole block */}
      <Tooltip content={t('heatmap.legend_tooltip')} side="top">
        <div className="flex-1 max-w-xs cursor-help space-y-1">
          {/* Color segments */}
          <div className="flex h-3 rounded overflow-hidden">
            <div className="flex-1 bg-error-subtle" />
            <div className="flex-1 bg-warning-subtle" />
            <div className="flex-1 bg-accent-subtle" />
            <div className="flex-1 bg-success-subtle" />
          </div>
          {/* Tick labels aligned to each segment boundary */}
          <div className="relative flex">
            {['1.0', '2.0', '3.0', '4.0', '5.0'].map((label, i) => (
              <span
                key={label}
                className="flex-1 text-xs text-muted"
                style={{ textAlign: i === 0 ? 'left' : i === 4 ? 'right' : 'center' }}
              >
                {label}
              </span>
            ))}
          </div>
        </div>
      </Tooltip>
    </div>
  );
}
