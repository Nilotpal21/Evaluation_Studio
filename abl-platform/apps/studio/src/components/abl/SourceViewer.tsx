/**
 * Source Viewer Component
 *
 * Displays ABL source code with syntax highlighting.
 * Uses React components instead of dangerouslySetInnerHTML for safety.
 *
 * Note: the literal Tailwind palette colors used for syntax tokens
 * (text-yellow-300, text-orange-400, text-cyan-400, text-yellow-400,
 * text-pink-400) are an intentional exception to the design-token
 * mandate — code syntax highlighting is its own color family, not
 * the semantic state palette, and intentionally stays stable across
 * theme changes the way most editors do.
 */

import { useMemo } from 'react';
import { Copy, Check } from 'lucide-react';
import { useState } from 'react';

interface SourceViewerProps {
  dsl: string;
}

export function SourceViewer({ dsl }: SourceViewerProps) {
  const [copied, setCopied] = useState(false);

  // Clean the ABL content
  const cleanDsl = useMemo(() => {
    if (!dsl) return '';
    // ABL content should be used as-is - no cleaning needed
    // The previous HTML tag removal regex was buggy: /<[^>]*>/g
    // It incorrectly matched ABL operators like <= and removed content until the next >
    return dsl.trim();
  }, [dsl]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(cleanDsl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const lines = useMemo(() => cleanDsl.split('\n'), [cleanDsl]);

  if (!cleanDsl) {
    return (
      <div className="h-full flex items-center justify-center text-subtle text-sm">
        No ABL source available
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Header */}
      <div className="px-3 py-2 border-b border-default flex items-center justify-between bg-background-subtle">
        <span className="text-xs font-medium text-muted">ABL Source</span>
        <button
          onClick={handleCopy}
          className="p-1 hover:bg-background-muted rounded transition-colors"
          title="Copy to clipboard"
        >
          {copied ? (
            <Check className="w-4 h-4 text-success" />
          ) : (
            <Copy className="w-4 h-4 text-muted" />
          )}
        </button>
      </div>

      {/* Code with line numbers */}
      <div className="flex-1 overflow-auto font-mono text-xs">
        {lines.map((line, index) => (
          <div key={index} className="flex hover:bg-background-muted">
            <span className="px-3 py-0.5 text-subtle text-right select-none border-r border-default w-12 flex-shrink-0">
              {index + 1}
            </span>
            <span className="px-3 py-0.5 whitespace-pre">
              <HighlightedLine line={line} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Renders a single line with syntax highlighting using React components
 */
function HighlightedLine({ line }: { line: string }) {
  // Comment line
  if (line.trim().startsWith('#') || line.trim().startsWith('//')) {
    return <span className="text-subtle">{line}</span>;
  }

  // Keywords at start of line
  const keywordMatch = line.match(
    /^(\s*)(AGENT|SUPERVISOR|MODE|GOAL|PERSONA|IDENTITY|LIMITATIONS|TOOLS|GATHER|MEMORY|CONSTRAINTS|FLOW|STEPS|DELEGATE|HANDOFF|ESCALATE|COMPLETE|ON_ERROR|GUARDRAILS|TESTS|VERSION|DESCRIPTION|NAME|PARAMETERS)(:.*)?$/,
  );
  if (keywordMatch) {
    const [, indent, keyword, rest] = keywordMatch;
    return (
      <>
        {indent}
        <span className="text-purple font-semibold">{keyword}</span>
        {rest && <span className="text-muted">{rest}</span>}
      </>
    );
  }

  // Sub-keywords
  const subKeywordMatch = line.match(
    /^(\s+)(WHEN|TO|RESPOND|STORE|RETURN|REQUIRE|ON_FAIL|ON_SUCCESS|THEN|CALL|CHECK|COLLECT|INPUT|RETURNS|PURPOSE|REASON|PRIORITY|TIMEOUT|TTL|CONTEXT|ON_INPUT|PROMPT|PRESENT|SET|IF|ELSE|FIELDS|STRATEGY)(:.*)?$/i,
  );
  if (subKeywordMatch) {
    const [, indent, keyword, rest] = subKeywordMatch;
    return (
      <>
        {indent}
        <span className="text-accent">{keyword}</span>
        {rest && <span className="text-muted">{rest}</span>}
      </>
    );
  }

  // Step definitions (- stepname:)
  const stepMatch = line.match(/^(\s*-\s+)(\w+)(:)?(.*)$/);
  if (stepMatch) {
    const [, prefix, name, colon, rest] = stepMatch;
    return (
      <>
        <span className="text-subtle">{prefix}</span>
        <span className="text-yellow-300">{name}</span>
        {colon && <span className="text-muted">{colon}</span>}
        {rest && <HighlightedText text={rest} />}
      </>
    );
  }

  // Default: highlight strings, numbers, etc.
  return <HighlightedText text={line} />;
}

/**
 * Highlights inline elements: strings, numbers, booleans
 */
function HighlightedText({ text }: { text: string }) {
  // Simple tokenization for inline highlighting
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // String match
    const stringMatch = remaining.match(/^"([^"]*)"/);
    if (stringMatch) {
      parts.push(
        <span key={key++} className="text-success">
          "{stringMatch[1]}"
        </span>,
      );
      remaining = remaining.slice(stringMatch[0].length);
      continue;
    }

    // Boolean match
    const boolMatch = remaining.match(/^(true|false)\b/i);
    if (boolMatch) {
      parts.push(
        <span key={key++} className="text-orange-400">
          {boolMatch[1]}
        </span>,
      );
      remaining = remaining.slice(boolMatch[0].length);
      continue;
    }

    // Number match
    const numMatch = remaining.match(/^\b(\d+(\.\d+)?)\b/);
    if (numMatch) {
      parts.push(
        <span key={key++} className="text-cyan-400">
          {numMatch[1]}
        </span>,
      );
      remaining = remaining.slice(numMatch[0].length);
      continue;
    }

    // Arrow match
    const arrowMatch = remaining.match(/^->/);
    if (arrowMatch) {
      parts.push(
        <span key={key++} className="text-yellow-400">
          {'->'}
        </span>,
      );
      remaining = remaining.slice(2);
      continue;
    }

    // Variable reference {{...}}
    const varMatch = remaining.match(/^(\{\{[^}]+\}\})/);
    if (varMatch) {
      parts.push(
        <span key={key++} className="text-pink-400">
          {varMatch[1]}
        </span>,
      );
      remaining = remaining.slice(varMatch[0].length);
      continue;
    }

    // Regular character
    parts.push(
      <span key={key++} className="text-muted">
        {remaining[0]}
      </span>,
    );
    remaining = remaining.slice(1);
  }

  return <>{parts}</>;
}

export default SourceViewer;
