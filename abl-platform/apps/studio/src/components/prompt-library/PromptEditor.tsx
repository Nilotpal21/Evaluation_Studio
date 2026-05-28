'use client';

/**
 * PromptEditor
 *
 * Monospace textarea for editing prompt templates. Extracts `{{variable}}`
 * placeholders on change and reports them via `onVariablesChange`.
 */

import { useCallback } from 'react';

const VARIABLE_RE = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;

export function extractVariables(template: string): string[] {
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = VARIABLE_RE.exec(template)) !== null) {
    seen.add(m[1]);
  }
  return Array.from(seen);
}

interface PromptEditorProps {
  value: string;
  onChange: (value: string) => void;
  onVariablesChange?: (variables: string[]) => void;
  placeholder?: string;
  readOnly?: boolean;
  minRows?: number;
  className?: string;
}

export function PromptEditor({
  value,
  onChange,
  onVariablesChange,
  placeholder = 'Write your prompt template here…\n\nUse {{variable_name}} for dynamic values.',
  readOnly = false,
  minRows = 12,
  className,
}: PromptEditorProps) {
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      onChange(next);
      onVariablesChange?.(extractVariables(next));
    },
    [onChange, onVariablesChange],
  );

  return (
    <textarea
      value={value}
      onChange={handleChange}
      readOnly={readOnly}
      placeholder={placeholder}
      rows={minRows}
      className={[
        'w-full resize-y rounded-lg border border-default bg-background-subtle p-3',
        'font-mono text-sm text-foreground placeholder:text-foreground-muted',
        'focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      spellCheck={false}
      data-testid="prompt-editor"
    />
  );
}
