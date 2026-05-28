'use client';

import { useState, useCallback } from 'react';
import Editor from '@monaco-editor/react';
import * as yaml from 'js-yaml';

interface GuardrailYamlEditorProps {
  value: string;
  onChange: (value: string) => void;
  height?: string;
}

export function GuardrailYamlEditor({
  value,
  onChange,
  height = '400px',
}: GuardrailYamlEditorProps) {
  const [parseError, setParseError] = useState<string | null>(null);

  const handleChange = useCallback(
    (newValue: string | undefined) => {
      const val = newValue ?? '';
      onChange(val);
      try {
        yaml.load(val);
        setParseError(null);
      } catch (err) {
        setParseError(err instanceof Error ? err.message : String(err));
      }
    },
    [onChange],
  );

  return (
    <div className="space-y-2">
      <div className="rounded-lg overflow-hidden border border-default">
        <Editor
          height={height}
          language="yaml"
          theme="vs-dark"
          value={value}
          onChange={handleChange}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            tabSize: 2,
            automaticLayout: true,
          }}
        />
      </div>
      {parseError && <p className="text-xs text-error px-1">YAML parse error: {parseError}</p>}
    </div>
  );
}

/**
 * Serialize a JS object to YAML string for the editor.
 * Strips undefined values and empty strings.
 */
export function toYaml(obj: Record<string, unknown>): string {
  const cleaned = JSON.parse(JSON.stringify(obj));
  return yaml.dump(cleaned, { indent: 2, lineWidth: 120, noRefs: true });
}

/**
 * Parse a YAML string back to a JS object.
 * Returns null if parsing fails.
 */
export function fromYaml(yamlStr: string): Record<string, unknown> | null {
  try {
    const result = yaml.load(yamlStr);
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      return result as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
