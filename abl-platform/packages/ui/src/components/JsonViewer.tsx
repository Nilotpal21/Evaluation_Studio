/**
 * JsonViewer & CollapsibleSection
 *
 * Shared UI components extracted from DebugTabs.
 * JsonViewer: Expandable JSON tree with syntax coloring.
 * CollapsibleSection: Togglable content block with chevron icon.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Check } from 'lucide-react';

// ── CollapsibleSection ──────────────────────────────────────────────────────

export interface CollapsibleSectionProps {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  badge?: string | number;
}

export function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
  badge,
}: CollapsibleSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="bg-background-muted rounded overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-background-muted/70 transition-colors"
      >
        {isOpen ? (
          <ChevronDown className="w-3.5 h-3.5 text-muted" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-muted" />
        )}
        <span className="text-xs font-medium text-muted">{title}</span>
        {badge !== undefined && (
          <span className="ml-auto text-xs text-muted bg-background px-1.5 py-0.5 rounded-full">
            {badge}
          </span>
        )}
      </button>
      {isOpen && <div className="px-2 pb-2">{children}</div>}
    </div>
  );
}

// ── JsonViewer ──────────────────────────────────────────────────────────────

export interface JsonViewerProps {
  data: unknown;
  maxDepth?: number;
  depth?: number;
  copyable?: boolean;
  expandAll?: boolean;
}

export function JsonViewer({
  data,
  maxDepth = 4,
  depth = 0,
  copyable = false,
  expandAll = false,
}: JsonViewerProps) {
  const [toggledKeys, setToggledKeys] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);

  const toggleKey = (key: string) => {
    setToggledKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const isKeyExpanded = (keyPath: string) =>
    expandAll ? !toggledKeys.has(keyPath) : toggledKeys.has(keyPath);

  const handleCopy = () => {
    try {
      navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard not available
    }
  };

  if (depth >= maxDepth) {
    return <span className="text-muted text-xs">...</span>;
  }

  if (data === null) {
    return <span className="text-muted">null</span>;
  }

  if (typeof data === 'undefined') {
    return <span className="text-muted">undefined</span>;
  }

  if (typeof data === 'boolean') {
    return <span className="text-purple">{data.toString()}</span>;
  }

  if (typeof data === 'number') {
    return <span className="text-accent">{data}</span>;
  }

  if (typeof data === 'string') {
    if (data.length > 200) {
      return <ExpandableString value={data} />;
    }
    return <span className="text-success">&quot;{data}&quot;</span>;
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return <span className="text-muted">[]</span>;
    }
    return (
      <div className="text-xs">
        <span className="text-muted">[</span>
        <div className="pl-3 border-l border-default ml-1">
          {data.slice(0, 10).map((item, i) => (
            <div key={i}>
              <JsonViewer data={item} maxDepth={maxDepth} depth={depth + 1} expandAll={expandAll} />
              {i < data.length - 1 && <span className="text-muted">,</span>}
            </div>
          ))}
          {data.length > 10 && <div className="text-muted">...{data.length - 10} more</div>}
        </div>
        <span className="text-muted">]</span>
      </div>
    );
  }

  if (typeof data === 'object') {
    const entries = Object.entries(data);
    if (entries.length === 0) {
      return <span className="text-muted">{'{}'}</span>;
    }

    const wrapper = (
      <div className="text-xs">
        {entries.map(([key, value]) => {
          const isExpandable = typeof value === 'object' && value !== null;
          const keyPath = `${depth}-${key}`;
          const isExpanded = isKeyExpanded(keyPath);

          return (
            <div key={key}>
              <div className="flex items-start gap-1">
                {isExpandable ? (
                  <button
                    onClick={() => toggleKey(keyPath)}
                    className="text-muted hover:text-foreground mt-0.5 flex-shrink-0"
                  >
                    {isExpanded ? (
                      <ChevronDown className="w-3 h-3" />
                    ) : (
                      <ChevronRight className="w-3 h-3" />
                    )}
                  </button>
                ) : (
                  <span className="w-3 flex-shrink-0" />
                )}
                <span className="text-warning flex-shrink-0">{key}</span>
                <span className="text-muted flex-shrink-0">:</span>
                {isExpandable && !isExpanded ? (
                  <span
                    className="text-muted cursor-pointer hover:text-foreground"
                    onClick={() => toggleKey(keyPath)}
                  >
                    {Array.isArray(value) ? `[${value.length}]` : '{...}'}
                  </span>
                ) : !isExpandable ? (
                  <JsonViewer
                    data={value}
                    maxDepth={maxDepth}
                    depth={depth + 1}
                    expandAll={expandAll}
                  />
                ) : null}
              </div>
              {isExpandable && isExpanded && (
                <div className="pl-5 border-l border-default ml-1.5">
                  <JsonViewer
                    data={value}
                    maxDepth={maxDepth}
                    depth={depth + 1}
                    expandAll={expandAll}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    );

    // Only show copy at root level
    if (depth === 0 && copyable) {
      return (
        <div className="relative group">
          <button
            onClick={handleCopy}
            className="absolute -top-1 right-0 p-1 rounded text-muted hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
            title="Copy JSON"
          >
            {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
          </button>
          {wrapper}
        </div>
      );
    }

    return wrapper;
  }

  return <span className="text-muted">{String(data)}</span>;
}

// ── ExpandableString ──────────────────────────────────────────────────────

function ExpandableString({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <span className="text-success">
      &quot;
      <span className="whitespace-pre-wrap">{expanded ? value : `${value.slice(0, 200)}...`}</span>
      &quot;
      <button
        onClick={() => setExpanded(!expanded)}
        className="ml-1 text-info hover:text-info text-xs underline"
      >
        {expanded ? '[show less]' : '[show more]'}
      </button>
    </span>
  );
}
