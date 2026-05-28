import { CodeBlock } from '../ui/CodeBlock';
import { JsonViewer } from '../ui/JsonViewer';

interface StructuredDataBlockProps {
  value: unknown;
  language?: string;
  maxHeight?: string;
  wrapLines?: boolean;
}

function stringifyStructuredValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'undefined') {
    return 'undefined';
  }

  return JSON.stringify(value, null, 2) ?? String(value);
}

export function StructuredDataBlock({
  value,
  language,
  maxHeight = '16rem',
  wrapLines = true,
}: StructuredDataBlockProps) {
  if (value !== null && typeof value === 'object') {
    return (
      <div className="rounded-lg border border-default bg-background-muted p-3">
        <div className="overflow-auto" style={{ maxHeight }}>
          <JsonViewer data={value} copyable />
        </div>
      </div>
    );
  }

  return (
    <CodeBlock
      code={stringifyStructuredValue(value)}
      language={language}
      maxHeight={maxHeight}
      wrapLines={wrapLines}
    />
  );
}
