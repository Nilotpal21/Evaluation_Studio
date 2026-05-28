import { Info, AlertTriangle, Lightbulb } from 'lucide-react';
import type { ReactNode } from 'react';

const styles = {
  info: {
    container: 'bg-info-subtle border-info/30 text-foreground',
    icon: <Info className="h-5 w-5 flex-shrink-0 text-info" />,
  },
  warning: {
    container: 'bg-warning-subtle border-warning/30 text-foreground',
    icon: <AlertTriangle className="h-5 w-5 flex-shrink-0 text-warning" />,
  },
  tip: {
    container: 'bg-success-subtle border-success/30 text-foreground',
    icon: <Lightbulb className="h-5 w-5 flex-shrink-0 text-success" />,
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
