/**
 * LambdaConfigForm Component
 *
 * Config form for Lambda tool type: function name, runtime, timeout.
 */

import { useTranslations } from 'next-intl';
import { Input } from '../ui/Input';

export interface LambdaConfig {
  functionName: string;
  runtime?: string;
  timeoutMs?: number;
}

interface LambdaConfigFormProps {
  config: LambdaConfig;
  onChange: (config: LambdaConfig) => void;
}

export function LambdaConfigForm({ config, onChange }: LambdaConfigFormProps) {
  const t = useTranslations('tools.lambda_config');
  const update = (field: string, value: unknown) => {
    onChange({ ...config, [field]: value });
  };

  return (
    <div className="space-y-4">
      <Input
        label={t('function_name_label')}
        placeholder={t('function_name_placeholder')}
        value={config.functionName || ''}
        onChange={(e) => update('functionName', e.target.value)}
      />

      <div className="grid grid-cols-2 gap-3">
        <Input
          label={t('runtime_label')}
          placeholder={t('runtime_placeholder')}
          value={config.runtime || ''}
          onChange={(e) => update('runtime', e.target.value)}
        />
        <Input
          label={t('timeout_label')}
          type="number"
          min={1000}
          max={300000}
          value={config.timeoutMs ?? ''}
          placeholder={t('timeout_placeholder')}
          onChange={(e) => update('timeoutMs', parseInt(e.target.value) || undefined)}
        />
      </div>
    </div>
  );
}
