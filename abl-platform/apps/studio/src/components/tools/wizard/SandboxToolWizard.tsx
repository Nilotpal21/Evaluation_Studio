/**
 * SandboxToolWizard Component
 *
 * Multi-step wizard for creating Code/Sandbox tools:
 * Step 1: Basic Info (name, description, runtime)
 * Step 2: Code Editor (write/paste code)
 * Step 3: Parameters (define input parameters)
 */

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { WizardLayout } from './WizardLayout';
import { ToolTypeBadge } from '../ToolTypeBadge';
import { Input } from '../../ui/Input';
import { SandboxConfigForm, validateSandboxConfig, type SandboxConfig } from '../SandboxConfigForm';
import { AlertCircle, Code2, Cpu, ListChecks } from 'lucide-react';
import { ReviewSection, ReviewRow } from './ReviewSection';
import { validateToolName } from '../shared-types';

interface SandboxToolWizardProps {
  onCancel: () => void;
  onSubmit: (data: {
    name: string;
    description: string;
    sandboxConfig: SandboxConfig;
  }) => Promise<void>;
  mode?: 'create' | 'edit';
  initialData?: { name: string; description: string; config: SandboxConfig };
  /** Error messages from failed submission */
  submitErrors?: string[];
  /** Callback to dismiss errors */
  onClearErrors?: () => void;
}

export function SandboxToolWizard({
  onCancel,
  onSubmit,
  mode = 'create',
  initialData,
  submitErrors,
  onClearErrors,
}: SandboxToolWizardProps) {
  const t = useTranslations('tools.wizard');
  const [currentStep, setCurrentStep] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isEdit = mode === 'edit';

  const STEPS = useMemo(
    () => [
      { id: 'basic', label: t('basic_info_step'), description: t('basic_info_description') },
      { id: 'code', label: t('sandbox_code_step'), description: t('sandbox_code_description') },
      { id: 'test', label: t('test_step'), description: t('sandbox_review_description') },
    ],
    [t],
  );

  // Form state — initialized from initialData when editing
  const [name, setName] = useState(initialData?.name ?? '');
  const [description, setDescription] = useState(initialData?.description ?? '');
  const [sandboxConfig, setSandboxConfig] = useState<SandboxConfig>(
    initialData?.config ?? {
      runtime: 'javascript',
      codeContent: '',
      parameters: [],
      memoryMb: 256,
    },
  );

  const [attempted, setAttempted] = useState(false);
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
        const configErrors = validateSandboxConfig(sandboxConfig);
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
        await onSubmit({ name: name.trim(), description: description.trim(), sandboxConfig });
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
              placeholder="calculate_metrics"
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
              placeholder="Calculates various metrics from input data"
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
            <p className="text-xs text-muted mt-2">{t('sandbox_name_hint')}</p>
          </div>
        );

      case 1: // Code & Config
        return (
          <div>
            <SandboxConfigForm config={sandboxConfig} onChange={setSandboxConfig} />
          </div>
        );

      case 2: {
        // Test & Review
        const params = sandboxConfig.parameters ?? [];
        const codeLines = sandboxConfig.codeContent.split('\n');
        const codePreview = codeLines.slice(0, 5).join('\n');
        const moreLines = codeLines.length > 5 ? codeLines.length - 5 : 0;

        return (
          <div className="space-y-4">
            {/* Tool Identity */}
            <ReviewSection
              icon={<Code2 className="w-4 h-4" />}
              title="Tool Identity"
              editStep={0}
              onEdit={(step) => setCurrentStep(step)}
            >
              <ReviewRow label="Name" value={name} mono />
              {description && <ReviewRow label="Description" value={description} />}
              <ReviewRow label="Type" value="Sandbox (Code)" />
            </ReviewSection>

            {/* Runtime & Resources */}
            <ReviewSection
              icon={<Cpu className="w-4 h-4" />}
              title="Runtime & Resources"
              editStep={1}
              onEdit={(step) => setCurrentStep(step)}
            >
              <ReviewRow
                label="Runtime"
                value={sandboxConfig.runtime === 'python' ? 'Python 3' : 'JavaScript (Node.js)'}
              />
              <ReviewRow label="Memory" value={`${sandboxConfig.memoryMb ?? 256} MB`} />
            </ReviewSection>

            {/* Code Preview */}
            <ReviewSection
              icon={<Code2 className="w-4 h-4" />}
              title="Code"
              badge={`${codeLines.length} lines`}
              editStep={1}
              onEdit={(step) => setCurrentStep(step)}
            >
              <pre className="text-xs font-mono text-foreground bg-background-subtle rounded p-2 overflow-x-auto max-h-32">
                {codePreview}
              </pre>
              {moreLines > 0 && (
                <p className="text-xs text-muted">
                  ...{moreLines} more line{moreLines > 1 ? 's' : ''}
                </p>
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
                    {p.required ? (
                      <span className="text-xs text-error/70 font-medium">required</span>
                    ) : (
                      <span className="text-xs text-muted">optional</span>
                    )}
                    {p.description && (
                      <span className="text-muted truncate max-w-xs">{p.description}</span>
                    )}
                  </div>
                ))}
              </ReviewSection>
            )}

            {/* Test Panel */}
            <div className="border border-default rounded-lg p-4 bg-background-elevated">
              <h3 className="text-sm font-semibold text-foreground mb-4">
                {t('test_tool_optional')}
              </h3>
              <p className="text-xs text-muted mb-4">{t('test_sandbox_hint')}</p>
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
    <WizardLayout
      title={isEdit ? t('edit_sandbox_title') : t('sandbox_title')}
      badge={<ToolTypeBadge type="sandbox" />}
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
      hasUnsavedChanges={name.trim().length > 0 || sandboxConfig.codeContent.trim().length > 0}
      stepErrors={stepErrors}
    >
      {renderStepContent()}
    </WizardLayout>
  );
}
