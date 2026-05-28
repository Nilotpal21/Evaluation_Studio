'use client';

/**
 * SimpleConstructModal
 *
 * A simplified modal for inserting basic DSL constructs like gather fields,
 * flow steps, memory vars, constraints, and handoffs. This is a placeholder
 * implementation that provides basic functionality with room for enhancement.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import * as RadixDialog from '@radix-ui/react-dialog';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { springs, transitions } from '../../../lib/animation';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import {
  generateGatherFieldSnippet,
  generateFlowStepSnippet,
  generateMemoryVarSnippet,
  generateConstraintSnippet,
  generateHandoffSnippet,
} from '../commands/SnippetGenerator';

type ConstructType = 'field' | 'step' | 'memory' | 'constraint' | 'handoff';

interface SimpleConstructModalProps {
  open: boolean;
  onClose: () => void;
  onInsert: (snippet: string) => void;
  type: ConstructType;
}

export function SimpleConstructModal({ open, onClose, onInsert, type }: SimpleConstructModalProps) {
  const t = useTranslations('agent_editor.construct_modal');
  const [name, setName] = useState('');
  const [config, setConfig] = useState<Record<string, any>>({});

  const handleInsert = () => {
    let snippet = '';

    switch (type) {
      case 'field':
        snippet = generateGatherFieldSnippet({
          name: name || 'field_name',
          type: config.type || 'string',
          prompt: config.prompt || 'Enter value',
          required: config.required ?? true,
        });
        break;

      case 'step':
        snippet = generateFlowStepSnippet({
          name: name || 'step_name',
          reasoning: config.reasoning ?? false,
          goal: config.goal,
          respond: config.respond,
          then: config.then,
        });
        break;

      case 'memory':
        snippet = generateMemoryVarSnippet({
          name: name || 'var_name',
          type: config.type || 'string',
          initialValue: config.initialValue,
        });
        break;

      case 'constraint':
        snippet = generateConstraintSnippet({
          phase: config.phase || 'pre',
          severity: config.severity || 'REQUIRE',
          condition: config.condition || 'true',
          onFail: config.onFail || 'Action required',
        });
        break;

      case 'handoff':
        snippet = generateHandoffSnippet({
          to: config.to || 'AgentName',
          when: config.when || 'input contains "lookup"',
          priority: config.priority,
        });
        break;
    }

    onInsert(snippet);
    onClose();
    // Reset form
    setName('');
    setConfig({});
  };

  const renderForm = () => {
    switch (type) {
      case 'field':
        return (
          <>
            <Input
              label={t('field_name_label')}
              placeholder="customer_name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Input
              label={t('field_type_label')}
              placeholder="string"
              value={config.type || ''}
              onChange={(e) => setConfig({ ...config, type: e.target.value })}
            />
            <Input
              label={t('field_prompt_label')}
              placeholder="What is your name?"
              value={config.prompt || ''}
              onChange={(e) => setConfig({ ...config, prompt: e.target.value })}
            />
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={config.required ?? true}
                onChange={(e) => setConfig({ ...config, required: e.target.checked })}
                className="rounded border-default"
              />
              {t('field_required_label')}
            </label>
          </>
        );

      case 'step':
        return (
          <>
            <Input
              label={t('step_name_label')}
              placeholder="welcome"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={config.reasoning ?? false}
                onChange={(e) => setConfig({ ...config, reasoning: e.target.checked })}
                className="rounded border-default"
              />
              {t('step_reasoning_label')}
            </label>
            {config.reasoning ? (
              <Input
                label={t('step_goal_label')}
                placeholder="Help user with..."
                value={config.goal || ''}
                onChange={(e) => setConfig({ ...config, goal: e.target.value })}
              />
            ) : (
              <Input
                label={t('step_respond_label')}
                placeholder="Hello! How can I help?"
                value={config.respond || ''}
                onChange={(e) => setConfig({ ...config, respond: e.target.value })}
              />
            )}
            <Input
              label={t('step_then_label')}
              placeholder="next_step"
              value={config.then || ''}
              onChange={(e) => setConfig({ ...config, then: e.target.value })}
            />
          </>
        );

      case 'memory':
        return (
          <>
            <Input
              label={t('memory_var_name_label')}
              placeholder="user_preference"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Input
              label={t('memory_type_label')}
              placeholder="string"
              value={config.type || ''}
              onChange={(e) => setConfig({ ...config, type: e.target.value })}
            />
            <Input
              label={t('memory_initial_value_label')}
              placeholder="default"
              value={config.initialValue || ''}
              onChange={(e) => setConfig({ ...config, initialValue: e.target.value })}
            />
          </>
        );

      case 'constraint':
        return (
          <>
            <div>
              <label className="text-sm font-medium text-foreground mb-1 block">
                {t('phase_label')}
              </label>
              <select
                value={config.phase || 'pre'}
                onChange={(e) => setConfig({ ...config, phase: e.target.value })}
                className="w-full px-3 py-2 bg-background-muted border border-default rounded-lg text-foreground"
              >
                <option value="pre">{t('phase_pre')}</option>
                <option value="post">{t('phase_post')}</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium text-foreground mb-1 block">
                {t('severity_label')}
              </label>
              <select
                value={config.severity || 'REQUIRE'}
                onChange={(e) => setConfig({ ...config, severity: e.target.value })}
                className="w-full px-3 py-2 bg-background-muted border border-default rounded-lg text-foreground"
              >
                <option value="REQUIRE">{t('severity_require')}</option>
                <option value="WARN">{t('severity_warn')}</option>
              </select>
            </div>
            <Input
              label={t('condition_label')}
              placeholder="value > 0"
              value={config.condition || ''}
              onChange={(e) => setConfig({ ...config, condition: e.target.value })}
            />
            <Input
              label={t('on_fail_label')}
              placeholder="Value must be positive"
              value={config.onFail || ''}
              onChange={(e) => setConfig({ ...config, onFail: e.target.value })}
            />
          </>
        );

      case 'handoff':
        return (
          <>
            <Input
              label={t('to_agent_label')}
              placeholder="SupportAgent"
              value={config.to || ''}
              onChange={(e) => setConfig({ ...config, to: e.target.value })}
            />
            <Input
              label={t('when_label')}
              placeholder='input contains "lookup"'
              value={config.when || ''}
              onChange={(e) => setConfig({ ...config, when: e.target.value })}
            />
            <Input
              label={t('priority_label')}
              type="number"
              placeholder="5"
              value={config.priority || ''}
              onChange={(e) =>
                setConfig({ ...config, priority: parseInt(e.target.value) || undefined })
              }
            />
          </>
        );
    }
  };

  return (
    <RadixDialog.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <AnimatePresence>
        {open && (
          <RadixDialog.Portal forceMount>
            <RadixDialog.Overlay asChild>
              <motion.div
                className="fixed inset-0 z-50 bg-overlay backdrop-blur-sm"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={transitions.backdrop}
              />
            </RadixDialog.Overlay>

            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <RadixDialog.Content
                asChild
                onEscapeKeyDown={() => onClose()}
                onPointerDownOutside={() => onClose()}
              >
                <motion.div
                  className="relative w-full max-w-md bg-background-elevated border border-default rounded-2xl shadow-xl bg-noise"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={springs.default}
                >
                  {/* Header */}
                  <div className="flex items-center justify-between px-6 py-4 border-b border-default">
                    <RadixDialog.Title className="text-lg font-semibold text-foreground">
                      {t(`title_${type}`)}
                    </RadixDialog.Title>
                    <RadixDialog.Close asChild>
                      <button
                        className="p-1.5 text-muted hover:text-foreground hover:bg-background-muted rounded-lg transition-default"
                        aria-label="Close dialog"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </RadixDialog.Close>
                  </div>

                  {/* Form */}
                  <div className="px-6 py-4 space-y-4">{renderForm()}</div>

                  {/* Footer */}
                  <div className="px-6 py-4 border-t border-default flex gap-3 justify-end">
                    <Button variant="secondary" onClick={onClose}>
                      {t('cancel')}
                    </Button>
                    <Button
                      variant="primary"
                      onClick={handleInsert}
                      disabled={!name && type !== 'constraint' && type !== 'handoff'}
                    >
                      {t('insert')}
                    </Button>
                  </div>
                </motion.div>
              </RadixDialog.Content>
            </div>
          </RadixDialog.Portal>
        )}
      </AnimatePresence>
    </RadixDialog.Root>
  );
}
