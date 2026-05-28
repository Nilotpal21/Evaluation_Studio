/**
 * HttpToolWizard Component
 *
 * Multi-step wizard for creating HTTP tools:
 * Step 1: Basic Info (name, description)
 * Step 2: Endpoint Configuration (URL, method, auth)
 * Step 3: Advanced Settings (headers, query params, body)
 */

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { WizardLayout } from './WizardLayout';
import { ToolTypeBadge } from '../ToolTypeBadge';
import { Input } from '../../ui/Input';
import {
  HttpConfigForm,
  validateHttpConfig,
  parseParametersFromHttpConfig,
  type HttpConfig,
} from '../HttpConfigForm';
import { ToolTestPanel } from '../ToolTestPanel';
import { CurlImportDialog } from '../CurlImportDialog';
import { AlertCircle, FileCode, Globe, Settings, ListChecks, Shield } from 'lucide-react';
import { Button } from '../../ui/Button';
import { ReviewSection, ReviewRow } from './ReviewSection';
import { type RuntimeNumericValue, validateToolName } from '../shared-types';

interface HttpToolWizardProps {
  onCancel: () => void;
  onSubmit: (data: { name: string; description: string; httpConfig: HttpConfig }) => Promise<void>;
  projectId?: string | null;
  /** 'create' (default) or 'edit' — controls title, name field disabled, layout */
  mode?: 'create' | 'edit';
  /** Pre-populate form state when editing an existing tool */
  initialData?: { name: string; description: string; config: HttpConfig };
  /** Error messages from failed submission */
  submitErrors?: string[];
  /** Callback to dismiss errors */
  onClearErrors?: () => void;
}

function isPositiveRuntimeNumeric(value: RuntimeNumericValue | undefined): boolean {
  if (typeof value === 'string') return true;
  return (value ?? 0) > 0;
}

function runtimeNumericLabel(value: RuntimeNumericValue | undefined, fallback?: number): string {
  return String(value ?? fallback ?? '');
}

function runtimeDurationLabel(value: RuntimeNumericValue): string {
  if (typeof value === 'string') return value;
  return `${(value / 1000).toFixed(0)}s`;
}

export function HttpToolWizard({
  onCancel,
  onSubmit,
  projectId,
  mode = 'create',
  initialData,
  submitErrors,
  onClearErrors,
}: HttpToolWizardProps) {
  const t = useTranslations('tools.wizard');
  const [currentStep, setCurrentStep] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showCurlImport, setShowCurlImport] = useState(false);
  const [attempted, setAttempted] = useState(false);

  const isEdit = mode === 'edit';

  const STEPS = useMemo(
    () => [
      { id: 'basic', label: t('basic_info_step'), description: t('basic_info_description') },
      { id: 'config', label: t('config_step'), description: t('http_endpoint_description') },
      { id: 'test', label: t('test_step'), description: t('test_review_description') },
    ],
    [t],
  );

  // Form state — initialized from initialData when editing
  const [name, setName] = useState(initialData?.name ?? '');
  const [description, setDescription] = useState(initialData?.description ?? '');
  const [httpConfig, setHttpConfig] = useState<HttpConfig>(
    initialData?.config ?? {
      endpoint: '',
      method: 'GET',
      headers: [],
      queryParams: [],
      authType: 'none',
      retryCount: 0,
      retryDelayMs: 1000,
    },
  );

  const handleCurlImport = (imported: {
    config: Partial<HttpConfig>;
    detectedInputs: string[];
  }) => {
    setHttpConfig((prev) => {
      const merged: HttpConfig = {
        ...prev,
        ...imported.config,
        // Preserve retry settings from prev (import never carries these).
        retryCount: prev.retryCount,
        retryDelayMs: prev.retryDelayMs,
      };
      // Auto-generate parameter stubs for any {{input.X}} references found in
      // the imported URL / headers / query / body / auth so the user doesn't
      // have to click "Parse" afterwards.
      merged.parameters = parseParametersFromHttpConfig(merged);
      return merged;
    });
    // Jump straight to the Configuration step — Basic Info is untouched and
    // users expect to see the imported config immediately.
    if (currentStep === 0) setCurrentStep(1);
  };

  const nameError = validateToolName(name.trim(), t);

  const getStepErrors = (): string[] => {
    switch (currentStep) {
      case 0: {
        const errs: string[] = [];
        if (!name.trim()) errs.push('Tool name is required');
        else if (name.trim().length < 2) errs.push('Tool name must be at least 2 characters');
        else if (nameError) errs.push(nameError);
        if (!description.trim()) errs.push('Description is required');
        return errs;
      }
      case 1: {
        const configErrors = validateHttpConfig(httpConfig);
        return Object.values(configErrors);
      }
      case 2:
        return [];
      default:
        return [];
    }
  };

  const stepErrors = attempted ? getStepErrors() : [];
  const canGoNext = getStepErrors().length === 0;

  const handleNext = async () => {
    setAttempted(true);
    const errors = getStepErrors();
    if (errors.length > 0) return;

    if (currentStep < STEPS.length - 1) {
      setAttempted(false);
      setCurrentStep(currentStep + 1);
    } else {
      setIsSubmitting(true);
      try {
        await onSubmit({ name: name.trim(), description: description.trim(), httpConfig });
      } finally {
        setIsSubmitting(false);
      }
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      setAttempted(false);
      setCurrentStep(currentStep - 1);
    }
  };

  const renderStepContent = () => {
    switch (currentStep) {
      case 0: // Basic Info
        return (
          <div className="space-y-4">
            <Input
              label={t('tool_name_label')}
              placeholder="weather_api"
              value={name}
              onChange={(e) => setName(e.target.value)}
              error={
                attempted && !name.trim()
                  ? 'Tool name is required'
                  : name.length > 0
                    ? nameError
                    : undefined
              }
              disabled={isEdit}
            />
            <Input
              label={t('description_label')}
              placeholder="Fetches weather data from OpenWeather API"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              error={
                attempted && !description.trim()
                  ? 'Description is required'
                  : description.length > 0 && !description.trim()
                    ? 'Description is required'
                    : undefined
              }
            />
            <p className="text-xs text-muted mt-2">{t('http_name_hint')}</p>
          </div>
        );

      case 1: // Configuration
        return (
          <div className="space-y-4">
            {/* cURL Import Button */}
            <div className="flex items-center justify-between pb-3 border-b border-default">
              <div>
                <h3 className="text-sm font-medium text-foreground">{t('http_config_title')}</h3>
                <p className="text-xs text-muted mt-1">{t('http_config_hint')}</p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                icon={<FileCode className="w-3.5 h-3.5" />}
                onClick={() => setShowCurlImport(true)}
              >
                {t('import_from_curl')}
              </Button>
            </div>

            <HttpConfigForm config={httpConfig} onChange={setHttpConfig} projectId={projectId} />
          </div>
        );

      case 2: {
        // Test & Review
        const params = httpConfig.parameters ?? [];
        const headers = httpConfig.headers?.filter((h) => h.key.trim()) ?? [];
        const queryParams = httpConfig.queryParams?.filter((q) => q.key.trim()) ?? [];
        const hasRetry = isPositiveRuntimeNumeric(httpConfig.retryCount);
        const hasResilience =
          hasRetry || httpConfig.rateLimitPerMinute != null || !!httpConfig.circuitBreaker;

        return (
          <div className="space-y-4">
            {/* Tool Identity */}
            <ReviewSection
              icon={<Globe className="w-4 h-4" />}
              title="Tool Identity"
              badge={httpConfig.method}
              editStep={0}
              onEdit={(step) => setCurrentStep(step)}
            >
              <ReviewRow label="Name" value={name} mono />
              {description && <ReviewRow label="Description" value={description} />}
              <ReviewRow label="Type" value="HTTP" />
            </ReviewSection>

            {/* Endpoint Configuration */}
            <ReviewSection
              icon={<Settings className="w-4 h-4" />}
              title="Endpoint Configuration"
              editStep={1}
              onEdit={(step) => setCurrentStep(step)}
            >
              <ReviewRow label="URL" value={httpConfig.endpoint} mono />
              <ReviewRow
                label="Auth"
                value={
                  httpConfig.authType === 'none' ? 'None' : httpConfig.authType.replace(/_/g, ' ')
                }
              />
              {headers.length > 0 && (
                <ReviewRow
                  label="Headers"
                  value={`${headers.length} custom header${headers.length > 1 ? 's' : ''}`}
                />
              )}
              {queryParams.length > 0 && (
                <ReviewRow
                  label="Query Params"
                  value={`${queryParams.length} static param${queryParams.length > 1 ? 's' : ''}`}
                />
              )}
            </ReviewSection>

            {/* Input Parameters */}
            {params.length > 0 && (
              <ReviewSection
                icon={<ListChecks className="w-4 h-4" />}
                title="Input Parameters"
                badge={`${params.length}`}
                editStep={1}
                onEdit={(step) => setCurrentStep(step)}
              >
                {params.map((p) => (
                  <div key={p.name} className="flex items-center gap-2 text-xs">
                    <code className="font-mono text-foreground">{p.name}</code>
                    <span className="text-muted">{p.type}</span>
                    {p.required && (
                      <span className="text-xs text-error/70 font-medium">required</span>
                    )}
                    {!p.required && <span className="text-xs text-muted">optional</span>}
                    {p.description && (
                      <span className="text-muted truncate max-w-xs">{p.description}</span>
                    )}
                  </div>
                ))}
              </ReviewSection>
            )}

            {/* Resilience */}
            {hasResilience && (
              <ReviewSection
                icon={<Shield className="w-4 h-4" />}
                title="Resilience"
                editStep={1}
                onEdit={(step) => setCurrentStep(step)}
              >
                {hasRetry && (
                  <ReviewRow
                    label="Retry"
                    value={`${runtimeNumericLabel(httpConfig.retryCount, 0)} attempt${httpConfig.retryCount === 1 ? '' : 's'}, ${runtimeNumericLabel(httpConfig.retryDelayMs, 1000)}ms delay`}
                  />
                )}
                {httpConfig.rateLimitPerMinute != null && (
                  <ReviewRow label="Rate Limit" value={`${httpConfig.rateLimitPerMinute}/min`} />
                )}
                {httpConfig.circuitBreaker && (
                  <ReviewRow
                    label="Circuit Breaker"
                    value={`threshold ${httpConfig.circuitBreaker.threshold}, reset ${runtimeDurationLabel(httpConfig.circuitBreaker.resetMs)}`}
                  />
                )}
              </ReviewSection>
            )}

            {/* Test Panel */}
            <div className="border border-default rounded-lg p-4 bg-background-elevated">
              <h3 className="text-sm font-semibold text-foreground mb-4">
                {t('test_tool_optional')}
              </h3>
              <p className="text-xs text-muted mb-4">{t('test_http_hint')}</p>
              <div className="flex items-center gap-2 p-3 rounded-lg bg-background-muted border border-default">
                <AlertCircle className="w-4 h-4 text-warning" />
                <span className="text-xs text-muted">{t('test_after_creation')}</span>
              </div>
            </div>
          </div>
        );
      }

      default:
        return null;
    }
  };

  return (
    <>
      <WizardLayout
        title={isEdit ? t('edit_http_title') : t('http_title')}
        badge={<ToolTypeBadge type="http" />}
        steps={STEPS}
        currentStep={currentStep}
        canGoNext={canGoNext}
        canGoBack={currentStep > 0}
        isLastStep={currentStep === STEPS.length - 1}
        isSubmitting={isSubmitting}
        onNext={handleNext}
        onBack={handleBack}
        onCancel={onCancel}
        submitLabel={isEdit ? t('save_changes') : undefined}
        cancelLabel={isEdit ? t('cancel') : undefined}
        inline={isEdit}
        submitErrors={submitErrors}
        onClearErrors={onClearErrors}
        onStepClick={(step) => {
          setAttempted(false);
          setCurrentStep(step);
        }}
        hasUnsavedChanges={name.trim().length > 0 || httpConfig.endpoint.length > 0}
        stepErrors={stepErrors}
      >
        {renderStepContent()}
      </WizardLayout>

      <CurlImportDialog
        isOpen={showCurlImport}
        onClose={() => setShowCurlImport(false)}
        onImport={handleCurlImport}
      />
    </>
  );
}
