'use client';

/**
 * FunctionEditorOverlay — full-viewport Monaco editor for function node JavaScript.
 *
 * Auto-saves on every keystroke via onUpdate callback. No Apply button needed.
 * Registers a context-aware completion provider so `context.` suggestions reflect
 * the real trigger payload, upstream step outputs, and execution context data.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { motion, AnimatePresence } from 'framer-motion';
import { Minimize2, Code2 } from 'lucide-react';
import clsx from 'clsx';
import type { OnMount } from '@monaco-editor/react';
import { springs, transitions } from '@/lib/animation';
import { OVERLAY_BACKDROP } from '@agent-platform/design-tokens';
import { useWorkflowCanvasStore } from '../../../../store/workflow-canvas-store';

const MonacoEditor = dynamic(() => import('@monaco-editor/react').then((m) => m.default), {
  ssr: false,
  loading: () => <div className="flex-1 animate-pulse bg-background-muted rounded" />,
});

// =============================================================================
// TYPES
// =============================================================================

type Monaco = Parameters<OnMount>[1];

interface StepEntry {
  id: string;
  name: string;
  outputSchema?: Record<string, unknown>;
}

interface ContextData {
  triggerPayload: Record<string, unknown>;
  previousSteps: StepEntry[];
  allSteps: StepEntry[];
  executionContext?: Record<string, unknown> | null;
}

interface SuggestionBase {
  label: string;
  kind: number;
  insertText: string;
  detail?: string;
}

// =============================================================================
// COMPLETION HELPERS
// =============================================================================

function getNestedKeys(obj: unknown): string[] {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  return Object.keys(obj as object);
}

function getSchemaKeys(schema: Record<string, unknown>): string[] {
  const props = schema.properties as Record<string, unknown> | undefined;
  return Object.keys(props ?? schema);
}

// Keep these in sync with HIDDEN_*_KEYS in ContextExplorer.tsx — these fields
// resolve at runtime but are intentionally hidden from authoring surfaces so
// expression suggestions stay focused on business-logic fields only.
const HIDDEN_AGENT_SESSION_KEYS = new Set([
  'sessionId',
  'source',
  'startedAt',
  'lastActivityAt',
  'locale',
]);
const HIDDEN_AGENT_CONTEXT_KEYS = new Set(['messageMetadata']);
// Top-level context namespaces hidden from authoring. The engine resolves
// {{context.workflow.*}} and {{context.tenant.*}} but they're not exposed in
// the Expression Browser, so Monaco shouldn't suggest them either.
const HIDDEN_CONTEXT_TOP_KEYS = new Set(['workflow', 'tenant']);

function buildSuggestions(text: string, data: ContextData, monaco: Monaco): SuggestionBase[] {
  const K = monaco.languages.CompletionItemKind;
  const { triggerPayload, previousSteps, allSteps, executionContext } = data;

  // context. → top-level keys (memory/agentSession/agentContext are siblings, not children)
  const CONTEXT_SIBLINGS = new Set(['memory', 'agentSession', 'agentContext']);
  if (/\bcontext\.$/.test(text)) {
    const keys = executionContext
      ? Object.keys(executionContext).filter(
          (k) => !CONTEXT_SIBLINGS.has(k) && !HIDDEN_CONTEXT_TOP_KEYS.has(k),
        )
      : ['trigger', 'steps', 'vars'];
    return keys.map((label) => ({ label, insertText: label, kind: K.Property }));
  }

  // context.trigger. → payload
  if (/\bcontext\.trigger\.$/.test(text)) {
    return [{ label: 'payload', insertText: 'payload', kind: K.Property }];
  }

  // context.trigger.payload. → trigger fields
  if (/\bcontext\.trigger\.payload\.$/.test(text)) {
    const execPayload =
      executionContext?.trigger &&
      typeof executionContext.trigger === 'object' &&
      (executionContext.trigger as Record<string, unknown>).payload;
    const payload =
      execPayload && typeof execPayload === 'object'
        ? (execPayload as Record<string, unknown>)
        : triggerPayload;
    return Object.entries(payload).map(([label, val]) => ({
      label,
      insertText: label,
      kind: K.Field,
      detail: typeof val,
    }));
  }

  // context.steps. → step IDs
  // Static fallback uses allSteps (all canvas nodes) so a new workflow with no
  // prior run still shows suggestions — previousSteps is BFS-upstream only and
  // would be empty for a function node placed directly after start.
  if (/\bcontext\.steps\.$/.test(text)) {
    const execSteps =
      executionContext?.steps && typeof executionContext.steps === 'object'
        ? (executionContext.steps as Record<string, unknown>)
        : null;
    const staticSteps = allSteps.length > 0 ? allSteps : previousSteps;
    const ids = execSteps ? Object.keys(execSteps) : staticSteps.map((s) => s.id);
    const nameMap = Object.fromEntries(staticSteps.map((s) => [s.id, s.name]));
    return ids.map((id) => ({
      label: id,
      insertText: id,
      kind: K.Variable,
      detail: nameMap[id] ?? id,
    }));
  }

  // context.steps.X.output. → output fields (check before X. so it wins)
  const outputFieldMatch = text.match(/\bcontext\.steps\.(\w+)\.output\.$/);
  if (outputFieldMatch) {
    const stepId = outputFieldMatch[1];
    const execStep =
      executionContext?.steps &&
      typeof executionContext.steps === 'object' &&
      (executionContext.steps as Record<string, unknown>)[stepId];
    if (execStep && typeof execStep === 'object') {
      const output = (execStep as Record<string, unknown>).output;
      const keys = getNestedKeys(output);
      if (keys.length > 0) {
        return keys.map((label) => ({ label, insertText: label, kind: K.Field }));
      }
    }
    const step = (allSteps.length > 0 ? allSteps : previousSteps).find((s) => s.id === stepId);
    if (step?.outputSchema) {
      return getSchemaKeys(step.outputSchema).map((label) => ({
        label,
        insertText: label,
        kind: K.Field,
      }));
    }
    return [];
  }

  // context.steps.X. → output, status, error (matches Expression Browser)
  if (/\bcontext\.steps\.\w+\.$/.test(text)) {
    return [
      { label: 'output', insertText: 'output', kind: K.Property },
      { label: 'status', insertText: 'status', kind: K.Field },
      { label: 'error', insertText: 'error', kind: K.Property },
    ];
  }

  // context.steps.X.error. → error.code, error.message
  if (/\bcontext\.steps\.\w+\.error\.$/.test(text)) {
    return [
      { label: 'code', insertText: 'code', kind: K.Field },
      { label: 'message', insertText: 'message', kind: K.Field },
    ];
  }

  // memory. → workflow, project, user
  if (/\bmemory\.$/.test(text)) {
    return ['workflow', 'project', 'user'].map((label) => ({
      label,
      insertText: label,
      kind: K.Property,
    }));
  }

  // agentSession. → session fields (telemetry/internal keys hidden)
  if (/\bagentSession\.$/.test(text)) {
    const execSession =
      executionContext?.agentSession && typeof executionContext.agentSession === 'object'
        ? (executionContext.agentSession as Record<string, unknown>)
        : null;
    const keys = execSession
      ? Object.keys(execSession).filter((k) => !HIDDEN_AGENT_SESSION_KEYS.has(k))
      : ['agentName', 'channel', 'endUserId'];
    return keys.map((label) => ({ label, insertText: label, kind: K.Field }));
  }

  // agentContext. → context fields (messageMetadata hidden)
  if (/\bagentContext\.$/.test(text)) {
    const execCtx =
      executionContext?.agentContext && typeof executionContext.agentContext === 'object'
        ? (executionContext.agentContext as Record<string, unknown>)
        : null;
    const keys = execCtx
      ? Object.keys(execCtx).filter((k) => !HIDDEN_AGENT_CONTEXT_KEYS.has(k))
      : ['caller', 'invocation', 'attachments'];
    return keys.map((label) => ({ label, insertText: label, kind: K.Field }));
  }

  return [];
}

// =============================================================================
// PROPS
// =============================================================================

export interface FunctionEditorOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  code: string;
  onUpdate: (code: string) => void;
  triggerPayload: Record<string, unknown>;
  previousSteps: Array<{ id: string; name: string; outputSchema?: Record<string, unknown> }>;
  executionContext?: Record<string, unknown> | null;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function FunctionEditorOverlay({
  isOpen,
  onClose,
  code,
  onUpdate,
  triggerPayload,
  previousSteps,
  executionContext,
}: FunctionEditorOverlayProps) {
  // All non-start canvas nodes — used as the static fallback for context.steps.*
  // completions when there is no prior execution context. previousSteps is only
  // BFS-upstream, so it would be empty for a function node placed directly after
  // start, leaving the user with no suggestions on a brand-new workflow.
  const canvasNodes = useWorkflowCanvasStore((s) => s.nodes);
  const allSteps = React.useMemo(
    () =>
      canvasNodes
        .filter((n) => n.data.nodeType !== 'start')
        .map((n) => ({ id: n.data.label ?? n.id, name: n.data.label ?? n.id })),
    [canvasNodes],
  );

  // Keep a ref so the completion provider always reads the latest data
  const contextDataRef = useRef<ContextData>({
    triggerPayload,
    previousSteps,
    allSteps,
    executionContext,
  });
  useEffect(() => {
    contextDataRef.current = { triggerPayload, previousSteps, allSteps, executionContext };
  }, [triggerPayload, previousSteps, allSteps, executionContext]);

  // Track the registered provider so we can dispose it on unmount
  const disposableRef = useRef<{ dispose: () => void } | null>(null);
  useEffect(() => {
    return () => {
      disposableRef.current?.dispose();
    };
  }, []);

  const handleMount = useCallback<OnMount>((_editor, monaco) => {
    disposableRef.current?.dispose();
    disposableRef.current = monaco.languages.registerCompletionItemProvider('javascript', {
      triggerCharacters: ['.'],
      provideCompletionItems(model, position) {
        const text = model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        });

        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };

        const items = buildSuggestions(text, contextDataRef.current, monaco);
        return {
          suggestions: items.map((item) => ({
            ...item,
            range,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          })),
        };
      },
    });
  }, []);

  const handleChange = useCallback(
    (v: string | undefined) => {
      onUpdate(v ?? '');
    },
    [onUpdate],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Swallow all keys so React Flow shortcuts (Space, Delete, etc.) don't fire while editing
      e.stopPropagation();
      if (e.key === 'Escape') {
        onClose();
      }
    },
    [onClose],
  );

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            key="fn-editor-backdrop"
            className={OVERLAY_BACKDROP}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={transitions.backdrop}
            onClick={onClose}
          />

          {/* Full-viewport overlay */}
          <motion.div
            key="fn-editor-overlay"
            data-testid="function-editor-overlay"
            className={clsx(
              'fixed inset-4 z-50',
              'bg-background-elevated border border-default rounded-xl shadow-xl',
              'flex flex-col overflow-hidden',
            )}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={springs.default}
            onKeyDown={handleKeyDown}
          >
            {/* Header bar */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-default shrink-0">
              <div className="flex items-center gap-2">
                <Code2 className="w-4 h-4 text-accent" />
                <h2 className="text-sm font-semibold text-foreground">Function Editor</h2>
                <span className="text-xs text-foreground-muted">JavaScript</span>
              </div>
              <button
                type="button"
                data-testid="fn-editor-collapse"
                aria-label="Collapse editor"
                onClick={onClose}
                className={clsx(
                  'flex items-center gap-1 px-2 py-1.5 text-xs rounded-md transition-fast',
                  'text-foreground-muted hover:text-foreground hover:bg-background-muted',
                )}
              >
                <Minimize2 className="w-3.5 h-3.5" />
                Collapse
              </button>
            </div>

            {/* Context API reference bar */}
            <div className="px-5 py-2 border-b border-default bg-background-subtle shrink-0 flex items-center gap-5 overflow-x-auto">
              <span className="text-xs font-semibold text-foreground-muted uppercase tracking-wider shrink-0">
                Context
              </span>
              <span className="text-xs text-foreground-muted shrink-0">
                <strong className="text-foreground font-medium">Read trigger</strong>
                {' — '}
                <code className="text-foreground">context.trigger.payload.x</code>
              </span>
              <span className="text-xs text-foreground-muted shrink-0">
                <strong className="text-foreground font-medium">Read step</strong>
                {' — '}
                <code className="text-foreground">context.steps.NodeName.output.y</code>
              </span>
              <span className="text-xs text-foreground-muted shrink-0">
                <strong className="text-foreground font-medium">Write downstream</strong>
                {' — '}
                <code className="text-foreground">{'context.x = value'}</code>
                {' → '}
                <code className="text-foreground">{'{{context.x}}'}</code>
              </span>
              <span className="text-xs text-foreground-muted shrink-0">
                <strong className="text-foreground font-medium">Persist</strong>
                {' — '}
                <code className="text-foreground">memory.workflow.set(key, val)</code>
                {' / '}
                <code className="text-foreground">.get(key)</code>
              </span>
            </div>

            {/* Monaco editor */}
            <div className="flex-1 min-h-0">
              <MonacoEditor
                language="javascript"
                theme="vs-dark"
                value={code}
                onChange={handleChange}
                onMount={handleMount}
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  wordWrap: 'on',
                  tabSize: 2,
                  automaticLayout: true,
                  padding: { top: 12 },
                }}
              />
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
