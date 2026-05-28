/**
 * McpToolWizard Component
 *
 * Multi-step wizard for creating MCP tools:
 * Step 1: Basic Info (name, description)
 * Step 2: Server Configuration (URL, transport, auth)
 * Step 3: Review
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { WizardLayout } from './WizardLayout';
import { ToolTypeBadge } from '../ToolTypeBadge';
import { Input } from '../../ui/Input';
import { McpConfigForm, validateMcpConfig, type McpConfig } from '../McpConfigForm';
import { AlertCircle, Plug, Server } from 'lucide-react';
import { ReviewSection, ReviewRow } from './ReviewSection';
import { validateToolName } from '../shared-types';

const STEPS = [
  { id: 'basic', label: 'Basic Info', description: 'Tool name and description' },
  { id: 'server', label: 'Configuration', description: 'MCP server and authentication' },
  { id: 'test', label: 'Test & Review', description: 'Review before creating' },
];

interface McpToolWizardProps {
  onCancel: () => void;
  onSubmit: (data: { name: string; description: string; mcpConfig: McpConfig }) => Promise<void>;
  mode?: 'create' | 'edit';
  initialData?: { name: string; description: string; config: McpConfig };
  /** Error messages from failed submission */
  submitErrors?: string[];
  /** Callback to dismiss errors */
  onClearErrors?: () => void;
}

export function McpToolWizard({
  onCancel,
  onSubmit,
  mode = 'create',
  initialData,
  submitErrors,
  onClearErrors,
}: McpToolWizardProps) {
  const t = useTranslations('tools.wizard');
  const [currentStep, setCurrentStep] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isEdit = mode === 'edit';

  // Form state — initialized from initialData when editing
  const [name, setName] = useState(initialData?.name ?? '');
  const [description, setDescription] = useState(initialData?.description ?? '');
  const [mcpConfig, setMcpConfig] = useState<McpConfig>(
    initialData?.config ?? {
      serverUrl: '',
      transportType: 'sse',
      headers: [],
      serverToolName: '',
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
        const configErrors = validateMcpConfig(mcpConfig);
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
        await onSubmit({ name: name.trim(), description: description.trim(), mcpConfig });
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
              label="Tool Name"
              placeholder="search_documents"
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
              placeholder="Searches documents via MCP server"
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
            <p className="text-xs text-muted mt-2">Name the tool that will be exposed to agents.</p>
          </div>
        );

      case 1: // Configuration
        return (
          <div>
            <McpConfigForm config={mcpConfig} onChange={setMcpConfig} />
          </div>
        );

      case 2: // Test & Review
        return (
          <div className="space-y-4">
            {/* Tool Identity */}
            <ReviewSection
              icon={<Plug className="w-4 h-4" />}
              title="Tool Identity"
              editStep={0}
              onEdit={(step) => setCurrentStep(step)}
            >
              <ReviewRow label="Name" value={name} mono />
              {description && <ReviewRow label="Description" value={description} />}
              <ReviewRow label="Type" value="MCP (Remote)" />
            </ReviewSection>

            {/* Server Configuration */}
            <ReviewSection
              icon={<Server className="w-4 h-4" />}
              title="Server Configuration"
              editStep={1}
              onEdit={(step) => setCurrentStep(step)}
            >
              <ReviewRow label="Server URL" value={mcpConfig.serverUrl} mono />
              <ReviewRow label="Transport" value={mcpConfig.transportType.toUpperCase()} />
              {mcpConfig.serverToolName && (
                <ReviewRow label="Remote Tool" value={mcpConfig.serverToolName} mono />
              )}
            </ReviewSection>

            {/* Test Panel */}
            <div className="border border-default rounded-lg p-4 bg-background-elevated">
              <h3 className="text-sm font-semibold text-foreground mb-4">Test Tool (Optional)</h3>
              <p className="text-xs text-muted mb-4">
                Test your MCP tool before creating it. You can also test after creation in the Test
                tab.
              </p>
              <div className="flex items-center gap-2 p-3 rounded-lg bg-background-muted border border-default">
                <AlertCircle className="w-4 h-4 text-warning" />
                <span className="text-xs text-muted">
                  Testing is available after tool creation. Click &quot;Create Tool&quot; to
                  proceed.
                </span>
              </div>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <WizardLayout
      title={isEdit ? t('edit_mcp_title') : t('mcp_title')}
      badge={<ToolTypeBadge type="mcp" />}
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
      hasUnsavedChanges={name.trim().length > 0 || mcpConfig.serverUrl.length > 0}
      stepErrors={stepErrors}
    >
      {renderStepContent()}
    </WizardLayout>
  );
}
