import { ExternalLink, FileText } from 'lucide-react';
import type { ReactNode } from 'react';

interface ReferenceProps {
  href: string;
  children: ReactNode;
}

export function Reference({ href, children }: ReferenceProps) {
  const isExternal = href.startsWith('http');

  return (
    <a
      href={href}
      target={isExternal ? '_blank' : undefined}
      rel={isExternal ? 'noopener noreferrer' : undefined}
      className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm font-medium text-slate-700 no-underline transition-colors hover:border-slate-300 hover:bg-slate-100"
    >
      {isExternal ? <ExternalLink className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />}
      {children}
    </a>
  );
}
