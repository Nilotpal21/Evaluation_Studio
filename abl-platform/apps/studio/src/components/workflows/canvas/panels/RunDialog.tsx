/**
 * RunDialog
 *
 * Modal dialog for running a workflow with input variables.
 * Validates required inputs and triggers execution via API.
 */

'use client';

import { useState, useEffect, useRef } from 'react';
import { X, Play, Loader2 } from 'lucide-react';
import { useWorkflowCanvasStore } from '../../../../store/workflow-canvas-store';
import { OVERLAY_BACKDROP } from '@agent-platform/design-tokens';
import { VAR_NAME_REGEX } from '../constants/workflow';
import { useWorkflowStartExecution } from '../hooks/useWorkflowStartExecution';

export function RunDialog() {
  const setRunDialogOpen = useWorkflowCanvasStore((s) => s.setRunDialogOpen);
  const nodes = useWorkflowCanvasStore((s) => s.nodes);

  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [isExecuting, setIsExecuting] = useState(false);
  // Auto-execute closes the dialog before startExecution resolves; the trailing
  // setIsExecuting(false) would land on an unmounted component without this guard.
  const isMounted = useRef(true);
  useEffect(() => {
    return () => {
      isMounted.current = false;
    };
  }, []);

  const { startExecution } = useWorkflowStartExecution();

  // Find start node to get input variables
  const startNode = nodes.find((n) => n.data.nodeType === 'start');
  const rawInputVars =
    (startNode?.data.config?.inputVariables as Array<{
      name: string;
      type: string;
      required: boolean;
      defaultValue?: string;
    }>) || [];

  // Seed inputValues with defaults from the Start node config the first time
  // the dialog mounts. Values the user has already typed in this session
  // take precedence, so re-opening the dialog mid-edit doesn't stomp on
  // their work.
  const defaultsSeeded = useRef(false);
  useEffect(() => {
    if (defaultsSeeded.current) return;
    defaultsSeeded.current = true;
    const seed: Record<string, string> = {};
    for (const v of rawInputVars) {
      const trimmedName = (v.name ?? '').trim();
      if (!trimmedName) continue;
      if (v.defaultValue !== undefined && v.defaultValue !== null && v.defaultValue !== '') {
        seed[trimmedName] = v.defaultValue;
      }
    }
    if (Object.keys(seed).length > 0) {
      setInputValues((prev) => ({ ...seed, ...prev }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inputVars = rawInputVars.filter((v) => VAR_NAME_REGEX.test((v.name ?? '').trim()));

  const handleInputChange = (name: string, value: string) => {
    setInputValues((prev) => ({ ...prev, [name]: value }));
    if (validationErrors[name]) {
      setValidationErrors((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    }
  };

  /** Convert string input values to their declared types */
  const coerceInputValues = (
    raw: Record<string, string>,
    vars: Array<{ name: string; type: string }>,
  ): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (const v of vars) {
      const rawVal = raw[v.name];
      if (rawVal === undefined || rawVal === '') continue;
      switch (v.type) {
        case 'number':
          result[v.name] = Number(rawVal);
          break;
        case 'boolean':
          result[v.name] = rawVal === 'true';
          break;
        case 'json':
          try {
            result[v.name] = JSON.parse(rawVal);
          } catch {
            result[v.name] = rawVal;
          }
          break;
        default:
          result[v.name] = rawVal;
      }
    }
    return result;
  };

  const handleRun = async () => {
    const errors: Record<string, string> = {};
    for (const v of inputVars) {
      if (v.required && (!inputValues[v.name] || inputValues[v.name].trim() === '')) {
        errors[v.name] = `${v.name} is required`;
      }
      if (v.type === 'json' && inputValues[v.name]) {
        try {
          JSON.parse(inputValues[v.name]);
        } catch {
          errors[v.name] = `${v.name} must be valid JSON`;
        }
      }
      if (v.type === 'number' && inputValues[v.name] && isNaN(Number(inputValues[v.name]))) {
        errors[v.name] = `${v.name} must be a number`;
      }
    }
    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors);
      return;
    }

    setIsExecuting(true);
    setRunDialogOpen(false);
    try {
      await startExecution(coerceInputValues(inputValues, inputVars));
    } finally {
      if (isMounted.current) setIsExecuting(false);
    }
  };

  // Auto-execute immediately when no input variables are needed (skip dialog).
  const autoExecuted = useRef(false);
  useEffect(() => {
    if (inputVars.length === 0 && !autoExecuted.current) {
      autoExecuted.current = true;
      handleRun();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputVars.length]);

  // When auto-executing with no inputs, don't render.
  if (inputVars.length === 0) {
    return null;
  }

  return (
    <div
      className={`${OVERLAY_BACKDROP} flex items-center justify-center z-50`}
      data-testid="run-dialog"
    >
      <div className="bg-background-elevated rounded-lg shadow-xl w-[480px] max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-default">
          <h3 className="text-sm font-semibold">Run Workflow</h3>
          <button onClick={() => setRunDialogOpen(false)} className="p-1 hover:bg-muted rounded">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {inputVars.map((v) => (
            <div key={v.name}>
              <label className="block text-xs font-medium mb-1">
                {v.name} <span className="text-muted-foreground">({v.type})</span>
                {v.required && <span className="text-error ml-1">*</span>}
              </label>
              {v.type === 'boolean' ? (
                <select
                  className={`w-full px-3 py-2 text-sm border rounded bg-background focus:ring-1 focus:ring-border-focus outline-none ${
                    validationErrors[v.name] ? 'border-error' : 'border-default'
                  }`}
                  value={inputValues[v.name] || ''}
                  onChange={(e) => handleInputChange(v.name, e.target.value)}
                  data-testid={`run-input-${v.name}`}
                >
                  <option value="">Select...</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : v.type === 'json' ? (
                <textarea
                  className={`w-full px-3 py-2 text-sm border rounded bg-background focus:ring-1 focus:ring-border-focus outline-none font-mono ${
                    validationErrors[v.name] ? 'border-error' : 'border-default'
                  }`}
                  value={inputValues[v.name] || ''}
                  onChange={(e) => handleInputChange(v.name, e.target.value)}
                  placeholder='{"key": "value"}'
                  rows={4}
                  data-testid={`run-input-${v.name}`}
                />
              ) : (
                <input
                  className={`w-full px-3 py-2 text-sm border rounded bg-background focus:ring-1 focus:ring-border-focus outline-none ${
                    validationErrors[v.name] ? 'border-error' : 'border-default'
                  }`}
                  type={v.type === 'number' ? 'number' : 'text'}
                  value={inputValues[v.name] || ''}
                  onChange={(e) => handleInputChange(v.name, e.target.value)}
                  placeholder={`Enter ${v.name}`}
                  data-testid={`run-input-${v.name}`}
                />
              )}
              {validationErrors[v.name] && (
                <p className="text-xs text-error mt-1 break-words">{validationErrors[v.name]}</p>
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-3 p-4 border-t border-default">
          <button
            onClick={() => setRunDialogOpen(false)}
            className="px-4 py-2 text-sm rounded hover:bg-muted"
            disabled={isExecuting}
          >
            Cancel
          </button>
          <button
            onClick={handleRun}
            disabled={isExecuting}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-accent text-accent-foreground rounded hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="run-execute-btn"
          >
            {isExecuting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {isExecuting ? 'Running...' : 'Run'}
          </button>
        </div>
      </div>
    </div>
  );
}
