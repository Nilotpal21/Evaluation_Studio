/**
 * VariableEditor — Reusable key-value pair editor.
 * Used for both gather values and session variables.
 */

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import clsx from 'clsx';

interface VariableEditorProps {
  values: Record<string, unknown>;
  onUpdate: (key: string, value: unknown) => void;
  onRemove: (key: string) => void;
  placeholder?: string;
  className?: string;
}

export function VariableEditor({
  values,
  onUpdate,
  onRemove,
  placeholder,
  className,
}: VariableEditorProps) {
  const t = useTranslations('test_context');
  const tVar = useTranslations('test_context.variable');
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  const handleAdd = () => {
    const key = newKey.trim();
    if (!key) return;

    // Try to parse as JSON, fall back to string
    let parsed: unknown = newValue;
    try {
      parsed = JSON.parse(newValue);
    } catch {
      // Keep as string
    }

    onUpdate(key, parsed);
    setNewKey('');
    setNewValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAdd();
    }
  };

  const entries = Object.entries(values);

  return (
    <div className={clsx('space-y-1.5', className)}>
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-center gap-1.5 group">
          <span className="text-xs text-accent font-mono min-w-[80px] truncate" title={key}>
            {key}
          </span>
          <input
            type="text"
            value={typeof value === 'string' ? value : JSON.stringify(value)}
            onChange={(e) => {
              let parsed: unknown = e.target.value;
              try {
                parsed = JSON.parse(e.target.value);
              } catch {
                /* string */
              }
              onUpdate(key, parsed);
            }}
            className="flex-1 min-w-0 px-2 py-1 text-xs bg-background-elevated border border-default rounded text-foreground font-mono"
          />
          <button
            onClick={() => onRemove(key)}
            className="p-1 text-subtle hover:text-error opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      ))}

      {/* Add new */}
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('key_placeholder')}
          className="min-w-[80px] w-24 px-2 py-1 text-xs bg-background-elevated border border-default rounded text-foreground font-mono placeholder:text-subtle"
        />
        <input
          type="text"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? t('value_placeholder')}
          className="flex-1 min-w-0 px-2 py-1 text-xs bg-background-elevated border border-default rounded text-foreground font-mono placeholder:text-subtle"
        />
        <button
          onClick={handleAdd}
          disabled={!newKey.trim()}
          className="p-1 text-subtle hover:text-accent disabled:opacity-30 transition-colors"
          aria-label={tVar('add_variable')}
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
