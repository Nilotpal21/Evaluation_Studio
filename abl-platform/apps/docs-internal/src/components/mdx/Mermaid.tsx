'use client';

import { useEffect, useRef, useState } from 'react';

export function Mermaid({ chart }: { chart: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState('');

  useEffect(() => {
    import('mermaid').then((mermaid) => {
      mermaid.default.initialize({
        startOnLoad: false,
        theme: 'neutral',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      });
      const id = `mermaid-${Math.random().toString(36).slice(2)}`;
      mermaid.default.render(id, chart).then(({ svg }) => setSvg(svg));
    });
  }, [chart]);

  if (!svg) return <div className="animate-pulse h-32 bg-gray-100 rounded-lg" />;
  return (
    <div ref={ref} dangerouslySetInnerHTML={{ __html: svg }} className="my-6 flex justify-center" />
  );
}
