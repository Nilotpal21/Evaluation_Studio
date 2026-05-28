'use client';

import DOMPurify from 'isomorphic-dompurify';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useThemeStore } from '../../../store/theme-store';

export function Mermaid({ chart }: { chart: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState('');
  const [error, setError] = useState(false);
  const resolved = useThemeStore((s) => s.resolved);

  useEffect(() => {
    setSvg('');
    setError(false);

    const id = `mermaid-${Math.random().toString(36).slice(2)}`;

    import('mermaid')
      .then((m) => {
        m.default.initialize({
          startOnLoad: false,
          theme: resolved === 'dark' ? 'dark' : 'neutral',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        });
        return m.default.render(id, chart);
      })
      .then(({ svg: renderedSvg }) => setSvg(renderedSvg))
      .catch(() => setError(true));
  }, [chart, resolved]);

  // Mermaid is a trusted library, but the chart string is user-editable MDX
  // content. A crafted chart can produce SVG containing `<script>` or event
  // handlers; sanitize through DOMPurify with the SVG profile before
  // injecting via dangerouslySetInnerHTML.
  const safeSvg = useMemo(
    () =>
      svg
        ? DOMPurify.sanitize(svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
          })
        : '',
    [svg],
  );

  if (error) {
    return (
      <pre className="my-6 overflow-x-auto rounded-lg bg-background-muted p-4 text-sm text-muted">
        {chart}
      </pre>
    );
  }

  if (!safeSvg) {
    return <div className="h-32 animate-pulse rounded-lg bg-background-muted" />;
  }

  return (
    <div
      ref={ref}
      dangerouslySetInnerHTML={{ __html: safeSvg }}
      className="my-6 flex justify-center"
    />
  );
}
