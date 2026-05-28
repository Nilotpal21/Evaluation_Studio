import { Info, AlertTriangle, Lightbulb } from 'lucide-react';
import type { ReactNode } from 'react';

const styles = {
  info: {
    container: 'bg-blue-50 border-blue-200 text-blue-900',
    icon: <Info className="h-5 w-5 text-blue-500 flex-shrink-0" />,
  },
  warning: {
    container: 'bg-amber-50 border-amber-200 text-amber-900',
    icon: <AlertTriangle className="h-5 w-5 text-amber-500 flex-shrink-0" />,
  },
  tip: {
    container: 'bg-green-50 border-green-200 text-green-900',
    icon: <Lightbulb className="h-5 w-5 text-green-500 flex-shrink-0" />,
  },
} as const;

interface CalloutProps {
  type: 'info' | 'warning' | 'tip';
  children: ReactNode;
}

export function Callout({ type, children }: CalloutProps) {
  const style = styles[type];

  return (
    <div className={`my-4 flex gap-3 rounded-lg border p-4 ${style.container}`}>
      {style.icon}
      <div className="flex-1">{children}</div>
    </div>
  );
}
