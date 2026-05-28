/**
 * SandboxConfigForm Component
 *
 * Config form for Code Tool type: runtime, code editor, parameters, memory limit.
 * Entrypoint is auto-set to "main" — not exposed to user.
 *
 * Parameters follow LLM tool_use / function_calling standards:
 * - Defined as JSON Schema–compatible property descriptors
 * - Names are valid JS identifiers (letters, digits, _, $)
 * - In user code, parameters are accessed via $prefix (e.g. $customer_name)
 * - At runtime, parameters are validated and type-coerced before execution
 * - The form auto-generates a JSON Schema preview for the LLM input contract
 */

import { useEffect, useCallback, useState, useRef } from 'react';
import { useTranslations } from 'next-intl';
import Editor, { type Monaco } from '@monaco-editor/react';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { useThemeStore } from '../../store/theme-store';
import type {
  ParameterDefinition,
  ParamType,
  RuntimeNumericValue,
  SandboxConfig,
} from './shared-types';
import { ParameterEditor, validateParam } from './ParameterEditor';

export type { SandboxConfig } from './shared-types';

interface SandboxConfigFormProps {
  config: SandboxConfig;
  onChange: (config: SandboxConfig) => void;
  showTemplates?: boolean;
}

const MAX_CODE_SIZE = 256 * 1024; // 256KB
const MAX_MEMORY_MB = 512;
const CONFIG_NUMERIC_TEMPLATE_RE = /^\{\{config\.[A-Za-z_][A-Za-z0-9_]*\}\}$/;
const INTEGER_DRAFT_RE = /^-?\d+$/;

function isConfigNumericTemplate(value: unknown): value is Extract<RuntimeNumericValue, string> {
  return typeof value === 'string' && CONFIG_NUMERIC_TEMPLATE_RE.test(value);
}

function parseRuntimeNumericDraft(raw: string, fallback: number): RuntimeNumericValue {
  const trimmed = raw.trim();
  if (!trimmed) {
    return fallback;
  }
  if (CONFIG_NUMERIC_TEMPLATE_RE.test(trimmed)) {
    return trimmed as Extract<RuntimeNumericValue, string>;
  }
  if (INTEGER_DRAFT_RE.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  return trimmed as Extract<RuntimeNumericValue, string>;
}

function runtimeNumericInputValue(
  value: RuntimeNumericValue | undefined,
  fallback: number,
): string | number {
  return value ?? fallback;
}

function validateRuntimeNumericDraft(
  value: RuntimeNumericValue | undefined,
  options: { min?: number; max?: number; message: string },
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return isConfigNumericTemplate(value)
      ? undefined
      : 'Must be a number or exact {{config.KEY}} placeholder';
  }
  if (options.min !== undefined && value < options.min) {
    return options.message;
  }
  if (options.max !== undefined && value > options.max) {
    return options.message;
  }
  return undefined;
}

/** Validate full sandbox config — returns map of field→error */
export function validateSandboxConfig(config: SandboxConfig): Record<string, string> {
  const errors: Record<string, string> = {};

  if (!config.runtime) errors.runtime = 'Runtime is required';

  if (!config.codeContent?.trim()) {
    errors.codeContent = 'Code is required';
  } else if (new Blob([config.codeContent]).size > MAX_CODE_SIZE) {
    errors.codeContent = 'Code exceeds 256KB limit';
  }

  const memoryError = validateRuntimeNumericDraft(config.memoryMb, {
    min: 128,
    max: MAX_MEMORY_MB,
    message: `Must be 128-${MAX_MEMORY_MB}MB`,
  });
  if (memoryError) errors.memoryMb = memoryError;

  const timeoutError = validateRuntimeNumericDraft(config.timeoutMs, {
    min: 100,
    max: 60000,
    message: 'Must be 100-60000ms',
  });
  if (timeoutError) errors.timeoutMs = timeoutError;

  // Validate parameters
  const params = config.parameters || [];
  const allNames = params.map((p) => p.name);
  for (let i = 0; i < params.length; i++) {
    const paramErrors = validateParam(params[i], allNames);
    if (paramErrors.length > 0) {
      errors[`param_${i}`] = paramErrors.join('. ');
    }
  }

  // Validate referenced parameters are defined
  if (config.codeContent?.trim()) {
    const parsedArgs = parseParametersFromCode(config.codeContent, config.runtime || 'javascript');
    if (parsedArgs.length > 0) {
      const defined = new Set(params.map((p) => p.name));
      const missing = parsedArgs.map((a) => a.name).filter((n) => !defined.has(n));
      if (missing.length > 0) {
        errors.parameters = `Function arguments not defined as parameters: ${missing.join(', ')}. Add them in the Parameters section or use the Parse button.`;
      }
    }
  }

  return errors;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const RUNTIME_OPTIONS = [
  { value: 'javascript', label: 'JavaScript (Node.js)' },
  { value: 'python', label: 'Python 3' },
];

// ─── Code Templates ──────────────────────────────────────────────────────────

const CODE_TEMPLATES: Record<string, { label: string; js: string; py: string }> = {
  '': { label: 'Load Template...', js: '', py: '' },
  hello: {
    label: 'Hello World',
    js: `function main(name) {
  return \`Hello, \${name}!\`;
}

return main($name);`,
    py: `def main(name):
    return f"Hello, {name}!"

# Call the function and return result
main($name)`,
  },
  transform: {
    label: 'Transform JSON',
    js: `function main(data) {
  // Parse input if string
  const obj = typeof data === 'string' ? JSON.parse(data) : data;

  // Transform the object
  return {
    ...obj,
    processed: true,
    timestamp: new Date().toISOString()
  };
}

return main($data);`,
    py: `import json
from datetime import datetime

def main(data):
    # Parse input if string
    obj = json.loads(data) if isinstance(data, str) else data

    # Transform the object
    return {
        **obj,
        'processed': True,
        'timestamp': datetime.utcnow().isoformat()
    }

# Call the function and return result
main($data)`,
  },
  fetch: {
    label: 'Fetch API Data',
    js: `async function main(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(\`HTTP error! status: \${response.status}\`);
    }
    const data = await response.json();
    return data;
  } catch (error) {
    return { error: error.message };
  }
}

return main($url).then((data)=>data);`,
    py: `import requests

def main(url):
    try:
        response = requests.get(url)
        response.raise_for_status()
        return response.json()
    except Exception as e:
        return {'error': str(e)}

# Call the function and return result
main($url)`,
  },
  calc: {
    label: 'Math Calculator',
    js: `function main(operation, a, b = 0) {
  const num1 = parseFloat(a);
  const num2 = parseFloat(b);

  switch (operation) {
    case 'add': return num1 + num2;
    case 'subtract': return num1 - num2;
    case 'multiply': return num1 * num2;
    case 'divide': return num2 !== 0 ? num1 / num2 : 'Error: Division by zero';
    default: return 'Error: Unknown operation';
  }
}

return main($operation, $a, $b);`,
    py: `def main(operation, a, b=0):
    num1 = float(a)
    num2 = float(b)

    if operation == 'add':
        return num1 + num2
    elif operation == 'subtract':
        return num1 - num2
    elif operation == 'multiply':
        return num1 * num2
    elif operation == 'divide':
        return num1 / num2 if num2 != 0 else 'Error: Division by zero'
    else:
        return 'Error: Unknown operation'

# Call the function and return result
main($operation, $a, $b)`,
  },
  text: {
    label: 'Text Processing',
    js: `function main(text, action = 'uppercase') {
  const str = String(text);

  switch (action) {
    case 'uppercase': return str.toUpperCase();
    case 'lowercase': return str.toLowerCase();
    case 'reverse': return str.split('').reverse().join('');
    case 'wordcount': return str.split(/\\s+/).filter(Boolean).length;
    case 'charcount': return str.length;
    default: return str;
  }
}

return main($text, $action);`,
    py: `def main(text, action='uppercase'):
    text_str = str(text)

    if action == 'uppercase':
        return text_str.upper()
    elif action == 'lowercase':
        return text_str.lower()
    elif action == 'reverse':
        return text_str[::-1]
    elif action == 'wordcount':
        return len(text_str.split())
    elif action == 'charcount':
        return len(text_str)
    else:
        return text_str

# Call the function and return result
main($text, $action)`,
  },
};

// ─── Monaco helpers ──────────────────────────────────────────────────────────

/** Map our runtime value to Monaco language id */
function runtimeToLanguage(runtime: string): string {
  if (runtime === 'python') return 'python';
  return 'javascript';
}

/** Register both light and dark themes matching the app's design system */
function setupMonacoThemes(monaco: Monaco) {
  monaco.editor.defineTheme('code-tool-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#0a0a0a',
      'editor.foreground': '#fafafa',
      'editor.lineHighlightBackground': '#1a1a1a',
      'editor.selectionBackground': '#3b82f633',
      'editorCursor.foreground': '#3b82f6',
      'editorLineNumber.foreground': '#525252',
      'editorLineNumber.activeForeground': '#a3a3a3',
    },
  });

  monaco.editor.defineTheme('code-tool-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#171717',
      'editor.lineHighlightBackground': '#f5f5f5',
      'editor.selectionBackground': '#3b82f633',
      'editorCursor.foreground': '#4f46e5',
      'editorLineNumber.foreground': '#a3a3a3',
      'editorLineNumber.activeForeground': '#525252',
    },
  });
}

// ─── Code Parser ─────────────────────────────────────────────────────────────

/**
 * Parse function signature from code to extract parameters.
 * Supports both JavaScript `function main(...)` and Python `def main(...)`.
 */
function parseParametersFromCode(code: string, runtime: string): ParameterDefinition[] {
  const pattern =
    runtime === 'python' ? /def\s+main\s*\(([^)]*)\)/ : /function\s+main\s*\(([^)]*)\)/;
  const match = code.match(pattern);
  if (!match) return [];

  const argsStr = match[1].trim();
  if (!argsStr) return [];

  return argsStr
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
    .map((arg): ParameterDefinition => {
      const defaultMatch = arg.match(/^\$?(\w+)\s*=\s*(.+)$/);
      if (defaultMatch) {
        const [, name, defaultVal] = defaultMatch;
        return {
          name,
          type: inferTypeFromDefault(defaultVal.trim()) as ParamType,
          description: '',
          required: false,
          defaultValue: defaultVal.trim(),
        };
      }
      return {
        name: arg.replace(/^\$/, ''),
        type: 'string',
        description: '',
        required: true,
      };
    });
}

function inferTypeFromDefault(value: string): string {
  if (value === 'true' || value === 'false' || value === 'True' || value === 'False')
    return 'boolean';
  if (value === 'null' || value === 'None') return 'string';
  if (/^\d+$/.test(value)) return 'integer';
  if (/^\d+\.\d+$/.test(value)) return 'number';
  if (value.startsWith('[') && value.endsWith(']')) return 'array';
  if (value.startsWith('{') && value.endsWith('}')) return 'object';
  return 'string';
}

// ─── Component ───────────────────────────────────────────────────────────────

export function SandboxConfigForm({
  config,
  onChange,
  showTemplates = true,
}: SandboxConfigFormProps) {
  const tc = useTranslations('tools.config');
  const resolvedTheme = useThemeStore((s) => s.resolved);
  const monacoTheme = resolvedTheme === 'light' ? 'code-tool-light' : 'code-tool-dark';

  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [pendingTemplate, setPendingTemplate] = useState<string | null>(null);

  // Refs for stable callbacks — prevents Monaco editor remounting on each keystroke
  const configRef = useRef(config);
  configRef.current = config;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const update = (field: string, value: unknown) => {
    onChange({ ...config, [field]: value });
  };

  const parseParameters = () => {
    const parsed = parseParametersFromCode(
      config.codeContent || '',
      config.runtime || 'javascript',
    );
    if (parsed.length > 0) {
      update('parameters', parsed);
    }
  };

  const applyTemplateInternal = (templateKey: string) => {
    const template = CODE_TEMPLATES[templateKey];
    if (!template) return;

    const code = config.runtime === 'python' ? template.py : template.js;

    // Auto-parse parameters from template
    const parsed = parseParametersFromCode(code, config.runtime || 'javascript');

    // Apply both code and parameters in a single update to avoid stale state
    onChange({
      ...config,
      codeContent: code,
      ...(parsed.length > 0 ? { parameters: parsed } : {}),
    });
  };

  const applyTemplate = (templateKey: string) => {
    if (!templateKey) return;

    const hasContent = config.codeContent && config.codeContent.trim().length > 0;

    if (hasContent) {
      setPendingTemplate(templateKey);
      setShowConfirmDialog(true);
    } else {
      applyTemplateInternal(templateKey);
    }
  };

  const handleConfirmReplace = () => {
    if (pendingTemplate) {
      applyTemplateInternal(pendingTemplate);
      setPendingTemplate(null);
    }
    setShowConfirmDialog(false);
  };

  const handleCancelReplace = () => {
    setPendingTemplate(null);
    setShowConfirmDialog(false);
  };

  // Auto-set defaults on mount: runtime
  useEffect(() => {
    if (!config.runtime) {
      onChange({ ...config, runtime: 'javascript' });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCodeChange = useCallback((value: string | undefined) => {
    onChangeRef.current({ ...configRef.current, codeContent: value || '' });
  }, []);

  const errors = validateSandboxConfig(config);
  const codeSize = config.codeContent ? new Blob([config.codeContent]).size : 0;
  const codeSizeKB = (codeSize / 1024).toFixed(1);

  return (
    <div className="space-y-5">
      {/* Runtime */}
      <Select
        label={tc('runtime_label')}
        options={RUNTIME_OPTIONS}
        value={config.runtime || 'javascript'}
        onChange={(v) => update('runtime', v)}
      />

      {/* Code Editor (Monaco) */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="block text-sm font-medium text-foreground">{tc('code_label')}</label>
          {showTemplates && (
            <div className="flex items-center gap-2">
              <Select
                options={Object.entries(CODE_TEMPLATES).map(([key, tmpl]) => ({
                  value: key,
                  label: tmpl.label,
                }))}
                value={undefined}
                placeholder={tc('template_placeholder')}
                onChange={(v) => applyTemplate(v)}
                className="text-xs"
              />
            </div>
          )}
        </div>
        <p className="text-xs text-muted mb-2">
          Define a <code className="font-mono">main()</code> function and call it to return a
          result.
          <strong> Important:</strong> Your code must return a value (e.g.,{' '}
          <code className="font-mono">return main($param)</code>).
        </p>
        <div
          className={`rounded-lg border overflow-hidden ${errors.codeContent && config.codeContent ? 'border-error/50' : 'border-default'}`}
        >
          <Editor
            height="340px"
            language={runtimeToLanguage(config.runtime)}
            value={config.codeContent || ''}
            onChange={handleCodeChange}
            beforeMount={setupMonacoThemes}
            theme={monacoTheme}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              fontFamily: 'var(--font-mono)',
              lineNumbers: 'on',
              renderLineHighlight: 'line',
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              tabSize: 2,
              insertSpaces: true,
              automaticLayout: true,
              padding: { top: 8, bottom: 8 },
              scrollbar: {
                verticalScrollbarSize: 8,
                horizontalScrollbarSize: 8,
              },
            }}
          />
        </div>
        <div className="flex items-center justify-between mt-1">
          <p className="text-xs text-muted">
            Code runs in an isolated container. Access parameters with{' '}
            <code className="font-mono text-xs bg-background-muted px-1 rounded">$</code> prefix
            (e.g.{' '}
            <code className="font-mono text-xs bg-background-muted px-1 rounded">
              $customer_name
            </code>
            ). Your code must call{' '}
            <code className="font-mono text-xs bg-background-muted px-1 rounded">main()</code> and
            return its result.
          </p>
          <span className={`text-xs ${errors.codeContent ? 'text-error' : 'text-muted'}`}>
            {codeSizeKB}KB / 256KB
          </span>
        </div>
        {errors.codeContent && config.codeContent && (
          <p className="text-xs text-error mt-0.5">{errors.codeContent}</p>
        )}
      </div>

      {/* ── Parameters Section (using shared ParameterEditor) ────────────── */}
      <ParameterEditor
        parameters={config.parameters || []}
        onChange={(params) => update('parameters', params)}
        helpText={tc('parameter_help_text_sandbox')}
        showParseButton
        onParseFromCode={parseParameters}
      />

      {/* Advanced Settings */}
      <details className="group">
        <summary className="text-sm font-medium text-muted cursor-pointer hover:text-foreground transition-default select-none flex items-center gap-1.5">
          <span className="group-open:rotate-90 transition-transform inline-block">&#9654;</span>
          {tc('advanced_settings')}
        </summary>
        <div className="mt-3 space-y-4">
          {/* Return Type */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              {tc('return_type_label')}
            </label>
            <input
              placeholder={tc('return_type_placeholder')}
              value={config.returnType || 'object'}
              onChange={(e) => update('returnType', e.target.value)}
              className="w-full rounded-lg border border-default bg-background-subtle text-foreground text-sm px-3 py-1.5 font-mono transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
            />
            <p className="text-xs text-muted mt-1">{tc('return_type_hint')}</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label={tc('memory_label')}
              inputMode="numeric"
              placeholder="{{config.SANDBOX_MEMORY_MB}}"
              value={runtimeNumericInputValue(config.memoryMb, 128)}
              onChange={(e) => update('memoryMb', parseRuntimeNumericDraft(e.target.value, 128))}
              error={errors.memoryMb}
            />
            <Input
              label={tc('timeout_label')}
              inputMode="numeric"
              placeholder="{{config.SANDBOX_TIMEOUT_MS}}"
              value={runtimeNumericInputValue(config.timeoutMs, 5000)}
              onChange={(e) => update('timeoutMs', parseRuntimeNumericDraft(e.target.value, 5000))}
              error={errors.timeoutMs}
            />
          </div>
        </div>
      </details>

      {/* Confirmation Dialog for Template Replacement */}
      <Dialog
        open={showConfirmDialog}
        onClose={handleCancelReplace}
        title={tc('replace_code_title')}
        description={tc('replace_code_description')}
        maxWidth="md"
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-warning/30 bg-warning-subtle/20 p-3">
            <p className="text-sm text-foreground">
              <strong>Warning:</strong> Your current code will be completely replaced with the
              selected template.
            </p>
          </div>
          <div className="flex items-center gap-3 justify-end">
            <Button variant="ghost" onClick={handleCancelReplace}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleConfirmReplace}>
              Replace Code
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
