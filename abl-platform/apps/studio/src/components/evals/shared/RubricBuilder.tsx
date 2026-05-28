/**
 * RubricBuilder — Visual editor for scoring rubric points (R2).
 *
 * Supports 1-5 scale and pass-fail scale types. Each point has
 * a numeric value, label, and criteria text.
 */

import { useTranslations } from 'next-intl';
import { Plus, Trash2, GripVertical } from 'lucide-react';
import { Input } from '../../ui/Input';
import { Textarea } from '../../ui/Textarea';
import { Button } from '../../ui/Button';

interface RubricPoint {
  value: number;
  label: string;
  criteria: string;
}

interface RubricBuilderProps {
  scaleType: '1-5' | 'pass-fail';
  points: RubricPoint[];
  onChange: (points: RubricPoint[]) => void;
  onScaleTypeChange: (type: '1-5' | 'pass-fail') => void;
}

const DEFAULT_1_5_POINTS: RubricPoint[] = [
  { value: 1, label: 'Poor', criteria: 'Response is incorrect, irrelevant, or harmful.' },
  { value: 2, label: 'Below Average', criteria: 'Significant issues that affect usability.' },
  { value: 3, label: 'Average', criteria: 'Partially addresses the request with notable gaps.' },
  { value: 4, label: 'Good', criteria: 'Mostly correct with minor issues.' },
  { value: 5, label: 'Excellent', criteria: 'Fully correct, complete, and well-structured.' },
];

const DEFAULT_PASS_FAIL_POINTS: RubricPoint[] = [
  { value: 0, label: 'Fail', criteria: 'Does not meet the required standard.' },
  { value: 1, label: 'Pass', criteria: 'Meets or exceeds the required standard.' },
];

export function RubricBuilder({
  scaleType,
  points,
  onChange,
  onScaleTypeChange,
}: RubricBuilderProps) {
  const t = useTranslations('evals');

  const handleScaleChange = (newType: '1-5' | 'pass-fail') => {
    onScaleTypeChange(newType);
    onChange(newType === '1-5' ? DEFAULT_1_5_POINTS : DEFAULT_PASS_FAIL_POINTS);
  };

  const updatePoint = (index: number, field: keyof RubricPoint, value: string | number) => {
    const updated = [...points];
    updated[index] = { ...updated[index], [field]: value };
    onChange(updated);
  };

  const addPoint = () => {
    const maxVal = Math.max(...points.map((p) => p.value), 0);
    onChange([...points, { value: maxVal + 1, label: '', criteria: '' }]);
  };

  const removePoint = (index: number) => {
    if (points.length <= 2) return;
    onChange(points.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium text-foreground">{t('rubric.scale_type')}</label>
        <div className="flex rounded-lg border border-default overflow-hidden">
          <button
            type="button"
            onClick={() => handleScaleChange('1-5')}
            className={`px-3 py-1.5 text-xs font-medium transition-default ${
              scaleType === '1-5'
                ? 'bg-accent text-accent-foreground'
                : 'bg-background-subtle text-muted hover:text-foreground'
            }`}
          >
            {t('rubric.scale_1_5')}
          </button>
          <button
            type="button"
            onClick={() => handleScaleChange('pass-fail')}
            className={`px-3 py-1.5 text-xs font-medium border-l border-default transition-default ${
              scaleType === 'pass-fail'
                ? 'bg-accent text-accent-foreground'
                : 'bg-background-subtle text-muted hover:text-foreground'
            }`}
          >
            {t('rubric.scale_pass_fail')}
          </button>
        </div>
      </div>

      <div className="space-y-2">
        {points.map((point, i) => (
          <div
            key={i}
            className="flex items-start gap-2 p-3 rounded-lg border border-default bg-background-subtle"
          >
            <GripVertical className="w-4 h-4 text-subtle mt-2 shrink-0" />
            <div className="w-12 shrink-0">
              <Input
                placeholder={t('rubric.value_placeholder')}
                type="number"
                value={point.value}
                onChange={(e) => updatePoint(i, 'value', parseInt(e.target.value, 10) || 0)}
              />
            </div>
            <div className="w-28 shrink-0">
              <Input
                placeholder={t('rubric.label_placeholder')}
                value={point.label}
                onChange={(e) => updatePoint(i, 'label', e.target.value)}
              />
            </div>
            <div className="flex-1">
              <Textarea
                placeholder={t('rubric.criteria_placeholder')}
                value={point.criteria}
                onChange={(e) => updatePoint(i, 'criteria', e.target.value)}
                rows={1}
              />
            </div>
            <button
              type="button"
              onClick={() => removePoint(i)}
              disabled={points.length <= 2}
              className="p-1.5 text-muted hover:text-error disabled:opacity-30 transition-default mt-1"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>

      {scaleType === '1-5' && (
        <Button
          variant="ghost"
          size="sm"
          onClick={addPoint}
          icon={<Plus className="w-3.5 h-3.5" />}
        >
          {t('rubric.add_point')}
        </Button>
      )}
    </div>
  );
}

export { DEFAULT_1_5_POINTS, DEFAULT_PASS_FAIL_POINTS };
export type { RubricPoint };
