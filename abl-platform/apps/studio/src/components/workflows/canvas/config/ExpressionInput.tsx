/**
 * ExpressionInput Component
 *
 * A text input (single-line or multi-line) that supports {{expression}} syntax.
 * - A {⋮} button at the right edge opens the ContextExplorer popover.
 * - Typing {{ auto-opens the ContextExplorer as an inline autocomplete.
 * - Selecting an expression inserts it at the cursor position.
 */

'use client';

import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Braces } from 'lucide-react';
import { clsx } from 'clsx';
import { ContextExplorer } from '../../steps/ContextExplorer';
import { useNodeExpressionContext } from './NodeExpressionContext';
import type { TriggerOption } from '../hooks/useWorkflowExpressionContext';

const POPUP_WIDTH = 400;
const POPUP_MAX_HEIGHT = 480;
const POPUP_MIN_HEIGHT = 200;
const POPUP_GAP = 4;
const VIEWPORT_PADDING = 8;

interface ExpressionInputProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  multiline?: boolean;
  rows?: number;
  description?: string;
  triggers: TriggerOption[];
  previousSteps: Array<{ id: string; name: string; outputSchema?: Record<string, unknown> }>;
  /**
   * Optional data-testid forwarded to the underlying input/textarea so E2E
   * tests can target a specific expression field (e.g. `config-url`,
   * `config-system-prompt`) instead of the generic `expression-input`.
   */
  testId?: string;
}

export function ExpressionInput({
  label,
  value,
  onChange,
  placeholder,
  required,
  multiline,
  rows = 3,
  description,
  triggers,
  previousSteps,
  testId,
}: ExpressionInputProps) {
  const { executionContext } = useNodeExpressionContext();
  const [showExplorer, setShowExplorer] = useState(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [popupPos, setPopupPos] = useState<{
    top?: number;
    bottom?: number;
    right: number;
    maxHeight: number;
  } | null>(null);

  const handleInsertExpression = useCallback(
    (expression: string) => {
      const el = inputRef.current;
      if (!el) {
        onChange(value + expression);
        setShowExplorer(false);
        return;
      }

      const start = el.selectionStart ?? value.length;
      const end = el.selectionEnd ?? value.length;
      // If the user typed {{ to trigger the explorer, those braces are already
      // in the value. The expression from ContextExplorer also starts with {{,
      // so back up 2 chars to overwrite them and avoid {{{{expression}}.
      const hasPendingBraces = start >= 2 && value.slice(start - 2, start) === '{{';
      const insertStart = hasPendingBraces ? start - 2 : start;
      const newValue = value.slice(0, insertStart) + expression + value.slice(end);
      onChange(newValue);
      setShowExplorer(false);

      // Restore cursor after the inserted expression
      requestAnimationFrame(() => {
        const pos = insertStart + expression.length;
        el.setSelectionRange(pos, pos);
        el.focus();
      });
    },
    [value, onChange],
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      onChange(newValue);

      // Auto-open ContextExplorer when user types {{
      const cursorPos = e.target.selectionStart ?? 0;
      if (cursorPos >= 2 && newValue.slice(cursorPos - 2, cursorPos) === '{{') {
        setShowExplorer(true);
      }
    },
    [onChange],
  );

  useEffect(() => {
    if (!showExplorer) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current && containerRef.current.contains(target)) return;
      if (popupRef.current && popupRef.current.contains(target)) return;
      setShowExplorer(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showExplorer]);
  useLayoutEffect(() => {
    if (!showExplorer) {
      setPopupPos(null);
      return;
    }
    const reposition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const right = Math.max(VIEWPORT_PADDING, window.innerWidth - rect.right);

      const spaceBelow = window.innerHeight - rect.bottom - POPUP_GAP - VIEWPORT_PADDING;
      const spaceAbove = rect.top - POPUP_GAP - VIEWPORT_PADDING;
      const shouldFlipAbove = spaceBelow < POPUP_MIN_HEIGHT && spaceAbove > spaceBelow;
      if (shouldFlipAbove) {
        const maxHeight = Math.min(POPUP_MAX_HEIGHT, spaceAbove);
        const bottom = window.innerHeight - rect.top + POPUP_GAP;
        setPopupPos({ bottom, right, maxHeight });
      } else {
        const maxHeight = Math.min(POPUP_MAX_HEIGHT, Math.max(POPUP_MIN_HEIGHT, spaceBelow));
        const top = rect.bottom + POPUP_GAP;
        setPopupPos({ top, right, maxHeight });
      }
    };
    reposition();
    window.addEventListener('resize', reposition);
    document.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      document.removeEventListener('scroll', reposition, true);
    };
  }, [showExplorer]);

  // Close on Escape
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape' && showExplorer) {
        e.stopPropagation();
        setShowExplorer(false);
      }
    },
    [showExplorer],
  );

  const inputClasses = clsx(
    'w-full rounded-md border border-default bg-background-subtle',
    'text-sm text-foreground placeholder:text-subtle',
    'py-2 pl-3 pr-9',
    'focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus',
    'transition-default',
  );

  return (
    <div ref={containerRef} className="relative space-y-1" data-testid="expression-input">
      {label && (
        <label className="block text-xs font-medium text-foreground-muted uppercase tracking-wider">
          {label}
          {required && <span className="text-error ml-0.5">*</span>}
        </label>
      )}
      {description && <p className="text-xs text-subtle">{description}</p>}
      <div className="relative">
        {multiline ? (
          <textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            className={inputClasses}
            value={value}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            rows={rows}
            data-testid={testId}
            title={value || undefined}
          />
        ) : (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            type="text"
            className={inputClasses}
            value={value}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            data-testid={testId}
            title={value || undefined}
          />
        )}
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setShowExplorer(!showExplorer)}
          className={clsx(
            'absolute right-2 top-2 p-0.5 rounded',
            'text-subtle hover:text-accent transition-colors',
            showExplorer && 'text-accent',
          )}
          aria-label="Open expression explorer"
          title="Insert expression"
          data-testid="expression-explorer-btn"
        >
          <Braces className="w-4 h-4" />
        </button>
      </div>
      {showExplorer &&
        popupPos &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popupRef}
            style={{
              position: 'fixed',
              top: popupPos.top,
              bottom: popupPos.bottom,
              right: popupPos.right,
              width: `min(${POPUP_WIDTH}px, calc(100vw - ${VIEWPORT_PADDING * 2}px))`,
              zIndex: 50,
            }}
          >
            <ContextExplorer
              triggers={triggers}
              previousSteps={previousSteps}
              executionContext={executionContext}
              onSelect={handleInsertExpression}
              style={{ maxHeight: popupPos.maxHeight }}
              className="w-full border border-default rounded-xl shadow-xl animate-fade-in-scale"
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
