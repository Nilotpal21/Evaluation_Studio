/**
 * WizardLayout Component
 *
 * Multi-step wizard layout with progress indicator, navigation, and step content.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft, ArrowRight, Check, AlertCircle, X } from 'lucide-react';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { PageHeader } from '../../ui/PageHeader';

interface WizardStep {
  id: string;
  label: string;
  description?: string;
}

interface WizardLayoutProps {
  title: string;
  badge?: React.ReactNode;
  steps: WizardStep[];
  currentStep: number;
  canGoNext: boolean;
  canGoBack: boolean;
  isLastStep: boolean;
  isSubmitting: boolean;
  onNext: () => void;
  onBack: () => void;
  onCancel: () => void;
  children: React.ReactNode;
  /** Override the submit button label (default: "Create Tool") */
  submitLabel?: string;
  /** Override the cancel/back link label (default: "Tools") */
  cancelLabel?: string;
  /** Suppress outer chrome (back link, PageHeader) for embedded use in edit mode */
  inline?: boolean;
  /** Error messages to display above navigation */
  submitErrors?: string[];
  /** Callback to dismiss errors */
  onClearErrors?: () => void;
  /** Callback when a step circle is clicked — enables step navigation */
  onStepClick?: (stepIndex: number) => void;
  /** Whether the form has unsaved changes (triggers confirm dialog on cancel) */
  hasUnsavedChanges?: boolean;
  /** Step-level validation errors to show when user clicks Next on an invalid step */
  stepErrors?: string[];
}

export function WizardLayout({
  title,
  badge,
  steps,
  currentStep,
  canGoNext,
  canGoBack,
  isLastStep,
  isSubmitting,
  onNext,
  onBack,
  onCancel,
  children,
  submitLabel,
  cancelLabel,
  inline,
  submitErrors,
  onClearErrors,
  onStepClick,
  hasUnsavedChanges,
  stepErrors,
}: WizardLayoutProps) {
  const t = useTranslations('tools.wizard');
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);

  const handleCancelClick = () => {
    if (hasUnsavedChanges) {
      setShowLeaveConfirm(true);
    } else {
      onCancel();
    }
  };

  return (
    <div className={inline ? '' : 'h-full overflow-y-auto'}>
      <div className={inline ? 'py-2' : 'max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8'}>
        {/* Back button — hidden in inline mode */}
        {!inline && (
          <button
            onClick={handleCancelClick}
            className="flex items-center gap-1 text-sm text-muted hover:text-foreground transition-default mb-4"
          >
            <ArrowLeft className="w-4 h-4" />
            {cancelLabel || t('back_to_tools')}
          </button>
        )}

        {/* Header — hidden in inline mode */}
        {!inline && (
          <div className="flex items-center gap-3 mb-2">
            <PageHeader
              title={title}
              description={t('step_of', { current: currentStep + 1, total: steps.length })}
            />
            {badge}
          </div>
        )}

        {/* Progress Steps */}
        <div className="mt-8 mb-8">
          <div className="flex items-center justify-between">
            {steps.map((step, index) => {
              const isActive = index === currentStep;
              const isCompleted = index < currentStep;
              const isUpcoming = index > currentStep;

              return (
                <div key={step.id} className="flex-1 flex items-center">
                  {/* Step circle */}
                  <div className="relative flex flex-col items-center">
                    <button
                      type="button"
                      onClick={() => {
                        if (index <= currentStep && onStepClick) {
                          onStepClick(index);
                        }
                      }}
                      disabled={isUpcoming}
                      className={`
                        w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium transition-all
                        ${isCompleted ? 'bg-accent text-accent-foreground cursor-pointer hover:ring-2 hover:ring-accent/30' : ''}
                        ${isActive ? 'bg-accent text-accent-foreground ring-4 ring-accent/20' : ''}
                        ${isUpcoming ? 'bg-background-muted text-muted border-2 border-default cursor-not-allowed' : ''}
                      `}
                    >
                      {isCompleted ? <Check className="w-5 h-5" /> : index + 1}
                    </button>
                    {/* Step label */}
                    <div className="absolute top-12 left-1/2 -translate-x-1/2 whitespace-nowrap">
                      <p
                        className={`text-xs font-medium ${isActive ? 'text-foreground' : 'text-muted'}`}
                      >
                        {step.label}
                      </p>
                    </div>
                  </div>

                  {/* Connector line */}
                  {index < steps.length - 1 && (
                    <div
                      className={`
                        flex-1 h-0.5 mx-2 transition-colors
                        ${index < currentStep ? 'bg-accent' : 'bg-default'}
                      `}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Step content */}
        <div className="mt-16 mb-8">{children}</div>

        {/* Error banner */}
        {submitErrors && submitErrors.length > 0 && (
          <div className="mb-4 rounded-lg border border-error/30 bg-error-subtle p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-error shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                {submitErrors.length === 1 ? (
                  <p className="text-sm text-error">{submitErrors[0]}</p>
                ) : (
                  <ul className="text-sm text-error space-y-1">
                    {submitErrors.map((msg, i) => (
                      <li key={i}>{msg}</li>
                    ))}
                  </ul>
                )}
              </div>
              {onClearErrors && (
                <button
                  type="button"
                  onClick={onClearErrors}
                  className="p-1 text-error/60 hover:text-error transition-default"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Step validation errors — shown when user clicks Next on an invalid step */}
        {stepErrors && stepErrors.length > 0 && (
          <div className="mb-4 rounded-lg border border-error/30 bg-error-subtle p-3">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-error shrink-0 mt-0.5" />
              <ul className="text-sm text-error space-y-0.5">
                {stepErrors.map((msg, i) => (
                  <li key={i}>{msg}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* Navigation buttons */}
        <div className="flex items-center justify-between pt-6 border-t border-default">
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onBack} disabled={!canGoBack}>
              {t('back')}
            </Button>
            {inline && (
              <Button variant="ghost" onClick={handleCancelClick}>
                {cancelLabel || t('back_to_tools')}
              </Button>
            )}
          </div>

          <Button
            variant="primary"
            onClick={onNext}
            loading={isSubmitting}
            icon={isLastStep ? <Check className="w-4 h-4" /> : <ArrowRight className="w-4 h-4" />}
          >
            {isLastStep ? submitLabel || t('create_tool') : t('next')}
          </Button>
        </div>

        {/* Unsaved changes confirmation dialog */}
        <Dialog
          open={showLeaveConfirm}
          onClose={() => setShowLeaveConfirm(false)}
          title="Discard changes?"
          description="You have unsaved changes. Are you sure you want to leave?"
          maxWidth="sm"
        >
          <div className="flex items-center gap-3 justify-end mt-4">
            <Button variant="ghost" onClick={() => setShowLeaveConfirm(false)}>
              Stay
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setShowLeaveConfirm(false);
                onCancel();
              }}
            >
              Discard
            </Button>
          </div>
        </Dialog>
      </div>
    </div>
  );
}
