/**
 * IR Viewer Component
 *
 * Displays the compiled Intermediate Representation (IR) as formatted JSON.
 * Uses the app's design system for consistent styling.
 */

import { useState, useMemo } from 'react';
import { Copy, Check, ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEditorStore } from '../../store/editor-store';
import clsx from 'clsx';

interface IRViewerProps {
  className?: string;
}

export function IRViewer({ className = '' }: IRViewerProps) {
  const t = useTranslations('agents.ir_viewer');
  const compiledIR = useEditorStore((s) => s.compiledIR);
  const compileErrors = useEditorStore((s) => s.compileErrors);
  const isCompiling = useEditorStore((s) => s.isCompiling);
  const [copied, setCopied] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(['metadata', 'identity', 'flow']),
  );

  const formattedIR = useMemo(() => {
    if (!compiledIR) return null;
    try {
      return JSON.stringify(compiledIR, null, 2);
    } catch {
      return null;
    }
  }, [compiledIR]);

  const handleCopy = async () => {
    if (!formattedIR) return;
    try {
      await navigator.clipboard.writeText(formattedIR);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const toggleSection = (key: string) => {
    const newExpanded = new Set(expandedSections);
    if (newExpanded.has(key)) {
      newExpanded.delete(key);
    } else {
      newExpanded.add(key);
    }
    setExpandedSections(newExpanded);
  };

  // Render JSON with collapsible sections
  const renderValue = (value: unknown, key: string, depth: number = 0): React.ReactNode => {
    const indent = '  '.repeat(depth);

    if (value === null) {
      return <span className="text-accent">null</span>;
    }

    if (typeof value === 'boolean') {
      return <span className="text-accent">{value.toString()}</span>;
    }

    if (typeof value === 'number') {
      return <span className="text-info">{value}</span>;
    }

    if (typeof value === 'string') {
      return <span className="text-warning">"{value}"</span>;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        return <span className="text-subtle">[]</span>;
      }

      const isExpanded = expandedSections.has(key);
      return (
        <span>
          <button
            onClick={() => toggleSection(key)}
            className="inline-flex items-center text-muted hover:text-foreground transition-colors"
          >
            {isExpanded ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
          </button>
          <span className="text-subtle">[</span>
          {!isExpanded && (
            <span className="text-muted ml-1 text-xs">
              {t('items_count', { count: value.length })}
            </span>
          )}
          {isExpanded && (
            <>
              <br />
              {value.map((item, i) => (
                <span key={i}>
                  {indent} {renderValue(item, `${key}[${i}]`, depth + 1)}
                  {i < value.length - 1 && <span className="text-subtle">,</span>}
                  <br />
                </span>
              ))}
              {indent}
            </>
          )}
          <span className="text-subtle">]</span>
        </span>
      );
    }

    if (typeof value === 'object') {
      const entries = Object.entries(value);
      if (entries.length === 0) {
        return <span className="text-subtle">{'{}'}</span>;
      }

      const isExpanded = expandedSections.has(key);
      return (
        <span>
          <button
            onClick={() => toggleSection(key)}
            className="inline-flex items-center text-muted hover:text-foreground transition-colors"
          >
            {isExpanded ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
          </button>
          <span className="text-subtle">{'{'}</span>
          {!isExpanded && (
            <span className="text-muted ml-1 text-xs">
              {t('fields_count', { count: entries.length })}
            </span>
          )}
          {isExpanded && (
            <>
              <br />
              {entries.map(([k, v], i) => (
                <span key={k}>
                  {indent} <span className="text-purple">"{k}"</span>
                  <span className="text-subtle">: </span>
                  {renderValue(v, `${key}.${k}`, depth + 1)}
                  {i < entries.length - 1 && <span className="text-subtle">,</span>}
                  <br />
                </span>
              ))}
              {indent}
            </>
          )}
          <span className="text-subtle">{'}'}</span>
        </span>
      );
    }

    return <span className="text-foreground">{String(value)}</span>;
  };

  if (isCompiling) {
    return (
      <div className={clsx('flex flex-col h-full bg-background', className)}>
        <div className="flex-shrink-0 px-4 py-2.5 border-b border-default bg-background-subtle">
          <span className="text-sm font-medium text-muted">{t('title')}</span>
        </div>
        <div className="flex-1 flex items-center justify-center text-muted">
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            {t('compiling')}
          </div>
        </div>
      </div>
    );
  }

  if (compileErrors.length > 0) {
    return (
      <div className={clsx('flex flex-col h-full bg-background', className)}>
        <div className="flex-shrink-0 px-4 py-2.5 border-b border-error bg-error-subtle">
          <span className="text-sm font-medium text-error">{t('compile_errors')}</span>
        </div>
        <div className="flex-1 overflow-auto p-4 font-mono text-sm">
          {compileErrors.map((error, i) => (
            <div key={i} className="text-error mb-2 leading-relaxed">
              {error}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!compiledIR) {
    return (
      <div className={clsx('flex flex-col h-full bg-background', className)}>
        <div className="flex-shrink-0 px-4 py-2.5 border-b border-default bg-background-subtle">
          <span className="text-sm font-medium text-muted">{t('title')}</span>
        </div>
        <div className="flex-1 flex items-center justify-center text-muted">
          {t('click_compile')}
        </div>
      </div>
    );
  }

  return (
    <div className={clsx('flex flex-col h-full bg-background', className)}>
      {/* Header */}
      <div className="flex-shrink-0 px-4 py-2.5 border-b border-default flex items-center justify-between bg-background-subtle">
        <span className="text-sm font-medium text-muted">{t('title')}</span>
        <button
          onClick={handleCopy}
          className="p-1.5 rounded-lg text-muted hover:text-foreground hover:bg-background-muted transition-default"
          title={t('copy_to_clipboard')}
        >
          {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>

      {/* JSON Content */}
      <div
        className="flex-1 overflow-auto p-4 text-sm leading-relaxed"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        {renderValue(compiledIR, 'root', 0)}
      </div>
    </div>
  );
}

export default IRViewer;
